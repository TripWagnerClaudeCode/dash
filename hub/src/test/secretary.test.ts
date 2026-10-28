/**
 * The secretary's timing and bookkeeping: quiet hours and the 8 AM digest, the morning brief push,
 * calendar events that move or go away, the deadline parser, hand edits, the scheduler's retries, the
 * syllabus failure counter and the sweep's push filter. Fixed clocks, stand-ins for ntfy, jarvis and Claude.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'dash-secretary-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';

const { paths, DATA, MEMORY_DIR } = await import('../paths.ts');
for (const path of [paths.syllabi, paths.aboutMe, paths.brightspace, paths.outputDir]) {
  if (!path.startsWith(data)) { console.error(`secretary test: ${path} is outside the test folder; stopping`); process.exit(1); }
}
const { Scheduler } = await import('../scheduler.ts');
const { Deadlines, parse } = await import('../deadlines.ts');
const { Notifier, actionKey } = await import('../notify.ts');
const { Secretary, sweepProfile } = await import('../proactive.ts');
const { Memory } = await import('../memory.ts');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

/** November 2026, after the clocks change, so every day is 24 hours. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
let clock = at(10, 14);

const pushes: any[] = [];
const notifier = new Notifier({
  config: { url: 'http://ntfy.test', topic: 'dash-test' }, clock: () => clock, heldFile: join(data, 'held.json'),
  post: (async (_url: string, init: any) => {
    pushes.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  }) as typeof fetch,
});
const memory = new Memory();

let voiced: string[] = [];
const fakeToday = {
  refreshed: 0, briefs: 0, briefText: 'Big day: the POLS exam is at 10.\nMore below.' as string | undefined,
  events: { state: 'idle' } as any,
  async refresh() {
    this.refreshed += 1;
    this.events = { state: 'loaded', value: [{ id: 'x', title: 'POLS1000A: Exam #3', start: at(10, 10).toISOString(), allDay: false, place: '' }] };
  },
  async fresh() {
    if (this.events.state !== 'loaded') await this.refresh();
  },
  async writeBrief() {
    this.briefs += 1;
    return this.briefText;
  },
  rawText(tool: string) {
    return tool === 'calendar_get' ? '1. POLS1000A: Exam #3\n   2026-11-12T10:00:00-05:00' : '1. From: Prof. Smith\n   Subject: Office hours moved';
  },
};

let deadlineFiles = 0;
const freshDeadlines = () => {
  deadlineFiles += 1;
  return new Deadlines(join(data, `deadlines-${deadlineFiles}.md`), join(data, `deadlines-${deadlineFiles}.json`));
};

let calendarText = '';
/** A secretary with fresh state, or with `state` as an older hub saved it. */
const makeSecretary = (deadlines: InstanceType<typeof Deadlines>, extra: Record<string, any> = {}, state?: object) => {
  rmSync(paths.secretaryState, { force: true });
  if (state) writeFileSync(paths.secretaryState, JSON.stringify(state));
  return new Secretary({
    deadlines, notifier, memory, today: fakeToday as any, appURL: () => undefined, hubURL: 'https://hub.test', clock: () => clock,
    jarvis: { call: async () => calendarText },
    ...extra,
    helpers: {
      voice: async (_purpose: string, facts: string) => {
        voiced.push(facts);
        return `Heads up. ${facts.split('\n')[0]}`;
      },
      ...extra.helpers,
    },
  });
};

// The morning brief: never before 8, and only once the brief is written.
{
  pushes.length = 0;
  const secretary = makeSecretary(freshDeadlines());
  clock = at(10, 7, 30);
  const early = await secretary.morning();
  check('morning() at 7:30 holds: no brief written, nothing pushed', early === 'held' && fakeToday.briefs === 0 && pushes.length === 0,
        JSON.stringify({ early, briefs: fakeToday.briefs, pushes }));
  clock = at(10, 8, 0);
  const onTime = await secretary.morning();
  check('morning() at 8:00 writes the brief and sends its opening line', onTime === 'sent' && pushes.length === 1
        && pushes[0].title === 'Good morning' && /Big day/.test(pushes[0].message), JSON.stringify({ onTime, pushes }));
  pushes.length = 0;
  fakeToday.briefText = undefined;
  const failed = await secretary.morning().then(() => 'resolved', () => 'failed');
  check('no brief, no "Good morning" push (the run fails so it can be retried)', failed === 'failed' && pushes.length === 0);
  fakeToday.briefText = 'Big day.';
}

// Quiet hours: everything waits, nothing is worded, and 8 AM brings one digest.
{
  pushes.length = 0;
  voiced = [];
  const deadlines = freshDeadlines();
  const secretary = makeSecretary(deadlines);
  // Due 10:30, so its 3-hour reminder comes due at 7:30, in quiet hours.
  const memo = deadlines.add({ due: at(11, 10, 30), course: 'POLS2200A', title: 'Policy memo' })!;
  // Due 7:45: its reminder comes due at 4:45, and by 8 it's already past.
  const early = deadlines.add({ due: at(11, 7, 45), course: 'SPAN1010B', title: 'Workbook' })!;
  clock = at(10, 23, 30);
  const night = await notifier.send({ kind: 'syllabus', title: 'ECON3100A: 2 new dates', body: 'Found 2 dates in the ECON3100A syllabus.' });
  const stale = await notifier.send({ kind: 'test', title: 'Leave at 7:45', body: 'For the bus.', expires: at(11, 7, 45).toISOString() });
  const lateNight = await secretary.remind();
  clock = at(11, 7, 30);
  const dawn = await secretary.remind();
  check('quiet hours hold every push, urgent reminders included, and word nothing', night === 'held' && stale === 'held' && lateNight === 0
        && dawn === 0 && pushes.length === 0 && voiced.length === 0, JSON.stringify({ night, lateNight, dawn, pushes, voiced }));
  clock = at(11, 8, 0);
  await secretary.remind();
  check('at 8:00 what waited goes out as one digest', pushes.length === 1 && pushes[0].title === '2 things waiting for you'
        && pushes[0].message.includes('ECON3100A: 2 new dates') && pushes[0].message.includes('Policy memo'), JSON.stringify(pushes));
  check('a held reminder that is past by 8 is dropped', !pushes[0]?.message.includes('Workbook') && !pushes[0]?.message.includes('Leave at 7:45')
        && !deadlines.sentReminders(early.id).length, JSON.stringify(pushes));
  check('the digest marks its reminders sent and empties the queue', deadlines.sentReminders(memo.id).includes('3h') && notifier.held().length === 0);
  pushes.length = 0;
  clock = at(11, 8, 5);
  check('nothing goes out twice', await secretary.remind() === 0 && pushes.length === 0, JSON.stringify(pushes));
}

// A single held push on its own goes out as it was; a past-due reminder alone sends nothing.
{
  pushes.length = 0;
  const deadlines = freshDeadlines();
  const secretary = makeSecretary(deadlines);
  deadlines.add({ due: at(13, 7, 30), course: 'HIST2100A', title: 'Reading quiz', exam: true });
  clock = at(12, 23, 45);
  await notifier.send({ kind: 'syllabus', title: 'HIST2100A: 1 new date', body: 'Found 1 date.' });
  clock = at(13, 8, 0);
  await secretary.remind();
  check('one held push alone goes out unchanged, and the past-due reminder is dropped', pushes.length === 1 && pushes[0].title === 'HIST2100A: 1 new date',
        JSON.stringify(pushes));
}

// Exactly two reminders at once, in the daytime: two pushes, both marked.
{
  pushes.length = 0;
  const deadlines = freshDeadlines();
  const secretary = makeSecretary(deadlines);
  const first = deadlines.add({ due: at(15, 23, 59), course: 'HIST2100A', title: 'Essay 2 draft' })!;
  const second = deadlines.add({ due: at(15, 17, 0), course: 'FILM1200A', title: 'Screening notes' })!;
  clock = at(14, 14, 0);
  const sent = await secretary.remind();
  check('exactly 2 reminders at once go out as 2 pushes', sent === 2 && pushes.length === 2 && pushes.every((push) => /^Due: /.test(push.title))
        && deadlines.sentReminders(first.id).includes('1d') && deadlines.sentReminders(second.id).includes('1d'), JSON.stringify(pushes));
}

// The deadline parser.
{
  const { items, unreadable } = parse([
    '- [ ] 2026-11-12 · HIST2100A · Exam',
    '- [ ] 2026-11-12 · Exam · exam',
    '- [ ] 2026-11-13 · From Hell essay · from syllabus',
    '- [X] 2026-11-14 09:00 · Quiz 4 · exam',
  ].join('\n'));
  check('a title of just "Exam" keeps its title', items[0]?.title === 'Exam' && items[0].course === 'HIST2100A' && items[1]?.title === 'Exam' && items[1].exam,
        JSON.stringify(items));
  check('a title starting "From" is not eaten as the source', items[2]?.title === 'From Hell essay' && items[2].source === 'syllabus', JSON.stringify(items[2]));
  check('- [X] (capital X) is read as done', items[3]?.done === true && items[3].exam && unreadable.length === 0, JSON.stringify({ items, unreadable }));
}

// Fixing a typo in a title by hand doesn't send the reminder again.
{
  pushes.length = 0;
  const file = join(data, 'typo.md');
  const deadlines = new Deadlines(file, join(data, 'typo.json'));
  const secretary = makeSecretary(deadlines);
  const memo = deadlines.add({ due: at(18, 23, 59), course: 'POLS2200A', title: 'Polcy memo' })!;
  clock = at(17, 9, 30);
  await secretary.remind();
  writeFileSync(file, readFileSync(file, 'utf8').replace('Polcy memo', 'Policy memo'));
  deadlines.reload();
  const fixed = deadlines.items.find((item) => item.title === 'Policy memo');
  pushes.length = 0;
  const again = await secretary.remind();
  check('a hand-fixed typo keeps its sent reminders', !!fixed && fixed.id !== memo.id && again === 0 && pushes.length === 0
        && deadlines.sentReminders(fixed.id).includes('1d'), JSON.stringify({ fixed, pushes }));
  check('the old id still finds it (Done links keep working)', deadlines.find(memo.id)?.title === 'Policy memo');
  check('a key of the wrong length is refused, the right one checks it off', !secretary.completeFromAction(memo.id, 'short')
        && secretary.completeFromAction(memo.id, actionKey(memo.id)) && deadlines.find(memo.id)?.done === true);
  // Pruning: gone or more than 30 days past.
  clock = at(30, 12);
  deadlines.prune(new Date(2027, 0, 1));
  check('reminder state for items long past is pruned', !deadlines.sentReminders(fixed!.id).length
        && !JSON.parse(readFileSync(join(data, 'typo.json'), 'utf8')).sent[fixed!.id]);
}

// Calendar events that move, get renamed or are cancelled.
{
  const deadlines = freshDeadlines();
  const event = (id: string, title: string, start: Date | string, end?: Date | string) =>
    `${title} (id: ${id})\n   ${typeof start === 'string' ? start : start.toISOString()} → ${
      end ? (typeof end === 'string' ? end : end.toISOString()) : new Date((start as Date).getTime() + 3_600_000).toISOString()}`;
  const calendar = (...events: string[]) => events.map((text, index) => `${index + 1}. ${text}`).join('\n');
  let classified = 0;
  const secretary = makeSecretary(deadlines, { helpers: {
    classify: async (lines: string) => {
      const sorted = lines.split('\n').map((line) => {
        const [id, title] = line.split(' | ');
        classified += 1;
        const kind = /Exam|Quiz/.test(title) ? 'exam' : /due|week/i.test(title) ? 'due' : 'none';
        return { id, kind, title: title.replace(/^[A-Z]+\d+[A-Z]?:\s*/, ''), dueTime: null };
      });
      return JSON.stringify(sorted);
    },
  } });
  clock = at(10, 14);
  const filler = event('e0', 'HIST2100A: The Silk Road', at(12, 10, 5));
  const exam = event('e1', 'POLS1000A: Exam #3', at(12, 10));
  const essay = event('e2', 'HIST2100A: Essay 2 due', at(13, 23, 59));
  const quiz = event('e3', 'SPAN1010B: Quiz 5', at(14, 9));
  const project = event('e4', 'FILM1200A: Project week', '2026-11-16', '2026-11-21');
  calendarText = calendar(filler, exam, essay, quiz, project);
  const added = await secretary.scanCalendar();
  const projectItem = deadlines.items.find((item) => item.title === 'Project week');
  check('adds the calendar deadlines', added === 4 && deadlines.items.length === 4, JSON.stringify(deadlines.items.map((item) => item.line)));
  check('a multi-day all-day event is due on its last day', projectItem?.due === at(20, 23, 59).toISOString(), projectItem?.due);

  calendarText = calendar(filler, event('e1', 'POLS1000A: Exam #3', at(19, 10)), essay, quiz, project);
  await secretary.scanCalendar();
  const exams = deadlines.items.filter((item) => item.title === 'Exam #3');
  check('a moved event updates its deadline instead of adding a second', exams.length === 1 && exams[0].due === at(19, 10).toISOString()
        && deadlines.items.length === 4, JSON.stringify(deadlines.items.map((item) => item.line)));

  calendarText = calendar(filler, event('e1', 'POLS1000A: Exam #3', at(19, 10)), essay, event('e3', 'SPAN1010B: Quiz 5', at(14, 13)), project);
  await secretary.scanCalendar();
  const quizzes = deadlines.items.filter((item) => item.title === 'Quiz 5');
  check('a same-day time change updates the time', quizzes.length === 1 && quizzes[0].due === at(14, 13).toISOString(), JSON.stringify(quizzes));

  const essayItem = deadlines.items.find((item) => item.title === 'Essay 2 due')!;
  deadlines.markSent(essayItem.id, ['3d']);
  calendarText = calendar(filler, event('e1', 'POLS1000A: Exam #3', at(19, 10)), event('e2', 'HIST2100A: Essay 2 final due', at(13, 23, 59)),
                          event('e3', 'SPAN1010B: Quiz 5', at(14, 13)), project);
  await secretary.scanCalendar();
  const renamed = deadlines.items.filter((item) => /Essay 2/.test(item.title));
  check('a renamed event renames its deadline, keeping its sent reminders', renamed.length === 1 && renamed[0].title === 'Essay 2 final due'
        && deadlines.sentReminders(renamed[0].id).includes('3d') && deadlines.find(essayItem.id)?.id === renamed[0].id, JSON.stringify(renamed));

  // Alex checks the essay off and fixes the project's title by hand; then all three are cancelled.
  deadlines.done(renamed[0].id);
  const projectID = deadlines.items.find((item) => item.title === 'Project week')!.id;
  const file = join(data, `deadlines-${deadlineFiles}.md`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Project week', 'Final project week'));
  deadlines.reload();
  calendarText = calendar(filler, event('e1', 'POLS1000A: Exam #3', at(19, 10)));
  await secretary.scanCalendar();
  check('a cancelled event removes its open calendar deadline', !deadlines.items.some((item) => item.title === 'Quiz 5'),
        JSON.stringify(deadlines.items.map((item) => item.line)));
  check('a cancelled event leaves a deadline Alex checked off or edited by hand', deadlines.items.some((item) => /Essay 2/.test(item.title) && item.done)
        && deadlines.find(projectID)?.title === 'Final project week', JSON.stringify(deadlines.items.map((item) => item.line)));

  const before = classified;
  calendarText = 'Failed to fetch calendar events: timeout';
  await secretary.scanCalendar();
  check('a failed calendar fetch cancels nothing', deadlines.items.some((item) => item.title === 'Exam #3') && classified === before);
}

// Only events sorted as deadlines touch one: a lecture or appointment on the same day that moves, is renamed
// or is cancelled leaves the deadlines alone, and so does one sorted before kinds were kept.
{
  const event = (id: string, title: string, start: Date) =>
    `${title} (id: ${id})\n   ${start.toISOString()} → ${new Date(start.getTime() + 3_600_000).toISOString()}`;
  const calendar = (...events: string[]) => events.map((text, index) => `${index + 1}. ${text}`).join('\n');
  let classified = 0;
  const helpers = { classify: async (lines: string) => JSON.stringify(lines.split('\n').map((line) => {
    const [id, title] = line.split(' | ');
    classified += 1;
    return { id, kind: /Exam/.test(title) ? 'exam' : /due/i.test(title) ? 'due' : 'none', title: title.replace(/^[A-Z]+\d+[A-Z]?:\s*/, ''), dueTime: null };
  })) };
  clock = at(10, 14);
  const deadlines = freshDeadlines();
  const secretary = makeSecretary(deadlines, { helpers });
  const essay = event('e2', 'HIST2100A: Essay 2 due', at(13, 23, 59));
  const lecture = event('l1', 'HIST2100A: Lecture', at(13, 10));
  const rent = event('r1', 'Rent due', at(13, 12));
  const dentist = event('d1', 'Dentist', at(13, 15));
  calendarText = calendar(essay, lecture, rent, dentist);
  await secretary.scanCalendar();
  const lines = () => JSON.stringify(deadlines.items.map((item) => item.line));
  check('a lecture and an appointment add no deadline', deadlines.items.length === 2, lines());
  const sorted = classified;
  await secretary.scanCalendar();
  check('events sorted as not deadlines are not sorted again', classified === sorted);

  calendarText = calendar(essay, event('l1', 'HIST2100A: Lecture (moved to Science Hall 210)', at(13, 10)), rent, event('d1', 'Dentist (Dr. Kim)', at(13, 16)));
  await secretary.scanCalendar();
  check("renaming a lecture or appointment on a deadline's day leaves the deadline alone",
        deadlines.items.some((item) => item.title === 'Essay 2 due') && deadlines.items.some((item) => item.title === 'Rent due'), lines());
  calendarText = calendar(essay, rent);
  await secretary.scanCalendar();
  check("cancelling a lecture or appointment on a deadline's day leaves the deadline alone",
        deadlines.items.some((item) => item.title === 'Essay 2 due') && deadlines.items.some((item) => item.title === 'Rent due'), lines());

  calendarText = calendar(essay, event('r1', 'Rent due', at(15, 12)));
  await secretary.scanCalendar();
  const rents = deadlines.items.filter((item) => item.title === 'Rent due');
  check('a moved deadline event still updates its deadline', rents.length === 1 && rents[0].due === at(15, 12).toISOString(), lines());
  calendarText = calendar(event('r1', 'Rent due', at(15, 12)), event('x1', 'Club meeting', at(20, 18)));
  await secretary.scanCalendar();
  check('a cancelled deadline event still removes its deadline', !deadlines.items.some((item) => item.title === 'Essay 2 due')
        && deadlines.items.some((item) => item.title === 'Rent due'), lines());

  // State from before kinds were kept: every event has a stamp, nothing is linked.
  const legacy = freshDeadlines();
  legacy.add({ due: at(13, 23, 59), course: 'HIST2100A', title: 'Essay 2 due', source: 'calendar' });
  legacy.add({ due: at(13, 12), title: 'Rent due', source: 'calendar' });
  const stamp = (title: string, start: Date) => `${title}|${start.toISOString()}`;
  const old = makeSecretary(legacy, { helpers }, {
    calendar: { e2: stamp('HIST2100A: Essay 2 due', at(13, 23, 59)), l1: stamp('HIST2100A: Lecture', at(13, 10)),
                r1: stamp('Rent due', at(13, 12)), d1: stamp('Dentist', at(13, 15)) },
    calendarDeadlines: {}, syllabusFailures: {}, pushedThreads: [], syllabi: {},
  });
  const legacyLines = () => JSON.stringify(legacy.items.map((item) => item.line));
  // The lecture is renamed and the dentist cancelled; the essay moves to Sunday.
  calendarText = calendar(event('e2', 'HIST2100A: Essay 2 due', at(15, 23, 59)), event('l1', 'HIST2100A: Lecture (cancelled, read ch. 4)', at(13, 10)),
                          event('r1', 'Rent due', at(13, 12)));
  await old.scanCalendar();
  const essays = legacy.items.filter((item) => item.title === 'Essay 2 due');
  check('older state: a renamed lecture or cancelled appointment leaves the deadlines alone', legacy.items.some((item) => item.title === 'Rent due'), legacyLines());
  check('older state: a moved deadline event finds its deadline once, by day, course and title', essays.length === 1
        && essays[0].due === at(15, 23, 59).toISOString(), legacyLines());
  calendarText = calendar(event('l1', 'HIST2100A: Lecture (cancelled, read ch. 4)', at(13, 10)), event('r1', 'Rent due', at(13, 12)));
  await old.scanCalendar();
  check('older state: once found, a cancelled deadline event removes it', !legacy.items.some((item) => item.title === 'Essay 2 due')
        && legacy.items.some((item) => item.title === 'Rent due'), legacyLines());
}

// The scheduler: a failure keeps its slot and is retried once; Claude jobs run one at a time.
{
  const file = join(data, 'sched.json');
  clock = at(10, 16, 0);
  let tries = 0;
  let failUntil = 1;
  const make = () => {
    const scheduler = new Scheduler(file, () => clock);
    scheduler.daily('sweep', '16:00', () => {
      tries += 1;
      if (tries <= failUntil) throw new Error('session limit');
    }, 3);
    return scheduler;
  };
  let scheduler = make();
  await scheduler.tick();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  check('a failing job is not recorded as run', tries === 1 && !saved.lastRun.sweep, JSON.stringify(saved));
  clock = at(10, 16, 5);
  scheduler = make();
  await scheduler.tick();
  check('it waits before retrying, across a restart too', tries === 1);
  clock = at(10, 16, 31);
  await scheduler.tick();
  check('a failing job keeps its slot and is retried once', tries === 2 && !!JSON.parse(readFileSync(file, 'utf8')).lastRun.sweep);
  clock = at(10, 17, 30);
  await scheduler.tick();
  check('after a success it does not run again that day', tries === 2);

  rmSync(file);
  tries = 0;
  failUntil = 99;
  clock = at(11, 16, 0);
  scheduler = make();
  await scheduler.tick();
  clock = at(11, 16, 31);
  await scheduler.tick();
  clock = at(11, 17, 31);
  await scheduler.tick();
  check('a job that keeps failing is tried twice, then left for the next slot', tries === 2, String(tries));

  rmSync(file);
  let held = true;
  let heldRuns = 0;
  clock = at(12, 16, 0);
  scheduler = new Scheduler(file, () => clock);
  scheduler.daily('brief', '16:00', () => {
    heldRuns += 1;
    return held ? 'held' : 'sent';
  }, 2);
  await scheduler.tick();
  clock = at(12, 16, 1);
  held = false;
  await scheduler.tick();
  clock = at(12, 16, 2);
  await scheduler.tick();
  check('a held run is looked at again next minute, and counts once it goes', heldRuns === 2, String(heldRuns));

  // Back after downtime: three Claude jobs due at once run one after another, a light one alongside.
  rmSync(file);
  clock = at(13, 9, 0);
  scheduler = new Scheduler(file, () => clock);
  let busy = 0;
  let most = 0;
  const order: string[] = [];
  const heavy = (name: string) => async () => {
    busy += 1;
    most = Math.max(most, busy);
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(name);
    busy -= 1;
  };
  let light = 0;
  scheduler.daily('consolidate', '04:15', heavy('consolidate'), 20, { heavy: true });
  scheduler.daily('morning', '08:00', heavy('morning'), 2, { heavy: true });
  scheduler.daily('sweep-morning', '08:00', heavy('sweep-morning'), 2, { heavy: true });
  scheduler.every('reminders', 5, () => { light += 1; });
  const ran = await scheduler.tick();
  check('catch-up Claude jobs run one at a time, in order', ran.length === 4 && most === 1 && light === 1
        && order.join(',') === 'consolidate,morning,sweep-morning', JSON.stringify({ ran, most, order }));
}

// Syllabi: size counts as a change, a bad read is retried at most 3 times, and a night push waits.
{
  pushes.length = 0;
  const deadlines = freshDeadlines();
  let reads = 0;
  let reply = 'not json';
  const secretary = makeSecretary(deadlines, { helpers: { readSyllabus: async () => {
    reads += 1;
    return reply;
  } } });
  mkdirSync(paths.syllabi, { recursive: true });
  const file = join(paths.syllabi, 'HIST2100A_syllabus.pdf');
  writeFileSync(file, 'v1');
  clock = at(10, 14);
  await secretary.scanSyllabi();
  const { mtime } = statSync(file);
  writeFileSync(file, 'version 2');
  utimesSync(file, mtime, mtime);
  await secretary.scanSyllabi();
  check('a syllabus with the same time but a new size counts as changed', reads === 1, String(reads));
  await secretary.scanSyllabi();
  await secretary.scanSyllabi();
  await secretary.scanSyllabi();
  check('a syllabus that will not parse stops being retried after 3 tries', reads === 3, String(reads));
  writeFileSync(file, 'version three');
  reply = JSON.stringify([{ date: '2026-12-01', time: null, title: 'Final paper', exam: false }]);
  clock = at(10, 23, 30);
  const found = await secretary.scanSyllabi();
  check('a changed file is read again, and its push at night is held, not dropped', reads === 4 && found === 1 && pushes.length === 0
        && notifier.held().some((push) => push.kind === 'syllabus'), JSON.stringify({ reads, found, held: notifier.held() }));
  notifier.release(notifier.held());
}

// The evening check-in after a restart still knows today's calendar.
{
  pushes.length = 0;
  voiced = [];
  fakeToday.events = { state: 'idle' };
  const secretary = makeSecretary(freshDeadlines());
  clock = at(10, 21);
  await secretary.checkIn();
  check('the check-in loads the calendar after a restart', fakeToday.events.state === 'loaded' && voiced.some((facts) => facts.includes('Exam #3')),
        JSON.stringify(voiced));
}

// The sweep: given the calendar, inbox and to-dos; its tools are scoped; a push repeating the list is dropped.
{
  pushes.length = 0;
  const deadlines = freshDeadlines();
  deadlines.add({ due: at(13, 23, 59), course: 'POLS1000A', title: 'Exam #3', exam: true });
  let input = '';
  let reply: any = {};
  const secretary = makeSecretary(deadlines, {
    todos: { items: ['Spanish HW 5.2'], summary: '- Spanish HW 5.2' },
    helpers: { sweep: async (text: string) => {
      input = text;
      return JSON.stringify(reply);
    } },
  });
  clock = at(10, 16);
  reply = { push: { title: 'Spanish HW', body: "Spanish HW 5.2 and 5.3 weren't on your list." }, note: 'Looked at email.' };
  const repeat = await secretary.sweep();
  check('the sweep is handed the calendar, inbox and to-do list', input.includes('<calendar_next_7_days>') && input.includes('Office hours moved')
        && input.includes('<my_todo_list>\n- Spanish HW 5.2'), input.slice(0, 400));
  check('a sweep push about something already on the list is dropped', repeat.pushed === 'repeat' && pushes.length === 0, JSON.stringify({ repeat, pushes }));
  reply = { push: { title: 'Exam moved', body: 'Prof. Smith moved the HIST exam to Friday. I added it; confirm in Dash.' },
            deadlines: [{ date: '2026-11-13', time: '09:00', course: 'HIST2100A', title: 'Exam (moved)', exam: true }] };
  const news = await secretary.sweep();
  check('a push about something it just added still goes out', news.pushed === 'sent' && pushes.length === 1, JSON.stringify({ news, pushes }));
  check("the sweep's tools: memory folder only, no web search, no writes", sweepProfile.cwd === MEMORY_DIR && !sweepProfile.addDirs?.length
        && !sweepProfile.allowedTools!.some((tool) => tool === 'Read' || /web_search|file_read/.test(tool))
        && ['web_search', 'email_send', 'calendar_create', 'file_read', 'browser_navigate', 'lecture_start']
          .every((tool) => sweepProfile.disallowedTools!.includes(`mcp__jarvis__${tool}`))
        && sweepProfile.disallowedTools!.includes(`Read(/${join(DATA, 'secrets')}/**)`), JSON.stringify(sweepProfile));
}

rmSync(data, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll secretary checks passed');
process.exit(failures ? 1 : 0);
