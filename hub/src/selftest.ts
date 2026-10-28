/**
 * `npm run selftest`: starts a throwaway hub (temporary data folder, a spare port, a fake jarvis) and
 * checks pairing, sign-in, refusals, Today, and to-do sync in both directions, the way the apps use it.
 * Nothing touches the real hub's data, Claude, or Google.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const data = mkdtempSync(join(tmpdir(), 'dash-hub-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';
const port = 47990;

const { Devices } = await import('./devices.ts');
const { HubServer } = await import('./server.ts');
const { Today, parseEvents, parseInbox } = await import('./today.ts');
const { ToDoList } = await import('./todo.ts');
const { Usage } = await import('./usage.ts');
const { Chats } = await import('./chats.ts');
const { paths } = await import('./paths.ts');
// Never touch the synced folders (an old version of this test overwrote a real syllabus).
for (const path of [paths.syllabi, paths.aboutMe, paths.brightspace, paths.outputDir, paths.profile]) {
  if (!path.startsWith(data)) { console.error(`selftest: ${path} is outside the test folder; stopping`); process.exit(1); }
}
// A made-up user, so names in memory files and chat transcripts come from the profile.
mkdirSync(join(paths.profile, '..'), { recursive: true });
writeFileSync(paths.profile, JSON.stringify({ name: 'Alex' }));
const { Memory, dayKey, addDays } = await import('./memory.ts');
const { consolidate } = await import('./consolidate.ts');
const { Scheduler } = await import('./scheduler.ts');
const { Deadlines, dueReminder, parse: parseDeadlines } = await import('./deadlines.ts');
const { Notifier, isQuietHour, actionKey } = await import('./notify.ts');
const { Secretary } = await import('./proactive.ts');

const calendar = `1. HIST2100A: Empires and Trade (id: ev1)
   2026-10-27T10:05:00-04:00 → 2026-10-27T11:20:00-04:00
   Main Hall 101
2. Fall break (id: ev2)
   2026-10-30 → 2026-10-31`;
const inbox = `1. From: "Prof. Smith" <smith@example.edu> (id: m1)
   Subject: Exam 2 review`;
const fakeJarvis = {
  isRunning: true,
  call: async (tool: string) => ({ calendar_get: calendar, weather_get: 'Sunny, 54°F', email_read: inbox })[tool] ?? '',
  shutdown() {},
};

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

class TestClient {
  socket: WebSocket;
  events: { event: string; data: any }[] = [];
  private nextID = 1;
  private waiting = new Map<number, (reply: any) => void>();
  closed: Promise<number>;

  constructor() {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.closed = new Promise((resolve) => this.socket.on('close', (code) => resolve(code)));
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (typeof message.re === 'number') this.waiting.get(message.re)?.(message);
      else this.events.push(message);
    });
  }

  opened() {
    return new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  request(type: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextID++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.socket.send(JSON.stringify({ ...params, id, type }));
    });
  }

  async nextEvent(kind: string, test: (data: any) => boolean = () => true, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const index = this.events.findIndex((event) => event.event === kind && test(event.data));
      if (index >= 0) return this.events.splice(index, 1)[0].data;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }
}

// Parsing, against jarvis's real output shape.
const events = parseEvents(calendar);
check('parses timed events', events[0]?.title === 'HIST2100A: Empires and Trade' && events[0].id === 'ev1' && events[0].course === 'HIST2100A'
      && events[0].start === '2026-10-27T14:05:00.000Z' && events[0].place === 'Main Hall 101', JSON.stringify(events[0]));
check('parses all-day events at Eastern midnight', events[1]?.allDay === true && events[1].start === '2026-10-30T04:00:00.000Z', JSON.stringify(events[1]));
const mail = parseInbox(inbox);
check('parses the inbox', mail[0]?.from === 'Prof. Smith' && mail[0].subject === 'Exam 2 review' && mail[0].id === 'm1', JSON.stringify(mail[0]));

// Memory: the old memory.md moves into the memory folder; days start at 4 AM Eastern.
writeFileSync(paths.oldMemory, '# Dash memory\n\nThings Alex asked Dash to remember, newest last.\n- 2026-10-14: earnings recaps lead with EPS\n');
const memory = new Memory();
check('moves memory.md into memory/remember.md', readFileSync(paths.memory, 'utf8').includes('earnings recaps lead with EPS')
      && existsSync(`${paths.oldMemory}.migrated`) && !existsSync(paths.oldMemory));
check('a 1:30 AM moment belongs to the day before', dayKey(new Date('2026-10-28T05:30:00Z')) === '2026-10-27'
      && dayKey(new Date('2026-10-28T09:00:00Z')) === '2026-10-28' && addDays('2026-10-31', 1) === '2026-11-01');
const memToday = dayKey();
memory.log({ source: 'lens', kind: 'question', text: 'VHL 3.2 preterite question' });
memory.log({ source: 'chat', kind: 'summary', text: 'Planned the HIST essay; Alex seemed stressed.', title: 'HIST essay' });
memory.log({ source: 'chat', kind: 'summary', text: '   ' });
check('logs entries to the day file, skipping empty ones', memory.entries(memToday).length === 2 && memory.loggedDays()[0] === memToday);
writeFileSync(paths.threads, `# Follow-ups\n\n- [ ] after ${addDays(memToday, -1)} · Ask how the HIST exam went\n- [ ] after ${addDays(memToday, 5)} · Ask about the dentist\n- [x] after 2026-01-01 · old\n`);
check('parses open follow-ups and which are due', memory.threads().length === 2 && memory.dueThreads().length === 1
      && memory.dueThreads()[0].text === 'Ask how the HIST exam went');
writeFileSync(paths.core, '# Alex, right now\n\n## People\n- Roommate: Sam\n');
const context = memory.context();
const order = ['<dash_self', '<core_memory', '<remember', '<follow_ups', '<this_week'].map((tag) => context.indexOf(tag));
check("memory context: Dash's self, core, remember, follow-ups, this week, in that order", order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]))
      && context.includes('(due) - [ ] after') && context.includes('Roommate: Sam') && context.includes('Planned the HIST essay')
      && !context.includes('VHL 3.2'), context);
memory.forget('core', '- Roommate: Sam');
check('forgets one line, keeping a copy', !memory.core().includes('Sam') && readdirSync(paths.memoryVersions).some((name) => name.startsWith('core.md.')));
writeFileSync(paths.core, '# Alex, right now\n\n## People\n- Roommate: Sam\n');

// The nightly write-up, with a stand-in for Sonnet.
let writerInput = '';
const goodReply = '<journal>A long day on the HIST essay.</journal>\n<core># Alex, right now\n\n## People\n- Roommate: Sam\n## School\n- HIST essay due Friday</core>\n<threads># Follow-ups\n\n- [ ] after 2026-11-01 · Ask how the essay went</threads>\n<self># Dash, in his own words\n\n## Who I am\n- Dash, he/him.\n## Running jokes and shared references\n- The essay that ate October.</self>';
const written = await consolidate(memory, memToday, async (input) => { writerInput = input; return goodReply; });
check('consolidation writes the journal, core and follow-ups', written === 'written' && memory.journal(memToday).includes('HIST essay')
      && memory.core().includes('HIST essay due Friday') && memory.threads()[0]?.text === 'Ask how the essay went'
      && memory.self().includes('The essay that ate October')
      && writerInput.includes('VHL 3.2') && writerInput.includes('Roommate: Sam'), writerInput.slice(0, 300));
const before = memory.core();
const bad = await consolidate(memory, memToday, async () => 'Sorry, I can\'t.');
check("a malformed write-up changes nothing", bad === 'failed' && memory.core() === before);
check('a day with no log is skipped', await consolidate(memory, '2020-01-01', async () => goodReply) === 'empty');

// The scheduler: runs once per slot, survives a restart, catches up only within its window.
const schedFile = join(data, 'sched-test.json');
let clock = new Date(2026, 9, 27, 7, 45);
let runs = 0;
let fives = 0;
const makeScheduler = () => {
  const made = new Scheduler(schedFile, () => clock);
  made.daily('brief', '07:30', () => { runs += 1; }, 1);
  made.every('five', 5, () => { fives += 1; });
  return made;
};
let sched = makeScheduler();
await sched.tick();
await sched.tick();
check('a daily job runs once when due', runs === 1 && fives === 1, `${runs} ${fives}`);
clock = new Date(2026, 9, 27, 7, 50);
sched = makeScheduler();
await sched.tick();
check('a restart does not run it again', runs === 1 && fives === 2, `${runs} ${fives}`);
clock = new Date(2026, 9, 28, 10, 0);
sched = makeScheduler();
await sched.tick();
check('a run missed by more than its window is skipped', runs === 1);
clock = new Date(2026, 9, 29, 8, 15);
sched = makeScheduler();
await sched.tick();
check('a run missed by less than its window catches up', runs === 2);

// Chats are summarized into memory once they go quiet; off-the-record ones never are.
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const chatTurns = [{ id: 'T1', role: 'user', text: 'My HIST exam is Thursday and I am nervous' },
                   { id: 'T2', role: 'assistant', text: 'You know the Investiture Controversy cold. Want a quiz?' }];
const makeChat = (chatID: string, extra: Record<string, unknown>) => writeFileSync(join(paths.chats, `${chatID}.json`), JSON.stringify({
  meta: { id: chatID, title: 'HIST exam nerves', titleIsCustom: false, createdAt: stamp, updatedAt: stamp, sessionID: chatID, sessionStarted: true,
          effort: 'medium', permissionMode: 'default', ...extra }, turns: chatTurns }));
mkdirSync(paths.chats, { recursive: true });
const onRecordID = 'AAAAAAAA-0000-4000-8000-000000000001';
const offRecordID = 'AAAAAAAA-0000-4000-8000-000000000002';
makeChat(onRecordID, {});
makeChat(offRecordID, { offRecord: true });

// Deadlines: the markdown format, dedup, confirm/done/dismiss, reminders.
const parsed = parseDeadlines('- [ ] 2026-10-30 · HIST2100A · Essay 2 draft · from syllabus · unconfirmed\n- [x] 2026-10-29 09:00 · Quiz 4 · exam\n- [ ] Oct 30 essay\n');
check('parses deadline lines', parsed.items.length === 2 && parsed.items[0].course === 'HIST2100A' && parsed.items[0].title === 'Essay 2 draft'
      && !parsed.items[0].confirmed && parsed.items[0].source === 'syllabus' && new Date(parsed.items[0].due).getHours() === 23
      && parsed.items[1].exam && parsed.items[1].done && !parsed.items[1].course && parsed.unreadable.length === 1, JSON.stringify(parsed));
const deadlines = new Deadlines();
deadlines.watch();
const inDays = (days: number, hour = 23, minute = 59) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return date;
};
const essay = deadlines.add({ due: inDays(2), course: 'HIST2100A', title: 'Essay 2 draft' })!;
const again = deadlines.add({ due: inDays(2, 17, 0), course: 'HIST2100A', title: 'Essay 2 draft due', source: 'calendar' });
check('adds a deadline and ignores a near-duplicate', deadlines.items.length === 1 && again?.id === essay.id
      && readFileSync(paths.deadlines, 'utf8').includes(`- [ ] ${essay.line.slice(6)}`));
const quiz = deadlines.add({ due: inDays(5, 10, 50), course: 'SPAN1010B', title: 'Quiz 5', exam: true, confirmed: false, source: 'syllabus' })!;
check('an unconfirmed deadline gets no reminders', !dueReminder(quiz, new Date(Date.parse(quiz.due) - 3_600_000), []).send);
deadlines.confirm(quiz.id);
check('confirming keeps its id', deadlines.find(quiz.id)?.confirmed === true);
const confirmedQuiz = deadlines.find(quiz.id)!;
const sixDaysBefore = new Date(Date.parse(confirmedQuiz.due) - 6 * 86_400_000);
check('an exam gets a reminder a week out', dueReminder(confirmedQuiz, sixDaysBefore, []).send?.key === '7d');
const late = dueReminder(confirmedQuiz, new Date(Date.parse(confirmedQuiz.due) - 2 * 3_600_000), []);
check('only the latest missed reminder goes out', late.send?.key === '3h' && late.send.urgent && late.skip.includes('1d') && late.skip.includes('7d'), JSON.stringify(late));
deadlines.dismiss(quiz.id);
check('a dismissed deadline is not added back', !deadlines.find(quiz.id) && !deadlines.add({ due: inDays(5, 10, 50), course: 'SPAN1010B', title: 'Quiz 5', exam: true }));
check('quiet hours are 11 PM to 8 AM', isQuietHour(new Date(2026, 9, 27, 23, 30)) && isQuietHour(new Date(2026, 9, 28, 7, 59)) && !isQuietHour(new Date(2026, 9, 28, 8, 0)));

// Pushes, to a stand-in for ntfy.
const pushes: any[] = [];
const fakePost = (async (_url: string, init: any) => {
  pushes.push({ ...JSON.parse(init.body), auth: init.headers.authorization });
  return new Response('{}', { status: 200 });
}) as typeof fetch;
let pushClock = new Date(2026, 9, 27, 14, 0);
const notifier = new Notifier({ memory, config: { url: 'http://ntfy.test', topic: 'dash-test', token: 'tk_test' }, clock: () => pushClock, post: fakePost });
const pushed = await notifier.send({ kind: 'test', title: 'Hi', body: 'Body', actions: [{ label: 'Done', url: 'https://hub/action' }] });
check('sends a push to ntfy with the token and a button', pushed === 'sent' && pushes[0]?.topic === 'dash-test' && pushes[0].auth === 'Bearer tk_test'
      && pushes[0].actions[0].action === 'http' && memory.entries(dayKey()).some((entry) => entry.source === 'notify'), JSON.stringify(pushes[0]));
pushClock = new Date(2026, 9, 27, 23, 30);
check('holds pushes in quiet hours unless Alex asked for it', await notifier.send({ kind: 'test', title: 'x', body: 'y' }) === 'held'
      && await notifier.send({ kind: 'test', title: 'x', body: 'y', urgent: true }) === 'sent');
pushes.length = 0;
notifier.release(notifier.held());

const devices = new Devices();
const todos = new ToDoList();
todos.watch();
const today = new Today(fakeJarvis as any, todos, memory, deadlines);
const usage = new Usage();
const chats = new Chats();
const summarized: string[] = [];
chats.setMemory(memory, async (text) => {
  summarized.push(text);
  return 'Alex is nervous about the HIST exam Thursday. follow up: exam Thu';
});
await chats.summarizePending();
await chats.summarizePending();
const chatSummaries = memory.entries(dayKey()).filter((entry) => entry.chat === onRecordID);
check('a quiet chat is summarized into memory once', summarized.length === 1 && chatSummaries.length === 1
      && summarized[0].includes('Alex: My HIST exam') && chatSummaries[0].title === 'HIST exam nerves', JSON.stringify(summarized));
check('an off-the-record chat is never summarized', !memory.entries(dayKey()).some((entry) => entry.chat === offRecordID));
check('the chat remembers how far it was summarized', JSON.parse(readFileSync(join(paths.chats, `${onRecordID}.json`), 'utf8')).meta.summarized === 2);
const { RobinhoodClient } = await import('./portfolio/robinhood.ts');
const { Portfolio } = await import('./portfolio/portfolio.ts');
const robinhood = new RobinhoodClient();
const portfolio = new Portfolio(robinhood);
// The secretary: calendar and syllabus intake, reminders, the check-in, follow-ups.
pushClock = new Date();
pushClock.setHours(14, 0, 0, 0);
const soon = new Date(Date.now() + 2 * 86_400_000);
soon.setHours(13, 10, 0, 0);
const examDay = new Date(Date.now() + 4 * 86_400_000);
examDay.setHours(9, 40, 0, 0);
const calendarText = `1. POLS2200A: Policy exercise memo (id: c1)
   ${soon.toISOString()} → ${soon.toISOString()}
2. POLS1000A: Exam #4 (id: c2)
   ${examDay.toISOString()} → ${examDay.toISOString()}
3. HIST2100A: The Silk Road and Trade Networks (id: c3)
   ${soon.toISOString()} → ${soon.toISOString()}`;
let classified = 0;
mkdirSync(paths.syllabi, { recursive: true });
writeFileSync(join(paths.syllabi, 'ECON3100A_syllabus.pdf'), 'old');
const secretary = new Secretary({
  deadlines, notifier, memory, today, chats, appURL: () => 'exp://100.64.0.1:8081', hubURL: 'https://hub.test', clock: () => pushClock,
  jarvis: { call: async () => calendarText } as any,
  helpers: {
    classify: async (events) => {
      classified += events.split('\n').length;
      return JSON.stringify([{ id: 'c1', kind: 'due', title: 'Policy exercise memo' }, { id: 'c2', kind: 'exam', title: 'Exam #4' },
                             { id: 'c3', kind: 'none' }]);
    },
    readSyllabus: async () => JSON.stringify([{ date: inDays(9).toISOString().slice(0, 10), title: 'Problem set 3' },
                                              { date: '2020-01-01', title: 'Long gone' }]),
    voice: async (_purpose, facts) => `Heads up. ${facts.split('\n')[0]}`,
  },
});
const fromCalendar = await secretary.scanCalendar();
check('adds exams and due dates from the calendar, not class sessions', fromCalendar === 2 && deadlines.items.some((item) => item.title === 'Exam #4' && item.exam)
      && !deadlines.items.some((item) => /Black Death/.test(item.title)), JSON.stringify(deadlines.items.map((item) => item.line)));
await secretary.scanCalendar();
check('looks at each calendar event once', classified === 3, String(classified));
check('the first syllabus scan only notes what is there', await secretary.scanSyllabi() === 0);
writeFileSync(join(paths.syllabi, 'ECON3100A_syllabus.pdf'), 'updated');
const { utimesSync } = await import('node:fs');
utimesSync(join(paths.syllabi, 'ECON3100A_syllabus.pdf'), new Date(), new Date(Date.now() + 5000));
const fromSyllabus = await secretary.scanSyllabi();
check('a changed syllabus adds its future dates as unconfirmed, and says so', fromSyllabus === 1
      && deadlines.items.some((item) => item.title === 'Problem set 3' && !item.confirmed && item.course === 'ECON3100A')
      && pushes.some((push) => /ECON3100A/.test(push.title)), JSON.stringify(pushes));
pushes.length = 0;
const reminded = await secretary.remind();
check('several reminders at once go out as one summary', reminded === 3 && pushes.length === 1 && pushes[0].title === '3 things coming up', JSON.stringify(pushes));
pushes.length = 0;
const memo = deadlines.add({ due: new Date(pushClock.getTime() + 2 * 3_600_000), course: 'POLS2200A', title: 'Reading response' })!;
const remindedOne = await secretary.remind();
check('a single reminder has a Done button that calls the hub', remindedOne === 1 && pushes[0]?.title === 'Due: POLS2200A Reading response'
      && pushes[0].actions?.[0]?.url.startsWith(`https://hub.test/action/done?item=${memo.id}&key=`), JSON.stringify(pushes));
const remindedAgain = await secretary.remind();
check('does not repeat a reminder', remindedAgain === 0);
check('a forged Done link is refused', !secretary.completeFromAction(memo.id, 'nope'));
pushes.length = 0;
pushClock = new Date();
pushClock.setHours(21, 0, 0, 0);
const checkIn = await secretary.checkIn();
check('the evening check-in opens a check-in chat', (checkIn === 'sent' && /checkin=1/.test(pushes[0]?.click ?? '')) || checkIn === 'skipped', JSON.stringify(pushes[0]));
pushClock.setHours(12, 30, 0, 0);
pushes.length = 0;
writeFileSync(paths.threads, `# Follow-ups\n\n- [ ] after ${addDays(dayKey(), -1)} · Ask how the HIST exam went\n- [ ] after ${addDays(dayKey(), -1)} · Ask about the dentist\n`);
const followed = await secretary.followUp();
const followedAgain = await secretary.followUp();
check('pushes one due follow-up a day', followed === 'sent' && followedAgain === 'skipped' && /exam/i.test(pushes[0]?.message ?? ''), JSON.stringify(pushes));
// Dash's afternoon sweep, with a stand-in for his read-only session.
let sweepInput = '';
const sweeper = new Secretary({
  deadlines, notifier, memory, today, chats, appURL: () => 'exp://100.64.0.1:8081', clock: () => pushClock, jarvis: { call: async () => '' } as any,
  helpers: { sweep: async (input) => {
    sweepInput = input;
    return '```json\n' + JSON.stringify({
      push: { title: 'Exam moved', body: 'Prof. Smith moved the HIST exam to Friday. I added it; confirm in Dash.' },
      followUps: [{ after: inDays(4).toISOString().slice(0, 10), text: 'Ask whether the advising appointment helped' },
                  { after: inDays(4).toISOString().slice(0, 10), text: 'Ask how the HIST exam went' }],
      deadlines: [{ date: inDays(6).toISOString().slice(0, 10), time: '09:00', course: 'HIST2100A', title: 'Exam (moved)', exam: true }],
      note: 'Read the inbox; Prof. Smith moved the exam.',
    }) + '\n```';
  } },
});
pushes.length = 0;
pushClock.setHours(16, 0, 0, 0);
const swept = await sweeper.sweep();
check("the sweep adds new follow-ups and unconfirmed deadlines, logs a note, and pushes once", swept.threads === 1 && swept.added === 1
      && swept.pushed === 'sent' && pushes.length === 1 && pushes[0].title === 'Exam moved'
      && deadlines.items.some((item) => item.title === 'Exam (moved)' && !item.confirmed && item.source === 'Dash')
      && memory.threads().some((thread) => /advising/.test(thread.text))
      && memory.entries(dayKey()).some((entry) => entry.kind === 'sweep' && /moved the exam/.test(entry.text))
      && sweepInput.includes('<deadline_list>') && sweepInput.includes('<already_done>') && sweepInput.includes('<dash_self'), JSON.stringify({ swept, pushes }));
pushes.length = 0;
pushClock.setHours(12, 30, 0, 0);


const server = new HubServer({ devices, today, todos, usage, chats, health: () => ({ ok: true }), appURL: () => 'exp://100.64.0.1:8081',
                               portfolio, robinhood, memory, deadlines, notifier,
                               completeFromAction: (item, key) => secretary.completeFromAction(item, key) });
server.start(port);
await new Promise((resolve) => setTimeout(resolve, 200));

try {
  const stranger = new TestClient();
  await stranger.opened();
  const refused = await stranger.request('todo.get');
  check('refuses requests before sign-in', !refused.ok && /Sign in/.test(refused.error));
  const badToken = await stranger.request('hello', { token: 'nope' });
  check('refuses an unknown token', !badToken.ok);
  const noCode = await stranger.request('pair', { code: '000000', name: 'x' });
  check('refuses pairing with no code showing', !noCode.ok);
  stranger.socket.close();

  // The Mac pairs first, with a code from the admin path (npm run pair).
  const { code } = devices.startPairing('mac');
  const mac = new TestClient();
  await mac.opened();
  const wrong = await mac.request('pair', { code: code === '123456' ? '654321' : '123456', name: 'Test Mac', role: 'mac' });
  check('refuses a wrong code', !wrong.ok);
  const paired = await mac.request('pair', { code, name: 'Test Mac', role: 'mac' });
  check('pairs the Mac', paired.ok && typeof paired.result.token === 'string' && paired.result.hub.length > 0
        && paired.result.app === 'exp://100.64.0.1:8081', JSON.stringify(paired));
  const reused = await mac.request('pair', { code, name: 'again' });
  check('a code works only once', !reused.ok);
  check('pushes to-do and Today on sign-in', !!(await mac.nextEvent('todo')) && !!(await mac.nextEvent('today')));
  const saved = JSON.parse(readFileSync(paths.devices, 'utf8'));
  check('saves only a hash of the token', saved.length === 1 && !JSON.stringify(saved).includes(paired.result.token) && saved[0].role === 'mac');

  // The Mac pairs a phone from Settings.
  const started = await mac.request('pair.start');
  check('Mac can start pairing', started.ok && /^\d{6}$/.test(started.result.code));
  const phone = new TestClient();
  await phone.opened();
  const phonePaired = await phone.request('pair', { code: started.result.code, name: 'Test iPhone' });
  check('pairs a phone', phonePaired.ok);
  const phoneAdmin = await phone.request('pair.start');
  check('a phone cannot pair other devices', !phoneAdmin.ok);
  const list = await mac.nextEvent('devices', (data) => data.devices.length === 2 && data.devices.every((device: any) => device.online));
  check('Mac sees both devices online', !!list && !JSON.stringify(list).includes('tokenHash'), JSON.stringify(list));

  // Signing back in with the saved token.
  const again = new TestClient();
  await again.opened();
  const hello = await again.request('hello', { token: paired.result.token });
  check('signs in with the saved token', hello.ok && hello.result.device === 'Test Mac');
  again.socket.close();

  // Today, from the fake jarvis.
  const loaded = await phone.nextEvent('today', (data) => data.events.state === 'loaded');
  check('Today loads calendar, weather and inbox', loaded?.events.value.length === 2 && loaded.weather.value === 'Sunny, 54°F'
        && loaded.inbox.value[0].from === 'Prof. Smith' && loaded.brief.canBrief === true, JSON.stringify(loaded));

  // Lecture relay: the Mac reports, the phone sees it and its Start reaches the Mac.
  const report = await mac.request('lecture.report', { state: { state: 'idle', selected: 'HIST2100A', courses: [{ code: 'HIST2100A', name: 'Popes', hasDoc: true }] } });
  check('the Mac reports its recorder', report.ok);
  check('the phone sees the Mac can record', !!(await phone.nextEvent('lecture', (data) => data.available && data.selected === 'HIST2100A')));
  const start = await phone.request('lecture.start', { course: 'HIST2100A' });
  const command = await mac.nextEvent('command', (data) => data.type === 'lecture.start');
  check("the phone's Start reaches the Mac", start.ok && command?.course === 'HIST2100A', JSON.stringify(command));
  const phoneReport = await phone.request('lecture.report', { state: {} });
  check('only a Mac can report a recorder', !phoneReport.ok);

  // To-do: phone adds, Mac sees it; the file changes, both see it; Mac removes.
  const added = await phone.request('todo.add', { text: 'Email Prof. Smith' });
  check('phone adds a to-do', added.ok && added.result.items.includes('Email Prof. Smith'));
  check('Mac gets the new to-do', !!(await mac.nextEvent('todo', (data) => data.items.includes('Email Prof. Smith'))));
  writeFileSync(paths.todo, readFileSync(paths.todo, 'utf8') + '- [ ] Added by a chat\n');
  check('an edit to todo.md reaches the phone', !!(await phone.nextEvent('todo', (data) => data.items.includes('Added by a chat'))));
  const removed = await mac.request('todo.remove', { text: 'Email Prof. Smith' });
  check('Mac checks one off', removed.ok && !removed.result.items.includes('Email Prof. Smith') && removed.result.items.includes('Added by a chat'));
  check('the phone sees it go', !!(await phone.nextEvent('todo', (data) => !data.items.includes('Email Prof. Smith'))));
  check('todo.md keeps the checklist format', readFileSync(paths.todo, 'utf8') === '# To-do\n\n- [ ] Added by a chat\n');

  // Line-level edits: notes, headings and items checked off by hand survive adds and removes.
  writeFileSync(paths.todo, '# To-do\n\n## School\n- [ ] Added by a chat\n  - note: due Friday\n- [x] Done already\n');
  await mac.nextEvent('todo', (data) => data.items.length === 1, 2000);
  await phone.request('todo.add', { text: 'Buy stamps' });
  await phone.request('todo.remove', { text: 'Added by a chat' });
  check('adding and removing keep notes and checked lines', readFileSync(paths.todo, 'utf8')
        === '# To-do\n\n## School\n  - note: due Friday\n- [x] Done already\n- [ ] Buy stamps\n', JSON.stringify(readFileSync(paths.todo, 'utf8')));

  // Memory over the hub: the Mac logs lens questions; the apps read and prune what Dash remembers.
  const logged = await mac.request('memory.log', { entries: [{ source: 'lens', kind: 'question', text: 'What is the subjunctive of tener?' }] });
  check('the Mac logs a lens question', logged.ok && memory.entries(dayKey()).some((entry) => entry.text === 'What is the subjunctive of tener?'
        && entry.device === 'Test Mac'));
  const remembered = await phone.request('memory.get');
  check('the phone reads the memory', remembered.ok && remembered.result.core.includes('Roommate: Sam') && remembered.result.journal.length === 1);
  const forgot = await phone.request('memory.forget', { file: 'core', line: '- Roommate: Sam' });
  check('the phone removes a line', forgot.ok && !forgot.result.core.includes('Sam'));
  const missing = await phone.request('memory.forget', { file: '../../etc', line: 'x' });
  check('forget only touches memory files', !missing.ok);
  const lensContext = await mac.request('memory.context');
  check('the lens gets a persona and the memory', lensContext.ok && lensContext.result.persona.includes('lens') && lensContext.result.memory.includes('<core_memory'));

  // Deadlines over the hub, and a notification's Done button.
  const listed = await phone.request('deadlines.get');
  check('the phone lists deadlines', listed.ok && listed.result.items.some((item: any) => item.title === 'Policy exercise memo'));
  const addedByPhone = await phone.request('deadlines.add', { title: 'Lab report', course: 'ECON3100A', due: inDays(3).toISOString() });
  check('the phone adds a deadline and the Mac hears about it', addedByPhone.ok
        && !!(await mac.nextEvent('deadlines', (data) => data.items.some((item: any) => item.title === 'Lab report'))));
  const doneResponse = await fetch(`http://127.0.0.1:${port}/action/done?item=${memo.id}&key=${actionKey(memo.id)}`, { method: 'POST' });
  check("a notification's Done button checks it off", doneResponse.status === 200 && deadlines.find(memo.id)?.done === true);
  const forged = await fetch(`http://127.0.0.1:${port}/action/done?item=${memo.id}&key=0000`, { method: 'POST' });
  check('a made-up Done link does nothing', forged.status === 404);

  // Chat ids become file names, so only UUIDs are accepted; an empty message leaves no chat behind.
  const traversal = await phone.request('chat.send', { chat: '../../evil', text: 'hi' });
  check('refuses a chat id that is not a UUID', !traversal.ok && /chat id/.test(traversal.error));
  const openBad = await phone.request('chat.open', { chat: '../../index' });
  check('refuses to open a path as a chat', !openBad.ok);
  const blankID = '11111111-2222-4333-8444-555555555555';
  const blank = await phone.request('chat.send', { chat: blankID, text: '   ' });
  const ghost = await phone.request('chat.open', { chat: blankID });
  check('an empty message leaves no chat behind', !blank.ok && !ghost.ok);

  // Removing the phone from the Mac ends its connection.
  const phoneID = list?.devices.find((device: any) => device.role === 'phone')?.id;
  const self = await mac.request('devices.remove', { device: list?.devices.find((device: any) => device.role === 'mac')?.id });
  check("the Mac can't remove itself", !self.ok);
  await mac.request('devices.remove', { device: phoneID });
  const code4001 = await Promise.race([phone.closed, new Promise((resolve) => setTimeout(() => resolve(-1), 2000))]);
  check('removing a phone disconnects it', code4001 === 4001, String(code4001));
  const revoked = new TestClient();
  await revoked.opened();
  const revokedHello = await revoked.request('hello', { token: phonePaired.result.token });
  check("a removed phone's token stops working", !revokedHello.ok);
  revoked.socket.close();
  mac.socket.close();
} catch (error) {
  check('selftest ran to the end', false, (error as Error).stack ?? String(error));
} finally {
  server.stop();
  todos.stop();
  deadlines.stop();
  rmSync(data, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
