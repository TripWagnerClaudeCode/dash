import { createHash } from 'node:crypto';
import { type FSWatcher, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { log } from './log.ts';
import { paths } from './paths.ts';

/**
 * One line of deadlines.md:
 *   - [ ] 2026-10-30 23:59 · HIST2100A · Essay 2 draft · exam · from syllabus · unconfirmed
 * Date first, then an optional time (11:59 PM if none), course code if there is one, the title, and
 * flags: "exam" (tests get earlier reminders), "from <source>", "unconfirmed" (no reminders until the user
 * confirms it). Checked off with [x]. The first part after the course is always the title, so a title of
 * just "Exam" or one starting "From …" isn't mistaken for a flag.
 */
export type Deadline = {
  id: string;
  due: string;
  course?: string;
  title: string;
  exam: boolean;
  confirmed: boolean;
  source?: string;
  done: boolean;
  line: string;
};
export type NewDeadline = { due: Date; course?: string; title: string; exam?: boolean; confirmed?: boolean; source?: string };
type State = {
  sent: Record<string, string[]>;
  dismissed: string[];
  /** Every item's id → "due|course" as last seen, so a title edited by hand is recognized as the same item. */
  known?: Record<string, string>;
  /** Old id → new id after a title edit, so reminders, Done links and calendar links follow the item. */
  renamed: Record<string, string>;
};

const HEADER = '# Deadlines\n\n<!-- "- [ ] YYYY-MM-DD HH:MM · COURSE · what · exam · from <source> · unconfirmed". Kept by Dash; check off with [x]. -->\n';
const LINE = /^- \[( |x|X)\] (\d{4}-\d{2}-\d{2})(?: (\d{1,2}:\d{2}))?\s*·\s*(.+)$/;
const COURSE = /^[A-Z]{2,4} ?\d{3,4}[A-Z]?$/;

/** The user's deadlines and exams: a markdown file anyone can edit (the apps, chats, the user), plus reminder state. */
export class Deadlines {
  items: Deadline[] = [];
  /** Lines that look like deadlines but couldn't be read, for the health banner. */
  unreadable: string[] = [];
  private lastText?: string;
  private state: State = { sent: {}, dismissed: [], renamed: {} };
  private listeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private readonly file: string;
  private readonly stateFile: string;

  constructor(file = paths.deadlines, stateFile = paths.deadlinesState) {
    this.file = file;
    this.stateFile = stateFile;
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
    } catch {}
    this.reload();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  watch() {
    const name = basename(this.file);
    this.watcher = watch(dirname(this.file), (_event, changed) => {
      if (!changed || changed === name) this.reload();
    });
  }

  stop() {
    this.watcher?.close();
  }

  reload() {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {}
    if (text === this.lastText) return;
    this.lastText = text;
    ({ items: this.items, unreadable: this.unreadable } = parse(text));
    this.track();
    this.listeners.forEach((listener) => listener());
  }

  /** Open items from now on (plus anything overdue in the last day), soonest first. */
  upcoming(now = new Date(), days = 60) {
    const from = now.getTime() - 86_400_000;
    const until = now.getTime() + days * 86_400_000;
    return this.items.filter((item) => !item.done && Date.parse(item.due) >= from && Date.parse(item.due) <= until)
      .sort((a, b) => a.due.localeCompare(b.due));
  }

  snapshot(now = new Date()) {
    return { items: this.upcoming(now), unconfirmed: this.items.filter((item) => !item.done && !item.confirmed).length };
  }

  /** Adds a deadline unless it's already there (same day, same course, similar title) or was dismissed. */
  add(entry: NewDeadline): Deadline | undefined {
    if (Number.isNaN(entry.due.getTime()) || !entry.title.trim()) return undefined;
    const candidate = toDeadline(entry);
    if (this.state.dismissed.includes(candidate.id)) return undefined;
    this.reload();
    const existing = this.items.find((item) => sameDeadline(item, candidate));
    if (existing) return existing;
    this.change((lines) => {
      let end = lines.length;
      while (end > 0 && !lines[end - 1].trim()) end -= 1;
      return [...lines.slice(0, end), candidate.line, ...lines.slice(end)];
    });
    return candidate;
  }

  /** Moves or renames an item in place (the calendar event behind it changed), keeping its other flags. */
  update(id: string, change: { due: Date; title: string; exam?: boolean }): Deadline | undefined {
    if (Number.isNaN(change.due.getTime()) || !change.title.trim()) return undefined;
    let updated: Deadline | undefined;
    this.edit(id, (item) => {
      updated = toDeadline({ due: change.due, course: item.course, title: change.title, exam: change.exam ?? item.exam,
                             confirmed: item.confirmed, source: item.source });
      updated.line = format({ ...updated, done: item.done });
      return updated.line;
    });
    return updated && this.items.find((item) => item.id === updated!.id);
  }

  /** Takes it off the list without remembering it (unlike dismiss, it can come back). */
  remove(id: string) {
    this.edit(id, () => undefined);
  }

  confirm(id: string) {
    this.edit(id, (item) => format({ ...item, confirmed: true }));
  }

  done(id: string) {
    this.edit(id, (item) => format({ ...item, done: true }));
  }

  /** Removes it and remembers not to add it back (the calendar would otherwise bring it back). */
  dismiss(id: string) {
    this.edit(id, () => undefined);
    if (!this.state.dismissed.includes(id)) this.state.dismissed = [...this.state.dismissed.slice(-500), id];
    this.saveState();
  }

  /** Finds an item by id, following it through title edits. */
  find(id: string) {
    this.reload();
    const current = this.resolve(id);
    return this.items.find((item) => item.id === current);
  }

  sentReminders(id: string) {
    return this.state.sent[id] ?? [];
  }

  /**
   * Forgets reminder state for items that are gone from the list or more than 30 days past. Run now and
   * then (with the calendar scan), not on every reload, so a file caught half-saved can't wipe it.
   */
  prune(now = new Date()) {
    this.reload();
    const cutoff = now.getTime() - 30 * 86_400_000;
    const live = new Set(this.items.filter((item) => Date.parse(item.due) >= cutoff).map((item) => item.id));
    const sent = Object.fromEntries(Object.entries(this.state.sent).filter(([id]) => live.has(id)));
    const renamed = Object.fromEntries(Object.entries(this.state.renamed).filter(([, to]) => live.has(this.resolve(to))));
    if (Object.keys(sent).length === Object.keys(this.state.sent).length
        && Object.keys(renamed).length === Object.keys(this.state.renamed).length) return;
    this.state = { ...this.state, sent, renamed };
    this.saveState();
  }

  private resolve(id: string) {
    let current = id;
    for (let step = 0; step < 20 && this.state.renamed[current]; step += 1) current = this.state.renamed[current];
    return current;
  }

  /**
   * Notices titles edited by hand: an id that's new, where one that's gone had the same due time and
   * course, is the same item renamed. Its sent reminders carry over, so fixing a typo doesn't send the
   * latest reminder again. A move to another time is a new item (its reminders start over).
   */
  private track() {
    if (!this.items.length) return;
    const keyFor = (item: Deadline) => `${item.due}|${item.course ?? ''}`;
    const current = Object.fromEntries(this.items.map((item) => [item.id, keyFor(item)]));
    // The first run with this state: everything on the list now is the baseline.
    if (!this.state.known) {
      this.state.known = current;
      this.saveState();
      return;
    }
    const gone = Object.entries(this.state.known).filter(([id]) => !(id in current));
    let changed = Object.keys(current).length !== Object.keys(this.state.known).length || gone.length > 0;
    for (const item of this.items) {
      if (item.id in this.state.known) continue;
      const key = keyFor(item);
      const matches = gone.filter(([, known]) => known === key);
      const rivals = this.items.filter((other) => !(other.id in this.state.known!) && keyFor(other) === key);
      if (matches.length !== 1 || rivals.length !== 1) continue;
      const [oldID] = matches[0];
      this.state.renamed[oldID] = item.id;
      delete this.state.renamed[item.id];
      if (this.state.sent[oldID]) this.state.sent[item.id] = [...new Set([...(this.state.sent[item.id] ?? []), ...this.state.sent[oldID]])];
      changed = true;
    }
    this.state.known = current;
    if (changed) this.saveState();
  }

  markSent(id: string, keys: string[]) {
    this.state.sent[id] = [...new Set([...(this.state.sent[id] ?? []), ...keys])];
    this.saveState();
  }

  /** Items checked off that were due in the last week or are still ahead, so nobody raises them again. */
  recentlyDone(now = new Date()) {
    const items = this.items.filter((item) => item.done && Date.parse(item.due) >= now.getTime() - 7 * 86_400_000)
      .sort((a, b) => a.due.localeCompare(b.due));
    return items.length ? items.map((item) => `- ${describeDue(item.due)} · ${item.course ? `${item.course} · ` : ''}${item.title} (done)`).join('\n') : '(none)';
  }

  /** The list for prompts: "- Fri Oct 30, 11:59 PM · HIST2100A · Essay 2 draft (exam)". */
  summary(now = new Date(), days = 14) {
    const items = this.upcoming(now, days);
    return items.length ? items.map((item) => `- ${describeDue(item.due)} · ${item.course ? `${item.course} · ` : ''}${item.title}${item.exam ? ' (exam)' : ''}${item.confirmed ? '' : ' (unconfirmed)'}`).join('\n')
      : '(nothing due in the next two weeks)';
  }

  private edit(id: string, change: (item: Deadline) => string | undefined) {
    this.reload();
    const current = this.resolve(id);
    const item = this.items.find((candidate) => candidate.id === current);
    if (!item) throw new Error("That deadline isn't on the list anymore.");
    this.change((lines) => lines.flatMap((line) => {
      if (line.trim() !== item.line) return [line];
      const replaced = change(item);
      return replaced === undefined ? [] : [replaced];
    }));
  }

  private change(edit: (lines: string[]) => string[]) {
    const current = this.lastText?.trim() ? this.lastText : HEADER;
    const text = `${edit(current.replace(/\n$/, '').split('\n')).join('\n')}\n`;
    try {
      writeFileSync(`${this.file}.tmp`, text);
      renameSync(`${this.file}.tmp`, this.file);
    } catch (error) {
      log(`deadlines save failed: ${(error as Error).message}`);
      return;
    }
    this.lastText = text;
    ({ items: this.items, unreadable: this.unreadable } = parse(text));
    this.track();
    this.listeners.forEach((listener) => listener());
  }

  private saveState() {
    try {
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (error) {
      log(`deadlines state save failed: ${(error as Error).message}`);
    }
  }
}

export function parse(text: string) {
  const items: Deadline[] = [];
  const unreadable: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^- \[[ xX]\] /.test(line)) continue;
    const match = line.match(LINE);
    const due = match && localDate(match[2], match[3] ?? '23:59');
    if (!match || !due) {
      unreadable.push(line);
      continue;
    }
    const parts = match[4].split('·').map((part) => part.trim()).filter(Boolean);
    let course: string | undefined;
    if (parts.length > 1 && COURSE.test(parts[0])) course = parts.shift()!.replace(' ', '');
    let exam = false;
    let confirmed = true;
    let source: string | undefined;
    // The title comes first; only what follows it can be a flag.
    const words = parts.slice(0, 1);
    for (const part of parts.slice(1)) {
      const lower = part.toLowerCase();
      if (lower === 'exam') exam = true;
      else if (lower === 'unconfirmed') confirmed = false;
      else if (lower.startsWith('from ')) source = part.slice(5).trim();
      else words.push(part);
    }
    const title = words.join(' · ');
    if (!title) {
      unreadable.push(line);
      continue;
    }
    items.push({ id: idFor(match[2], course, title), due: due.toISOString(), course, title, exam, confirmed, source, done: match[1] !== ' ', line });
  }
  return { items, unreadable };
}

function toDeadline(entry: NewDeadline): Deadline {
  const course = entry.course && COURSE.test(entry.course.trim()) ? entry.course.trim().replace(' ', '') : undefined;
  const title = entry.title.replace(/\s*[·\n]\s*/g, ' ').trim();
  const item: Deadline = { id: idFor(dateText(entry.due), course, title), due: entry.due.toISOString(), course, title, exam: !!entry.exam,
                           confirmed: entry.confirmed ?? true, source: entry.source, done: false, line: '' };
  item.line = format(item);
  return item;
}

function format(item: Deadline) {
  const due = new Date(item.due);
  const parts = [`${dateText(due)} ${timeText(due)}`, ...(item.course ? [item.course] : []), item.title,
                 ...(item.exam ? ['exam'] : []), ...(item.source ? [`from ${item.source}`] : []), ...(item.confirmed ? [] : ['unconfirmed'])];
  return `- [${item.done ? 'x' : ' '}] ${parts.join(' · ')}`;
}

/** Stable across edits to flags and time, so reminder state survives "confirm" and small fixes. */
function idFor(day: string, course: string | undefined, title: string) {
  return createHash('sha256').update(`${day}|${course ?? ''}|${normalize(title)}`).digest('hex').slice(0, 12);
}

function normalize(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Same day and course, and the titles mostly share words ("Essay 2 draft" vs "Essay 2 draft due"). */
function sameDeadline(a: Deadline, b: Deadline) {
  if (a.id === b.id) return true;
  if (dateText(new Date(a.due)) !== dateText(new Date(b.due)) || (a.course ?? '') !== (b.course ?? '')) return false;
  const words = (title: string) => new Set(normalize(title).split(' ').filter((word) => word.length > 1 && word !== 'due'));
  const left = words(a.title);
  const right = words(b.title);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, Math.min(left.size, right.size)) >= 0.6;
}

function localDate(day: string, time: string) {
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime()) || hour > 23 || minute > 59) return undefined;
  date.setHours(hour, minute, 0, 0);
  return date;
}

const pad = (value: number) => String(value).padStart(2, '0');
const dateText = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const timeText = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** "Fri Oct 30, 11:59 PM". */
export function describeDue(due: string) {
  return new Date(due).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Reminders

/** `at` is when it came due, so a reminder that waited out quiet hours can be told apart. */
export type Reminder = { key: string; urgent: boolean; at: Date };

/**
 * Which reminder is due for a deadline right now, if any: assignments 3 days and 1 day before (at 9 AM)
 * and 3 hours before; exams also a week and 2 days before. If several have come due unsent (it was
 * added late, or the hub was off), only the latest one goes out; the earlier ones count as sent.
 */
export function dueReminder(item: Deadline, now: Date, sent: string[]): { send?: Reminder; skip: string[] } {
  const due = new Date(item.due);
  if (item.done || !item.confirmed || due <= now) return { skip: [] };
  const atNine = (daysBefore: number) => {
    const slot = new Date(due);
    slot.setDate(slot.getDate() - daysBefore);
    slot.setHours(9, 0, 0, 0);
    return slot;
  };
  const slots: (Reminder & { at: Date })[] = [
    ...(item.exam ? [{ key: '7d', at: atNine(7), urgent: false }, { key: '2d', at: atNine(2), urgent: false }] : []),
    { key: '3d', at: atNine(3), urgent: false },
    { key: '1d', at: atNine(1), urgent: false },
    { key: '3h', at: new Date(due.getTime() - 3 * 3_600_000), urgent: true },
  ].filter((slot) => slot.at <= now && !sent.includes(slot.key)).sort((a, b) => a.at.getTime() - b.at.getTime());
  const latest = slots.at(-1);
  return latest ? { send: { key: latest.key, urgent: latest.urgent, at: latest.at }, skip: slots.slice(0, -1).map((slot) => slot.key) } : { skip: [] };
}

/** "in 3 hours", "tomorrow at 11:59 PM", "Thursday at 9:00 AM". */
export function whenText(due: string, now: Date) {
  const date = new Date(due);
  const hours = (date.getTime() - now.getTime()) / 3_600_000;
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (hours <= 6) return `in ${Math.max(1, Math.round(hours))} hour${Math.round(hours) === 1 ? '' : 's'} (${time})`;
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${date.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`;
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}
