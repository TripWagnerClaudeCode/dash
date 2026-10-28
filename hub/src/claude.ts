import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './log.ts';
import { DATA, HOME } from './paths.ts';

export const models = {
  opus: { id: 'claude-opus-5-5', supportsEffort: true },
  sonnet: { id: 'claude-sonnet-5-5', supportsEffort: true },
  haiku: { id: 'claude-haiku-4-5', supportsEffort: false },
} as const;
export type Model = (typeof models)[keyof typeof models];

/** What a session may use. The default (no tools at all) is for one-off writing like the brief. */
export type Profile = {
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  /** `--mcp-config` JSON (jarvis, the Robinhood relay…). */
  mcpConfig?: string;
  /** Keep Claude Code's own system prompt and append Dash's (chats), instead of replacing it. */
  keepDefaultPrompt?: boolean;
  permissionMode?: string;
};

export type PermissionRequest = {
  id: string;
  toolName: string;
  displayName: string;
  input: Record<string, unknown>;
  /** Rules Claude Code offers for "always allow this", already scoped to this session. */
  suggestions: Record<string, unknown>[];
};

export type ClaudeEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolStarted'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'toolFinished'; id: string; isError: boolean; output: string }
  | { type: 'permission'; request: PermissionRequest };

export type TurnResult = { text: string; stopReason?: string; interrupted: boolean };

export class ClaudeError extends Error {}

/** One-off questions to Haiku (push wording, summaries, the usage ping) are short; a hang fails after this. */
const HAIKU_TIMEOUT = 2 * 60_000;
/** Other one-off calls (the brief, the nightly write-up, the sweep, a syllabus) get longer. */
const ONE_SHOT_TIMEOUT = 15 * 60_000;

/**
 * Folders and files no Claude session may read, whatever its tools or working folders: the hub's
 * secrets (Robinhood tokens, the ntfy publish token), ntfy's own user database, the MCP configs that
 * carry the Robinhood relay's secret, paired devices, off-the-record chats, jarvis's Google tokens and
 * Claude Code's own sign-in. ~/.claude is listed entry by entry, leaving out skills/, which skill chats
 * read their files from.
 */
export function protectedPaths(): string[] {
  const claudeDir = join(HOME, '.claude');
  let claudeEntries: string[] = [];
  try {
    claudeEntries = readdirSync(claudeDir).filter((name) => name !== 'skills').map((name) => {
      const path = join(claudeDir, name);
      return statSync(path).isDirectory() ? `${path}/**` : path;
    });
  } catch {}
  return [join(DATA, 'secrets/**'), join(DATA, 'ntfy/**'), join(DATA, 'mcp-*.json'), join(DATA, 'hub_devices.json*'),
          join(DATA, 'chats/off-record/**'), join(HOME, '.jarvis/**'), join(HOME, '.claude.json'), ...claudeEntries];
}

/**
 * `Read(//abs/path)` rules for --disallowedTools: a double slash is an absolute path in Claude Code's
 * rules, and a Read deny also stops Grep, Glob, Edit and Write on that path. Rules are comma-joined, so
 * a path with a comma in it can't be written as one and is left out.
 */
export function denyRules(): string[] {
  return protectedPaths().filter((path) => !path.includes(',')).map((path) => `Read(/${path})`);
}

/** Every rate_limit_event goes here; usage.ts listens. */
export const rateLimitListeners = new Set<(info: Record<string, any>) => void>();

const live = new Set<ClaudeSession>();

/** Where the claude binary is. systemd gives services a bare PATH, so check the usual spots. Tests set DASH_CLAUDE. */
function findClaude(): string | undefined {
  if (process.env.DASH_CLAUDE) return process.env.DASH_CLAUDE;
  const candidates = [join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
                      '/usr/bin/claude', join(HOME, '.claude/local/claude')];
  return candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

type Options = {
  model: Model;
  effort?: string;
  system: string;
  profile?: Profile;
  /** Makes the conversation resumable: created under this ID, or continued with `resume`. */
  sessionID?: string;
  resume?: boolean;
  cwd?: string;
  /**
   * How long one turn may take before the process is killed and the turn fails. One-off sessions (no
   * sessionID) get a default; chats have none, since the user can Stop them and approvals can wait.
   */
  timeout?: number;
  /** Who's calling, for the usage line in hub.log ("chat", "advisor", "summary"…). */
  caller?: string;
};

/**
 * One headless Claude Code session (`claude -p`, stream-json in and out), ported from ClaudeCLI.swift.
 * It stays open for a whole conversation so follow-ups only send the new message, and runs on the
 * subscription Claude Code is signed in with: API-key variables are stripped from its environment, and
 * it loads no user settings, plugins or MCP servers beyond what its profile names.
 */
export class ClaudeSession {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderrText = '';
  private onEvent?: (event: ClaudeEvent) => void;
  private turn?: { resolve: (result: TurnResult) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
  private interruptRequested = false;
  /** Set when the process couldn't start (EACCES, EAGAIN…); Node then never reports an exit. */
  private startError?: Error;
  private readonly timeout?: number;
  private readonly caller: string;
  private readonly modelID: string;
  /** The command line it was started with (tests check the permission rules). */
  readonly args: string[];

  constructor(options: Options) {
    const executable = findClaude();
    if (!executable) throw new ClaudeError("Couldn't find the claude command. Install Claude Code on the hub and sign in with `claude`.");
    const profile = options.profile ?? {};
    this.timeout = options.timeout ?? (options.sessionID ? undefined : options.model === models.haiku ? HAIKU_TIMEOUT : ONE_SHOT_TIMEOUT);
    this.caller = options.caller ?? 'one-shot';
    this.modelID = options.model.id;
    // Every session with tools is kept away from the hub's secrets and private files.
    const disallowed = [...(profile.disallowedTools ?? []), ...(profile.tools?.length ? denyRules() : [])];
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
                  '--include-partial-messages', '--verbose', '--model', options.model.id,
                  profile.keepDefaultPrompt ? '--append-system-prompt' : '--system-prompt', options.system,
                  '--tools', (profile.tools ?? []).join(','), '--strict-mcp-config', '--setting-sources', ''];
    if (options.sessionID) args.push(options.resume ? '--resume' : '--session-id', options.sessionID);
    else args.push('--no-session-persistence');
    if (profile.permissionMode) args.push('--permission-mode', profile.permissionMode);
    if (options.model.supportsEffort) args.push('--effort', options.effort ?? 'medium');
    if (profile.mcpConfig) args.push('--mcp-config', profile.mcpConfig);
    if (profile.allowedTools?.length) args.push('--allowedTools', profile.allowedTools.join(','));
    if (disallowed.length) args.push('--disallowedTools', disallowed.join(','));
    for (const dir of profile.addDirs ?? []) if (existsSync(dir)) args.push('--add-dir', dir);
    // Tool calls that aren't pre-approved come back over stdout as control requests.
    if (profile.tools?.length || profile.mcpConfig) args.push('--permission-prompt-tool', 'stdio');

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Dash keeps its own memory file; don't let Claude Code write a second, hidden one.
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    env.PATH = [join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin'].join(':');

    // The data folder as working directory, so no project CLAUDE.md gets pulled in.
    this.args = args;
    this.child = spawn(executable, args, { cwd: options.cwd ?? DATA, env, stdio: 'pipe' });
    // When the process can't start at all, Node may leave out the pipes; the 'error' event says why.
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrText = (this.stderrText + chunk).slice(-10_000);
    });
    this.child.on('error', (error) => {
      // A failed spawn never exits, so this is the only word on it: fail the turn and forget the process.
      if (this.child.pid === undefined) {
        this.startError = new ClaudeError(`Claude Code didn't start: ${error.message}`);
        live.delete(this);
      }
      this.finish(this.startError ?? new ClaudeError(`Claude Code: ${error.message}`));
    });
    this.child.on('exit', (code) => {
      if (this.turn) log(`claude exited mid-turn (status ${code}): ${this.stderrText.slice(-200)}`);
      this.finish(new ClaudeError(this.exitMessage()));
      live.delete(this);
    });
    // A failed write after exit is reported by the exit handler instead.
    this.child.stdin?.on('error', () => {});
    live.add(this);
  }

  /** Whether the process is gone, or never started. */
  private get isDead() {
    return !!this.startError || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  get isTurnActive() {
    return !!this.turn;
  }

  /** Sends one user message and streams the reply through `onEvent`. */
  send(content: Record<string, unknown>[], onEvent: (event: ClaudeEvent) => void): Promise<TurnResult> {
    if (this.turn) return Promise.reject(new ClaudeError('Still answering the last message.'));
    if (this.startError) return Promise.reject(this.startError);
    if (this.isDead) return Promise.reject(new ClaudeError(this.exitMessage()));
    this.onEvent = onEvent;
    this.interruptRequested = false;
    return new Promise((resolve, reject) => {
      this.turn = { resolve, reject };
      if (this.timeout) {
        // A hung call fails and its process goes, so nothing waiting on it (reminders, health) waits forever.
        const timeout = this.timeout;
        this.turn.timer = setTimeout(() => {
          log(`claude (${this.caller}) gave no answer in ${Math.round(timeout / 1000)}s; stopping it`);
          this.finish(new ClaudeError(`Claude Code didn't answer within ${duration(timeout)}.`));
          this.close();
        }, timeout);
        this.turn.timer.unref();
      }
      this.write({ type: 'user', message: { role: 'user', content } });
    });
  }

  /** Answers a permission request. `always` applies Claude Code's suggested rule for this session. */
  respond(request: PermissionRequest, allow: boolean, always = false) {
    const decision: Record<string, unknown> = allow
      ? { behavior: 'allow', updatedInput: request.input }
      : { behavior: 'deny', message: "The user denied this in Dash. Don't retry it unless they ask." };
    if (allow && always && request.suggestions.length) decision.updatedPermissions = request.suggestions;
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: request.id, response: decision } });
  }

  /** Stops the current turn; the session keeps its context. Returns false when nothing is running. */
  interrupt(): boolean {
    if (!this.turn || this.isDead) return false;
    this.interruptRequested = true;
    this.write({ type: 'control_request', request_id: `dash-int-${randomUUID()}`, request: { subtype: 'interrupt' } });
    return true;
  }

  close() {
    this.child.stdin?.end();
    if (!this.isDead) {
      this.child.kill('SIGTERM');
      // A claude stuck mid-turn can ignore SIGTERM; make sure it doesn't outlive the hub.
      const child = this.child;
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
    live.delete(this);
  }

  static closeAll() {
    for (const session of live) session.close();
  }

  /**
   * Plain one-off question with no tools: starts a session, asks, closes it. It fails rather than hangs,
   * after two minutes for Haiku and fifteen otherwise unless `options.timeout` says different.
   */
  static async ask(prompt: string, system: string, model: Model = models.sonnet, effort = 'low',
                   onText?: (text: string) => void, options: { timeout?: number; caller?: string } = {}): Promise<string> {
    const session = new ClaudeSession({ model, effort, system, ...options });
    try {
      const result = await session.send([{ type: 'text', text: prompt }], (event) => {
        if (event.type === 'text') onText?.(event.text);
      });
      return result.text;
    } finally {
      session.close();
    }
  }

  private write(object: Record<string, unknown>) {
    if (this.isDead || !this.child.stdin) return;
    this.child.stdin.write(`${JSON.stringify(object)}\n`);
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        this.handle(JSON.parse(line));
      } catch {
        // Not JSON (a stray log line); skip it.
      }
    }
  }

  private handle(event: any) {
    switch (event.type) {
      case 'stream_event': {
        const inner = event.event;
        if (inner?.type !== 'content_block_delta') return;
        if (inner.delta?.type === 'text_delta') this.onEvent?.({ type: 'text', text: inner.delta.text });
        else if (inner.delta?.type === 'thinking_delta') this.onEvent?.({ type: 'thinking', text: inner.delta.thinking });
        return;
      }
      case 'assistant':
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use' && block.id && block.name) {
            this.onEvent?.({ type: 'toolStarted', id: block.id, name: block.name, input: block.input ?? {} });
          }
        }
        return;
      case 'user':
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.onEvent?.({ type: 'toolFinished', id: block.tool_use_id, isError: !!block.is_error,
                             output: resultText(block.content) });
          }
        }
        return;
      case 'rate_limit_event':
        if (event.rate_limit_info) rateLimitListeners.forEach((listener) => listener(event.rate_limit_info));
        return;
      case 'control_request': {
        const id = event.request_id;
        const request = event.request;
        if (!id || !request) return;
        if (request.subtype !== 'can_use_tool' || !request.tool_name) {
          // Hooks, MCP elicitation… aren't supported. Answer, so Claude Code doesn't wait forever.
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: "Dash doesn't support this request." } });
          return;
        }
        // "Always allow" lasts for this conversation only, and only as a narrow allow rule: Claude Code
        // also suggests mode changes and whole directories, which are far broader.
        const suggestions = ((request.permission_suggestions ?? []) as Record<string, unknown>[])
          .filter((rule) => rule.type === 'addRules' && rule.behavior === 'allow')
          .map((rule) => ({ ...rule, destination: 'session' }));
        const permission: PermissionRequest = { id, toolName: request.tool_name, displayName: request.display_name ?? request.tool_name,
                                                input: request.input ?? {}, suggestions };
        // Nobody is listening between turns; refuse rather than leave Claude hanging.
        if (this.onEvent) this.onEvent({ type: 'permission', request: permission });
        else this.respond(permission, false);
        return;
      }
      case 'result': {
        this.logUsage(event);
        const text: string = event.result ?? '';
        if (this.interruptRequested && event.is_error) {
          this.finish({ text, stopReason: 'interrupted', interrupted: true });
        } else if (event.is_error) {
          const detail = ((event.errors ?? []) as string[]).join(' ');
          this.finish(new ClaudeError(text || detail || 'Claude Code reported an error.'));
        } else {
          this.finish({ text, stopReason: event.stop_reason, interrupted: false });
        }
        return;
      }
    }
  }

  private exitMessage() {
    const detail = this.stderrText.trim();
    const lower = detail.toLowerCase();
    if (['/login', 'not logged in', 'please log in', 'authenticat', 'oauth', 'invalid api key'].some((word) => lower.includes(word))) {
      return "Claude Code isn't signed in on the hub. Run `claude` there and log in, then try again.";
    }
    return detail ? `Claude Code: ${detail.slice(-300)}` : 'Claude Code stopped unexpectedly.';
  }

  /** One hub.log line per answered call, so what each job really costs is known, not estimated. */
  private logUsage(event: any) {
    const usage = event.usage ?? {};
    const count = (value: unknown) => (typeof value === 'number' ? value : 0);
    log(`claude usage caller=${this.caller} model=${this.modelID} in=${count(usage.input_tokens)} `
      + `cache_write=${count(usage.cache_creation_input_tokens)} cache_read=${count(usage.cache_read_input_tokens)} `
      + `out=${count(usage.output_tokens)} turns=${count(event.num_turns)}`);
  }

  private finish(result: TurnResult | Error) {
    const turn = this.turn;
    if (!turn) return;
    noteOutcome(result);
    clearTimeout(turn.timer);
    this.turn = undefined;
    this.onEvent = undefined;
    this.interruptRequested = false;
    if (result instanceof Error) turn.reject(result);
    else turn.resolve(result);
  }
}

/** "90 seconds", "15 minutes". */
function duration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
}

/**
 * Whether Claude Code on the hub is signed in, from `claude auth status` (no model call, so it costs no
 * usage). Resolves to undefined when it is, or to what's wrong. Never takes more than 30 seconds.
 */
export function claudeSignInProblem(): Promise<string | undefined> {
  const executable = findClaude();
  if (!executable) return Promise.resolve("Couldn't find the claude command. Install Claude Code on the hub and sign in with `claude`.");
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve) => {
    execFile(executable, ['auth', 'status'], { env, timeout: 30_000 }, (error, stdout) => {
      let status: Record<string, unknown> = {};
      try {
        status = JSON.parse(stdout);
      } catch {}
      if (!error && status.loggedIn !== false) return resolve(undefined);
      if ((error as (Error & { killed?: boolean }) | null)?.killed) return resolve("`claude auth status` didn't answer in 30 seconds.");
      resolve("Claude Code isn't signed in on the hub. Run `claude` there and log in.");
    });
  });
}

/**
 * `claude auth status` only reads the saved sign-in, so it stays happy when every real call fails (a
 * revoked token, a usage limit). Real calls' outcomes cover that: several failures in a row with no
 * success since is a problem worth a banner.
 */
const recentCalls = { failuresInARow: 0, lastError: '', lastAt: 0 };

function noteOutcome(result: TurnResult | Error) {
  if (result instanceof Error) {
    recentCalls.failuresInARow += 1;
    recentCalls.lastError = result.message;
  } else {
    recentCalls.failuresInARow = 0;
  }
  recentCalls.lastAt = Date.now();
}

/** Why Claude calls on the hub are failing, if the last 3 or more in a row failed within the past 2 hours. */
export function claudeCallProblem(): string | undefined {
  if (recentCalls.failuresInARow < 3 || Date.now() - recentCalls.lastAt > 2 * 3_600_000) return undefined;
  return `the last ${recentCalls.failuresInARow} Claude calls failed: ${recentCalls.lastError.slice(0, 200)}`;
}

/** A tool_result's content is a string, or a list of text blocks. */
function resultText(content: unknown): string {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((block) => block?.text ?? '').filter(Boolean).join('\n') : '';
  return text.length > 30_000 ? `${text.slice(0, 30_000)}\n… (output truncated)` : text;
}
