import { existsSync, unlinkSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';

import { ADVISOR_ID, type Chats } from './chats.ts';
import { type Deadlines } from './deadlines.ts';
import { type Device, type Devices, type Role } from './devices.ts';
import { type Health, hubVersion } from './health.ts';
import { log } from './log.ts';
import { type Memory, type Source } from './memory.ts';
import { type Notifier } from './notify.ts';
import { profile, prompt } from './personal.ts';
import { type Portfolio } from './portfolio/portfolio.ts';
import { type RobinhoodClient } from './portfolio/robinhood.ts';
import { ADMIN_SOCKET, HUB_NAME } from './paths.ts';
import { listSkills } from './skills.ts';
import { type Today } from './today.ts';
import { type ToDoList } from './todo.ts';
import { type Usage } from './usage.ts';

type Client = {
  socket: WebSocket; device?: Device; watchingPortfolio?: boolean;
  /** Heartbeat pings sent since the last sign of life (a pong or any message). */
  missed: number;
  /** Wrong pairing codes tried on this connection. */
  wrongCodes: number;
  /** Chats this app has opened or used: only these get live `chat` events (newest last). */
  chats: Set<string>;
};
type Handler = (message: Record<string, any>, client: Client) => Promise<unknown> | unknown;

/** A refusal. `code` is for the apps to act on (only "unknown_token" so far); the text is for the user. */
class Failure extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Each kind of event goes out at most this often; changes arrive in bursts (a streaming brief, a reload). */
const COALESCE = 200;
/** A connection that never says who it is doesn't get to sit there. */
const SIGN_IN_WINDOW = 15_000;
/** Every connection is pinged this often; one that misses two pongs in a row is dead and is dropped. */
const HEARTBEAT = 30_000;
const MAX_MISSED = 2;
/** Wrong pairing codes one connection may try before it's closed. */
const MAX_WRONG_CODES = 3;
/** An app this far behind on reading (asleep, or gone without closing) is dropped rather than buffered for. */
const MAX_BUFFERED = 8 << 20;
/** How many chats per connection get live events; an app shows one or two at a time. */
const MAX_WATCHED_CHATS = 16;

export type HubParts = {
  devices: Devices; today: Today; todos: ToDoList; usage: Usage; chats: Chats; health: () => Record<string, unknown>;
  portfolio: Portfolio; robinhood: RobinhoodClient;
  /** Optional so tests can leave it out. */
  monitor?: Health;
  memory?: Memory;
  deadlines?: Deadlines;
  notifier?: Notifier;
  /** A notification's Done button (POST /action/done?item=…&key=…). True if it checked something off. */
  completeFromAction?: (item: string, key: string) => boolean;
  /** The Expo Go address the phone app loads from ("exp://100.x.y.z:8081"), once Tailscale has an address. */
  appURL: () => string | undefined;
};

/**
 * The way into Dash for the phone and Mac Dash (ported from DashHub.swift): a WebSocket server on
 * 127.0.0.1 that `tailscale serve` publishes to the user's own devices. Nothing listens on a network
 * interface, so the hub can't be reached from the LAN or the internet.
 *
 * One JSON message per WebSocket frame:
 *   app → hub  {"id": 7, "type": "todo.add", "text": "…"}
 *   hub → app  {"re": 7, "ok": true, "result": {…}}  or  {"re": 7, "ok": false, "error": "…"}
 *   hub → app  {"event": "todo", "data": {…}}        pushed whenever something changes
 * A connection must send `pair` or `hello` first; anything else is refused until it does.
 */
export class HubServer {
  private http?: Server;
  private admin?: Server;
  private sockets?: WebSocketServer;
  private clients = new Set<Client>();
  private pending = new Set<string>();
  private handlers: Record<string, Handler> = {};
  private heartbeat?: NodeJS.Timeout;
  private readonly heartbeatEvery: number;
  private readonly parts: HubParts;
  /**
   * Lecture recording runs on the Mac (its microphone), so the hub only relays: the Mac reports its
   * recorder's state, and Start/Stop from the phone are passed on to that Mac.
   */
  private lecture: { mac?: Client; report: Record<string, unknown> } = { report: {} };

  /** `heartbeat` (milliseconds) is for tests; the hub pings every 30 seconds. */
  constructor(parts: HubParts, options: { heartbeat?: number } = {}) {
    this.parts = parts;
    this.heartbeatEvery = options.heartbeat ?? HEARTBEAT;
    const { devices, today, todos, usage, chats } = parts;

    this.handlers = {
      'today.get': () => {
        today.refreshIfStale();
        return today.snapshot();
      },
      'today.refresh': () => {
        today.refresh();
        return {};
      },
      'today.brief': () => {
        if (!today.canBrief) throw new Failure('Today is still loading, or a brief is already being written.');
        today.writeBrief();
        return {};
      },
      'todo.get': () => {
        todos.reload();
        return this.todoSnapshot();
      },
      'todo.add': (message) => {
        todos.add(String(message.text ?? ''));
        return this.todoSnapshot();
      },
      'todo.remove': (message) => {
        todos.remove(String(message.text ?? ''));
        return this.todoSnapshot();
      },
      'usage.get': () => {
        usage.refreshIfStale();
        return usage.snapshot;
      },
      // Mac Dash forwards the usage numbers from its own Claude calls (lens, lecture notes).
      'usage.report': (message) => {
        if (message.info && typeof message.info === 'object') usage.update(message.info);
        return {};
      },
      'health.get': () => ({ ...parts.health(), version: hubVersion() }),
      'health.problems': () => parts.monitor?.snapshot() ?? { problems: [] },
      // Chats. Parameters are named `chat`, `request`, `turn`… because `id` is the request's own id.
      'chat.list': () => chats.list(),
      'chat.open': (message) => chats.open(message.chat),
      'chat.send': (message, client) => {
        const result = chats.send(message.chat, String(message.text ?? ''), arrayOf(message.blocks),
                                  arrayOf(message.attachments).map(String), message.settings ?? {});
        this.watchChat(client, result.chat);
        return result;
      },
      'chat.stop': (message) => {
        chats.stop(message.chat);
        return {};
      },
      'chat.decide': (message) => {
        chats.decide(message.chat, message.request, message.allow === true, message.always === true);
        return {};
      },
      'chat.unqueue': (message) => {
        chats.unqueue(message.chat, message.queued);
        return {};
      },
      'chat.retry': (message) => {
        chats.retry(message.chat, message.turn);
        return {};
      },
      'chat.rename': (message) => {
        chats.rename(message.chat, String(message.title ?? ''));
        return chats.list();
      },
      'chat.delete': (message) => {
        chats.delete(message.chat);
        return chats.list();
      },
      'chat.settings': (message) => {
        chats.settings(message.chat, message.settings ?? {});
        return {};
      },
      'skills.list': () => ({ skills: listSkills() }),
      // Who the user is and the Study page's links, from ~/.dash-shared/profile.json. `name` is null until it's set.
      'profile.get': () => {
        const user = profile();
        return { name: user.named ? user.name : null, links: user.links, studyApps: user.studyApps };
      },
      // Deadlines and exams (deadlines.md): the Today card lists them; unconfirmed ones (from a syllabus) wait for a yes.
      'deadlines.get': () => this.deadlines().snapshot(),
      'deadlines.add': (message) => {
        const due = new Date(String(message.due ?? ''));
        if (Number.isNaN(due.getTime()) || !String(message.title ?? '').trim()) throw new Failure('A deadline needs a title and a date.');
        this.deadlines().add({ due, title: String(message.title), course: message.course ? String(message.course) : undefined,
                               exam: message.exam === true, source: 'Dash' });
        return this.deadlines().snapshot();
      },
      'deadlines.confirm': (message) => this.changeDeadline(() => this.deadlines().confirm(String(message.item ?? ''))),
      'deadlines.done': (message) => this.changeDeadline(() => this.deadlines().done(String(message.item ?? ''))),
      'deadlines.dismiss': (message) => this.changeDeadline(() => this.deadlines().dismiss(String(message.item ?? ''))),
      // Settings › Notifications: where the phone's ntfy app subscribes, and a test push.
      'notify.setup': () => parts.notifier?.subscription ?? { server: '', topic: '' },
      'notify.test': async () => {
        if (!parts.notifier?.configured) throw new Failure("Notifications aren't set up on the hub yet.");
        // Tapping it should open Dash in Expo Go, like the real ones.
        const app = parts.appURL();
        const result = await parts.notifier.send({ kind: 'test', title: 'Dash', urgent: true, ...(app ? { click: `${app}/--/` } : {}),
                                                   body: 'Testing, testing. Tap this to open Dash.' });
        if (result !== 'sent') throw new Failure("The hub couldn't send it. Check that ntfy is running on the hub.");
        return {};
      },
      // Dash's memory. The Mac logs lens questions and lectures here; the apps show and prune it.
      'memory.get': () => this.memory().snapshot(),
      // The Mac sends its whole queue (up to 500) and drops the first `accepted` entries once the reply comes.
      // Entries carry an id, so a batch sent again after a lost reply isn't logged twice.
      'memory.log': (message, client) => {
        // A single entry is the message itself, whose `id` is the request's, not the entry's.
        const entries: any[] = Array.isArray(message.entries) ? message.entries.slice(0, 500) : [{ ...message, id: undefined }];
        for (const raw of entries) {
          const entry = raw && typeof raw === 'object' ? raw : {};
          this.memory().log({ source: String(entry.source ?? 'note') as Source, kind: String(entry.kind ?? 'note'), text: String(entry.text ?? ''),
                              ...(entry.at ? { at: String(entry.at) } : {}), ...(entry.title ? { title: String(entry.title) } : {}),
                              ...(typeof entry.id === 'string' && entry.id ? { id: entry.id } : {}), device: client.device?.name });
          // A "remember…" line the Mac saved while unpaired belongs in remember.md as well as the log.
          if (entry.kind === 'remember') this.memory().addRemember(String(entry.text ?? ''));
        }
        return { accepted: entries.length };
      },
      'memory.forget': (message) => {
        try {
          this.memory().forget(String(message.file ?? ''), String(message.line ?? ''), message.day ? String(message.day) : undefined);
        } catch (error) {
          throw new Failure((error as Error).message);
        }
        return this.memory().snapshot();
      },
      // What the Mac's lens knows about the user: a short persona and the memory, to add to its system prompt.
      'memory.context': () => ({ persona: prompt('lens'), memory: this.memory().lensContext() }),
      // Portfolio. Prices poll fast while any app is watching; signing in goes through a Mac's browser.
      'portfolio.get': () => parts.portfolio.snapshot(),
      'portfolio.watch': (message, client) => {
        const on = message.on === true;
        if (on !== !!client.watchingPortfolio) {
          client.watchingPortfolio = on;
          parts.portfolio.watch(on);
        }
        return parts.portfolio.snapshot();
      },
      'portfolio.refresh': () => {
        parts.portfolio.refreshNow();
        return {};
      },
      'portfolio.connect': (_message, client) => {
        requireMac(client);
        return parts.robinhood.startConnect();
      },
      'portfolio.callback': async (message, client) => {
        requireMac(client);
        await parts.robinhood.finishConnect(message.query ?? {});
        log('robinhood: connected');
        parts.portfolio.refreshNow();
        this.schedule('portfolio');
        return {};
      },
      'portfolio.disconnect': (_message, client) => {
        requireMac(client);
        parts.portfolio.disconnect();
        // On purpose, so no "sign-in ended" banner or email.
        parts.monitor?.robinhoodDisconnected();
        return {};
      },
      // "New session" on the advisor: forget the conversation (the investor profile stays).
      'advisor.reset': () => {
        try {
          chats.delete(ADVISOR_ID);
        } catch (error) {
          if (!/doesn't exist/.test((error as Error).message)) throw error;
        }
        return {};
      },
      'lecture.get': () => this.lectureSnapshot(),
      'lecture.report': (message, client) => {
        requireMac(client);
        this.lecture = { mac: client, report: message.state ?? {} };
        this.schedule('lecture');
        return {};
      },
      'lecture.start': (message) => this.toMac({ type: 'lecture.start', course: String(message.course ?? '') }),
      'lecture.stop': () => this.toMac({ type: 'lecture.stop' }),
      // Pairing and device management happen from Mac Dash's Settings.
      // Settings › Pair a Phone. A code is for a phone unless the Mac asks for one for another Mac.
      'pair.start': (message, client) => {
        requireMac(client);
        const { code, expires, role } = devices.startPairing(message.role === 'mac' ? 'mac' : 'phone');
        return { code, expires: expires.toISOString(), role };
      },
      'devices.list': (_message, client) => {
        requireMac(client);
        return this.devicesSnapshot();
      },
      'devices.remove': (message, client) => {
        requireMac(client);
        if (message.device === client.device?.id) throw new Failure("This is the device you're using. Remove it from another one.");
        devices.remove(String(message.device ?? ''));
        return this.devicesSnapshot();
      },
    };

    today.onChange(() => this.schedule('today'));
    todos.onChange(() => this.schedule('todo'));
    usage.onChange(() => this.schedule('usage'));
    chats.onIndex(() => this.schedule('chats'));
    parts.portfolio.onChange(() => this.schedule('portfolio'));
    parts.monitor?.onChange(() => this.schedule('health'));
    parts.deadlines?.onChange(() => this.schedule('deadlines'));
    chats.onChat((id) => this.schedule(`chat:${id}`));
    // Removing a device ends its connection too.
    devices.onChange(() => {
      const ids = new Set(devices.devices.map((device) => device.id));
      for (const client of this.clients) {
        if (client.device && !ids.has(client.device.id)) client.socket.close(4001, 'Removed');
      }
      this.schedule('devices');
    });
  }

  start(port: number) {
    this.http = createServer((request, response) => {
      if (request.method === 'POST' && request.url?.startsWith('/action/done?')) {
        const query = new URL(request.url, 'http://hub').searchParams;
        const ok = this.parts.completeFromAction?.(query.get('item') ?? '', query.get('key') ?? '') ?? false;
        response.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' }).end(ok ? 'Done' : 'Not found');
      } else if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...this.parts.health(), version: hubVersion() }));
      } else {
        response.writeHead(404).end();
      }
    });
    this.sockets = new WebSocketServer({ server: this.http, maxPayload: 32 << 20 });
    this.sockets.on('connection', (socket) => this.accept(socket));
    this.http.on('error', (error) => log(`hub couldn't listen: ${error.message}`));
    this.http.listen(port, '127.0.0.1', () => log(`hub listening on 127.0.0.1:${port}`));
    this.startAdmin();
    this.heartbeat = setInterval(() => this.checkAlive(), this.heartbeatEvery);
    this.heartbeat.unref();
  }

  stop() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.socket.close(1001, 'Hub restarting');
    this.sockets?.close();
    this.http?.close();
    this.admin?.close();
  }

  /** Whether a Mac is connected and has reported its lecture recorder (for /health). */
  get lectureReady() {
    return !!this.lecture.mac;
  }

  get connected() {
    return [...this.clients].flatMap((client) => (client.device ? [client.device] : []));
  }

  /**
   * Local admin commands over a Unix socket (`npm run pair`), for pairing the first device. The socket
   * file is only reachable by the user's account on the hub, and Tailscale never sees it. Its codes are for a
   * Mac unless `?role=phone` says otherwise.
   */
  private startAdmin() {
    if (existsSync(ADMIN_SOCKET)) unlinkSync(ADMIN_SOCKET);
    this.admin = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://hub');
      if (request.method === 'POST' && url.pathname === '/pair') {
        const { code, expires, role } = this.parts.devices.startPairing(url.searchParams.get('role') === 'phone' ? 'phone' : 'mac');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code, expires: expires.toISOString(), role }));
      } else {
        response.writeHead(404).end();
      }
    });
    this.admin.listen(ADMIN_SOCKET);
  }

  // Connections

  private accept(socket: WebSocket) {
    const client: Client = { socket, missed: 0, wrongCodes: 0, chats: new Set() };
    this.clients.add(client);
    socket.on('pong', () => { client.missed = 0; });
    socket.on('message', (data, isBinary) => {
      client.missed = 0;
      if (isBinary) return;
      let message: Record<string, any>;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message && typeof message === 'object') this.handle(message, client);
    });
    socket.on('close', () => {
      if (!this.clients.delete(client)) return;
      client.chats.clear();
      if (client.device) this.schedule('devices');
      // Fast Robinhood polling is only for apps that are really there with Portfolio open.
      if (client.watchingPortfolio) {
        client.watchingPortfolio = false;
        this.parts.portfolio.watch(false);
      }
      if (this.lecture.mac === client) {
        this.lecture.mac = undefined;
        this.schedule('lecture');
      }
    });
    socket.on('error', () => socket.terminate());
    setTimeout(() => {
      if (!client.device) socket.terminate();
    }, SIGN_IN_WINDOW).unref();
  }

  private send(client: Client, object: unknown) {
    if (client.socket.readyState !== client.socket.OPEN) return;
    // An app that stopped reading would otherwise have every event piled up in memory for it.
    if (client.socket.bufferedAmount > MAX_BUFFERED) {
      log(`hub dropped ${client.device?.name ?? 'a connection'}: too far behind`);
      client.socket.terminate();
      return;
    }
    client.socket.send(JSON.stringify(object));
  }

  /** Pings every connection; one that missed the last two pings is gone (asleep, or off the network) and is dropped. */
  private checkAlive() {
    for (const client of this.clients) {
      if (client.missed >= MAX_MISSED) {
        log(`hub dropped ${client.device?.name ?? 'a connection'}: no answer to ${MAX_MISSED} pings`);
        client.socket.terminate();
        continue;
      }
      client.missed += 1;
      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }
  }

  /** From now on, this app gets live events for this chat. */
  private watchChat(client: Client, id: unknown) {
    const chat = String(id ?? '').toUpperCase();
    if (!chat) return;
    client.chats.delete(chat);
    client.chats.add(chat);
    if (client.chats.size > MAX_WATCHED_CHATS) client.chats.delete(client.chats.values().next().value!);
  }

  private async handle(message: Record<string, any>, client: Client) {
    const id = message.id ?? null;
    try {
      const result = await this.respond(String(message.type ?? ''), message, client);
      this.send(client, { re: id, ok: true, result });
    } catch (error) {
      const code = error instanceof Failure ? error.code : undefined;
      this.send(client, { re: id, ok: false, error: (error as Error).message, ...(code ? { code } : {}) });
    }
  }

  private async respond(type: string, message: Record<string, any>, client: Client) {
    const { devices } = this.parts;
    // A cheap app-level heartbeat (any message counts as a sign of life), signed in or not.
    if (type === 'ping') return {};
    if (type === 'pair') {
      const asked: Role | undefined = message.role === 'mac' ? 'mac' : message.role === 'phone' ? 'phone' : undefined;
      const paired = devices.pair(String(message.code ?? ''), String(message.name ?? ''), asked);
      if (paired === 'role') throw new Failure('That code is for pairing a phone. Pair this Mac with a code from `npm run pair` on the hub.');
      if (typeof paired === 'string') {
        if (paired === 'wrong' && (client.wrongCodes += 1) >= MAX_WRONG_CODES) {
          setTimeout(() => client.socket.close(4003, 'Too many wrong codes'), 50).unref();
        }
        throw new Failure("That code didn't work. Get a fresh one from Dash on the Mac (Settings › Pair a Phone).");
      }
      log(`hub paired ${paired.device.name} (${paired.device.role})`);
      this.signIn(client, paired.device);
      return { token: paired.token, device: paired.device.name, mac: HUB_NAME, hub: HUB_NAME, app: this.parts.appURL() };
    }
    if (type === 'hello') {
      const device = devices.find(String(message.token ?? ''));
      // The one refusal that means "unpair": the apps forget their pairing only on this code.
      if (!device) throw new Failure("This device isn't paired with the Dash hub anymore. Pair it again.", 'unknown_token');
      this.signIn(client, device);
      return { device: device.name, mac: HUB_NAME, hub: HUB_NAME, app: this.parts.appURL() };
    }
    if (!client.device) throw new Failure('Sign in first.');
    const handler = this.handlers[type];
    if (!handler) throw new Failure(`The Dash hub doesn't know "${type}" yet. Update the hub.`);
    // Opening or acting on a chat is what tells the hub this app is showing it.
    if (type.startsWith('chat.') && message.chat) this.watchChat(client, message.chat);
    return handler(message, client);
  }

  private signIn(client: Client, device: Device) {
    client.device = device;
    this.parts.devices.markSeen(device.id);
    this.schedule('devices');
    // Everything the app shows, right away, so it never starts blank.
    this.parts.today.refreshIfStale();
    this.send(client, { event: 'todo', data: this.todoSnapshot() });
    this.send(client, { event: 'today', data: this.parts.today.snapshot() });
    this.send(client, { event: 'usage', data: this.parts.usage.snapshot });
    this.send(client, { event: 'chats', data: this.parts.chats.list() });
    this.send(client, { event: 'lecture', data: this.lectureSnapshot() });
    if (this.parts.monitor) this.send(client, { event: 'health', data: this.parts.monitor.snapshot() });
    if (this.parts.deadlines) this.send(client, { event: 'deadlines', data: this.parts.deadlines.snapshot() });
    if (device.role === 'mac') this.send(client, { event: 'devices', data: this.devicesSnapshot() });
  }

  // Events

  private schedule(kind: string) {
    if (this.pending.has(kind)) return;
    this.pending.add(kind);
    setTimeout(() => {
      this.pending.delete(kind);
      const data = this.snapshot(kind);
      const chat = kind.startsWith('chat:') ? kind.slice('chat:'.length) : undefined;
      for (const client of this.clients) {
        if (!client.device || (kind === 'devices' && client.device.role !== 'mac')) continue;
        // Live prices go only to apps with Portfolio open; the others get a snapshot when they open it.
        if (kind === 'portfolio' && !client.watchingPortfolio) continue;
        // A chat's live turns go only to apps showing it; the others see its changes in the `chats` list.
        // The advisor is one chat both apps keep open on Portfolio, so it always goes to everyone.
        if (chat && chat !== ADVISOR_ID && !client.chats.has(chat)) continue;
        this.send(client, { event: chat ? 'chat' : kind, data });
      }
    }, COALESCE);
  }

  private snapshot(kind: string) {
    switch (kind) {
      case 'todo': return this.todoSnapshot();
      case 'today': return this.parts.today.snapshot();
      case 'usage': return this.parts.usage.snapshot;
      case 'chats': return this.parts.chats.list();
      case 'lecture': return this.lectureSnapshot();
      case 'portfolio': return this.parts.portfolio.snapshot();
      case 'health': return this.parts.monitor?.snapshot() ?? { problems: [] };
      case 'devices': return this.devicesSnapshot();
      case 'deadlines': return this.parts.deadlines?.snapshot() ?? { items: [], unconfirmed: 0 };
      default: return this.parts.chats.liveState(kind.slice('chat:'.length));
    }
  }

  /** What the phone's Lecture tab shows: the Mac's last report, and whether that Mac is connected now. */
  private lectureSnapshot() {
    return { ...this.lecture.report, available: !!this.lecture.mac };
  }

  private toMac(command: Record<string, unknown>) {
    const mac = this.lecture.mac;
    if (!mac || mac.socket.readyState !== mac.socket.OPEN) {
      throw new Failure("Open Dash on your Mac to record. Recording uses the Mac's microphone.");
    }
    this.send(mac, { event: 'command', data: command });
    return {};
  }

  private deadlines() {
    if (!this.parts.deadlines) throw new Failure("This hub doesn't keep deadlines.");
    return this.parts.deadlines;
  }

  private changeDeadline(change: () => void) {
    try {
      change();
    } catch (error) {
      throw new Failure((error as Error).message);
    }
    return this.deadlines().snapshot();
  }

  private memory() {
    if (!this.parts.memory) throw new Failure("This hub doesn't keep a memory.");
    return this.parts.memory;
  }

  private todoSnapshot() {
    return { items: this.parts.todos.items };
  }

  private devicesSnapshot() {
    const online = new Set(this.connected.map((device) => device.id));
    return {
      devices: this.parts.devices.devices.map(({ tokenHash: _hash, ...device }) => ({ ...device, online: online.has(device.id) })),
    };
  }
}

function arrayOf(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function requireMac(client: Client) {
  if (client.device?.role !== 'mac') throw new Failure('Only Dash on the Mac can do that.');
}

