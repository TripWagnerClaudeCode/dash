import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './log.ts';
import { type Memory } from './memory.ts';
import { DATA } from './paths.ts';

const secretsDir = join(DATA, 'secrets');
/** Written by deploy.sh on the hub: where ntfy listens, the topic the phone subscribes to, and a publish token. */
const configFile = join(secretsDir, 'ntfy.json');
const actionKeyFile = join(secretsDir, 'actions.key');
/** Pushes waiting for quiet hours to end. */
const heldFile = join(DATA, 'held-pushes.json');

/** `public` is the address the phone's ntfy app subscribes at (the tailnet name and :8443). */
export type NtfyConfig = { url: string; topic: string; token?: string; public?: string };
export type PushAction = { label: string; url: string; method?: 'POST' | 'GET' };
export type Push = {
  /** What it's about, for the memory log and dedup ("deadline", "brief", "checkin"…). */
  kind: string;
  title: string;
  body: string;
  tags?: string[];
  /** ntfy priority, 1–5. 4 and up break through Focus on iOS. */
  priority?: number;
  /** Opened when the notification is tapped (the Dash app in Expo Go). */
  click?: string;
  actions?: PushAction[];
  /**
   * Only for a push the user asked for themselves just now (the Settings test push): it goes out even in quiet
   * hours. Everything Dash sends on his own waits until 8 AM, however soon it's due.
   */
  urgent?: boolean;
  /** Identifies it in the held queue: a newer push with the same key replaces a held one, and sending it clears it. */
  key?: string;
  /** A held push past this moment (ISO) is dropped instead of going out late. */
  expires?: string;
};
/** "held": quiet hours, so it waits in the queue for the first run after 8 AM. */
export type Result = 'sent' | 'held' | 'off' | 'failed';

/** No pushes from 11 PM to 8 AM. */
const QUIET_FROM = 23;
const QUIET_UNTIL = 8;

export function isQuietHour(date: Date) {
  const hour = date.getHours();
  return hour >= QUIET_FROM || hour < QUIET_UNTIL;
}

/**
 * Pushes to the user's iPhone through the ntfy server on the hub. The phone's ntfy app is subscribed to one
 * topic; ntfy.sh only relays a content-free wake-up, and the phone fetches the text from the hub over
 * Tailscale. Every push is noted in Dash's memory, so Dash knows what it has already nudged about.
 */
export class Notifier {
  private readonly config?: NtfyConfig;
  private readonly memory?: Memory;
  private readonly clock: () => Date;
  private readonly post: typeof fetch;
  private readonly heldFile: string;
  private queue: Push[] = [];

  constructor(options: { memory?: Memory; config?: NtfyConfig; clock?: () => Date; post?: typeof fetch; heldFile?: string } = {}) {
    this.memory = options.memory;
    this.config = options.config ?? readConfig();
    this.clock = options.clock ?? (() => new Date());
    this.post = options.post ?? fetch;
    this.heldFile = options.heldFile ?? heldFile;
    try {
      const saved = JSON.parse(readFileSync(this.heldFile, 'utf8'));
      if (Array.isArray(saved)) this.queue = saved;
    } catch {}
  }

  get configured() {
    return !!this.config;
  }

  /** What to type into the ntfy app on the phone. */
  get subscription() {
    return this.config ? { server: this.config.public ?? '', topic: this.config.topic } : undefined;
  }

  quietNow() {
    return isQuietHour(this.clock());
  }

  /** Pushes held through quiet hours that still matter (ones past their `expires` are dropped here), oldest first. */
  held(): Push[] {
    const now = this.clock().getTime();
    const live = this.queue.filter((push) => !push.expires || Date.parse(push.expires) > now);
    if (live.length !== this.queue.length) {
      this.queue = live;
      this.saveHeld();
    }
    return [...live];
  }

  /** Takes these out of the held queue (they went out, folded into a digest). */
  release(pushes: Push[]) {
    const keys = new Set(pushes.map(keyOf));
    this.queue = this.queue.filter((push) => !keys.has(keyOf(push)));
    this.saveHeld();
  }

  async send(push: Push): Promise<Result> {
    if (!this.config) return 'off';
    if (!push.urgent && this.quietNow()) {
      this.queue = [...this.queue.filter((held) => keyOf(held) !== keyOf(push)), push].slice(-30);
      this.saveHeld();
      return 'held';
    }
    const body: Record<string, unknown> = {
      topic: this.config.topic, title: push.title.slice(0, 200), message: push.body.slice(0, 3_000),
      ...(push.tags?.length ? { tags: push.tags } : {}),
      ...(push.priority ? { priority: push.priority } : {}),
      ...(push.click ? { click: push.click } : {}),
      ...(push.actions?.length
        ? { actions: push.actions.slice(0, 3).map((action) => ({ action: 'http', label: action.label, url: action.url, method: action.method ?? 'POST', clear: true })) }
        : {}),
    };
    try {
      const response = await this.post(this.config.url, {
        method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) },
      });
      if (!response.ok) throw new Error(`ntfy answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } catch (error) {
      log(`push failed (${push.kind}): ${(error as Error).message}`);
      return 'failed';
    }
    this.memory?.log({ source: 'notify', kind: push.kind, text: `${push.title}: ${push.body}` });
    if (this.queue.some((held) => keyOf(held) === keyOf(push))) this.release([push]);
    return 'sent';
  }

  private saveHeld() {
    try {
      writeFileSync(`${this.heldFile}.tmp`, JSON.stringify(this.queue), { mode: 0o600 });
      renameSync(`${this.heldFile}.tmp`, this.heldFile);
    } catch (error) {
      log(`held pushes save failed: ${(error as Error).message}`);
    }
  }
}

const keyOf = (push: Push) => push.key ?? `${push.kind}|${push.title}`;

function readConfig(): NtfyConfig | undefined {
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    return typeof config.url === 'string' && typeof config.topic === 'string' ? config : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Notification buttons call back into the hub (POST /action/…) from the phone. Each link carries a key
 * made from a secret only the hub knows, so a link can't be made up for some other item.
 */
export function actionKey(item: string) {
  return createHmac('sha256', secret()).update(item).digest('hex').slice(0, 24);
}

let cachedSecret: Buffer | undefined;
function secret() {
  if (cachedSecret) return cachedSecret;
  if (!existsSync(actionKeyFile)) {
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(actionKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  cachedSecret = Buffer.from(readFileSync(actionKeyFile, 'utf8').trim(), 'hex');
  return cachedSecret;
}
