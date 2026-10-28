import { readFileSync, writeFileSync } from 'node:fs';

import { ClaudeSession, models, rateLimitListeners } from './claude.ts';
import { paths } from './paths.ts';

type Window = { utilization: number; resetsAt: string };
export type UsageSnapshot = { session?: Window; week?: Window; updatedAt?: string; limited: boolean; error?: string };

/** Older than this, the hub pings Haiku for fresh numbers (use elsewhere doesn't reach the hub on its own). */
const MAX_AGE = 15 * 60_000;
/** The ping is a one-word answer; one that takes longer than this has hung, and counts as failed. */
const PING_TIMEOUT = 60_000;

/**
 * How much of the Claude subscription is used: the 5-hour and 7-day windows, read from the
 * `rate_limit_event` Claude Code sends with every request (ported from Usage.swift). Any Claude call the
 * hub makes keeps it current; `refreshIfStale` sends a tiny Haiku ping when nothing has lately, and only
 * when an app asks for the numbers (health checks use `claude auth status` instead).
 */
export class Usage {
  snapshot: UsageSnapshot = { limited: false };
  private refreshing?: Promise<void>;
  /** When the last ping failed; a failing Claude Code isn't pinged again for a while. */
  private failedAt = 0;
  private listeners = new Set<() => void>();
  private readonly pingTimeout: number;

  constructor(options: { pingTimeout?: number } = {}) {
    this.pingTimeout = options.pingTimeout ?? PING_TIMEOUT;
    try {
      this.snapshot = JSON.parse(readFileSync(paths.usage, 'utf8'));
    } catch {}
    rateLimitListeners.add((info) => this.update(info));
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  /** Reads a `rate_limit_info` object, from the hub's own calls or one Mac Dash forwards. */
  update(info: Record<string, any>) {
    const windows = info.unifiedWindows ?? {};
    const window = (name: string): Window | undefined => {
      const entry = windows[name];
      if (typeof entry?.utilization !== 'number' || typeof entry?.resetsAt !== 'number') return undefined;
      return { utilization: entry.utilization, resetsAt: new Date(entry.resetsAt * 1000).toISOString() };
    };
    this.snapshot = {
      session: window('five_hour') ?? this.snapshot.session,
      week: window('seven_day') ?? this.snapshot.week,
      limited: info.status === 'rejected',
      updatedAt: new Date().toISOString(),
    };
    this.failedAt = 0;
    try {
      writeFileSync(paths.usage, JSON.stringify(this.snapshot));
    } catch {}
    this.listeners.forEach((listener) => listener());
  }

  get isStale() {
    if (Date.now() - this.failedAt < MAX_AGE) return false;
    const { updatedAt, session } = this.snapshot;
    if (!updatedAt) return true;
    return Date.now() - Date.parse(updatedAt) > MAX_AGE || (!!session && Date.parse(session.resetsAt) <= Date.now());
  }

  /** Resolves once the numbers (or the error) are current. */
  refreshIfStale(): Promise<void> {
    return this.isStale ? this.refresh() : Promise.resolve();
  }

  /**
   * Smallest possible request (Haiku, a few hundred tokens) just to read the current numbers. Always
   * settles: a ping that hangs is stopped after a minute and counts as a failure.
   */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        await ClaudeSession.ask('OK', 'Reply with the single word OK.', models.haiku, 'low', undefined,
                                { timeout: this.pingTimeout, caller: 'usage-ping' });
        this.failedAt = 0;
      } catch (error) {
        this.failedAt = Date.now();
        this.snapshot = { ...this.snapshot, error: (error as Error).message };
        this.listeners.forEach((listener) => listener());
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
}
