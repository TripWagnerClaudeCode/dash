import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Chats } from './chats.ts';
import { ClaudeSession, models } from './claude.ts';
import { log } from './log.ts';
import { addDays, coreHeading, dayKey, type LogEntry, type Memory, type Source } from './memory.ts';
import { DATA, paths } from './paths.ts';
import { aboutMe, prompt, TIME_ZONE } from './personal.ts';

/** Asks Claude to write the night's memory update (Sonnet in the hub; a stand-in in tests). */
export type Writer = (input: string, system: string) => Promise<string>;
const sonnet: Writer = (input, system) => ClaudeSession.ask(input, system, models.sonnet, 'medium');
/** A quiet day only gets a short journal entry, which Haiku writes. */
const haiku: Writer = (input, system) => ClaudeSession.ask(input, system, models.haiku);

/**
 * How the last write-up went, for the health check: the day it wrote up (null when none was due) and any
 * trouble. `ok` is false only for a real error (Sonnet failed, the reply was cut off, a save failed), which
 * is retried the next night. `skipped` lists files a usable reply left as they were, for information only.
 */
export type ConsolidationStatus = { at: string; day: string | null; ok: boolean; error?: string; skipped?: string[] };

const MAX_LOG = 60_000;
const stateFile = join(DATA, 'consolidation.json');
/** Days with one of these get a full rewrite of core and self. Lens questions, pushes and sweep notes alone only get a journal entry. */
const CONVERSATIONS = new Set<Source>(['chat', 'checkin', 'lecture', 'advisor']);
/** When a day's log is too long, these go first, in this order, oldest first; conversations go last. */
const DROP_FIRST: Source[] = ['lens', 'notify', 'note', 'brief'];
/**
 * A rewritten file shorter than this share of what it had to carry over is blank or cut short, unless the
 * current one is small. Low on purpose: the prompt asks for real pruning (old checked follow-ups, core lines
 * that repeat remember.md or ABOUT_ME, finished worries), and those lines don't count as ones to carry over.
 */
const MIN_KEPT = 0.25;
const SMALL_FILE = 1_500;
/** The files the night rewrites, with the heading each must keep. */
const FILES = {
  core: { path: () => paths.core, read: (memory: Memory) => memory.core(), get heading() { return coreHeading(); }, max: 16_000 },
  threads: { path: () => paths.threads, read: (memory: Memory) => memory.threadsText(), heading: '# Follow-ups', max: 16_000 },
  self: { path: () => paths.self, read: (memory: Memory) => memory.self(), heading: '# Dash, in his own words', max: 12_000 },
};
type FileName = keyof typeof FILES;

/**
 * The nightly write-up: summarizes any chats still waiting, then turns each finished day's log into a
 * journal entry and an updated core memory and follow-up list. Days the hub missed (it was off at
 * night) are caught up, oldest first, so core.md evolves in order. A day that hits a real error (Sonnet
 * failed, or its reply was cut off) stops the catch-up and is tried again the next night; a day whose core
 * was only turned down by the checks below still gets its journal, and the catch-up goes on.
 */
export async function consolidatePending(memory: Memory, chats: Chats | undefined, write: Writer = sonnet, lookBack = 7,
                                         writeQuiet: Writer = write === sonnet ? haiku : write) {
  if (chats) await chats.summarizePending();
  const today = dayKey();
  const journaled = new Set(memory.journalDays());
  const days = memory.loggedDays().filter((day) => day < today && day >= addDays(today, -lookBack) && !journaled.has(day)).reverse();
  const results: Record<string, string> = {};
  for (const day of days) {
    results[day] = await consolidate(memory, day, write, writeQuiet);
    if (results[day] === 'failed') break;
  }
  if (!days.length) record({ day: null, ok: true });
  return results;
}

/** The last write-up's outcome, or undefined if there hasn't been one. */
export function lastConsolidation(): ConsolidationStatus | undefined {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as ConsolidationStatus;
  } catch {
    return undefined;
  }
}

/**
 * Writes one day's journal and updates core.md, threads.md and self.md. Each rewritten file is checked
 * before it replaces the current one (one that fails the check is left as it was, and noted), a file edited
 * while Sonnet was writing keeps the edit, and the journal entry, which marks the day done, is written
 * last. A reply with no journal or no core was cut off or refused: nothing changes and the day fails.
 * Tests pass a stand-in `write`, which then also writes quiet days.
 */
export async function consolidate(memory: Memory, day: string, write: Writer = sonnet,
                                  writeQuiet: Writer = write === sonnet ? haiku : write): Promise<'written' | 'empty' | 'failed'> {
  const entries = memory.entries(day);
  if (!entries.length) return 'empty';
  const weekday = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  if (!entries.some((entry) => CONVERSATIONS.has(entry.source))) return quietDay(memory, day, weekday, entries, writeQuiet);
  // What the files said when Sonnet started, to spot edits made while it writes (a few minutes).
  const before = { core: memory.core(), threads: memory.threadsText(), self: memory.self() };
  const previous = memory.journalDays().find((candidate) => candidate < day);
  const input = `<day>${weekday} (${day})</day>

<log>
${logText(entries)}
</log>

<current_core>
${before.core.trim()}
</current_core>

<current_threads>
${before.threads.trim()}
</current_threads>

<current_self>
${before.self.trim()}
</current_self>
${previous ? `\n<previous_journal day="${previous}">\n${memory.journal(previous).trim()}\n</previous_journal>\n` : ''}
<remember>
${memory.remember().trim()}
</remember>

<about_me>
${aboutMe().trim()}
</about_me>

Write the four sections for ${day}.`;
  let reply: string;
  try {
    reply = await write(input, prompt('consolidate'));
  } catch (error) {
    return fail(day, `the write-up failed: ${(error as Error).message}`);
  }
  const journal = section(reply, 'journal');
  const rewritten = { core: section(reply, 'core'), threads: section(reply, 'threads'), self: section(reply, 'self') };
  // A section without its closing tag reads as missing, so a reply cut off before the end of core lands here.
  if (!journal || !rewritten.core) {
    return fail(day, `the reply wasn't usable (${journal ? 'core was empty or cut off' : 'no journal'}), nothing changed`);
  }
  // Lines Dash sees in every chat anyway, which the prompt asks Sonnet to take out of core.
  const known = new Set([...memory.remember().split('\n'), ...aboutMe().split('\n')].map(normalize).filter((line) => line.length > 3));

  const skipped: string[] = [];
  try {
    for (const name of ['core', 'threads', 'self'] as const) {
      const file = FILES[name];
      let text = rewritten[name];
      const bad = problem(name, text, before[name], known);
      if (bad || !text) {
        // Dash's self-notes are optional in a reply; a missing one leaves them as they were. Any other file
        // that fails the check is left as it was too, and the rest of the night's work still goes in.
        if (name !== 'self' || text) skipped.push(`${name}: ${bad}`);
        continue;
      }
      const now = file.read(memory);
      if (now !== before[name]) {
        // Changed while Sonnet was writing (a chat, the sweep, or the user). Follow-ups are merged line by
        // line; core and self keep the edit, and tonight's rewrite of them is dropped.
        if (name !== 'threads') {
          skipped.push(`${name}: edited during the write-up, kept the edit`);
          continue;
        }
        text = mergeLines(before.threads, now, text);
      }
      memory.write(file.path(), text);
    }
    // Last: the journal entry marks the day done, so a crash before this point writes the day up again.
    memory.writeJournal(day, journal);
  } catch (error) {
    return fail(day, `saving the write-up failed: ${(error as Error).message}`);
  }
  for (const note of skipped) log(`consolidate ${day}: left ${note}`);
  log(`consolidate ${day}: journal written from ${entries.length} entries`);
  record({ day, ok: true, ...(skipped.length ? { skipped } : {}) });
  return 'written';
}

/** A day with no conversations: a short journal entry only, so core and self aren't rewritten for nothing. */
async function quietDay(memory: Memory, day: string, weekday: string, entries: LogEntry[], write: Writer): Promise<'written' | 'failed'> {
  let journal: string | undefined;
  try {
    journal = section(await write(`<day>${weekday} (${day})</day>\n\n<log>\n${logText(entries)}\n</log>\n\nWrite the journal entry for ${day}.`,
                                  prompt('consolidateQuiet')), 'journal');
  } catch (error) {
    return fail(day, `the quiet-day write-up failed: ${(error as Error).message}`);
  }
  if (!journal) return fail(day, "the quiet-day reply wasn't usable, nothing changed");
  try {
    memory.writeJournal(day, journal);
  } catch (error) {
    return fail(day, `saving the journal failed: ${(error as Error).message}`);
  }
  log(`consolidate ${day}: quiet day, journal only, from ${entries.length} entries`);
  record({ day, ok: true });
  return 'written';
}

/**
 * Why a rewritten file shouldn't replace the current one, or undefined if it can. It only catches a blank,
 * mangled or cut-short rewrite: a missing heading, lost "## " sections, too long, or a big file shrunk to
 * under a quarter of what it had to carry over (checked follow-ups and core lines repeating `known` may go).
 */
function problem(name: FileName, text: string | undefined, current: string, known: Set<string>) {
  const file = FILES[name];
  if (!text) return 'was empty';
  const heading = current.match(/^# .+/)?.[0].trim() ?? file.heading;
  if (text.split('\n')[0].trim() !== heading) return `didn't start with "${heading}"`;
  if (text.length > file.max) return `was too long (${text.length} characters)`;
  const sections = (body: string) => body.match(/^## /gm)?.length ?? 0;
  if (sections(current) >= 2 && !sections(text)) return 'lost its "## " sections';
  const length = current.trim().length;
  const carried = current.split('\n').filter((line) => !(name === 'threads' && /^\s*- \[x\]/i.test(line))
                                                     && !(name === 'core' && known.has(normalize(line)))).join('\n').trim().length;
  if (length >= SMALL_FILE && text.length < carried * MIN_KEPT) return `shrank from ${length} to ${text.length} characters`;
  return undefined;
}

/** A line as compared with remember.md and ABOUT_ME: no bullet, case or extra spaces. */
function normalize(line: string) {
  return line.trim().replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}

/** The reply's follow-ups, plus lines added on disk while it was written, minus lines removed or changed there. */
function mergeLines(before: string, now: string, reply: string) {
  const old = new Set(before.split('\n').map((line) => line.trim()));
  const current = new Set(now.split('\n').map((line) => line.trim()));
  const lines = reply.split('\n').filter((line) => !(old.has(line.trim()) && !current.has(line.trim())));
  const kept = new Set(lines.map((line) => line.trim()));
  const added = now.split('\n').filter((line) => line.trim() && !old.has(line.trim()) && !kept.has(line.trim()));
  return [...lines, ...added].join('\n');
}

function fail(day: string, error: string) {
  log(`consolidate ${day}: ${error}`);
  record({ day, ok: false, error });
  return 'failed' as const;
}

function record(status: Omit<ConsolidationStatus, 'at'>) {
  try {
    const temp = `${stateFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ at: new Date().toISOString(), ...status })}\n`, { mode: 0o600 });
    renameSync(temp, stateFile);
  } catch (error) {
    log(`consolidate: couldn't save its status: ${(error as Error).message}`);
  }
}

function logText(entries: LogEntry[]) {
  const lines = entries.map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
    const title = entry.title ? ` "${entry.title}"` : '';
    const text = entry.text.length > 800 ? `${entry.text.slice(0, 800)}…` : entry.text;
    return { source: entry.source, text: `${time} · ${entry.source} ${entry.kind}${title}: ${text}` };
  });
  let length = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  // A day of heavy lens use can be long. Lens questions go first, then pushes and notes, each oldest
  // first; conversation summaries only if it's still too long.
  for (const source of [...DROP_FIRST, undefined]) {
    while (length > MAX_LOG && lines.length > 1) {
      const index = lines.findIndex((line) => source === undefined || line.source === source);
      if (index < 0) break;
      length -= lines[index].text.length + 1;
      lines.splice(index, 1);
    }
  }
  return lines.map((line) => line.text).join('\n');
}

function section(reply: string, tag: string) {
  const match = reply.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  return match?.[1].trim();
}
