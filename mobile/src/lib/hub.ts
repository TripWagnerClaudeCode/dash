/**
 * The connection to the Dash hub (hub/src/server.ts, on the always-on PC). One WebSocket carries everything:
 *   phone → hub  {"id": 7, "type": "todo.add", "text": "…"}
 *   hub → phone  {"re": 7, "ok": true, "result": {…}}  or  {"re": 7, "ok": false, "error": "…"}
 *   hub → phone  {"event": "todo", "data": {…}}        whenever something changes
 * The client signs in with its saved token on every connect and reconnects on its own.
 */

export type Credentials = { url: string; token: string; mac: string };

export type Load<T> =
  | { state: 'idle' | 'loading' }
  | { state: 'loaded'; value: T }
  | { state: 'failed'; error: string };

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  place: string;
  course?: string;
};

export type MailItem = { id: string; from: string; subject: string };

export type TodaySnapshot = {
  events: Load<CalendarEvent[]>;
  weather: Load<string>;
  inbox: Load<MailItem[]>;
  brief: { text: string; isError: boolean; busy: boolean; canBrief: boolean };
  refreshed?: string;
};

export type TodoSnapshot = { items: string[] };

export type Deadline = {
  id: string; due: string; course?: string; title: string; exam: boolean; confirmed: boolean; source?: string; done: boolean;
};
export type DeadlinesSnapshot = { items: Deadline[]; unconfirmed: number };

export type HealthSnapshot = { problems: { key: string; text: string; since: string }[]; checked: string | null };

export type HubEvents = {
  today: TodaySnapshot; todo: TodoSnapshot; chats: { chats: ChatMeta[] }; chat: ChatLive;
  usage: UsageSnapshot; lecture: LectureSnapshot; portfolio: PortfolioSnapshot; health: HealthSnapshot;
  deadlines: DeadlinesSnapshot;
};

/** online: signed in · connecting: trying (or retrying) · offline: the hub can't be reached · unpaired: no valid token */
export type ConnectionState = 'unpaired' | 'connecting' | 'online' | 'offline';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const REQUEST_TIMEOUT = 15_000;
const MAX_BACKOFF = 15_000;
/** How long a connect (socket open + hello) may take before it's abandoned and retried. */
const CONNECT_TIMEOUT = 15_000;
/** While the app is in the foreground, a `ping` this often; no answer in time means the socket is dead. */
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;
const OFFLINE = "Can't reach the Dash hub. Check that Tailscale is on; if it is, the PC may be off or signed out.";

/** The hub answered and said no. `code` is set for errors the app acts on: "unknown_token" means this phone was removed. */
export class HubError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** Sends one request on a fresh socket and closes it. Used for pairing, before there's a token. */
export function pairOnce(url: string, code: string, name: string): Promise<Credentials> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      reject(new HubError(`"${url}" isn't a valid address.`));
      return;
    }
    const timer = setTimeout(() => {
      socket.close();
      reject(new HubError("Couldn't reach the Dash hub. Is Tailscale on?"));
    }, REQUEST_TIMEOUT);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, type: 'pair', code, name }));
    socket.onmessage = (message) => {
      const reply = JSON.parse(String(message.data));
      if (reply.re !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (reply.ok) resolve({ url, token: reply.result.token, mac: reply.result.mac });
      else reject(new HubError(reply.error));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new HubError("Couldn't reach the Dash hub. Is Tailscale on?"));
    };
  });
}

export class HubClient {
  state: ConnectionState = 'unpaired';
  /** Why the last connect failed, for the status line. */
  problem?: string;

  private credentials?: Credentials;
  private socket?: WebSocket;
  private nextID = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(data: any) => void>>();
  private stateListeners = new Set<() => void>();
  private backoff = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private connectingSince = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private foreground = true;
  private revokeListeners = new Set<() => void>();
  /** The latest copy of each event: replayed to screens as they open, and saved for when the hub is offline. */
  private latest = new Map<string, unknown>();
  private eventListeners = new Set<() => void>();

  connect(credentials: Credentials) {
    this.credentials = credentials;
    this.backoff = 1000;
    this.open();
  }

  disconnect() {
    this.credentials = undefined;
    clearTimeout(this.retryTimer);
    this.detach('Disconnected from Dash.');
    this.setState('unpaired');
  }

  /** Try again now (pull to refresh while offline). A connect that's stuck past its time limit is restarted too. */
  reconnectNow() {
    if (!this.credentials || this.state === 'online') return;
    if (this.state === 'connecting' && Date.now() - this.connectingSince < CONNECT_TIMEOUT) return;
    this.backoff = 1000;
    this.open();
  }

  /**
   * The app came to the foreground or left it. Coming back checks the connection right away: an "online"
   * socket may have died while the phone slept, so it's pinged, and anything else reconnects now.
   * The heartbeat only runs in the foreground.
   */
  setForeground(active: boolean) {
    this.foreground = active;
    if (!active) {
      this.stopHeartbeat();
      return;
    }
    if (this.state === 'online') {
      this.startHeartbeat();
      this.checkAlive();
    } else {
      this.reconnectNow();
    }
  }

  request<T = any>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || this.state !== 'online') return Promise.reject(new HubError('Not connected to Dash.'));
    return this.send<T>(socket, type, params);
  }

  on<K extends keyof HubEvents>(event: K, listener: (data: HubEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    const last = this.latest.get(event);
    if (last !== undefined) listener(last as HubEvents[K]);
    return () => set.delete(listener);
  }

  /** Any event arrived (for saving the copies). */
  onEvent(listener: () => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Copies saved on a previous run, shown until the hub sends fresh ones. */
  seed(saved: Record<string, unknown>) {
    for (const [event, data] of Object.entries(saved)) {
      if (this.latest.has(event)) continue;
      this.latest.set(event, data);
      this.listeners.get(event)?.forEach((listener) => listener(data));
    }
  }

  /** Every event worth keeping offline. A chat's live updates aren't; chats are fetched whole. */
  copies(): Record<string, unknown> {
    return Object.fromEntries([...this.latest].filter(([event]) => event !== 'chat'));
  }

  forget() {
    this.latest.clear();
  }

  /** The hub says the saved token is no longer valid (the phone was removed in Dash's Settings). */
  onRevoke(listener: () => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ConnectionState, problem?: string) {
    this.state = state;
    this.problem = problem;
    this.stateListeners.forEach((listener) => listener());
  }

  private open() {
    const credentials = this.credentials;
    if (!credentials) return;
    clearTimeout(this.retryTimer);
    // Anything still waiting on the old socket won't be answered now; fail it instead of letting it time out.
    this.detach('Lost the connection to Dash.');
    this.setState('connecting', this.problem);
    this.connectingSince = Date.now();
    let socket: WebSocket;
    try {
      socket = new WebSocket(credentials.url);
    } catch {
      this.setState('offline', `"${credentials.url}" isn't a valid address.`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    // A socket that never opens, or a hello that's never answered, is given up on and retried.
    this.connectTimer = setTimeout(() => {
      if (socket === this.socket && this.state === 'connecting') this.drop(socket, OFFLINE);
    }, CONNECT_TIMEOUT);

    socket.onopen = async () => {
      try {
        await this.send(socket, 'hello', { token: credentials.token });
        if (socket !== this.socket) return;
        clearTimeout(this.connectTimer);
        this.backoff = 1000;
        this.setState('online');
        this.startHeartbeat();
      } catch (error) {
        if (socket !== this.socket) return;
        if (error instanceof HubError && error.code === 'unknown_token') {
          // The hub doesn't know this phone's token: it was removed, so pairing is the only way back.
          this.credentials = undefined;
          this.detach('This phone is no longer paired with Dash.');
          this.setState('unpaired', error.message);
          this.revokeListeners.forEach((listener) => listener());
        } else {
          // Any other refusal (a hub-side error) or no answer at all: keep the pairing and try again.
          this.drop(socket, error instanceof HubError ? `Dash couldn't sign in: ${error.message}` : OFFLINE);
        }
      }
    };
    socket.onmessage = (message) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (typeof parsed.re === 'number') {
        const waiting = this.pending.get(parsed.re);
        if (!waiting) return;
        this.pending.delete(parsed.re);
        clearTimeout(waiting.timer);
        if (parsed.ok) waiting.resolve(parsed.result);
        else waiting.reject(new HubError(parsed.error, typeof parsed.code === 'string' ? parsed.code : undefined));
      } else if (typeof parsed.event === 'string') {
        if (parsed.event !== 'chat') this.latest.set(parsed.event, parsed.data);
        this.listeners.get(parsed.event)?.forEach((listener) => listener(parsed.data));
        this.eventListeners.forEach((listener) => listener());
      }
    };
    socket.onclose = () => this.drop(socket, OFFLINE);
  }

  /** `socket` is dead: let go of it, show offline and retry after the backoff. Does nothing for a socket already replaced. */
  private drop(socket: WebSocket, problem: string) {
    if (socket !== this.socket) return;
    this.detach('Lost the connection to Dash.');
    if (!this.credentials) return;
    this.setState('offline', problem);
    this.scheduleRetry();
  }

  /** Lets go of the current socket (closing it without hearing from it again) and fails its requests. */
  private detach(message: string) {
    clearTimeout(this.connectTimer);
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {}
    }
    this.failPending(message);
  }

  /** Doubles the wait after each failure, up to MAX_BACKOFF; a successful hello resets it. */
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    if (!this.foreground) return;
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** Pings the hub; no answer in time means a half-open socket, so it's dropped and reconnected. */
  private checkAlive() {
    const socket = this.socket;
    if (!socket || this.state !== 'online') return;
    this.send(socket, 'ping', {}, HEARTBEAT_TIMEOUT).catch((error) => {
      // Any answer, even an error (an older hub without `ping`), means the socket is alive.
      if (error instanceof HubError) return;
      this.drop(socket, OFFLINE);
    });
  }

  private send<T>(socket: WebSocket, type: string, params: Record<string, unknown>, timeout = REQUEST_TIMEOUT): Promise<T> {
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Dash took too long to answer.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ ...params, id, type }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Lost the connection to Dash.'));
      }
    });
  }

  private failPending(message: string) {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(message));
    }
    this.pending.clear();
  }
}

// Chats (hub/src/chats.ts): the same shapes Mac Dash uses.

export type ToolCall = { id: string; name: string; done: boolean; failed: boolean; inputJSON: string; output: string; summary: string };

export type Turn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isError: boolean;
  tools: ToolCall[];
  thinking: string;
  attachments: string[];
  stopped: boolean;
};

export type ChatMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelID?: string;
  effort: string;
  permissionMode: string;
  skillName?: string;
  /** "checkin" for the evening check-in. */
  kind?: string;
  /** Off the record: never summarized into Dash's memory. */
  offRecord?: boolean;
};

export type Approval = { id: string; toolName: string; displayName: string; input: Record<string, unknown>; canAlways: boolean };

/** A `chat` event: the last two turns and the live state. `chat.open` adds every turn. */
export type ChatLive = {
  id: string;
  meta: ChatMeta;
  count: number;
  tail: Turn[];
  turns?: Turn[];
  status: 'idle' | 'thinking' | 'streaming';
  stopping: boolean;
  notice: string | null;
  approvals: Approval[];
  queue: { id: string; text: string; attachments: string[] }[];
};

/** The hub's `usage` event: the Claude subscription's 5-hour and weekly windows. */
export type UsageSnapshot = {
  session?: { utilization: number; resetsAt: string };
  week?: { utilization: number; resetsAt: string };
  updatedAt?: string;
  limited: boolean;
  error?: string;
};

/** The Mac's lecture recorder, relayed by the hub. `available` is whether that Mac is connected now. */
export type LectureSnapshot = {
  available: boolean;
  state?: 'idle' | 'starting' | 'recording' | 'stopping';
  selected?: string | null;
  course?: string;
  courseName?: string;
  since?: string;
  courses?: { code: string; name: string; hasDoc: boolean }[];
  log?: { time: string; text: string; isError: boolean }[];
};

/** The hub's `portfolio` event (hub/src/portfolio/portfolio.ts): holdings, quotes and computed stats. */
export type SeriesJSON = { dates: string[]; values: number[] };
export type HoldingJSON = { symbol: string; quantity: number; averageCost: number; price: number; previousClose: number; sector?: string };
export type PortfolioSnapshot = {
  connected: boolean;
  error: string | null;
  session: 'regular' | 'extended' | 'closed';
  lastQuote: string | null;
  holdings: HoldingJSON[];
  otherValue: number;
  cash: number;
  buyingPower: number;
  spyQuote: { price: number; previousClose: number } | null;
  stats: {
    periods?: { label: string; portfolio: number | null; spy: number | null }[];
    volatility?: number | null; spyVolatility?: number | null; beta?: number | null;
    maxDrawdown?: number | null; currentDrawdown?: number | null;
    top1?: number | null; top5?: number | null; effectiveCount?: number | null;
    sectors?: { name: string; weight: number }[];
    realizedYear?: number | null;
    risk?: Record<string, { contribution: number; volatility?: number; beta?: number }>;
  };
  lookback: SeriesJSON;
  spy: SeriesJSON;
  recorded: SeriesJSON;
};
