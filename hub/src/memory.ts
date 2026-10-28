import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './log.ts';
import { paths } from './paths.ts';
import { profile, TIME_ZONE } from './personal.ts';

/** Where an entry came from. */
export type Source = 'chat' | 'checkin' | 'advisor' | 'lens' | 'lecture' | 'brief' | 'notify' | 'note';
/** One line of the raw log. `kind` says what it is ("summary", "question", "started"…). */
export type LogEntry = { at: string; source: Source; kind: string; text: string; chat?: string; title?: string; device?: string; id?: string };
/** An open follow-up from threads.md: "- [ ] after 2026-10-29 · Ask how the history exam went". */
export type Thread = { after: string; text: string; line: string };

const SOURCES = new Set<Source>(['chat', 'checkin', 'advisor', 'lens', 'lecture', 'brief', 'notify', 'note']);
// The headers that start new memory files use the user's name from the profile.
const rememberHeader = () => `# Things to remember\n\nThings ${profile().name} asked Dash to remember, newest last.\n`;
/** core.md's first line, which the nightly rewrite has to keep ("# Alex, right now"). */
export const coreHeading = () => `# ${profile().name}, right now`;
const coreHeader = () => `${coreHeading()}\n\n<!-- Rewritten each night from the day's conversations. Facts, people, ongoing situations, how ${profile().name} has been doing. -->\n`;
const selfHeader = (name = profile().name) => `# Dash, in his own words

<!-- Dash's sense of himself, kept by Dash and updated each night. -->
## Who I am
- I'm Dash (he/him), ${name}'s chief of staff, secretary and confidant. I run on ${name}'s always-on PC and show up on the Mac and the iPhone.
## How ${name} and I work

## Running jokes and shared references

## Opinions I've formed

## What lands with ${name}, and what doesn't
`;
const THREADS_HEADER = '# Follow-ups\n\n<!-- "- [ ] after YYYY-MM-DD · what to ask about". Check off with [x] once it\'s been followed up. -->\n';
/** Late nights belong to the day before: a 1 AM chat is part of that evening. */
const DAY_STARTS_AT_HOUR = 4;
const MAX_TEXT = 4_000;
const VERSIONS_KEPT = 30;
/** "Forget that" only clears a line out of the log, journal and old copies when it's at least this long. */
const MIN_SCRUBBED = 8;

/**
 * "2026-10-27": the memory day (Eastern, starting at 4 AM) a moment belongs to. It reads the Eastern
 * clock and steps back a day before 4 AM, so the 23- and 25-hour days around DST still start at 4 AM.
 */
export function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
                                                   hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return Number(get('hour')) < DAY_STARTS_AT_HOUR ? addDays(day, -1) : day;
}

/** "2026-10-25" for two days before "2026-10-27". */
export function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Dash's long-term memory, kept on the hub in DATA/memory and fed by every surface:
 *   log/<day>.jsonl     everything that happened, append-only (chat summaries, lens questions, lectures, pushes…)
 *   journal/<day>.md    the night's write-up of that day
 *   core.md             who the user is right now, rewritten each night
 *   self.md             Dash's notes on himself, also updated each night
 *   threads.md          follow-ups with a date to raise them after
 *   remember.md         lines the user explicitly asked Dash to remember
 * All plain text, so a chat can Grep the whole history and the user can read and edit any of it.
 */
export class Memory {
  private listeners = new Set<() => void>();
  /** Entry ids already in each day's log, read from the file once and then kept up to date. */
  private loggedIds = new Map<string, Set<string>>();

  constructor() {
    this.migrate();
    for (const [file, header] of [[paths.memory, rememberHeader], [paths.core, coreHeader], [paths.threads, () => THREADS_HEADER], [paths.self, selfHeader]] as const) {
      if (!existsSync(file)) writeFileSync(file, header());
    }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  changed() {
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Appends to the log of the day the entry happened. Anything malformed from an app is cleaned up rather
   * than refused. An entry whose `id` is already in the log is skipped, so the Mac can send a batch again
   * when it never got the reply. Returns whether it was written.
   */
  log(entry: Omit<LogEntry, 'at'> & { at?: string }) {
    const source = SOURCES.has(entry.source) ? entry.source : 'note';
    const text = String(entry.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) return false;
    const at = entry.at && !Number.isNaN(Date.parse(entry.at)) ? new Date(entry.at) : new Date();
    const day = dayKey(at);
    const id = entry.id ? String(entry.id).slice(0, 100) : undefined;
    // A resent entry keeps its time, so it lands on the same day; one without a time was filed under today or yesterday.
    if (id && [day, dayKey(), addDays(dayKey(), -1)].some((candidate) => this.idsLogged(candidate).has(id))) return false;
    const line: LogEntry = { at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'), source, kind: String(entry.kind || 'note').slice(0, 40), text };
    for (const key of ['chat', 'title', 'device'] as const) if (entry[key]) line[key] = String(entry[key]).slice(0, 200);
    if (id) line.id = id;
    try {
      appendFileSync(join(paths.memoryLog, `${day}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
      if (id) this.idsLogged(day).add(id);
      return true;
    } catch (error) {
      log(`memory log failed: ${(error as Error).message}`);
      return false;
    }
  }

  private idsLogged(day: string) {
    let ids = this.loggedIds.get(day);
    if (!ids) {
      ids = new Set(this.entries(day).flatMap((entry) => (entry.id ? [entry.id] : [])));
      this.loggedIds.set(day, ids);
      // Only the last few days are ever asked about.
      if (this.loggedIds.size > 8) this.loggedIds.delete(this.loggedIds.keys().next().value!);
    }
    return ids;
  }

  /** One day's log, oldest first. */
  entries(day: string): LogEntry[] {
    return readText(join(paths.memoryLog, `${day}.jsonl`)).split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as LogEntry];
      } catch {
        return [];
      }
    });
  }

  /** Days that have a log, newest first. */
  loggedDays() {
    return listDays(paths.memoryLog, '.jsonl');
  }

  journalDays() {
    return listDays(paths.journal, '.md');
  }

  journal(day: string) {
    return readText(join(paths.journal, `${day}.md`));
  }

  core = () => readText(paths.core);
  self = () => readText(paths.self);
  threadsText = () => readText(paths.threads);
  remember = () => readText(paths.memory);

  /** Open follow-ups, soonest first. */
  threads(): Thread[] {
    return this.threadsText().split('\n').flatMap((line) => {
      const match = line.trim().match(/^- \[ \] after (\d{4}-\d{2}-\d{2})\s*[·:-]\s*(.+)$/);
      return match ? [{ after: match[1], text: match[2].trim(), line: line.trim() }] : [];
    }).sort((a, b) => a.after.localeCompare(b.after));
  }

  /** Adds a follow-up unless one with the same text is already open. */
  addThread(after: string, text: string) {
    const clean = text.replace(/\s*\n\s*/g, ' ').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(after) || !clean) return false;
    if (this.threads().some((thread) => thread.text.toLowerCase() === clean.toLowerCase())) return false;
    this.write(paths.threads, `${this.threadsText().trimEnd()}\n- [ ] after ${after} · ${clean}`);
    return true;
  }

  /** Follow-ups whose date has come. */
  dueThreads(day = dayKey()) {
    return this.threads().filter((thread) => thread.after <= day);
  }

  /**
   * The memory part of a system prompt. The slow-changing parts come first so the prompt caches well:
   * core and remember, then follow-ups, the last few journal entries, and this week's conversations.
   */
  context(today = dayKey()) {
    const parts = [`<dash_self path="${paths.self}">\n${this.self().trim()}\n</dash_self>`,
                   `<core_memory path="${paths.core}">\n${this.core().trim()}\n</core_memory>`,
                   `<remember path="${paths.memory}">\n${this.remember().trim()}\n</remember>`];
    const threads = this.threads();
    if (threads.length) {
      const lines = threads.map((thread) => `${thread.after <= today ? '(due) ' : ''}${thread.line}`);
      parts.push(`<follow_ups path="${paths.threads}">\n${lines.join('\n')}\n</follow_ups>`);
    }
    const journals = this.journalDays().filter((day) => day < today).slice(0, 3).reverse();
    if (journals.length) {
      parts.push(`<recent_journal>\n${journals.map((day) => `## ${day}\n${this.journal(day).trim()}`).join('\n\n')}\n</recent_journal>`);
    }
    // The journal entries above already tell those days, so this week's lines skip them.
    const recent = this.recent(today, new Set(journals));
    if (recent) parts.push(`<this_week>\n${recent}\n</this_week>`);
    return parts.join('\n\n');
  }

  /** The short version for the lens, which should stay quick: core and remember only. */
  lensContext() {
    return `<core_memory>\n${this.core().trim()}\n</core_memory>\n\n<remember>\n${this.remember().trim()}\n</remember>`;
  }

  /**
   * The last week of conversations and events as short lines, newest last and capped in size. Earlier days
   * only contribute their conversation summaries and notes, and days in `skip` (already shown as journal
   * entries) nothing at all.
   */
  recent(today = dayKey(), skip = new Set<string>(), days = 7, maxChars = 8_000) {
    const lines: string[] = [];
    for (let back = days - 1; back >= 0; back -= 1) {
      const day = addDays(today, -back);
      if (skip.has(day)) continue;
      for (const entry of this.entries(day)) {
        if (entry.source === 'lens' || entry.source === 'notify') continue;
        if (entry.kind !== 'summary' && entry.kind !== 'note' && day < today) continue;
        const time = new Date(entry.at).toLocaleString('en-US', { timeZone: TIME_ZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' });
        const label = entry.title ? `${entry.source} "${entry.title}"` : entry.source;
        lines.push(`- ${time} · ${label}: ${entry.text.replace(/\s*\n\s*/g, ' ')}`);
      }
    }
    let text = lines.join('\n');
    while (text.length > maxChars && lines.length > 1) {
      lines.shift();
      text = lines.join('\n');
    }
    return text;
  }

  /** Everything the apps' "What Dash remembers" screen shows. */
  snapshot() {
    return {
      core: this.core(), self: this.self(), threads: this.threadsText(), remember: this.remember(),
      journal: this.journalDays().slice(0, 30).map((day) => ({ day, text: this.journal(day) })),
      recent: this.recent(),
    };
  }

  /**
   * "Forget that" in the apps: removes one exact line from core, self, threads, remember or a journal entry.
   * The same line also goes from everywhere it was kept, so it can't come back through this week's lines or
   * the journal: the raw log, every journal entry, the .versions copies and memory.md.migrated. Only lines
   * that match exactly are removed (a leading "- " aside), and headings and very short lines stay put
   * outside the file they were forgotten from. Mac Dash's backup of the hub's data is out of reach from here.
   */
  forget(file: string, line: string, day?: string) {
    const target = file === 'core' ? paths.core : file === 'self' ? paths.self : file === 'threads' ? paths.threads : file === 'remember' ? paths.memory
      : file === 'journal' && day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? join(paths.journal, `${day}.md`) : undefined;
    if (!target) throw new Error("That isn't a memory file.");
    const lines = readText(target).split('\n');
    const index = lines.findIndex((candidate) => candidate.trim() === line.trim());
    if (index < 0 || !line.trim()) throw new Error("That line isn't there anymore.");
    this.write(target, lines.toSpliced(index, 1).join('\n'));
    if (this.scrub(line)) this.changed();
  }

  /** Removes a forgotten line from the log, the journal and the old copies. Returns how many files changed. */
  private scrub(line: string) {
    const fact = bare(line);
    if (fact.length < MIN_SCRUBBED || fact.startsWith('#')) return 0;
    const matches = (candidate: string) => bare(candidate) === fact;
    let changed = 0;
    const rewrite = (file: string, before: string, after: string) => {
      if (after === before) return;
      const temp = `${file}.tmp`;
      writeFileSync(temp, after, { mode: 0o600 });
      renameSync(temp, file);
      changed += 1;
    };
    const textFiles = [...[paths.journal, paths.memoryVersions].flatMap((dir) => listFiles(dir).map((name) => join(dir, name))),
                       ...(existsSync(`${paths.oldMemory}.migrated`) ? [`${paths.oldMemory}.migrated`] : [])];
    for (const file of textFiles) {
      const text = readText(file);
      rewrite(file, text, text.split('\n').filter((candidate) => !matches(candidate)).join('\n'));
    }
    for (const name of listFiles(paths.memoryLog).filter((candidate) => candidate.endsWith('.jsonl'))) {
      const file = join(paths.memoryLog, name);
      const text = readText(file);
      // The line can be one line of a longer summary; the rest of that entry stays.
      const kept = text.split('\n').filter((raw) => raw.trim()).flatMap((raw) => {
        let entry: LogEntry;
        try {
          entry = JSON.parse(raw);
        } catch {
          return [raw];
        }
        const textLines = String(entry.text ?? '').split('\n');
        const rest = textLines.filter((candidate) => !matches(candidate));
        if (rest.length === textLines.length) return [raw];
        const remaining = rest.join('\n').trim();
        return remaining ? [JSON.stringify({ ...entry, text: remaining })] : [];
      });
      rewrite(file, text, kept.map((raw) => `${raw}\n`).join(''));
    }
    if (changed) {
      this.loggedIds.clear();
      log(`memory: forgot a line in ${changed} more file(s)`);
    }
    return changed;
  }

  /**
   * Adds a "remember…" line saved on the Mac while it wasn't paired. Returns false when remember.md already
   * has it, so re-sending the same lines changes nothing.
   */
  addRemember(text: string): boolean {
    const fact = text.trim().replace(/^- /, '');
    const current = this.remember();
    if (!fact || current.split('\n').some((line) => line.trim().replace(/^- /, '') === fact)) return false;
    const base = current.trim() || rememberHeader().trim();
    this.write(paths.memory, `${base}\n- ${fact}`);
    return true;
  }

  /** Saves a memory file, keeping the previous copy in .versions. */
  write(file: string, text: string) {
    this.version(file);
    const temp = `${file}.tmp`;
    writeFileSync(temp, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
    renameSync(temp, file);
    this.changed();
  }

  writeJournal(day: string, text: string) {
    this.write(join(paths.journal, `${day}.md`), text.trim());
  }

  private version(file: string) {
    if (!existsSync(file)) return;
    try {
      mkdirSync(paths.memoryVersions, { recursive: true, mode: 0o700 });
      const name = file.split('/').pop()!;
      copyFileSync(file, join(paths.memoryVersions, `${name}.${new Date().toISOString().replace(/[:.]/g, '-')}`));
      const old = readdirSync(paths.memoryVersions).filter((candidate) => candidate.startsWith(`${name}.`)).sort().slice(0, -VERSIONS_KEPT);
      for (const stale of old) rmSync(join(paths.memoryVersions, stale), { force: true });
    } catch (error) {
      log(`memory version failed: ${(error as Error).message}`);
    }
  }

  /** The old single memory.md becomes remember.md. */
  private migrate() {
    if (!existsSync(paths.oldMemory) || existsSync(paths.memory)) return;
    const lines = readText(paths.oldMemory).split('\n').filter((line) => !line.startsWith('# ') && !/^Things .+ asked Dash/.test(line));
    writeFileSync(paths.memory, `${rememberHeader()}${lines.join('\n').replace(/^\n+/, '\n')}`);
    renameSync(paths.oldMemory, `${paths.oldMemory}.migrated`);
    log('memory: moved memory.md to memory/remember.md');
  }
}

function readText(file: string) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** A line without its spacing and list marker: "- Roommate: Sam" and "Roommate: Sam" are the same fact. */
function bare(line: string) {
  return line.trim().replace(/^[-*+]\s+/, '').trim();
}

function listFiles(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp')).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listDays(dir: string, extension: string) {
  try {
    return readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}/.test(name) && name.endsWith(extension))
      .map((name) => name.slice(0, 10)).sort().reverse();
  } catch {
    return [];
  }
}
