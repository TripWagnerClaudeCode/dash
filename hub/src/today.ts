import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { ClaudeSession, models } from './claude.ts';
import { type Jarvis } from './jarvis.ts';
import { log } from './log.ts';
import { type Deadlines } from './deadlines.ts';
import { type Memory } from './memory.ts';
import { now, persona, personalBackground, prompt } from './personal.ts';
import { paths } from './paths.ts';
import { type ToDoList } from './todo.ts';

export type Load<T> = { state: 'idle' | 'loading' } | { state: 'loaded'; value: T } | { state: 'failed'; error: string };

export type CalendarEvent = { id: string; title: string; start: string; end?: string; allDay: boolean; place: string; course?: string };
export type MailItem = { id: string; from: string; subject: string };
type Brief = { text: string; isError: boolean; busy: boolean; written?: string };

/** Refresh when Today is opened and the data is older than this. */
const STALE = 10 * 60_000;

/**
 * The Today page's data (ported from TodayModel.swift): calendar, weather and inbox straight from the
 * hub's jarvis (no Claude in the loop), plus the "Brief me" overview, which Claude writes from them.
 * The last brief is saved, so it's still there after the hub restarts.
 */
export class Today {
  events: Load<CalendarEvent[]> = { state: 'idle' };
  weather: Load<string> = { state: 'idle' };
  inbox: Load<MailItem[]> = { state: 'idle' };
  lastRefresh?: Date;
  brief: Brief = { text: '', isError: false, busy: false };

  private raw: Record<string, string> = {};
  private loading?: Promise<void>;
  private listeners = new Set<() => void>();
  private readonly jarvis: Jarvis;
  private readonly todos: ToDoList;
  private readonly memory?: Memory;
  private readonly deadlines?: Deadlines;

  constructor(jarvis: Jarvis, todos: ToDoList, memory?: Memory, deadlines?: Deadlines) {
    this.jarvis = jarvis;
    this.todos = todos;
    this.memory = memory;
    this.deadlines = deadlines;
    try {
      this.brief = { ...JSON.parse(readFileSync(paths.brief, 'utf8')), busy: false };
    } catch {}
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  private changed() {
    this.listeners.forEach((listener) => listener());
  }

  get isLoading() {
    return [this.events, this.weather, this.inbox].some((load) => load.state === 'loading');
  }

  /** Whether the brief has something to work from: done loading and at least one tile loaded. */
  get canBrief() {
    return !this.isLoading && !this.brief.busy && Object.keys(this.raw).length > 0;
  }

  refreshIfStale() {
    if (!this.lastRefresh || Date.now() - this.lastRefresh.getTime() > STALE) this.refresh();
  }

  /** Reloads the tiles. A refresh already under way is shared rather than started twice. */
  refresh() {
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** Waits for tiles no older than `maxAge`, refreshing first if they're older (or were never loaded, as after a restart). */
  async fresh(maxAge = STALE) {
    if (this.loading) return this.loading;
    if (!this.lastRefresh || Date.now() - this.lastRefresh.getTime() > maxAge) return this.refresh();
  }

  /** What jarvis last returned for a tile ("calendar_get", "email_read"), without ids, or undefined if it didn't load. */
  rawText(tool: string) {
    return this.raw[tool] === undefined ? undefined : stripIDs(this.raw[tool]);
  }

  private async load() {
    this.lastRefresh = new Date();
    // Forget the last fetch, so a failed refresh can't feed old data to the brief.
    this.raw = {};
    this.events = this.weather = this.inbox = { state: 'loading' };
    this.changed();
    const [calendar, weather, mail] = await Promise.all([
      this.fetch('calendar_get', { days: 7 }), this.fetch('weather_get'), this.fetch('email_read', { n: 8 }),
    ]);
    this.events = mapLoad(calendar, parseEvents);
    this.weather = weather;
    this.inbox = mapLoad(mail, parseInbox);
    this.changed();
  }

  /** Writes the daily overview from what the tiles loaded, streaming it to every client. Returns it, or undefined if it failed. */
  async writeBrief(): Promise<string | undefined> {
    if (!this.canBrief) return undefined;
    let brightspace = '(no to-do file)';
    try {
      brightspace = readFileSync(paths.brightspace, 'utf8');
    } catch {}
    // Event and message ids mean nothing to the brief; dropping them trims the prompt.
    const text = `Right now it is ${now()}.

<calendar_next_7_days>
${this.raw.calendar_get ? stripIDs(this.raw.calendar_get) : "(couldn't load)"}
</calendar_next_7_days>

<my_todo_list>
${this.todos.summary}
</my_todo_list>

<deadlines_next_14_days>
${this.deadlines?.summary() ?? '(not tracked)'}
</deadlines_next_14_days>

<brightspace_todo>
${brightspace}
</brightspace_todo>

<weather>
${this.raw.weather_get ?? "(couldn't load)"}
</weather>

<recent_inbox>
${this.raw.email_read ? stripIDs(this.raw.email_read) : "(couldn't load)"}
</recent_inbox>

Write today's overview.`;
    this.brief = { text: '', isError: false, busy: true };
    this.changed();
    try {
      const system = `${persona()}\n\n${prompt('brief')}\n\n${personalBackground(this.memory?.context() ?? '')}`;
      const reply = await ClaudeSession.ask(text, system, models.sonnet, 'low', (delta) => {
        this.brief.text += delta;
        this.changed();
      });
      this.brief = { text: reply || this.brief.text, isError: false, busy: false, written: new Date().toISOString() };
    } catch (error) {
      log(`brief failed: ${(error as Error).message}`);
      this.brief = { text: (error as Error).message, isError: true, busy: false };
    }
    try {
      writeFileSync(paths.brief, JSON.stringify(this.brief));
    } catch {}
    this.changed();
    return this.brief.isError ? undefined : this.brief.text;
  }

  snapshot() {
    return {
      events: this.events, weather: this.weather, inbox: this.inbox,
      brief: { text: this.brief.text, isError: this.brief.isError, busy: this.brief.busy, canBrief: this.canBrief,
               ...(this.brief.written ? { written: this.brief.written } : {}) },
      ...(this.lastRefresh ? { refreshed: this.lastRefresh.toISOString() } : {}),
    };
  }

  private async fetch(tool: string, args: Record<string, unknown> = {}): Promise<Load<string>> {
    try {
      const text = await this.jarvis.call(tool, args);
      // jarvis reports Google auth trouble as plain text rather than an error.
      const lower = text.toLowerCase();
      if (lower.includes('invalid_grant') || lower.includes('token has been expired')) {
        return { state: 'failed', error: 'Google sign-in expired on the hub. Ask Claude on the Mac to re-authorize jarvis on dash-hub.' };
      }
      if (lower.startsWith('failed to') || lower.includes('credentials.json')) return { state: 'failed', error: text };
      this.raw[tool] = text;
      return { state: 'loaded', value: text };
    } catch (error) {
      return { state: 'failed', error: (error as Error).message };
    }
  }
}

function mapLoad<T, U>(load: Load<T>, transform: (value: T) => U): Load<U> {
  return load.state === 'loaded' ? { state: 'loaded', value: transform(load.value) } : load;
}

/** Removes " (id: …)" tags and the invisible padding characters newsletters stuff into previews. */
export function stripIDs(text: string) {
  return text.replace(/ \(id: [^)]+\)/g, '').replace(/[​‌‍ ͏﻿]/g, '').replace(/ {2,}/g, ' ');
}

/** Splits jarvis's "1. …\n   …\n2. …" lists into the lines of each entry. */
function entries(text: string): string[][] {
  const result: string[][] = [];
  for (const line of text.split('\n')) {
    const number = line.match(/^\d+\. /);
    if (number) result.push([line.slice(number[0].length)]);
    else if (result.length && line.trim()) result[result.length - 1].push(line.trim());
  }
  return result;
}

/** Splits off a trailing " (id: …)" tag. */
function splitID(text: string): [string, string] {
  const tag = text.match(/ \(id: ([^)]+)\)$/);
  return tag?.index !== undefined ? [text.slice(0, tag.index), tag[1]] : [text, randomUUID()];
}

/** "2026-10-27T10:00:00-04:00", or "2026-10-27" for all-day events (midnight in the hub's zone, Eastern). */
function parseDate(value: string): Date | undefined {
  const trimmed = value.trim();
  const day = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "HIST2100A" from "HIST2100A: Empires and Trade". */
function courseCode(title: string) {
  const head = title.split(':')[0];
  return /^[A-Z]{2,5}\d{3,4}[A-Z]?$/.test(head) ? head : undefined;
}

export function parseEvents(text: string): CalendarEvent[] {
  return entries(text).flatMap((lines) => {
    if (lines.length < 2) return [];
    const [title, id] = splitID(lines[0]);
    const times = lines[1].split(' → ');
    const start = parseDate(times[0]);
    if (!start) return [];
    const end = times.length > 1 ? parseDate(times[1]) : undefined;
    const course = courseCode(title);
    return [{ id, title, start: start.toISOString(), ...(end ? { end: end.toISOString() } : {}), allDay: !times[0].includes('T'),
              place: lines[2] ?? '', ...(course ? { course } : {}) }];
  });
}

export function parseInbox(text: string): MailItem[] {
  return entries(text).flatMap((lines) => {
    if (!lines[0]?.startsWith('From: ')) return [];
    let [from, id] = splitID(lines[0].slice(6));
    // "Name <address>" → "Name"
    const angle = from.indexOf('<');
    if (angle > 0) from = from.slice(0, angle).trim().replace(/^"|"$/g, '');
    const subject = lines.find((line) => line.startsWith('Subject: '))?.slice(9) ?? '(no subject)';
    return [{ id, from, subject }];
  });
}
