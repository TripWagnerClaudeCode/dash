import { execFile } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { claudeCallProblem, claudeSignInProblem } from './claude.ts';
import { lastConsolidation } from './consolidate.ts';
import { type Jarvis } from './jarvis.ts';
import { log } from './log.ts';
import { DATA, HUB_NAME } from './paths.ts';
import { type Portfolio } from './portfolio/portfolio.ts';
import { type RobinhoodClient } from './portfolio/robinhood.ts';

export type Problem = { key: string; text: string; since: string };

const versionFile = join(dirname(fileURLToPath(import.meta.url)), '../VERSION');

/** What's deployed: deploy.sh writes `git describe --always --dirty` to hub/VERSION. 'dev' without one. */
export function hubVersion() {
  try {
    return readFileSync(versionFile, 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
}
type Parts = {
  jarvis: Jarvis; robinhood: RobinhoodClient; portfolio: Portfolio;
  /** Whether Claude Code is signed in (undefined) or what's wrong; tests pass a stand-in. */
  claude?: () => Promise<string | undefined>;
};

const EVERY = 15 * 60_000;
const ALERT_AGAIN = 24 * 60 * 60_000;
const MIN_FREE_GB = 5;

/**
 * Checks every 15 minutes that the hub's sign-ins and services still work: Google (jarvis), Claude Code,
 * Robinhood, Syncthing and free disk. Problems go to the apps as a `health` event (a banner on Today),
 * and each new one is emailed to the user once a day, unless the problem is Gmail itself.
 */
export class Health {
  problems: Problem[] = [];
  checked?: Date;
  private alerted = new Map<string, number>();
  private wasConnected: boolean;
  private checking = false;
  private listeners = new Set<() => void>();
  private readonly parts: Parts;

  constructor(parts: Parts) {
    this.parts = parts;
    this.wasConnected = parts.robinhood.isConnected;
  }

  /**
   * The user disconnected Robinhood on purpose (Portfolio › Disconnect): that's not a problem to banner or
   * email about. Only a sign-in that ends on its own is.
   */
  robinhoodDisconnected() {
    this.wasConnected = false;
    this.alerted.delete('robinhood');
    if (!this.problems.some((problem) => problem.key === 'robinhood')) return;
    this.problems = this.problems.filter((problem) => problem.key !== 'robinhood');
    log('health: robinhood was disconnected on purpose');
    this.listeners.forEach((listener) => listener());
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  start() {
    setTimeout(() => this.check(), 60_000).unref();
    setInterval(() => this.check(), EVERY).unref();
  }

  snapshot() {
    return { problems: this.problems, checked: this.checked?.toISOString() ?? null };
  }

  /** One check at a time; a slow one (jarvis can take minutes to give up) doesn't stack up behind itself. */
  async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.run();
    } finally {
      this.checking = false;
    }
  }

  private async run() {
    const found: Omit<Problem, 'since'>[] = [];
    const { jarvis, robinhood, portfolio } = this.parts;

    try {
      const text = (await jarvis.call('calendar_get', { days: 1 })).toLowerCase();
      if (text.includes('invalid_grant') || text.includes('token has been expired') || text.startsWith('failed to')) {
        found.push({ key: 'google', text: "Google sign-in on the hub expired, so email, calendar and Docs don't work. Ask Claude on the Mac to re-authorize jarvis on dash-hub." });
      }
    } catch (error) {
      found.push({ key: 'google', text: `jarvis isn't answering on the hub: ${(error as Error).message}` });
    }

    // `claude auth status` reads the sign-in without spending any usage (a Haiku ping used to, every 15 minutes).
    // It can't see a revoked token or a usage limit, so real calls failing in a row count too.
    const claude = await (this.parts.claude ?? claudeSignInProblem)().catch((error: Error) => error.message)
      ?? (this.parts.claude ? undefined : claudeCallProblem());
    if (claude) found.push({ key: 'claude', text: `Claude Code on the hub isn't working: ${claude}` });

    if (this.wasConnected && !robinhood.isConnected) {
      found.push({ key: 'robinhood', text: 'The Robinhood sign-in ended. Connect again from Portfolio in Dash on the Mac.' });
    } else if (robinhood.isConnected && portfolio.error) {
      found.push({ key: 'robinhood', text: `Portfolio can't update: ${portfolio.error}` });
    }
    if (robinhood.isConnected) this.wasConnected = true;

    try {
      await promisify(execFile)('systemctl', ['--user', 'is-active', '--quiet', 'syncthing']);
    } catch {
      found.push({ key: 'syncthing', text: "File sync (Syncthing) isn't running on the hub, so chats may not see your latest files." });
    }

    // The 4:15 AM memory update. A day it couldn't do is retried the next night, but say so meanwhile.
    const night = lastConsolidation();
    if (night && !night.ok) {
      found.push({ key: 'memory', text: `Last night's memory update failed (${night.day}): ${night.error ?? 'unknown error'}` });
    } else if (night && Date.now() - Date.parse(night.at) > 30 * 3_600_000) {
      found.push({ key: 'memory', text: `Dash's memory hasn't been updated since ${night.day}; the nightly job may not be running.` });
    }

    try {
      const stats = statfsSync(DATA);
      const free = (stats.bavail * stats.bsize) / 1e9;
      if (free < MIN_FREE_GB) found.push({ key: 'disk', text: `The hub is almost out of disk space (${free.toFixed(1)} GB free).` });
    } catch {}

    const now = new Date();
    const previous = new Map(this.problems.map((problem) => [problem.key, problem.since]));
    this.problems = found.map((problem) => ({ ...problem, since: previous.get(problem.key) ?? now.toISOString() }));
    this.checked = now;
    for (const problem of this.problems) {
      if (!previous.has(problem.key)) log(`health: ${problem.key}: ${problem.text}`);
    }
    for (const key of previous.keys()) {
      if (!this.problems.some((problem) => problem.key === key)) log(`health: ${key} is fine again`);
    }
    this.listeners.forEach((listener) => listener());
    await this.alert();
  }

  /** One email a day per problem, through the user's own Gmail (so not when Google is what's broken). */
  private async alert() {
    const to = process.env.DASH_ALERT_EMAIL;
    if (!to || this.problems.some((problem) => problem.key === 'google')) return;
    const due = this.problems.filter((problem) => Date.now() - (this.alerted.get(problem.key) ?? 0) > ALERT_AGAIN);
    if (!due.length) return;
    const body = `Dash's hub (${HUB_NAME}) found ${due.length === 1 ? 'a problem' : 'some problems'}:\n\n`
      + due.map((problem) => `- ${problem.text}`).join('\n')
      + '\n\nThe same note is at the top of Today in Dash. This email comes at most once a day per problem.';
    try {
      await this.parts.jarvis.call('email_send', { to, subject: 'Dash hub needs attention', body });
      for (const problem of due) this.alerted.set(problem.key, Date.now());
    } catch (error) {
      log(`health: couldn't send the alert email: ${(error as Error).message}`);
    }
  }
}
