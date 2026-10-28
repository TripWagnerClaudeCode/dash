import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { type Chats } from './chats.ts';
import { ClaudeSession, models, type Profile } from './claude.ts';
import { type Deadline, type Deadlines, dueReminder, whenText } from './deadlines.ts';
import { type Jarvis, jarvisMcpConfig } from './jarvis.ts';
import { log } from './log.ts';
import { dayKey, type Memory } from './memory.ts';
import { actionKey, isQuietHour, type Notifier } from './notify.ts';
import { DATA, MEMORY_DIR, paths } from './paths.ts';
import { now as nowText, persona, profile, prompt } from './personal.ts';
import { type CalendarEvent, parseEvents, type Today } from './today.ts';
import { type ToDoList } from './todo.ts';

/** Classifies calendar events, reads a syllabus, or words a push (Claude in the hub; stand-ins in tests). */
export type Helpers = {
  classify: (events: string) => Promise<string>;
  readSyllabus: (file: string) => Promise<string>;
  voice: (purpose: string, facts: string) => Promise<string>;
  /** Dash's afternoon look around: a read-only session with his tools that replies with JSON. */
  sweep: (input: string) => Promise<string>;
};

type State = {
  /** Calendar events already sorted: id → "title|start", so an edited event is looked at again. */
  calendar: Record<string, string>;
  /**
   * Calendar event id → the deadline made from it and its line as written, so a moved event updates that
   * deadline instead of adding another, and a line the user has since checked off or edited is left alone.
   */
  calendarDeadlines: Record<string, { id: string; line: string }>;
  /**
   * Calendar event id → how it was sorted: 'deadline' (an exam or something due) or 'none'. Only an event
   * sorted as a deadline is ever linked to one or takes one off the list. Events sorted before this was kept
   * have no entry, and are sorted again on the next scan.
   */
  calendarKinds: Record<string, 'deadline' | 'none'>;
  /**
   * Syllabus file → "modified time|size" when it was last read (older state kept just the modified time).
   * Undefined until the first scan sets a baseline.
   */
  syllabi?: Record<string, string | number>;
  /** Syllabus file → how often its current version failed to read, so a bad one stops costing a Sonnet run every hour. */
  syllabusFailures: Record<string, { stamp: string; tries: number }>;
  /** Follow-up lines already pushed, and the day of the last follow-up push. */
  pushedThreads: string[];
  lastThreadPush?: string;
};

export type SecretaryParts = {
  deadlines: Deadlines; notifier: Notifier; memory: Memory; today: Today; jarvis: Pick<Jarvis, 'call'>; chats?: Chats;
  /** The user's to-do list, for the sweep (what's already on it, and not worth a push). */
  todos?: Pick<ToDoList, 'items' | 'summary'>;
  /** The phone app's Expo Go address ("exp://100.x.y.z:8081"), for links that open Dash. */
  appURL: () => string | undefined;
  /** This hub's address on the tailnet ("https://dash-hub.….ts.net"), for notification buttons. */
  hubURL?: string;
  helpers?: Partial<Helpers>;
  clock?: () => Date;
};

const SYLLABUS_TYPES = new Set(['.pdf', '.docx', '.md', '.txt']);
/** A syllabus that fails to read this many times is left alone until the file changes. */
const SYLLABUS_TRIES = 3;
const CALENDAR_DAYS = 30;
/** jarvis returns at most this many events; a list that long may be cut short, so nothing is read as cancelled. */
const CALENDAR_LIMIT = 250;
const DAY = 86_400_000;

/**
 * Dash being a secretary between conversations: keeps the deadline list fed from the calendar and new
 * syllabi, sends reminders as things come due, a morning brief, an evening check-in and the odd
 * follow-up. The scheduler in main.ts decides when each of these runs.
 */
export class Secretary {
  private state: State = { calendar: {}, calendarDeadlines: {}, calendarKinds: {}, syllabusFailures: {}, pushedThreads: [] };
  private readonly parts: SecretaryParts;
  private readonly helpers: Helpers;
  private readonly clock: () => Date;

  constructor(parts: SecretaryParts) {
    this.parts = parts;
    this.clock = parts.clock ?? (() => new Date());
    this.helpers = { classify, readSyllabus, voice, sweep, ...parts.helpers };
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(paths.secretaryState, 'utf8')) };
    } catch {}
    // Older state: an event with a deadline linked was sorted as one (links were only ever kept for deadlines).
    for (const eventID of Object.keys(this.state.calendarDeadlines)) this.state.calendarKinds[eventID] ??= 'deadline';
  }

  // Deadlines in

  /**
   * Looks at the next 30 days of calendar for exams and due dates it hasn't sorted yet. An event that
   * moved or was renamed updates the deadline made from it; one that was cancelled takes it off the list.
   * Either way, a deadline the user has checked off or edited by hand is theirs and stays as it is, and only an
   * event sorted as a deadline ever changes one: a lecture or appointment that moves or goes away doesn't.
   */
  async scanCalendar() {
    const now = this.clock();
    const text = await this.parts.jarvis.call('calendar_get', { days: CALENDAR_DAYS });
    if (/invalid_grant|expired or revoked|not authorized/i.test(text)) throw new Error('Google sign-in needs renewing');
    const all = parseEvents(text).filter((event) => event.id);
    let changed = this.dropCancelled(all, now);
    changed = this.pruneCalendar(now) || changed;
    this.parts.deadlines.prune(now);
    if (changed) this.save();
    const events = all.filter((event) => this.state.calendar[event.id] !== stampOf(event) || !this.state.calendarKinds[event.id]);
    if (!events.length) return 0;
    const reply = await this.helpers.classify(events.map((event) => `${event.id} | ${event.title} | ${event.start}`).join('\n'));
    const sorted = parseJSON<{ id: string; kind: string; title?: string; dueTime?: string | null }[]>(reply);
    if (!Array.isArray(sorted)) throw new Error("the calendar sorter's answer wasn't a list");
    let added = 0;
    for (const event of events) {
      const verdict = sorted.find((candidate) => candidate.id === event.id);
      if (!verdict) continue;
      const before = this.state.calendar[event.id];
      const was = this.state.calendarKinds[event.id];
      this.state.calendar[event.id] = stampOf(event);
      if (verdict.kind !== 'exam' && verdict.kind !== 'due') {
        this.state.calendarKinds[event.id] = 'none';
        // It was a deadline and no longer reads as one ("Exam 3" became "Exam 3 review"): as good as cancelled.
        if (was === 'deadline') this.dropLinked(event.id);
        continue;
      }
      this.state.calendarKinds[event.id] = 'deadline';
      const due = dueOf(event, verdict.dueTime);
      const title = verdict.title?.trim() || event.title.replace(/^[A-Z]{2,4}\d{3,4}[A-Z]?:\s*/, '');
      const exam = verdict.kind === 'exam';
      // Sorted before links were kept: looked for once, now that it reads as a deadline again.
      const link = this.state.calendarDeadlines[event.id] ?? (before && !was ? this.legacyLink(event, before, title) : undefined);
      if (link) {
        const current = this.parts.deadlines.find(link.id);
        // Checked off, edited or deleted by hand: the user's version stands, and no second copy is added.
        if (!current || current.line !== link.line) continue;
        const updated = this.parts.deadlines.update(current.id, { due, title, exam });
        if (updated) this.state.calendarDeadlines[event.id] = { id: updated.id, line: updated.line };
        continue;
      }
      const count = this.parts.deadlines.items.length;
      const item = this.parts.deadlines.add({ due, course: event.course, title, exam, source: 'calendar' });
      if (!item) continue;
      if (this.parts.deadlines.items.length > count) added += 1;
      // Only a line the calendar wrote is followed; one the user or a chat already added stays theirs.
      if (item.source === 'calendar') this.state.calendarDeadlines[event.id] = { id: item.id, line: item.line };
    }
    this.save();
    return added;
  }

  /**
   * A cancelled event simply drops out of the calendar. That's only believed for events still ahead and
   * well inside the window, and only when jarvis answered with a full list (not an error or an empty one).
   */
  private dropCancelled(events: CalendarEvent[], now: Date) {
    if (!events.length || events.length >= CALENDAR_LIMIT) return false;
    const seen = new Set(events.map((event) => event.id));
    const horizon = now.getTime() + (CALENDAR_DAYS - 1) * DAY;
    let changed = false;
    for (const [eventID, stamp] of Object.entries(this.state.calendar)) {
      if (seen.has(eventID)) continue;
      const start = Date.parse(startOf(stamp));
      if (!(start > now.getTime() && start < horizon)) continue;
      // Only an event sorted as a deadline takes one away. One not sorted again since kinds were kept is left
      // alone too: better a stale line the user can delete than a real deadline gone.
      if (this.state.calendarKinds[eventID] === 'deadline') this.dropLinked(eventID);
      delete this.state.calendar[eventID];
      delete this.state.calendarKinds[eventID];
      delete this.state.calendarDeadlines[eventID];
      changed = true;
    }
    return changed;
  }

  /** Takes a calendar event's deadline off the list, if it's still open and exactly as the calendar wrote it. */
  private dropLinked(eventID: string) {
    const link = this.state.calendarDeadlines[eventID];
    delete this.state.calendarDeadlines[eventID];
    if (!link) return;
    const current = this.parts.deadlines.find(link.id);
    if (!current || current.done || current.line !== link.line || current.source !== 'calendar') return;
    this.parts.deadlines.remove(current.id);
    log(`calendar: ${current.title} was cancelled or moved off the calendar; took it off the deadlines`);
  }

  /**
   * The deadline an event sorted before links were kept became, looked for once when it's sorted as a
   * deadline again: the one open calendar deadline, not already another event's, for its course on the day
   * it was, whose title matches the event's. Anything less certain isn't linked (the worst that does is a
   * second copy, never the wrong line deleted).
   */
  private legacyLink(event: CalendarEvent, stamp: string, title: string) {
    const oldTitle = stamp.slice(0, stamp.lastIndexOf('|'));
    const day = new Date(startOf(stamp)).toDateString();
    const course = oldTitle.match(/^([A-Z]{2,5}\d{3,4}[A-Z]?):/)?.[1];
    const named = words(`${oldTitle} ${event.title} ${title}`);
    const taken = new Set(Object.values(this.state.calendarDeadlines).map((link) => link.id));
    const candidates = this.parts.deadlines.items.filter((item) => item.source === 'calendar' && !item.done && item.course === course
      && !taken.has(item.id) && new Date(item.due).toDateString() === day && mentions(named, item));
    if (candidates.length !== 1) return undefined;
    log(`calendar: linked ${event.title} to its deadline from before links were kept`);
    return { id: candidates[0].id, line: candidates[0].line };
  }

  /** Forgets calendar events more than 30 days past (the calendar no longer returns them). */
  private pruneCalendar(now: Date) {
    let changed = false;
    for (const [eventID, stamp] of Object.entries(this.state.calendar)) {
      if (Date.parse(startOf(stamp)) >= now.getTime() - 30 * DAY) continue;
      delete this.state.calendar[eventID];
      delete this.state.calendarKinds[eventID];
      delete this.state.calendarDeadlines[eventID];
      changed = true;
    }
    return changed;
  }

  /**
   * Reads syllabi that are new or changed in ~/Documents/Syllabi. The first scan only notes what's there
   * (those were already put on the calendar). Dates it finds wait as "unconfirmed" until the user looks at them.
   */
  async scanSyllabi() {
    let files: { name: string; modified: number; stamp: string }[];
    try {
      files = readdirSync(paths.syllabi).filter((name) => SYLLABUS_TYPES.has(extname(name).toLowerCase()) && !/^readme/i.test(name))
        .map((name) => {
          const stats = statSync(join(paths.syllabi, name));
          // Size as well as time, so a file replaced with one of the same timestamp still counts as changed.
          return { name, modified: stats.mtimeMs, stamp: `${stats.mtimeMs}|${stats.size}` };
        });
    } catch {
      return 0;
    }
    if (!this.state.syllabi) {
      this.state.syllabi = Object.fromEntries(files.map((file) => [file.name, file.stamp]));
      this.save();
      return 0;
    }
    for (const name of Object.keys(this.state.syllabusFailures)) {
      if (!files.some((file) => file.name === name)) delete this.state.syllabusFailures[name];
    }
    let found = 0;
    for (const file of files) {
      const known = this.state.syllabi[file.name];
      if (known === file.stamp) continue;
      if (known === file.modified) {
        // Read before sizes were kept, and unchanged since.
        this.state.syllabi[file.name] = file.stamp;
        this.save();
        continue;
      }
      const failed = this.state.syllabusFailures[file.name];
      if (failed?.stamp === file.stamp && failed.tries >= SYLLABUS_TRIES) continue;
      const course = file.name.match(/^([A-Z]{2,4}\d{3,4}[A-Z]?)/)?.[1];
      const items = parseJSON<{ date: string; time?: string | null; title: string; exam?: boolean }[]>(
        await this.helpers.readSyllabus(join(paths.syllabi, file.name)));
      if (!Array.isArray(items)) {
        const tries = failed?.stamp === file.stamp ? failed.tries + 1 : 1;
        this.state.syllabusFailures[file.name] = { stamp: file.stamp, tries };
        this.save();
        log(tries >= SYLLABUS_TRIES ? `syllabus ${file.name}: couldn't read the dates ${tries} times; leaving it until the file changes`
          : `syllabus ${file.name}: couldn't read the dates, will try again later`);
        continue;
      }
      delete this.state.syllabusFailures[file.name];
      let added = 0;
      for (const item of items) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? '') || !item.title) continue;
        const due = new Date(`${item.date}T${/^\d{1,2}:\d{2}$/.test(item.time ?? '') ? item.time!.padStart(5, '0') : '23:59'}:00`);
        if (due <= this.clock()) continue;
        const before = this.parts.deadlines.items.length;
        this.parts.deadlines.add({ due, course, title: item.title, exam: !!item.exam, source: 'syllabus', confirmed: false });
        if (this.parts.deadlines.items.length > before) added += 1;
      }
      this.state.syllabi[file.name] = file.stamp;
      this.save();
      found += added;
      if (added) {
        // At night this waits in the notifier's queue and goes out after 8 AM.
        await this.parts.notifier.send({ kind: 'syllabus', title: `${course ?? file.name}: ${added} new date${added === 1 ? '' : 's'}`,
                                         body: `Found ${added} date${added === 1 ? '' : 's'} in the ${course ?? ''} syllabus. Have a look in Dash and confirm the ones that are right.`.replace('  ', ' '),
                                         tags: ['calendar'], click: this.appLink() });
      }
    }
    return found;
  }

  // Pushes out

  /**
   * Sends whatever deadline reminders have come due. Runs every few minutes. More than two at once (the
   * first run, or after the hub was off) go out as one summary instead of a burst.
   *
   * Nothing goes out in quiet hours (11 PM to 8 AM), however soon it's due, and nothing is worded either.
   * Reminders that came due overnight wait for the first run after 8, along with any push the notifier
   * held, and go out together: one digest if there are several. A reminder for something already past by
   * then is dropped.
   */
  async remind() {
    if (this.parts.notifier.quietNow()) return 0;
    const now = this.clock();
    const due = this.parts.deadlines.upcoming(now, 8).flatMap((item) => {
      const { send, skip } = dueReminder(item, now, this.parts.deadlines.sentReminders(item.id));
      return send ? [{ item, send, skip }] : [];
    });
    const held = this.parts.notifier.held();
    if (!due.length && !held.length) return 0;
    const markSent = (result: string, batch: typeof due) => {
      // A failure: not marked, so it goes out on a later run.
      if (result !== 'sent' && result !== 'off') return 0;
      for (const { item, send, skip } of batch) this.parts.deadlines.markSent(item.id, [...skip, send.key]);
      return result === 'sent' ? batch.length : 0;
    };
    const overnight = held.length > 0 || due.some(({ send }) => isQuietHour(send.at));
    if (due.length > 2 || (overnight && due.length + held.length > 1)) {
      const lines = [...held.map((push) => `${push.title}: ${push.body}`.slice(0, 300)),
                     ...due.map(({ item }) => `${item.course ? `${item.course} ` : ''}${item.title}: ${whenText(item.due, now)}`)];
      const result = await this.parts.notifier.send({
        kind: held.length ? 'digest' : 'deadline', key: 'digest', click: this.appLink(),
        title: `${lines.length} things ${held.length ? 'waiting for you' : 'coming up'}`, body: lines.join('\n'),
        priority: due.some(({ send }) => send.urgent) ? 4 : 3, tags: ['alarm_clock'],
      });
      if (result === 'sent' || result === 'off') this.parts.notifier.release(held);
      return markSent(result, due);
    }
    // A single held push on its own goes out as it was.
    for (const push of held) await this.parts.notifier.send(push);
    let sent = 0;
    for (const entry of due) {
      const { item, send } = entry;
      const result = await this.parts.notifier.send({
        kind: 'deadline', title: `${item.exam ? 'Exam' : 'Due'}: ${item.course ? `${item.course} ` : ''}${item.title}`.slice(0, 120),
        body: await this.say(`a reminder that this ${item.exam ? 'exam' : 'deadline'} is coming up`,
                             reminderFacts(item, now), reminderFallback(item, now)),
        priority: send.urgent ? 4 : 3, tags: [item.exam ? 'pencil2' : 'alarm_clock'], click: this.appLink(),
        key: `deadline|${item.id}|${send.key}`, expires: item.due,
        actions: this.parts.hubURL && !item.exam
          ? [{ label: 'Done', url: `${this.parts.hubURL}/action/done?item=${item.id}&key=${actionKey(item.id)}` }] : [],
      });
      sent += markSent(result, [entry]);
    }
    return sent;
  }

  /**
   * 8:00: writes the day's brief and pushes its opening line. The push only goes out once the brief has
   * actually been written this morning; if it wasn't, the run fails and the scheduler tries once more.
   */
  async morning() {
    // Never before 8 (the scheduler looks again next minute, and nothing has been spent yet).
    if (this.parts.notifier.quietNow()) return 'held';
    await this.parts.today.refresh();
    const brief = await this.parts.today.writeBrief();
    if (!brief) throw new Error("the morning brief wasn't written");
    const week = this.parts.deadlines.upcoming(this.clock(), 7).filter((item) => item.confirmed).length;
    const opening = brief.split('\n').map((line) => line.replace(/[*_#>]/g, '').trim()).find(Boolean);
    const body = [opening ?? 'Your brief for today is ready.', week ? `${week} thing${week === 1 ? '' : 's'} due this week.` : '']
      .filter(Boolean).join(' ');
    return this.parts.notifier.send({ kind: 'brief', key: 'brief', title: 'Good morning', body, tags: ['sunrise'], click: this.appLink() });
  }

  /** 9 PM: "how'd today go?", unless the user has already been talking to Dash this evening. */
  async checkIn() {
    const now = this.clock();
    const evening = new Date(now);
    evening.setHours(18, 0, 0, 0);
    const last = this.parts.chats?.lastMessageAt();
    if (last && last >= evening) return 'skipped';
    if (this.parts.notifier.quietNow()) return 'held';
    // After a restart the calendar tile hasn't loaded yet; load it so the check-in knows what was on today.
    await this.parts.today.fresh();
    const today = this.parts.memory.entries(dayKey(now)).filter((entry) => entry.kind === 'summary' || entry.source === 'lecture')
      .map((entry) => `- ${entry.text}`).slice(-6).join('\n');
    const events = this.parts.today.events.state === 'loaded'
      ? this.parts.today.events.value.filter((event) => new Date(event.start).toDateString() === now.toDateString()).map((event) => `- ${event.title}`).join('\n') : '';
    const body = await this.say(`the evening check-in: ask how ${profile().name}'s day went, mentioning one specific thing from today if there is one`,
                                `Today's calendar:\n${events || '(nothing)'}\n\nToday so far:\n${today || '(nothing logged)'}`,
                                "How'd today go? Tap to tell me.");
    return this.parts.notifier.send({ kind: 'checkin', title: 'Evening check-in', body, tags: ['crescent_moon'],
                                      click: this.appLink(`chat/${randomUUID().toUpperCase()}?fresh=1&checkin=1`) });
  }

  /** Midday: at most one gentle push a day about a follow-up that's due and hasn't been pushed. */
  async followUp() {
    const today = dayKey(this.clock());
    if (this.state.lastThreadPush === today) return 'skipped';
    const thread = this.parts.memory.dueThreads(today).find((candidate) => !this.state.pushedThreads.includes(candidate.line));
    if (!thread) return 'skipped';
    if (this.parts.notifier.quietNow()) return 'held';
    const body = await this.say(`a gentle follow-up on something ${profile().name} mentioned earlier; ask, don't nag`, thread.text, thread.text);
    const result = await this.parts.notifier.send({ kind: 'followup', title: 'Dash', body, tags: ['speech_balloon'],
                                                    click: this.appLink(`chat/${randomUUID().toUpperCase()}?fresh=1`) });
    if (result === 'sent' || result === 'held') {
      this.state.pushedThreads = [...this.state.pushedThreads.slice(-200), thread.line];
      this.state.lastThreadPush = today;
      this.save();
    }
    return result;
  }

  /**
   * 8 AM and 4 PM: Dash looks across calendar, email, deadlines and memory on his own, and acts on what he finds:
   * adds follow-ups and deadlines (unconfirmed, since he inferred them), notes what he saw, and pushes
   * at most one thing if it's worth an interruption. The calendar, inbox and to-do list are handed to him
   * (the brief usually loaded them minutes earlier), so he doesn't fetch them again.
   */
  async sweep() {
    const now = this.clock();
    await this.parts.today.fresh(30 * 60_000);
    let brightspace = '(no to-do file)';
    try {
      brightspace = readFileSync(paths.brightspace, 'utf8').slice(0, 6_000);
    } catch {}
    const input = `It is now ${nowText(now)}.

<calendar_next_7_days>
${this.parts.today.rawText('calendar_get') ?? "(couldn't load)"}
</calendar_next_7_days>

<recent_inbox>
${this.parts.today.rawText('email_read') ?? "(couldn't load)"}
</recent_inbox>

<my_todo_list>
${this.parts.todos?.summary ?? '(not available)'}
</my_todo_list>

<brightspace_todo>
${brightspace}
</brightspace_todo>

<deadline_list>
${this.parts.deadlines.summary(now, 21)}
</deadline_list>

<already_done>
${this.parts.deadlines.recentlyDone(now)}
</already_done>

<dash_memory>
${this.parts.memory.context(dayKey(now))}
</dash_memory>

Have your look around, then reply with the JSON.`;
    const result = parseJSON<{ push?: { title?: string; body?: string } | null; followUps?: { after: string; text: string }[];
                               deadlines?: { date: string; time?: string | null; course?: string | null; title: string; exam?: boolean }[];
                               note?: string }>(await this.helpers.sweep(input));
    if (!result || typeof result !== 'object') throw new Error("the sweep's answer wasn't JSON");
    // What was already on the lists before this run, to keep the push from repeating it.
    const listed = this.listed(now);
    let threads = 0;
    for (const item of result.followUps ?? []) if (this.parts.memory.addThread(String(item.after), String(item.text ?? ''))) threads += 1;
    let added = 0;
    const fresh: Deadline[] = [];
    for (const item of result.deadlines ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? '') || !item.title) continue;
      const due = new Date(`${item.date}T${/^\d{1,2}:\d{2}$/.test(item.time ?? '') ? item.time!.padStart(5, '0') : '23:59'}:00`);
      if (due <= now) continue;
      const before = this.parts.deadlines.items.length;
      const deadline = this.parts.deadlines.add({ due, course: item.course ?? undefined, title: item.title, exam: !!item.exam, source: 'Dash', confirmed: false });
      if (deadline && this.parts.deadlines.items.length > before) {
        added += 1;
        fresh.push(deadline);
      }
    }
    const summary = [result.note?.trim(), threads ? `Added ${threads} follow-up${threads === 1 ? '' : 's'}.` : '',
                     added ? `Spotted ${added} deadline${added === 1 ? '' : 's'} to confirm.` : ''].filter(Boolean).join(' ');
    if (summary) this.parts.memory.log({ source: 'note', kind: 'sweep', text: summary });
    let pushed: string = 'none';
    if (result.push?.title && result.push.body) {
      // The prompt says not to push what's already on the list or done, and he sometimes does anyway. A push
      // about something he just added is fine (that's news); one about an item already there isn't.
      const text = words(`${result.push.title} ${result.push.body}`);
      const repeat = listed.find((item) => mentions(text, item));
      if (repeat && !fresh.some((item) => mentions(text, item))) {
        log(`sweep push dropped, already on the list: ${result.push.title} (${repeat.title})`);
        pushed = 'repeat';
      } else {
        pushed = await this.parts.notifier.send({ kind: 'sweep', key: 'sweep', title: result.push.title.slice(0, 120), body: result.push.body.slice(0, 400),
                                                  tags: ['eyes'], click: this.appLink() });
      }
    }
    if (pushed === 'none' && added) {
      pushed = await this.parts.notifier.send({ kind: 'sweep', key: 'sweep', title: 'Dash', tags: ['calendar'], click: this.appLink(),
                                                body: `I spotted ${added} date${added === 1 ? '' : 's'} that ${added === 1 ? "isn't" : "aren't"} on your list yet. Have a look and confirm in Dash.` });
    }
    return { threads, added, pushed };
  }

  /** What's already on the user's lists: open deadlines, ones checked off in the last week, and their to-dos. */
  private listed(now: Date): { title: string; course?: string }[] {
    const weekAgo = now.getTime() - 7 * DAY;
    return [...this.parts.deadlines.upcoming(now, 21),
            ...this.parts.deadlines.items.filter((item) => item.done && Date.parse(item.due) >= weekAgo),
            ...(this.parts.todos?.items ?? []).map((title) => ({ title }))];
  }

  /** A notification button was pressed: checks a deadline off, if the link is genuine. */
  completeFromAction(item: string, key: string) {
    if (!/^[0-9a-f]{12}$/.test(item) || !sameKey(key, actionKey(item))) return false;
    const found = this.parts.deadlines.find(item);
    if (!found) return false;
    this.parts.deadlines.done(item);
    this.parts.memory.log({ source: 'notify', kind: 'done', text: `Checked off from a notification: ${found.course ? `${found.course} ` : ''}${found.title}` });
    return true;
  }

  private async say(purpose: string, facts: string, fallback: string) {
    try {
      const text = (await this.helpers.voice(purpose, facts)).trim().replace(/^["“]|["”]$/g, '');
      return text && text.length <= 240 ? text : fallback;
    } catch (error) {
      log(`push wording failed: ${(error as Error).message}`);
      return fallback;
    }
  }

  private appLink(path = '') {
    const app = this.parts.appURL();
    return app ? `${app}/--/${path}` : undefined;
  }

  private save() {
    try {
      writeFileSync(`${paths.secretaryState}.tmp`, JSON.stringify(this.state));
      renameSync(`${paths.secretaryState}.tmp`, paths.secretaryState);
    } catch (error) {
      log(`secretary state save failed: ${(error as Error).message}`);
    }
  }
}

function reminderFacts(item: Deadline, now: Date) {
  return `${item.exam ? 'Exam' : 'Due'}: ${item.course ? `${item.course} ` : ''}${item.title}\nWhen: ${whenText(item.due, now)}\nIt is now ${nowText(now)}.`;
}

function reminderFallback(item: Deadline, now: Date) {
  return `${item.course ? `${item.course} ` : ''}${item.title} ${item.exam ? 'is' : 'is due'} ${whenText(item.due, now)}.`;
}

/** "title|start", the calendar's note of what an event looked like when it was sorted. */
const stampOf = (event: CalendarEvent) => `${event.title}|${event.start}`;
const startOf = (stamp: string) => stamp.slice(stamp.lastIndexOf('|') + 1);

/** When a calendar deadline is due: its start, or the end of its last day if it's all-day (a multi-day one included). */
function dueOf(event: CalendarEvent, dueTime?: string | null) {
  const due = new Date(event.start);
  if (event.allDay) {
    // An all-day event's end is the day after its last day.
    const last = event.end ? new Date(event.end) : undefined;
    last?.setDate(last.getDate() - 1);
    if (last && last > due) due.setTime(last.getTime());
    due.setHours(23, 59, 0, 0);
  }
  const time = dueTime?.match(/^(\d{1,2}):(\d{2})$/);
  if (time) due.setHours(Number(time[1]), Number(time[2]), 0, 0);
  return due;
}

/** Compares a notification button's key without leaking, through timing, how much of it was right. */
function sameKey(given: string, expected: string) {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const STOP_WORDS = new Set(('a an and are at be by do due for from has have in is isn it its just list me my no not of on or so still that the '
                            + 'this to up was wasn were weren with yet you your').split(' '));

/** The meaningful words of a text, with course codes split ("HIST2100A" → hist, 2100). */
function words(text: string) {
  return new Set(text.toLowerCase().replace(/([a-z])(?=\d)|(\d)(?=[a-z])/g, '$1$2 ').split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
}

/** Whether a push is about this item: most of its title's words are in it (the course too, for a one-word title like "Exam"). */
function mentions(text: Set<string>, item: { title: string; course?: string }) {
  let own = words(item.title);
  if (own.size < 2 && item.course) own = new Set([...own, ...words(item.course)]);
  if (!own.size) return false;
  const shared = [...own].filter((word) => text.has(word)).length;
  return shared >= Math.min(2, own.size) && shared / own.size >= 0.6;
}

/** The first JSON value in a reply, which may come wrapped in a code fence. */
function parseJSON<T>(reply: string): T | undefined {
  const start = reply.search(/[[{]/);
  if (start < 0) return undefined;
  const end = Math.max(reply.lastIndexOf(']'), reply.lastIndexOf('}'));
  try {
    return JSON.parse(reply.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

// The real helpers, on Claude.

const classify: Helpers['classify'] = (events) => ClaudeSession.ask(events, prompt('calendar'), models.haiku);

const voice: Helpers['voice'] = (purpose, facts) =>
  ClaudeSession.ask(`What it's for: ${purpose}\n\nFacts:\n${facts}`, `${prompt('push')}\n\n<dash_voice>\n${persona()}\n</dash_voice>`, models.haiku);

/** jarvis tools the sweep may use without asking, for a closer look; the calendar and inbox come in its prompt. */
const sweepReads = ['calendar_get', 'email_read', 'weather_get', 'docs_read_section'].map((tool) => `mcp__jarvis__${tool}`);
/**
 * Refused outright: everything in jarvis that writes, sends, browses, records or searches the web, and
 * jarvis's file_read, which has no folder limit. The sweep reads untrusted email, so nothing it can call
 * may carry what it reads out of the hub.
 */
const sweepRefused = ['email_send', 'email_delete', 'calendar_create', 'calendar_delete', 'docs_append_notes', 'docs_replace_section',
                      'file_read', 'file_write', 'web_search', 'browser_navigate', 'browser_interact', 'browser_screenshot',
                      'lecture_start', 'lecture_stop', 'lecture_status', 'lecture_get_new_transcript', 'lecture_bootstrap_course']
  .map((tool) => `mcp__jarvis__${tool}`);

/**
 * The sweep's tools. It works in its memory folder (Read, Glob and Grep need no asking there) and may
 * also read deadlines.md. Nothing else: not the rest of DATA, which holds secrets/ and every chat
 * (off-the-record ones too), and not Documents.
 */
export const sweepProfile: Profile & { cwd: string } = {
  tools: ['Read', 'Glob', 'Grep'],
  allowedTools: [...sweepReads, `Read(/${paths.deadlines})`],
  disallowedTools: [...sweepRefused, `Read(/${join(DATA, 'secrets')}/**)`, `Read(/${paths.chats}/**)`],
  mcpConfig: jarvisMcpConfig,
  cwd: MEMORY_DIR,
};

async function sweep(input: string) {
  const { cwd, ...profile } = sweepProfile;
  const session = new ClaudeSession({ model: models.sonnet, effort: 'medium', system: `${persona()}\n\n${prompt('sweep')}`, profile, cwd });
  try {
    // Read-only: anything that would change something, or read outside its folder, is refused rather than left waiting.
    const result = await session.send([{ type: 'text', text: input }], (event) => {
      if (event.type === 'permission') session.respond(event.request, false);
    });
    return result.text;
  } finally {
    session.close();
  }
}

async function readSyllabus(file: string) {
  const session = new ClaudeSession({
    model: models.sonnet, effort: 'medium', system: prompt('syllabus'),
    profile: { tools: ['Read'], allowedTools: ['Read'], addDirs: [paths.syllabi] },
  });
  try {
    const result = await session.send([{ type: 'text', text: `Today is ${nowText()}. The syllabus: ${file}` }], () => {});
    return result.text;
  } finally {
    session.close();
  }
}
