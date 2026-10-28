import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './log.ts';
import { paths } from './paths.ts';

export class JarvisError extends Error {}

const python = join(paths.jarvis, '.venv/bin/python');
const server = join(paths.jarvis, 'server.py');
/** Long enough for a slow Google call; a hung call fails instead of leaving Today stuck on "Loading…". */
const TIMEOUT = 180_000;

/** The same server as an `--mcp-config` entry, for chats that start their own copy. */
export const jarvisMcpConfig = JSON.stringify({
  mcpServers: { jarvis: { type: 'stdio', command: python, args: [server] } },
});

export const jarvisInstalled = () => existsSync(python) && existsSync(server);

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * The hub's own long-lived jarvis MCP server, spoken to over stdio (newline-delimited JSON-RPC), ported
 * from JarvisClient.swift. Today's tiles call tools through this without going through Claude. It
 * starts on first use and again on the next call after it dies or stops answering.
 */
export class Jarvis {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private buffer = '';
  private stderrTail = '';
  private nextID = 1;
  private pending = new Map<number, Pending>();
  private readonly timeout: number;
  private readonly python: string;
  private readonly server: string;

  /** Tests pass a stand-in server and a short timeout. */
  constructor(options: { timeout?: number; python?: string; server?: string } = {}) {
    this.timeout = options.timeout ?? TIMEOUT;
    this.python = options.python ?? python;
    this.server = options.server ?? server;
  }

  /** Calls a tool and returns its text. jarvis reports most problems (no Google token…) as plain text. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    await this.start();
    const result = await this.request('tools/call', { name: tool, arguments: args });
    const text = ((result.content ?? []) as { text?: string }[]).map((block) => block.text ?? '').join('\n');
    if (result.isError) throw new JarvisError(text || `${tool} failed.`);
    return text;
  }

  get isRunning() {
    return !!this.child && this.child.exitCode === null;
  }

  private start(): Promise<void> {
    if (this.ready && this.isRunning) return this.ready;
    if (!existsSync(this.python) || !existsSync(this.server)) return Promise.reject(new JarvisError(`Couldn't find jarvis at ${paths.jarvis}.`));

    const child = spawn(this.python, [this.server], { cwd: existsSync(paths.jarvis) ? paths.jarvis : undefined, stdio: 'pipe' });
    this.child = child;
    this.buffer = '';
    this.stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    child.on('error', (error) => log(`jarvis failed to start: ${error.message}`));
    // Writing to a jarvis that just died fails here rather than crashing the hub; the exit handler reports it.
    child.stdin.on('error', (error) => log(`jarvis stdin: ${error.message}`));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      log(`jarvis exited (status ${code}): ${this.stderrTail.slice(-200)}`);
      this.failAll(new JarvisError(`jarvis stopped: ${this.stderrTail.trim().slice(-300)}`));
      this.child = undefined;
      this.ready = undefined;
    });

    const ready = (async () => {
      await this.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dash-hub', version: '1.0' },
      });
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    this.ready = ready;
    // A failed handshake would otherwise stick; drop this process so the next call starts fresh.
    ready.catch(() => {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        child.kill();
      }
    });
    return ready;
  }

  /**
   * A call went unanswered: jarvis may be stuck (a Google call that never returns, a lock), so this
   * process is dropped, along with everything still waiting on it, and the next call starts a new one.
   */
  private restart(reason: string) {
    const child = this.child;
    if (!child) return;
    log(`jarvis restarting: ${reason}`);
    this.child = undefined;
    this.ready = undefined;
    this.failAll(new JarvisError(`jarvis stopped answering (${reason}), so it was restarted. Try again.`));
    child.kill();
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000).unref();
  }

  /** Closes jarvis's stdin so it exits on its own, then makes sure it's gone. */
  shutdown() {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000).unref();
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late reply finds nothing pending and is ignored.
        this.pending.delete(id);
        reject(new JarvisError(`jarvis didn't answer ${method} in time.`));
        this.restart(`no answer to ${method} in ${Math.round(this.timeout / 1000)}s`);
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(message: Record<string, unknown>) {
    if (!this.child || !this.isRunning) throw new JarvisError(`jarvis stopped: ${this.stderrTail.slice(-300)}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!waiting) continue;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new JarvisError(message.error.message ?? 'jarvis error'));
      else waiting.resolve(message.result ?? {});
    }
  }

  private failAll(error: Error) {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}
