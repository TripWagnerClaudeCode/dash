import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { log } from './log.ts';
import { paths } from './paths.ts';

type Job = {
  name: string;
  /** The most recent moment this job should have run at, at or before `now`. */
  slot: (now: Date) => Date;
  /** How late a missed run may still happen (the hub was off at the time). */
  catchUp: number;
  /** A Claude session (the brief, the sweep, the nightly write-up): these run one at a time. */
  heavy: boolean;
  /**
   * Returning "held" means it couldn't go yet (quiet hours) and should be looked at again on the next
   * tick, without counting as a run or a failure.
   */
  run: () => Promise<unknown> | unknown;
};

/** The slot a job last tried and how often, so a failure is retried once and a crash doesn't loop. */
type Attempt = { slot: string; tries: number; retryAt?: string };
type Saved = { lastRun: Record<string, string>; attempts: Record<string, Attempt> };

/** How long a failed run waits before its one retry (long enough to outlast a short session limit). */
const RETRY_AFTER = 30 * 60_000;
const MAX_TRIES = 2;

/**
 * The hub's clock: jobs at a time of day ("08:00") or every few minutes. When each job last ran is saved,
 * so a restart neither runs a job twice nor skips one: a run missed while the hub was down still happens
 * when it comes back, if that's within the job's catch-up window. A run only counts once it succeeds; a
 * failure (a session limit, Google sign-in) is retried once a little later, then left for the next slot.
 * Times are local (the hub runs Eastern).
 */
export class Scheduler {
  private jobs: Job[] = [];
  private lastRun: Record<string, string> = {};
  private attempts: Record<string, Attempt> = {};
  private running = new Set<string>();
  private heavyQueue: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private readonly file: string;
  private readonly clock: () => Date;

  constructor(file = paths.scheduler, clock = () => new Date()) {
    this.file = file;
    this.clock = clock;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      // Older files were just { job: last run }.
      if (saved.lastRun && typeof saved.lastRun === 'object') {
        this.lastRun = saved.lastRun;
        this.attempts = saved.attempts ?? {};
      } else {
        this.lastRun = saved;
      }
    } catch {}
  }

  /** Once a day at "HH:MM". */
  daily(name: string, time: string, run: Job['run'], catchUpHours = 3, options: { heavy?: boolean } = {}) {
    const [hour, minute] = time.split(':').map(Number);
    this.jobs.push({
      name, run, catchUp: catchUpHours * 3_600_000, heavy: !!options.heavy,
      slot: (now) => {
        const slot = new Date(now);
        slot.setHours(hour, minute, 0, 0);
        if (slot > now) slot.setDate(slot.getDate() - 1);
        return slot;
      },
    });
  }

  /** Every so many minutes, on the clock (every 5 minutes runs at :00, :05…). */
  every(name: string, minutes: number, run: Job['run'], options: { heavy?: boolean } = {}) {
    const period = minutes * 60_000;
    this.jobs.push({ name, run, catchUp: period, heavy: !!options.heavy, slot: (now) => new Date(Math.floor(now.getTime() / period) * period) });
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Runs whatever is due. Exposed for tests, which move the clock themselves. */
  async tick() {
    const now = this.clock();
    const due = this.jobs.filter((job) => {
      if (this.running.has(job.name)) return false;
      const slot = job.slot(now);
      const last = this.lastRun[job.name] ? new Date(this.lastRun[job.name]) : undefined;
      if ((last && last >= slot) || now.getTime() - slot.getTime() > job.catchUp) return false;
      const attempt = this.attempts[job.name];
      if (attempt?.slot !== slot.toISOString()) return true;
      return attempt.tries < MAX_TRIES && (!attempt.retryAt || now >= new Date(attempt.retryAt));
    });
    for (const job of due) this.running.add(job.name);
    // Light jobs run side by side; Claude jobs queue behind each other, across ticks too, so a catch-up
    // after downtime doesn't start the brief, the sweep and the nightly write-up all at once.
    await Promise.all(due.map((job) => {
      if (!job.heavy) return this.runJob(job, now);
      this.heavyQueue = this.heavyQueue.then(() => this.runJob(job, now));
      return this.heavyQueue;
    }));
    return due.map((job) => job.name);
  }

  private async runJob(job: Job, now: Date) {
    const slot = job.slot(now).toISOString();
    const earlier = this.attempts[job.name];
    const tries = earlier?.slot === slot ? earlier.tries + 1 : 1;
    // Counted before running, so a job that crashes the hub is tried at most twice, not in a loop.
    this.attempts[job.name] = { slot, tries };
    this.save();
    try {
      const result = await job.run();
      if (result === 'held') {
        // Not a try: it'll be looked at again next minute.
        if (tries === 1) delete this.attempts[job.name];
        else this.attempts[job.name] = { slot, tries: tries - 1 };
      } else {
        this.lastRun[job.name] = now.toISOString();
        delete this.attempts[job.name];
      }
    } catch (error) {
      const retrying = tries < MAX_TRIES;
      log(`job ${job.name} failed${retrying ? ', will try once more' : ''}: ${(error as Error).message}`);
      const retryAt = new Date(this.clock().getTime() + Math.min(RETRY_AFTER, job.catchUp / 2));
      this.attempts[job.name] = { slot, tries, ...(retrying ? { retryAt: retryAt.toISOString() } : {}) };
    } finally {
      this.running.delete(job.name);
      this.save();
    }
  }

  private save() {
    try {
      const saved: Saved = { lastRun: this.lastRun, attempts: this.attempts };
      writeFileSync(`${this.file}.tmp`, JSON.stringify(saved, null, 1), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (error) {
      log(`scheduler save failed: ${(error as Error).message}`);
    }
  }
}
