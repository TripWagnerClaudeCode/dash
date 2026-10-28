// All-day events, "today" and the brief's clock are Eastern, wherever the hub runs.
process.env.TZ ??= 'America/New_York';

import { execFile } from 'node:child_process';
import { statfsSync } from 'node:fs';

import { Chats } from './chats.ts';
import { ClaudeSession } from './claude.ts';
import { consolidatePending } from './consolidate.ts';
import { Deadlines } from './deadlines.ts';
import { Devices } from './devices.ts';
import { Health } from './health.ts';
import { Jarvis, jarvisInstalled } from './jarvis.ts';
import { log } from './log.ts';
import { Memory } from './memory.ts';
import { Notifier } from './notify.ts';
import { DATA, HUB_NAME, PORT } from './paths.ts';
import { Portfolio } from './portfolio/portfolio.ts';
import { RobinhoodRelay } from './portfolio/relay.ts';
import { RobinhoodClient } from './portfolio/robinhood.ts';
import { Secretary } from './proactive.ts';
import { Scheduler } from './scheduler.ts';
import { HubServer } from './server.ts';
import { Today } from './today.ts';
import { ToDoList } from './todo.ts';
import { Usage } from './usage.ts';

const started = new Date();
const jarvis = new Jarvis();
const memory = new Memory();
const todos = new ToDoList();
todos.watch();
const deadlines = new Deadlines();
deadlines.watch();
const today = new Today(jarvis, todos, memory, deadlines);
const notifier = new Notifier({ memory });
const usage = new Usage();
const devices = new Devices();
const chats = new Chats();
chats.setMemory(memory);
const robinhood = new RobinhoodClient();
const portfolio = new Portfolio(robinhood);
// The advisor's read-only Robinhood relay listens on 127.0.0.1 from launch; it only works once connected.
const relay = new RobinhoodRelay(robinhood);
let relayEntry: Record<string, unknown> | undefined;
relay.start().then((entry) => { relayEntry = entry; }, (error) => log(`robinhood relay failed: ${error.message}`));
chats.setAdvisor({ relay: () => (robinhood.isConnected ? relayEntry : undefined), snapshot: () => portfolio.reviewData() });
portfolio.start();
const monitor = new Health({ jarvis, robinhood, portfolio });
monitor.start();

/** What's working, for /health and the apps' status line. */
function health() {
  const google = [today.events, today.inbox].find((load) => load.state === 'failed');
  let freeGB: number | undefined;
  try {
    const stats = statfsSync(DATA);
    freeGB = Math.round((stats.bavail * stats.bsize) / 1e9);
  } catch {}
  return {
    hub: HUB_NAME,
    started: started.toISOString(),
    jarvis: jarvisInstalled() ? (jarvis.isRunning ? 'running' : 'idle') : 'missing',
    google: google?.state === 'failed' ? google.error : 'ok',
    claude: monitor.problems.find((problem) => problem.key === 'claude')?.text ?? 'ok',
    robinhood: robinhood.isConnected ? (portfolio.error ?? 'ok') : 'not connected',
    diskFreeGB: freeGB,
    connected: server.connected.map((device) => device.name),
    lectureReady: server.lectureReady,
    problems: monitor.problems.map((problem) => problem.key),
  };
}

/** This machine's Tailscale address, for the phone app's Expo Go link. Checked again every few minutes. */
let tailscaleIP: string | undefined;
function lookUpTailscaleIP() {
  execFile('tailscale', ['ip', '-4'], (error, stdout) => {
    if (!error) tailscaleIP = stdout.split('\n')[0].trim() || undefined;
  });
}
lookUpTailscaleIP();
setInterval(lookUpTailscaleIP, 5 * 60_000).unref();
const appURL = () => (tailscaleIP ? `exp://${tailscaleIP}:8081` : undefined);

const secretary = new Secretary({ deadlines, notifier, memory, today, jarvis, chats, todos, appURL, hubURL: process.env.DASH_PUBLIC_URL });
const server = new HubServer({ devices, today, todos, usage, chats, health, appURL, portfolio, robinhood, monitor, memory, deadlines, notifier,
                               completeFromAction: (item, key) => secretary.completeFromAction(item, key) });
server.start(PORT);

// Every night the day's conversations become a journal entry and an updated core memory. Days missed
// while the hub was off are caught up on the next run. Jobs marked heavy are Claude sessions, run one at a time.
const scheduler = new Scheduler();
scheduler.daily('consolidate', '04:15', () => consolidatePending(memory, chats), 20, { heavy: true });
// Dash as secretary: deadlines in from the calendar and new syllabi, reminders and nudges out to the phone.
scheduler.every('calendar', 180, () => secretary.scanCalendar());
scheduler.every('syllabi', 60, () => secretary.scanSyllabi(), { heavy: true });
// Nothing is pushed from 11 PM to 8 AM; the first reminders run after 8 sends what waited overnight.
scheduler.every('reminders', 5, () => secretary.remind());
scheduler.daily('morning', '08:00', () => secretary.morning(), 2, { heavy: true });
scheduler.daily('follow-up', '12:30', () => secretary.followUp(), 4);
scheduler.daily('check-in', '21:00', () => secretary.checkIn(), 1);
// Dash looks around on his own twice a day (8 AM and 4 PM) and pushes only if something's worth it.
// The morning one queues behind the brief, so it reuses the calendar and inbox the brief just loaded.
scheduler.daily('sweep-morning', '08:00', () => secretary.sweep(), 2, { heavy: true });
scheduler.daily('sweep', '16:00', () => secretary.sweep(), 3, { heavy: true });
scheduler.start();
log(`hub ${HUB_NAME} started, data in ${DATA}`);

function shutdown(signal: string) {
  log(`hub stopping (${signal})`);
  server.stop();
  scheduler.stop();
  todos.stop();
  deadlines.stop();
  chats.closeAll();
  relay.stop();
  ClaudeSession.closeAll();
  jarvis.shutdown();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Keep serving through a bug in one request; systemd restarts the hub if it really dies.
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error.message}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${(error as Error)?.stack ?? String(error)}`));
