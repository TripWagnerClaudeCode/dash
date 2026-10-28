/**
 * The hub's connection rules: the unknown_token code on hello (contract A), the `ping` request, pairing
 * roles and wrong-guess limits, the heartbeat that drops dead connections (with a 100 ms interval), live
 * chat events only for apps showing that chat, /health's version, and an on-purpose Robinhood disconnect.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const data = mkdtempSync(join(tmpdir(), 'dash-server-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';
const port = 47991;

const { paths } = await import('../paths.ts');
for (const path of [paths.syllabi, paths.aboutMe, paths.brightspace, paths.outputDir]) {
  if (!path.startsWith(data)) { console.error(`server.test: ${path} is outside the test folder; stopping`); process.exit(1); }
}
const { Devices } = await import('../devices.ts');
const { HubServer } = await import('../server.ts');
const { Today } = await import('../today.ts');
const { ToDoList } = await import('../todo.ts');
const { Usage } = await import('../usage.ts');
const { Chats } = await import('../chats.ts');
const { Memory } = await import('../memory.ts');
const { Deadlines } = await import('../deadlines.ts');
const { Health, hubVersion } = await import('../health.ts');
const { RobinhoodClient } = await import('../portfolio/robinhood.ts');
const { Portfolio } = await import('../portfolio/portfolio.ts');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TestClient {
  socket: WebSocket;
  events: { event: string; data: any }[] = [];
  closed: Promise<number>;
  private nextID = 1;
  private waiting = new Map<number, (reply: any) => void>();

  /** `autoPong: false` plays a phone that went to sleep: the socket stays open but never answers pings. */
  constructor(options: { autoPong?: boolean } = {}) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: options.autoPong ?? true });
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

  isOpen() {
    return this.socket.readyState === this.socket.OPEN;
  }
}

async function connect(options: { autoPong?: boolean } = {}) {
  const client = new TestClient(options);
  await client.opened();
  return client;
}

const fakeJarvis = { isRunning: true, call: async () => '', shutdown() {} };
const memory = new Memory();
const deadlines = new Deadlines();
const devices = new Devices();
const todos = new ToDoList();
const today = new Today(fakeJarvis as any, todos, memory, deadlines);
const usage = new Usage();
const realChats = new Chats();
// A chats index that can be made to fail, for a hello that fails for a reason other than the token.
let brokenIndex = false;
const chats = Object.create(realChats) as typeof realChats;
chats.list = () => {
  if (brokenIndex) throw new Error('The chats index is unreadable.');
  return realChats.list();
};
const robinhood = new RobinhoodClient();
const portfolio = new Portfolio(robinhood);
const monitor = new Health({ jarvis: fakeJarvis as any, robinhood, portfolio, claude: async () => undefined });
const server = new HubServer({ devices, today, todos, usage, chats, health: () => ({ ok: true }), appURL: () => undefined,
                               portfolio, robinhood, memory, deadlines, monitor }, { heartbeat: 100 });
server.start(port);
await sleep(200);

try {
  // Contract A: only an unknown token carries code "unknown_token".
  const stranger = await connect();
  const pinged = await stranger.request('ping');
  check('ping answers {} even before sign-in', pinged.ok && JSON.stringify(pinged.result) === '{}', JSON.stringify(pinged));
  const unknown = await stranger.request('hello', { token: 'not-a-token' });
  check('hello with an unknown token says code "unknown_token"', !unknown.ok && unknown.code === 'unknown_token' && typeof unknown.error === 'string',
        JSON.stringify(unknown));
  const refused = await stranger.request('todo.get');
  check('other refusals carry no code', !refused.ok && !('code' in refused));

  // Pairing: the code decides the role. A phone code can't make a Mac.
  const phoneCode = devices.startPairing('phone').code;
  const fakeMac = await connect();
  const asMac = await fakeMac.request('pair', { code: phoneCode, name: 'Sneaky', role: 'mac' });
  check('a phone code cannot register a Mac', !asMac.ok && !('code' in asMac) && devices.devices.length === 0, JSON.stringify(asMac));
  const phone = await connect();
  const phonePaired = await phone.request('pair', { code: phoneCode, name: 'Test iPhone' });
  check('the same code still pairs the phone, as a phone', phonePaired.ok && devices.devices[0]?.role === 'phone');
  const macCode = devices.startPairing('mac').code;
  const phoneWithMacCode = await connect();
  const downgraded = await phoneWithMacCode.request('pair', { code: macCode, name: 'Other phone' });
  check("an app that doesn't say it's a Mac pairs as a phone, even with a Mac code", downgraded.ok && devices.devices.at(-1)?.role === 'phone');
  phoneWithMacCode.socket.close();
  const macCode2 = devices.startPairing('mac').code;
  const mac = await connect();
  const macPaired = await mac.request('pair', { code: macCode2, name: 'Test Mac', role: 'mac' });
  check('a Mac code pairs the Mac', macPaired.ok && devices.devices.at(-1)?.role === 'mac');
  const started = await mac.request('pair.start');
  check("the Mac's Settings issue phone codes", started.ok && started.result.role === 'phone');

  // Wrong guesses: a few close that connection, but don't void Alex's code.
  const code = started.result.code as string;
  const guesser = await connect();
  for (const guess of ['000001', '000002', '000003']) await guesser.request('pair', { code: guess === code ? '999999' : guess, name: 'x' });
  const guesserClosed = await Promise.race([guesser.closed, sleep(1000).then(() => -1)]);
  check('three wrong codes close the connection', guesserClosed === 4003, String(guesserClosed));
  const lateGuesser = await connect();
  const stillGood = await lateGuesser.request('pair', { code, name: 'Real phone' });
  check("a stranger's wrong guesses don't void the code", stillGood.ok);
  lateGuesser.socket.close();
  const counted = new Devices(join(data, 'other-devices.json'));
  const fresh = counted.startPairing('phone').code;
  for (let i = 0; i < 30; i++) counted.pair(fresh === '000000' ? '111111' : '000000', 'x');
  check('many wrong guesses in all do void the code', counted.pair(fresh, 'x') === 'no-code');

  // A hello that fails for another reason (a broken chats index) has no code, so the apps stay paired.
  brokenIndex = true;
  const unlucky = await connect();
  const failedHello = await unlucky.request('hello', { token: phonePaired.result.token });
  brokenIndex = false;
  check('a hello failing for another reason has no code', !failedHello.ok && !('code' in failedHello), JSON.stringify(failedHello));
  unlucky.socket.close();

  // Heartbeat: an app that stops answering pings is dropped, and so is its Portfolio watch.
  const sleeper = await connect({ autoPong: false });
  await sleeper.request('hello', { token: phonePaired.result.token });
  await sleeper.request('portfolio.watch', { on: true });
  const watching = (portfolio as any).watchers;
  const dropped = await Promise.race([sleeper.closed.then(() => true), sleep(1500).then(() => false)]);
  check('a connection that misses two pongs is terminated', dropped);
  await sleep(50);
  check("its Portfolio watch ends with it (Robinhood stops fast polling)", watching === 1 && (portfolio as any).watchers === 0,
        `${watching} → ${(portfolio as any).watchers}`);
  check('live connections that answer pings stay', phone.isOpen() && mac.isOpen());

  // Live chat events go only to apps that opened (or used) that chat; the list still reaches everyone.
  const chatID = crypto.randomUUID().toUpperCase();
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(paths.chats, `${chatID}.json`), JSON.stringify({
    meta: { id: chatID, title: 'Essay plan', titleIsCustom: false, createdAt: stamp, updatedAt: stamp, sessionID: chatID, sessionStarted: true,
            effort: 'medium', permissionMode: 'default' },
    turns: [{ id: 'T1', role: 'user', text: 'Plan my essay' }, { id: 'T2', role: 'assistant', text: 'Sure.' }] }));
  const opened = await phone.request('chat.open', { chat: chatID.toLowerCase() });
  check('the phone opens the chat', opened.ok && opened.result.turns.length === 2);
  phone.events.length = 0;
  mac.events.length = 0;
  await phone.request('chat.rename', { chat: chatID, title: 'Essay plan v2' });
  await sleep(400);
  check('the app showing the chat gets its live event', phone.events.some((event) => event.event === 'chat' && event.data.id === chatID));
  check("an app not showing it doesn't, but gets the list", !mac.events.some((event) => event.event === 'chat')
        && mac.events.some((event) => event.event === 'chats' && event.data.chats.some((meta: any) => meta.title === 'Essay plan v2')));

  // /health and health.get carry the deployed version (VERSION next to src/, 'dev' without one).
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const viaSocket = await mac.request('health.get');
  check('/health includes the version', typeof health.version === 'string' && health.version === hubVersion() && health.version.length > 0
        && viaSocket.result.version === health.version, JSON.stringify(health));

  // Disconnecting Robinhood on purpose leaves no "sign-in ended" problem behind.
  monitor.problems = [{ key: 'robinhood', text: 'The Robinhood sign-in ended.', since: stamp }];
  const disconnected = await mac.request('portfolio.disconnect');
  check('an on-purpose Robinhood disconnect clears the banner', disconnected.ok && !monitor.problems.some((problem) => problem.key === 'robinhood'));
  await monitor.check();
  check('and the next health check finds no Robinhood problem', !monitor.problems.some((problem) => problem.key === 'robinhood'),
        JSON.stringify(monitor.problems));

  for (const client of [stranger, fakeMac, phone, guesser, mac]) client.socket.close();
} catch (error) {
  check('server.test ran to the end', false, (error as Error).stack ?? String(error));
} finally {
  server.stop();
  todos.stop();
  realChats.closeAll();
  await sleep(100);
  rmSync(data, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll server checks passed');
process.exit(failures ? 1 : 0);
