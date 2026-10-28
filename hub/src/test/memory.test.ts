/**
 * Memory and the nightly write-up: the Mac's memory queue (big batches, resent batches), what a bad or
 * badly timed consolidation reply may and may not change, memory days around DST, "Forget that" reaching
 * the log and journal, and this week's lines not repeating the journal. Sonnet is always a stand-in.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'dash-memory-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';

const { paths, MEMORY_DIR } = await import('../paths.ts');
const { Memory, dayKey, addDays } = await import('../memory.ts');
const { consolidate, consolidatePending, lastConsolidation } = await import('../consolidate.ts');
const { HubServer } = await import('../server.ts');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

/** A fresh, empty memory folder. */
function fresh() {
  rmSync(MEMORY_DIR, { recursive: true, force: true });
  mkdirSync(join(MEMORY_DIR, 'log'), { recursive: true });
  mkdirSync(join(MEMORY_DIR, 'journal'), { recursive: true });
  return new Memory();
}

const today = dayKey();
/** Noon Eastern on a day, as the apps would send it. */
const noon = (day: string) => new Date(`${day}T16:00:00Z`).toISOString();

// Memory days start at 4 AM Eastern, including on the DST days.
const days: [string, string][] = [
  ['2027-03-14T06:30:00Z', '2027-03-13'], // 1:30 AM EST, before the clocks go forward
  ['2027-03-14T07:00:00Z', '2027-03-13'], // 3:00 AM EDT
  ['2027-03-14T07:59:00Z', '2027-03-13'], // 3:59 AM EDT
  ['2027-03-14T08:00:00Z', '2027-03-14'], // 4:00 AM EDT
  ['2027-03-14T08:15:00Z', '2027-03-14'], // 4:15 AM EDT, when the write-up runs
  ['2027-03-14T09:00:00Z', '2027-03-14'], // 5:00 AM EDT
  ['2026-11-01T05:30:00Z', '2026-10-31'], // 1:30 AM EDT
  ['2026-11-01T06:30:00Z', '2026-10-31'], // 1:30 AM EST, after the clocks go back
  ['2026-11-01T08:00:00Z', '2026-10-31'], // 3:00 AM EST
  ['2026-11-01T08:59:00Z', '2026-10-31'], // 3:59 AM EST
  ['2026-11-01T09:00:00Z', '2026-11-01'], // 4:00 AM EST
  ['2026-11-01T09:15:00Z', '2026-11-01'], // 4:15 AM EST
  ['2026-11-01T10:00:00Z', '2026-11-01'], // 5:00 AM EST
];
const wrongDays = days.filter(([at, day]) => dayKey(new Date(at)) !== day).map(([at, day]) => `${at} → ${dayKey(new Date(at))}, not ${day}`);
check('memory days start at 4 AM local on both DST days', !wrongDays.length, wrongDays.join('; '));

// The Mac's queue: up to 500 entries a request, every one written, ids sent twice written once.
let memory = fresh();
const stub: any = new Proxy({}, { get: () => () => {} });
const server = new HubServer({ devices: stub, today: stub, todos: stub, usage: stub, chats: stub, portfolio: stub, robinhood: stub,
                               health: () => ({}), appURL: () => undefined, memory });
const memoryLog = (message: Record<string, unknown>) => (server as any).handlers['memory.log'](message, { socket: stub, device: { name: 'Test Mac' } });
const batch = Array.from({ length: 250 }, (_, i) => ({ id: `mac-${i}`, source: 'lens', kind: 'question', text: `Question ${i}`, at: noon(today) }));
const first = memoryLog({ entries: batch });
check('a batch of 250 is accepted whole', first.accepted === 250 && memory.entries(today).length === 250, JSON.stringify(first));
const again = memoryLog({ entries: [...batch, { id: 'mac-250', source: 'lens', kind: 'question', text: 'Question 250', at: noon(today) }] });
const texts = memory.entries(today).map((entry) => entry.text);
check('a resent batch is acknowledged but written once', again.accepted === 251 && texts.length === 251 && new Set(texts).size === 251
      && texts.at(-1) === 'Question 250', `${again.accepted} accepted, ${texts.length} lines`);
const restarted = new Memory();
check('ids already logged are remembered across a restart', !restarted.log({ id: 'mac-3', source: 'lens', kind: 'question', text: 'Question 3', at: noon(today) }));
const huge = memoryLog({ entries: Array.from({ length: 600 }, (_, i) => ({ id: `big-${i}`, source: 'lens', kind: 'question', text: `Big ${i}` })) });
check('at most 500 entries a request, and the reply says how many', huge.accepted === 500
      && memory.entries(today).filter((entry) => entry.text.startsWith('Big ')).length === 500);
memoryLog({ entries: [{ source: 'lens', kind: 'question', text: 'No id' }, { source: 'lens', kind: 'question', text: 'No id' }, null, 'junk'] });
check('entries without an id still work', memory.entries(today).filter((entry) => entry.text === 'No id').length === 2);
memoryLog({ id: 7, type: 'memory.log', source: 'lecture', kind: 'started', text: 'Single entry' });
memoryLog({ id: 7, type: 'memory.log', source: 'lecture', kind: 'started', text: 'Single entry' });
check("a single entry isn't deduped on the request's id", memory.entries(today).filter((entry) => entry.text === 'Single entry').length === 2);

// The nightly write-up, with a stand-in for Sonnet.
const longCore = `# Alex, right now\n\n## People\n- Roommate: Sam\n${Array.from({ length: 60 }, (_, i) => `- Fact number ${i} about Alex's week`).join('\n')}\n`;
const threadsText = '# Follow-ups\n\n- [ ] after 2026-11-02 · Ask how the HIST exam went\n';
const reply = (parts: { journal?: string; core?: string; threads?: string; self?: string }) =>
  Object.entries(parts).map(([tag, text]) => `<${tag}>${text}</${tag}>`).join('\n');
const goodCore = `${longCore}- HIST essay due Friday`;
const goodThreads = '# Follow-ups\n\n- [ ] after 2026-11-02 · Ask how the HIST exam went\n- [ ] after 2026-11-03 · Ask how the essay went';
const goodSelf = '# Dash, in his own words\n\n## Who I am\n- Dash, he/him.\n## Running jokes and shared references\n- The essay that ate October.';
const good = reply({ journal: 'A long day on the HIST essay.', core: goodCore, threads: goodThreads, self: goodSelf });
const day = addDays(today, -2);
function setUp() {
  memory = fresh();
  writeFileSync(paths.core, longCore);
  writeFileSync(paths.threads, threadsText);
  memory.log({ source: 'chat', kind: 'summary', text: 'Planned the HIST essay; Alex seemed stressed.', title: 'HIST essay', at: noon(day) });
  memory.log({ source: 'lens', kind: 'question', text: 'VHL 3.2 preterite question', at: noon(day) });
  return { core: memory.core(), threads: memory.threadsText(), self: memory.self() };
}

let before = setUp();
const emptyCore = await consolidate(memory, day, async () => reply({ journal: 'A day.', core: '', threads: goodThreads, self: goodSelf }));
check('a reply with an empty core still writes nothing, journal included', emptyCore === 'failed' && memory.core() === before.core && memory.threadsText() === before.threads
      && memory.self() === before.self && !memory.journal(day));
check('the failure is recorded for the health check', lastConsolidation()?.ok === false && lastConsolidation()?.day === day
      && /core/.test(lastConsolidation()?.error ?? ''), JSON.stringify(lastConsolidation()));
// A core the checks turn down (blank, cut short, mangled) is left as it was; the journal and the rest still go in.
before = setUp();
const shrunk = await consolidate(memory, day, async () => reply({ journal: 'A day.', core: '# Alex, right now\n\n- Roommate: Sam', threads: goodThreads }));
check('a core that shrank to a fraction is left as it was, and the journal is still written', shrunk === 'written' && memory.core() === before.core
      && memory.journal(day).includes('A day') && memory.threads().some((thread) => thread.text === 'Ask how the essay went'));
check('which is noted, not reported as a failure', lastConsolidation()?.ok === true
      && (lastConsolidation()?.skipped ?? []).some((note) => note.startsWith('core: shrank')), JSON.stringify(lastConsolidation()));
before = setUp();
const renamed = await consolidate(memory, day, async () => reply({ journal: 'A day.', core: goodCore.replace('# Alex, right now', 'Here is the core:'), threads: goodThreads }));
check('a core without its heading is left as it was', renamed === 'written' && memory.core() === before.core && memory.journal(day).includes('A day'));
before = setUp();
const badThreads = await consolidate(memory, day, async () => reply({ journal: 'A day.', core: goodCore, threads: 'Sorry, no follow-ups.', self: goodSelf }));
check('a bad follow-up list is left out, the rest is written', badThreads === 'written' && memory.core() === `${goodCore}\n`
      && memory.threadsText() === before.threads && memory.self().includes('ate October') && memory.journal(day).includes('A day'));
check('and is noted without the health check calling it a failure', lastConsolidation()?.ok === true
      && (lastConsolidation()?.skipped ?? []).some((note) => note.startsWith('threads')), JSON.stringify(lastConsolidation()));

// Real pruning is accepted: a core cut to a third, old checked follow-ups dropped, lines repeating remember.md taken out.
before = setUp();
const oldChecked = Array.from({ length: 40 }, (_, i) => `- [x] after 2026-09-${String((i % 28) + 1).padStart(2, '0')} · Ask how quiz ${i} went`).join('\n');
writeFileSync(paths.threads, `${threadsText}${oldChecked}\n`);
const remembered = Array.from({ length: 40 }, (_, i) => `- Alex likes summaries of kind ${i} to lead with the numbers`);
writeFileSync(paths.memory, `# Things to remember\n\n${remembered.join('\n')}\n`);
const thirdCore = `${longCore.split('\n').slice(0, 24).join('\n')}\n- HIST essay due Friday`;
const pruned = await consolidate(memory, day, async () => reply({ journal: 'A day.', core: thirdCore, threads: goodThreads, self: goodSelf }));
check('a core cut to about a third is accepted', pruned === 'written' && memory.core() === `${thirdCore}\n` && thirdCore.length < before.core.length * 0.4,
      JSON.stringify(lastConsolidation()));
check('a follow-up list without its old checked items is accepted', memory.threadsText().trim() === goodThreads && lastConsolidation()?.ok === true
      && !lastConsolidation()?.skipped, JSON.stringify(lastConsolidation()));
writeFileSync(paths.core, `# Alex, right now\n\n## People\n- Roommate: Sam\n## Preferences\n${remembered.join('\n')}\n`);
const deduped = '# Alex, right now\n\n## People\n- Roommate: Sam\n## Preferences\n- Short replies';
await consolidate(memory, day, async () => reply({ journal: 'A day.', core: deduped, threads: goodThreads, self: goodSelf }));
check('a core that drops lines repeating remember.md is accepted', memory.core() === `${deduped}\n`, JSON.stringify(lastConsolidation()));
rmSync(paths.memory, { force: true });

// The catch-up: a day whose core is turned down still gets its journal, and the days after it still run.
memory = fresh();
writeFileSync(paths.core, longCore);
writeFileSync(paths.threads, threadsText);
const queue = [addDays(today, -3), addDays(today, -2), addDays(today, -1)];
for (const queued of queue) memory.log({ source: 'chat', kind: 'summary', text: `Chat on ${queued}`, at: noon(queued) });
const caughtUp = await consolidatePending(memory, undefined, async (text) => {
  const which = queue.find((queued) => text.includes(`(${queued})`))!;
  return reply({ journal: `Journal for ${which}.`, core: which === queue[0] ? '# Alex, right now\n' : `${longCore}- Last written up: ${which}`, threads: goodThreads });
});
check('a day with a turned-down core still gets its journal, and later days still run', queue.every((queued) => caughtUp[queued] === 'written'
      && memory.journal(queued).includes(`Journal for ${queued}`)) && memory.core().includes(`Last written up: ${queue[2]}`)
      && lastConsolidation()?.ok === true, JSON.stringify(caughtUp));

// A real error (Sonnet failing) still stops the catch-up, and the health check hears about it.
memory = fresh();
writeFileSync(paths.core, longCore);
for (const queued of queue) memory.log({ source: 'chat', kind: 'summary', text: `Chat on ${queued}`, at: noon(queued) });
const stopped = await consolidatePending(memory, undefined, async () => { throw new Error('session limit'); });
check('a failed write-up stops the catch-up and is reported', stopped[queue[0]] === 'failed' && Object.keys(stopped).length === 1
      && !memory.journal(queue[0]) && lastConsolidation()?.ok === false && /session limit/.test(lastConsolidation()?.error ?? ''), JSON.stringify(stopped));

// A crash after core is saved but before the journal: the day isn't marked done, so it's written up again.
before = setUp();
const realWrite = memory.write.bind(memory);
memory.write = (file: string, text: string) => {
  if (file === paths.threads) throw new Error('simulated crash');
  realWrite(file, text);
};
const crashed = await consolidate(memory, day, async () => good);
memory.write = realWrite;
check('a crash between writes leaves the day without a journal', crashed === 'failed' && memory.core() === `${goodCore}\n` && !memory.journal(day)
      && memory.threadsText() === before.threads && lastConsolidation()?.ok === false);
const retried = await consolidatePending(memory, undefined, async () => good);
check('the next night writes that day up again', retried[day] === 'written' && memory.journal(day).includes('HIST essay')
      && memory.threads().some((thread) => thread.text === 'Ask how the essay went') && lastConsolidation()?.ok === true, JSON.stringify(retried));

// Edits made while Sonnet writes: core keeps the edit, a follow-up added meanwhile survives the new list.
before = setUp();
const edited = `${longCore}- Alex edited this by hand\n`;
const raced = await consolidate(memory, day, async () => {
  writeFileSync(paths.core, edited);
  memory.addThread('2026-11-05', 'Ask about the advising meeting');
  return good;
});
check('core edited during the write-up keeps the edit', raced === 'written' && memory.core() === edited && memory.journal(day).includes('HIST essay'));
check('a follow-up added during the write-up is kept alongside the new ones', memory.threads().some((thread) => thread.text === 'Ask about the advising meeting')
      && memory.threads().some((thread) => thread.text === 'Ask how the essay went'), memory.threadsText());
check('the skipped core is noted', (lastConsolidation()?.skipped ?? []).some((note) => note.startsWith('core')), JSON.stringify(lastConsolidation()));

// What Sonnet sees: remember.md as context, and lens lines dropped before conversations when the log is long.
setUp();
writeFileSync(paths.memory, '# Things to remember\n\n- earnings recaps lead with EPS\n');
for (let i = 0; i < 120; i += 1) memory.log({ source: 'lens', kind: 'question', text: `Lens question ${i} ${'x'.repeat(780)}`, at: noon(day) });
memory.log({ source: 'chat', kind: 'summary', text: 'Late chat about the ECON memo.', at: noon(day) });
let input = '';
let system = '';
await consolidate(memory, day, async (text, prompt) => { input = text; system = prompt; return good; });
check('the write-up sees remember.md, and is told not to copy it or ABOUT_ME into core', input.includes('<remember>') && input.includes('earnings recaps lead with EPS')
      && /never copy them into core/.test(system));
check('a long log drops lens lines before conversations', input.includes('Planned the HIST essay') && input.includes('Late chat about the ECON memo')
      && !input.includes('Lens question 0 ') && input.includes('Lens question 119 '));

// A day with only lens questions and pushes: a journal entry, no rewrite of core or self.
memory = fresh();
writeFileSync(paths.core, longCore);
memory.log({ source: 'lens', kind: 'question', text: 'VHL 3.2 preterite question', at: noon(day) });
memory.log({ source: 'notify', kind: 'deadline', text: 'Spanish HW due tomorrow', at: noon(day) });
input = '';
system = '';
const quiet = await consolidate(memory, day, async (text, prompt) => { input = text; system = prompt; return '<journal>Spanish homework in the lens all evening.</journal>'; });
check('a quiet day gets a journal entry and no rewrite', quiet === 'written' && memory.journal(day).includes('Spanish homework') && memory.core() === longCore
      && !input.includes('<current_core>') && /quiet day/.test(system));

// "Forget that" reaches the log, the journal, the old copies and memory.md.migrated, and only exact lines.
memory = fresh();
const yesterday = addDays(today, -1);
writeFileSync(paths.core, '# Alex, right now\n\n## People\n- Roommate: Sam\n- Sam is a great roommate\n');
memory.write(paths.core, memory.core());
memory.log({ source: 'chat', kind: 'summary', text: '- Roommate: Sam\n- Planned the essay', at: noon(yesterday) });
memory.log({ source: 'note', kind: 'note', text: 'Roommate: Sam', at: noon(yesterday) });
memory.log({ source: 'chat', kind: 'summary', text: 'Roommate: Sam, who moved in last week', at: noon(today) });
memory.writeJournal(yesterday, 'A quiet evening.\n- Roommate: Sam\nWorked on the essay.');
writeFileSync(`${paths.oldMemory}.migrated`, '# Dash memory\n- Roommate: Sam\n- Likes EPS first\n');
memory.forget('core', '- Roommate: Sam');
const versions = readdirSync(paths.memoryVersions).map((name) => readFileSync(join(paths.memoryVersions, name), 'utf8'));
const logged = [...memory.entries(yesterday), ...memory.entries(today)].map((entry) => entry.text);
check('forget removes the line from core', !/^- Roommate: Sam$/m.test(memory.core()) && memory.core().includes('Sam is a great roommate'));
check('forget scrubs the log, keeping the rest of an entry', logged.includes('- Planned the essay') && !logged.includes('Roommate: Sam')
      && logged.includes('Roommate: Sam, who moved in last week'), JSON.stringify(logged));
check('forget scrubs the journal and old copies', memory.journal(yesterday) === 'A quiet evening.\nWorked on the essay.\n'
      && versions.length > 0 && versions.every((text) => !/^- Roommate: Sam$/m.test(text))
      && readFileSync(`${paths.oldMemory}.migrated`, 'utf8') === '# Dash memory\n- Likes EPS first\n', JSON.stringify(memory.journal(yesterday)));
check("a forgotten line doesn't come back through the memory context", !/Roommate: Sam$/m.test(memory.context()), memory.context());
memory.log({ source: 'note', kind: 'note', text: '- Sam', at: noon(today) });
writeFileSync(paths.core, '# Alex, right now\n\n- Sam\n');
memory.forget('core', '- Sam');
check('a very short line is only forgotten where it was', memory.entries(today).some((entry) => entry.text === '- Sam'));

// This week's lines skip days the recent journal already tells.
memory = fresh();
memory.log({ source: 'chat', kind: 'summary', text: 'Three days ago: talked about the dentist', at: noon(addDays(today, -3)) });
memory.log({ source: 'chat', kind: 'summary', text: 'Two days ago: planned the HIST essay', at: noon(addDays(today, -2)) });
memory.log({ source: 'chat', kind: 'summary', text: 'Yesterday: ECON memo outline', at: noon(addDays(today, -1)) });
memory.log({ source: 'chat', kind: 'summary', text: 'Today: Spanish quiz prep', at: noon(today) });
memory.writeJournal(addDays(today, -1), 'Journal for yesterday.');
memory.writeJournal(addDays(today, -3), 'Journal for three days ago.');
const context = memory.context();
const week = context.slice(context.indexOf('<this_week>'));
check("this week doesn't repeat journaled days", context.includes('Journal for yesterday') && context.includes('Journal for three days ago')
      && !week.includes('Yesterday: ECON memo') && !week.includes('Three days ago') && week.includes('Two days ago') && week.includes('Today: Spanish quiz'), week);

{
  const added = memory.addRemember('- Mac-only fact from while unpaired');
  const again = memory.addRemember('Mac-only fact from while unpaired');
  check('a remember line from the Mac lands in remember.md once', added && !again
        && memory.remember().split('\n').filter((line) => line.includes('Mac-only fact')).length === 1, memory.remember());
}

check('nothing was written outside the test folder', existsSync(data) && paths.core.startsWith(data));
rmSync(data, { recursive: true, force: true });
console.log(failures ? `\n${failures} memory check(s) failed` : '\nAll memory checks passed');
process.exit(failures ? 1 : 0);
