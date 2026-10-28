import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { ClaudeSession, type ClaudeEvent, type Model, models, type PermissionRequest, type Profile } from './claude.ts';
import { jarvisMcpConfig } from './jarvis.ts';
import { log } from './log.ts';
import { type Memory } from './memory.ts';
import { DATA, HOME, MEMORY_DIR, paths } from './paths.ts';
import { aboutMe, investorProfile, now, persona, profile, prompt } from './personal.ts';
import { readTools } from './portfolio/robinhood.ts';
import { isSkillName, loadSkill, type Skill } from './skills.ts';

// Same shapes as Conversation.Turn / ToolCall and ChatMeta in the Mac app, so saved chats move between
// them unchanged and Mac Dash decodes these with its own Codable types.
export type ToolCall = { id: string; name: string; done: boolean; failed: boolean; inputJSON: string; output: string; summary: string };
export type Turn = {
  id: string; role: 'user' | 'assistant'; text: string; isError: boolean; tools: ToolCall[]; thinking: string;
  attachments: string[]; stopped: boolean;
};
export type ChatMeta = {
  id: string; title: string; titleIsCustom: boolean; createdAt: string; updatedAt: string; sessionID: string;
  sessionStarted: boolean; modelID?: string; effort: string; permissionMode: string; skillName?: string;
  /** "advisor" for the Portfolio advisor, "checkin" for the evening check-in; plain chats have none. */
  kind?: 'advisor' | 'checkin';
  /** Off the record: never summarized into Dash's memory. */
  offRecord?: boolean;
  /** How many turns have been summarized into memory already. */
  summarized?: number;
};

/**
 * The Portfolio advisor is one chat with a fixed id (a UUID, so Mac Dash can decode it) that isn't in
 * the history list. "New session" deletes it; the next message starts it again.
 */
export const ADVISOR_ID = '00000000-0000-4000-8000-0000000000AD';

/** What the advisor needs from Portfolio: the read-only Robinhood relay and a snapshot of the numbers. */
export type AdvisorSupport = { relay: () => Record<string, unknown> | undefined; snapshot: () => string };
export type Settings = {
  modelID?: string | null; effort?: string; permissionMode?: string; skillName?: string | null; offRecord?: boolean;
  /** Only when starting a chat: "checkin" for the evening check-in. */
  kind?: string;
};
/** Turns a conversation into a few lines for memory (Haiku in the hub; a stand-in in tests). */
export type Summarizer = (transcript: string) => Promise<string>;

type Queued = { id: string; text: string; blocks: Record<string, unknown>[]; attachments: string[] };
type Status = 'idle' | 'thinking' | 'streaming';

class Failure extends Error {}

/** One saved chat and, while it's in use, its Claude Code session. */
class Chat {
  meta: ChatMeta;
  turns: Turn[];
  session?: ClaudeSession;
  status: Status = 'idle';
  approvals: PermissionRequest[] = [];
  queue: Queued[] = [];
  stopping = false;
  notice?: string;
  /** A setting changed mid-answer; the session restarts (with --resume) after this turn. */
  respawnAfterTurn = false;
  /** Set when Stop had to kill the process, so the failure that follows reads as "stopped". */
  cancelled = false;
  /** Bumped when the chat is reset, so a turn still running for the old state can't write into it. */
  generation = 0;
  lastUsed = Date.now();

  constructor(meta: ChatMeta, turns: Turn[]) {
    this.meta = meta;
    this.turns = turns;
  }

  get isBusy() {
    return this.status !== 'idle';
  }
}

/** JavaScript dates with no milliseconds, which Swift's .iso8601 decoding needs. */
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Swift writes UUIDs in capitals; use the same everywhere so ids compare as plain strings. */
const newID = () => randomUUID().toUpperCase();
/** A chat id from an app, or '' if it isn't a UUID (ids become file names, so nothing else is allowed). */
const normalize = (id: unknown) => {
  const upper = String(id ?? '').toUpperCase();
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(upper) ? upper : '';
};

/** jarvis tools that only read, so they run without asking (ClaudeProfile.jarvisReads). */
const jarvisReads = ['calendar_get', 'email_read', 'weather_get', 'web_search', 'docs_read_section'].map((tool) => `mcp__jarvis__${tool}`);
/**
 * Lecture recording lives on the Mac, and the headless browser isn't part of the console. jarvis's
 * file_read is left out too: it has no path limits, so it would get round the rules that keep chats out
 * of the hub's secrets, and Read already reaches the same files on the hub.
 */
const jarvisBlocked = ['lecture_start', 'lecture_stop', 'lecture_status', 'lecture_get_new_transcript', 'lecture_bootstrap_course',
                       'browser_navigate', 'browser_interact', 'browser_screenshot', 'file_read'].map((tool) => `mcp__jarvis__${tool}`);
const chatTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'Task'];

/** What the apps may set on a chat. Anything else is refused rather than quietly replaced. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** No bypassPermissions: every change outside Dash's own files goes through a card. */
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'];

const SAVED_OUTPUT = 8_000;
const LIVE_OUTPUT = 4_000;
const IDLE_CLOSE = 30 * 60_000;
/** A chat with no session left is dropped from memory after this; it's read from disk again when needed. */
const IDLE_EVICT = 60 * 60_000;
const STOP_GRACE = 4_000;

/**
 * Console chats, run on the hub (a port of ChatConversation + Conversation from the Mac app): full
 * Claude Code sessions with jarvis, Approve/Deny for anything that changes something, saved history,
 * resume, Stop, and a queue. Any number of chats can run at once (one on the phone, one on the Mac);
 * idle sessions close after a while and resume with their context on the next message.
 */
export class Chats {
  private chats = new Map<string, Chat>();
  private metas: ChatMeta[] = [];
  private readonly dir: string;
  /**
   * Off-the-record chats are saved in a folder of their own that no Claude session may read (see
   * protectedPaths in claude.ts), so an on-record chat searching old chats can't find them. A chat
   * that was ever off the record stays there, since its transcript has off-the-record turns in it.
   */
  private readonly offDir: string;
  private offRecordIDs = new Set<string>();
  private chatListeners = new Set<(id: string) => void>();
  private indexListeners = new Set<() => void>();
  private advisor?: AdvisorSupport;
  private memory?: Memory;
  private summarizer: Summarizer = (transcript) => ClaudeSession.ask(transcript, prompt('summary'), models.haiku, 'low', undefined, { caller: 'summary' });
  private summarizing = new Set<string>();

  constructor(dir = paths.chats) {
    this.dir = dir;
    this.offDir = join(dir, 'off-record');
    mkdirSync(dir, { recursive: true });
    mkdirSync(this.offDir, { recursive: true, mode: 0o700 });
    this.offRecordIDs = new Set(chatFiles(this.offDir).map((name) => name.slice(0, -'.json'.length)));
    this.metas = this.readIndex() ?? this.readAll();
    // Off-the-record chats saved before they had their own folder move into it.
    for (const meta of this.metas) {
      if (meta.offRecord && !this.offRecordIDs.has(meta.id) && existsSync(this.file(meta.id))) this.moveOffRecord(meta.id);
    }
    this.metas = this.metas.filter((meta) => meta.kind !== 'advisor' && existsSync(this.file(meta.id)));
    this.sortIndex();
    this.writeIndex();
    setInterval(() => this.closeIdle(), 5 * 60_000).unref();
  }

  setAdvisor(support: AdvisorSupport) {
    this.advisor = support;
  }

  /** Conversations go into Dash's memory when they go quiet, and chats are given that memory. */
  setMemory(memory: Memory, summarizer?: Summarizer) {
    this.memory = memory;
    if (summarizer) this.summarizer = summarizer;
  }

  onChat(listener: (id: string) => void) {
    this.chatListeners.add(listener);
  }

  onIndex(listener: () => void) {
    this.indexListeners.add(listener);
  }

  list() {
    return { chats: this.metas };
  }

  /** The whole chat, for opening it. */
  open(id: unknown) {
    const chat = this.get(normalize(id));
    if (!chat) throw new Failure("That chat doesn't exist anymore.");
    return { ...this.live(chat), turns: chat.turns.map(liveTurn) };
  }

  /** What changed in a chat, for the `chat` event: everything but the full transcript. */
  live(chat: Chat) {
    return {
      id: chat.meta.id, meta: chat.meta, count: chat.turns.length, tail: chat.turns.slice(-2).map(liveTurn),
      status: chat.status, stopping: chat.stopping, notice: chat.notice ?? null,
      approvals: chat.approvals.map((request) => ({ id: request.id, toolName: request.toolName, displayName: request.displayName,
                                                    input: request.input, canAlways: request.suggestions.length > 0 })),
      queue: chat.queue.map(({ id, text, attachments }) => ({ id, text, attachments })),
    };
  }

  liveState(id: string) {
    const chat = this.chats.get(id);
    return chat ? this.live(chat) : undefined;
  }

  /**
   * Sends a message, or queues it if the chat is still answering. A chat id the hub hasn't seen yet
   * starts a new chat with `settings` (the apps make the id, so they can show the chat right away).
   */
  send(id: unknown, text: string, blocks: Record<string, unknown>[] = [], attachments: string[] = [], settings: Settings = {}) {
    if (id !== undefined && id !== null && id !== '' && !normalize(id)) throw new Failure("That isn't a chat id.");
    const trimmed = text.trim();
    if (!trimmed && !blocks.length) throw new Failure('Nothing to send.');
    const chatID = normalize(id) || newID();
    let chat = this.get(chatID);
    if (!chat) {
      checkSettings(settings);
      const stamp = isoNow();
      const advisor = chatID === ADVISOR_ID;
      const kind = advisor ? 'advisor' as const : settings.kind === 'checkin' ? 'checkin' as const : undefined;
      chat = new Chat({ id: chatID, title: advisor ? 'Portfolio advisor' : 'New chat', titleIsCustom: advisor,
                        ...(kind ? { kind } : {}), ...(settings.offRecord ? { offRecord: true } : {}), createdAt: stamp, updatedAt: stamp, sessionID: newID(),
                        sessionStarted: false, effort: settings.effort ?? 'medium', permissionMode: settings.permissionMode ?? 'default',
                        ...(settings.modelID ? { modelID: settings.modelID } : {}),
                        ...(settings.skillName ? { skillName: settings.skillName } : {}) }, []);
      this.chats.set(chatID, chat);
    }
    if (chat.isBusy) {
      chat.queue.push({ id: newID(), text: trimmed, blocks, attachments });
      this.changed(chat);
    } else {
      this.dispatch(chat, trimmed, blocks, attachments);
    }
    return { chat: chatID };
  }

  stop(id: unknown) {
    const chat = this.require(id);
    chat.queue = [];
    // Busy with no turn actually running (Claude Code failed to start, say): just put it back to idle.
    if (chat.isBusy && !chat.session?.isTurnActive) return this.unstick(chat);
    if (!chat.isBusy || chat.stopping) return;
    // Interrupting keeps the session and its memory of the conversation; if Claude Code doesn't wrap
    // up in a few seconds, the process is closed outright.
    if (chat.session?.interrupt()) {
      chat.stopping = true;
      chat.approvals = [];
      const generation = chat.generation;
      setTimeout(() => {
        if (generation === chat.generation && chat.stopping) this.cancel(chat);
      }, STOP_GRACE).unref();
    } else {
      this.cancel(chat);
    }
    this.changed(chat);
  }

  decide(id: unknown, requestID: unknown, allow: boolean, always = false) {
    const chat = this.require(id);
    const request = chat.approvals.find((candidate) => candidate.id === requestID);
    if (!request) throw new Failure('That request was already answered.');
    chat.approvals = chat.approvals.filter((candidate) => candidate !== request);
    chat.session?.respond(request, allow, always);
    this.changed(chat);
  }

  unqueue(id: unknown, queuedID: unknown) {
    const chat = this.require(id);
    chat.queue = chat.queue.filter((message) => message.id !== queuedID);
    this.changed(chat);
  }

  /** Asks the same question again, as a new message (Claude Code can't rewind a session). */
  retry(id: unknown, turnID: unknown) {
    const chat = this.require(id);
    if (chat.isBusy) throw new Failure('Wait for the current answer to finish first.');
    const index = chat.turns.findIndex((turn) => turn.id === turnID);
    const question = chat.turns.slice(0, Math.max(index, 0)).reverse().find((turn) => turn.role === 'user');
    if (index < 0 || !question) throw new Failure("Couldn't find the question to ask again.");
    this.dispatch(chat, question.text, [], []);
    if (question.attachments.length) {
      chat.notice = `Asked again without the attached files (${question.attachments.join(', ')}). Attach them again if they matter.`;
      this.changed(chat);
    }
  }

  rename(id: unknown, title: string) {
    const chat = this.require(id);
    const trimmed = title.trim();
    if (!trimmed) return;
    chat.meta.title = trimmed;
    chat.meta.titleIsCustom = true;
    this.persist(chat, false);
  }

  delete(id: unknown) {
    const chat = this.require(id);
    if (chat.isBusy && chat.session?.isTurnActive) throw new Failure('Stop the answer before deleting this chat.');
    this.resetSession(chat);
    this.chats.delete(chat.meta.id);
    rmSync(this.file(chat.meta.id), { force: true });
    this.offRecordIDs.delete(chat.meta.id);
    this.metas = this.metas.filter((meta) => meta.id !== chat.meta.id);
    this.writeIndex();
    this.indexListeners.forEach((listener) => listener());
  }

  /** Model, effort, permissions or skill. The session restarts with them, resuming the conversation. */
  settings(id: unknown, settings: Settings) {
    const chat = this.require(id);
    // The skill a chat already has is fine even if its folder has since gone; only a new one must exist.
    checkSettings(settings, chat.meta.skillName);
    // Apps send every setting each time; only a different skill counts as changing it. Check before
    // changing anything, so a refusal leaves the chat as it was.
    const skillChanges = 'skillName' in settings && (settings.skillName || undefined) !== chat.meta.skillName;
    if (skillChanges && chat.isBusy) throw new Failure('Wait for the current answer to finish before changing the skill.');
    if ('modelID' in settings) {
      if (settings.modelID) chat.meta.modelID = settings.modelID;
      else delete chat.meta.modelID;
    }
    if (settings.effort) chat.meta.effort = settings.effort;
    if (typeof settings.offRecord === 'boolean' && settings.offRecord !== !!chat.meta.offRecord) {
      if (settings.offRecord) {
        chat.meta.offRecord = true;
      } else {
        // Back on the record from here: everything said so far counts as already remembered, so the
        // off-the-record part is never summarized.
        delete chat.meta.offRecord;
        chat.meta.summarized = chat.turns.length;
      }
    }
    if (settings.permissionMode) chat.meta.permissionMode = settings.permissionMode;
    if (skillChanges) {
      if (settings.skillName) chat.meta.skillName = settings.skillName;
      else delete chat.meta.skillName;
    }
    this.persist(chat, false);
    if (chat.isBusy) chat.respawnAfterTurn = true;
    else if (chat.session) this.resetSession(chat);
  }

  closeAll() {
    for (const chat of this.chats.values()) this.resetSession(chat);
  }

  // Running a turn

  private dispatch(chat: Chat, text: string, blocks: Record<string, unknown>[], attachments: string[]) {
    // The system prompt is fixed when the session starts, so give the clock with each message.
    const content = [{ type: 'text', text: `(It is now ${now()}.)` }, ...blocks,
                     { type: 'text', text: text || '(See the attached.)' }];
    // An advisor session starts with everything Portfolio has computed.
    if (chat.meta.kind === 'advisor' && !chat.meta.sessionStarted && !chat.session && this.advisor) {
      content.unshift({ type: 'text', text: `<portfolio_snapshot source="Dash, computed from Robinhood">\n${this.advisor.snapshot()}\n</portfolio_snapshot>` });
    }
    this.run(chat, content, newTurn('user', text, attachments));
    this.persist(chat);
  }

  private run(chat: Chat, content: Record<string, unknown>[], display: Turn) {
    chat.notice = undefined;
    chat.lastUsed = Date.now();
    chat.turns.push(display);
    const turn = newTurn('assistant');
    chat.turns.push(turn);
    let session: ClaudeSession;
    try {
      session = chat.session ?? this.makeSession(chat);
      chat.session = session;
    } catch (error) {
      turn.text = (error as Error).message;
      turn.isError = true;
      this.changed(chat);
      return;
    }
    chat.status = 'thinking';
    chat.stopping = false;
    chat.cancelled = false;
    let breakBeforeText = false;
    const generation = chat.generation;
    this.changed(chat);

    const onEvent = (event: ClaudeEvent) => {
      if (generation !== chat.generation) return;
      chat.status = 'streaming';
      switch (event.type) {
        case 'text':
          if (breakBeforeText && turn.text) turn.text += '\n\n';
          breakBeforeText = false;
          turn.text += event.text;
          break;
        case 'thinking':
          turn.thinking += event.text;
          break;
        case 'toolStarted':
          if (turn.tools.some((call) => call.id === event.id)) return;
          turn.tools.push({ id: event.id, name: event.name, done: false, failed: false, inputJSON: stableJSON(event.input), output: '',
                            summary: summary(event.name, event.input) });
          breakBeforeText = true;
          break;
        case 'toolFinished': {
          const call = turn.tools.find((candidate) => candidate.id === event.id);
          if (call) Object.assign(call, { done: true, failed: event.isError, output: event.output });
          break;
        }
        case 'permission':
          if (autoApproves(event.request, chat.meta)) session.respond(event.request, true);
          else chat.approvals.push(event.request);
          break;
      }
      this.changed(chat);
    };

    session.send(content, onEvent).then((result) => {
      if (generation !== chat.generation) return;
      if (!turn.text) turn.text = result.text;
      if (result.interrupted) {
        markStopped(turn);
      } else if (result.stopReason === 'refusal') {
        turn.text = 'Claude declined to answer this one. Try rephrasing.';
        turn.isError = true;
      } else if (!turn.text) {
        turn.text = 'No answer came back. Try again.';
        turn.isError = true;
      } else if (result.stopReason === 'max_tokens') {
        turn.text += '\n\n*(Cut off at the length limit.)*';
      }
    }, (error: Error) => {
      if (generation !== chat.generation) return;
      // The process is gone or unreliable; the next message respawns it and resumes the context.
      this.resetSession(chat, false);
      if (chat.cancelled) {
        markStopped(turn);
      } else {
        // Claude Code lost the session (its transcript was deleted, say): continue fresh.
        if (chat.meta.sessionStarted && /no conversation found/i.test(error.message)) {
          chat.meta.sessionStarted = false;
          chat.notice = "Claude Code no longer has this chat's earlier context, so it will continue as a fresh session.";
        }
        if (!turn.text) {
          turn.text = error.message;
          turn.isError = true;
        } else {
          turn.text += `\n\n*(${error.message})*`;
        }
      }
    }).finally(() => {
      if (generation !== chat.generation) return;
      for (const call of turn.tools) if (!call.done) Object.assign(call, { done: true, failed: true });
      chat.approvals = [];
      chat.status = 'idle';
      chat.stopping = false;
      chat.lastUsed = Date.now();
      this.turnDidFinish(chat, turn);
    });
  }

  private turnDidFinish(chat: Chat, turn: Turn) {
    // The session now exists in Claude Code, so later spawns resume it. A turn killed before Claude
    // Code answered may never have created it, so only a live process or a finished turn counts.
    if (!turn.isError && (!turn.stopped || chat.session)) chat.meta.sessionStarted = true;
    this.persist(chat);
    if (chat.respawnAfterTurn) {
      chat.respawnAfterTurn = false;
      this.resetSession(chat, false);
    }
    const next = chat.queue.shift();
    if (next) this.dispatch(chat, next.text, next.blocks, next.attachments);
  }

  private cancel(chat: Chat) {
    chat.cancelled = true;
    chat.session?.close();
  }

  private makeSession(chat: Chat) {
    if (chat.meta.kind === 'advisor') return this.makeAdvisorSession(chat);
    const skill = chat.meta.skillName ? loadSkill(chat.meta.skillName) : undefined;
    mkdirSync(paths.outputDir, { recursive: true });
    const addDirs = ['Documents', 'Desktop', 'Downloads', 'BrightspaceToDo'].map((dir) => join(HOME, dir))
      .concat([DATA, paths.outputDir], skill ? [skill.directory] : []);
    // Dash reads the user's portfolio from chats too, through the same read-only relay as the advisor.
    const relay = this.advisor?.relay();
    let mcpConfig = jarvisMcpConfig;
    if (relay) {
      // Written to a private file rather than the command line, since it carries the relay's secret.
      mcpConfig = join(DATA, 'mcp-console.json');
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { ...JSON.parse(jarvisMcpConfig).mcpServers, robinhood: relay } }), { mode: 0o600 });
    }
    const robinhoodReads = relay ? [...readTools].sort().map((tool) => `mcp__robinhood__${tool}`) : [];
    const profile: Profile = {
      tools: chatTools, allowedTools: [...jarvisReads, ...robinhoodReads, 'Read', 'Glob', 'Grep', 'WebSearch', 'Task'],
      disallowedTools: jarvisBlocked, addDirs, mcpConfig, keepDefaultPrompt: true,
      ...(chat.meta.permissionMode !== 'default' ? { permissionMode: chat.meta.permissionMode } : {}),
    };
    // A chat that hasn't completed a turn has nothing to resume; a half-started session ID may be taken.
    if (!chat.meta.sessionStarted) chat.meta.sessionID = newID();
    return new ClaudeSession({ model: findModel(chat.meta.modelID), effort: chat.meta.effort, system: consoleSystem(chat.meta, skill, this.memory),
                               profile, sessionID: chat.meta.sessionID, resume: chat.meta.sessionStarted, caller: chat.meta.kind ?? 'chat' });
  }

  /**
   * The advisor (AdvisorConversation in the Mac app): a senior risk manager and analyst with Robinhood's
   * read tools through the hub's relay, web research for cross-checking, and the investor profile as
   * permanent memory, which it edits without a card. It reads web pages it's pointed at, so it gets no
   * free run of the data folder: only the profile and SEC filings need no card.
   */
  private makeAdvisorSession(chat: Chat) {
    const relay = this.advisor?.relay();
    if (!relay) throw new Failure("Robinhood isn't connected. Connect it from Portfolio in Dash on the Mac.");
    // Written to a private file rather than the command line, since it carries the relay's secret.
    const config = join(DATA, 'mcp-advisor.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { robinhood: relay } }), { mode: 0o600 });
    const profile = investorProfile();
    const system = `${prompt('advisor')}

<about_me>
${aboutMe()}
</about_me>

<investor_profile path="${paths.investorProfile}">
${profile}
</investor_profile>`;
    if (!chat.meta.sessionStarted) chat.meta.sessionID = newID();
    return new ClaudeSession({
      model: findModel(chat.meta.modelID), effort: chat.meta.effort, system, sessionID: chat.meta.sessionID, resume: chat.meta.sessionStarted,
      caller: 'advisor',
      profile: { tools: ['Read', 'Edit', 'Write', 'WebSearch', 'WebFetch'], mcpConfig: config,
                 allowedTools: [...[...readTools].sort().map((tool) => `mcp__robinhood__${tool}`), `Read(/${resolve(paths.investorProfile)})`,
                                'WebSearch', 'WebFetch(domain:sec.gov)', 'WebFetch(domain:*.sec.gov)'] },
    });
  }

  private resetSession(chat: Chat, bump = true) {
    chat.session?.close();
    chat.session = undefined;
    chat.approvals = [];
    if (bump && chat.isBusy) {
      chat.generation += 1;
      chat.status = 'idle';
    }
  }

  /** A chat marked busy with nothing running goes back to idle, its unfinished answer marked stopped. */
  private unstick(chat: Chat) {
    log(`chat ${chat.meta.id} was busy with no answer running; set back to idle`);
    this.resetSession(chat);
    chat.stopping = false;
    chat.approvals = [];
    const last = chat.turns.at(-1);
    if (last?.role === 'assistant' && !last.text && !last.isError) markStopped(last);
    this.persist(chat, false);
  }

  /**
   * Sessions nobody has used for a while are closed; the next message resumes them with their context.
   * Chats with no session left are dropped from memory a while later, and read from disk when next used.
   */
  private closeIdle() {
    for (const [id, chat] of this.chats) {
      const idle = Date.now() - chat.lastUsed;
      if (chat.session && !chat.isBusy && idle > IDLE_CLOSE) {
        this.resetSession(chat);
        this.summarize(chat);
      } else if (!chat.session && !chat.isBusy && !chat.queue.length && idle > IDLE_EVICT && !this.summarizing.has(id)) {
        this.chats.delete(id);
      }
    }
  }

  // Memory

  /**
   * Writes the new part of a conversation into today's memory log as a few lines, once it has gone quiet.
   * Off-the-record chats never are. Returns whether anything was written.
   */
  async summarize(chat: Chat): Promise<boolean> {
    const from = chat.meta.summarized ?? 0;
    const upTo = chat.turns.length;
    if (!this.memory || chat.meta.offRecord || upTo <= from || chat.isBusy || this.summarizing.has(chat.meta.id)) return false;
    const fresh = chat.turns.slice(from, upTo);
    if (!fresh.some((turn) => turn.role === 'assistant' && turn.text && !turn.isError)) return false;
    this.summarizing.add(chat.meta.id);
    try {
      const earlier = from > 0 ? `(Earlier in this conversation, already remembered: ${from} turns.)\n\n` : '';
      // A chat that was off the record earlier is titled from its off-the-record start, so its title stays out too.
      const chatTitle = this.offRecordIDs.has(chat.meta.id) ? 'Chat' : chat.meta.title;
      const reply = (await this.summarizer(`${earlier}<conversation title="${chatTitle}">\n${transcript(fresh)}\n</conversation>`)).trim();
      if (chat.meta.offRecord) return false;
      if (reply && !/^\(nothing to remember\)$/i.test(reply)) {
        const source = chat.meta.kind === 'advisor' ? 'advisor' : chat.meta.kind === 'checkin' ? 'checkin' : 'chat';
        this.memory.log({ source, kind: 'summary', text: reply, chat: chat.meta.id, title: chatTitle });
      }
      // Never move it back: if the chat went off and on the record meanwhile, that already marked
      // everything up to then as summarized, and the off-the-record turns must stay that way.
      chat.meta.summarized = Math.max(chat.meta.summarized ?? 0, upTo);
      this.persist(chat, false);
      return true;
    } catch (error) {
      log(`summary failed for ${chat.meta.id}: ${(error as Error).message}`);
      return false;
    } finally {
      this.summarizing.delete(chat.meta.id);
    }
  }

  /** Summarizes every recent chat with turns not yet in memory (before the nightly write-up). */
  async summarizePending(withinDays = 3) {
    const since = new Date(Date.now() - withinDays * 86_400_000).toISOString();
    const ids = [...this.metas.filter((meta) => meta.updatedAt >= since).map((meta) => meta.id), ADVISOR_ID];
    let count = 0;
    for (const id of ids) {
      const chat = this.get(id);
      if (chat && await this.summarize(chat)) count += 1;
    }
    return count;
  }

  /** The most recent time the user sent a message in any chat. */
  lastMessageAt(): Date | undefined {
    const latest = this.metas[0]?.updatedAt;
    return latest ? new Date(latest) : undefined;
  }

  // Storage: one JSON file per chat plus index.json, the same files Mac Dash used to keep. Off-the-record
  // chats are in off-record/, with their own index.json.

  private file(id: string) {
    return join(this.offRecordIDs.has(id) ? this.offDir : this.dir, `${id}.json`);
  }

  /** Moves a chat's file into off-record/ (where it then stays). */
  private moveOffRecord(id: string) {
    const from = join(this.dir, `${id}.json`);
    this.offRecordIDs.add(id);
    try {
      if (existsSync(from)) renameSync(from, this.file(id));
    } catch (error) {
      log(`couldn't move chat ${id} off the record: ${(error as Error).message}`);
    }
  }

  private require(id: unknown) {
    const chat = this.get(normalize(id));
    if (!chat) throw new Failure("That chat doesn't exist anymore.");
    return chat;
  }

  private get(id: string): Chat | undefined {
    if (!id) return undefined;
    const loaded = this.chats.get(id);
    if (loaded) return loaded;
    try {
      const stored = JSON.parse(readFileSync(this.file(id), 'utf8'));
      const chat = new Chat(stored.meta, (stored.turns ?? []).map(normalizeTurn));
      this.chats.set(id, chat);
      return chat;
    } catch {
      return undefined;
    }
  }

  private persist(chat: Chat, touch = true) {
    if (!chat.turns.length) return;
    if (chat.meta.offRecord && !this.offRecordIDs.has(chat.meta.id)) this.moveOffRecord(chat.meta.id);
    if (touch) chat.meta.updatedAt = isoNow();
    const first = chat.turns.find((turn) => turn.role === 'user');
    if (!chat.meta.titleIsCustom && first) chat.meta.title = title(first);
    // Tool output can be huge; the saved transcript keeps the start of it.
    const turns = chat.turns.map((turn) => ({
      ...turn,
      tools: turn.tools.map((call) => call.output.length > SAVED_OUTPUT
        ? { ...call, output: `${call.output.slice(0, SAVED_OUTPUT)}\n… (saved copy truncated)` } : call),
    }));
    writeAtomic(this.file(chat.meta.id), JSON.stringify({ meta: chat.meta, turns }));
    if (chat.meta.kind === 'advisor') {
      this.changed(chat);
      return;
    }
    const index = this.metas.findIndex((meta) => meta.id === chat.meta.id);
    if (index >= 0) this.metas[index] = { ...chat.meta };
    else this.metas.unshift({ ...chat.meta });
    this.sortIndex();
    this.writeIndex();
    this.indexListeners.forEach((listener) => listener());
    this.changed(chat);
  }

  private changed(chat: Chat) {
    this.chatListeners.forEach((listener) => listener(chat.meta.id));
  }

  private sortIndex() {
    this.metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private readIndex(): ChatMeta[] | undefined {
    try {
      const metas: ChatMeta[] = JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8'));
      let hidden: ChatMeta[] = [];
      try {
        hidden = JSON.parse(readFileSync(join(this.offDir, 'index.json'), 'utf8'));
      } catch {
        // No off-the-record index yet; any such chat not in the main one is found by readAll next time.
      }
      const known = new Set(metas.map((meta) => meta.id));
      return [...metas, ...hidden.filter((meta) => !known.has(meta.id))];
    } catch {
      return undefined;
    }
  }

  private writeIndex() {
    writeAtomic(join(this.dir, 'index.json'), JSON.stringify(this.metas.filter((meta) => !this.offRecordIDs.has(meta.id))));
    writeAtomic(join(this.offDir, 'index.json'), JSON.stringify(this.metas.filter((meta) => this.offRecordIDs.has(meta.id))));
  }

  /** A missing or unreadable index is rebuilt from the chat files. */
  private readAll(): ChatMeta[] {
    return [this.dir, this.offDir].flatMap((dir) => chatFiles(dir).flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(dir, name), 'utf8')).meta as ChatMeta];
      } catch {
        return [];
      }
    }));
  }
}

// Helpers

function newTurn(role: Turn['role'], text = '', attachments: string[] = []): Turn {
  return { id: newID(), role, text, isError: false, tools: [], thinking: '', attachments, stopped: false };
}

/** Saved chats outlive versions; fill in anything an older file doesn't have. */
function normalizeTurn(turn: Partial<Turn>): Turn {
  return {
    id: turn.id ?? newID(), role: turn.role ?? 'assistant', text: turn.text ?? '', isError: turn.isError ?? false,
    tools: ((turn.tools ?? []) as Partial<ToolCall>[]).map((call) => ({
      id: call.id ?? newID(), name: call.name ?? 'tool', done: call.done ?? true, failed: call.failed ?? false,
      inputJSON: call.inputJSON ?? '{}', output: call.output ?? '', summary: call.summary ?? '',
    })),
    thinking: turn.thinking ?? '', attachments: turn.attachments ?? [], stopped: turn.stopped ?? false,
  };
}

/** A turn for the apps, with very long tool output cut (the full transcript is saved on the hub). */
function liveTurn(turn: Turn): Turn {
  return {
    ...turn,
    tools: turn.tools.map((call) => call.output.length > LIVE_OUTPUT
      ? { ...call, output: `${call.output.slice(0, LIVE_OUTPUT)}\n… (cut for display)` } : call),
  };
}

function markStopped(turn: Turn) {
  turn.stopped = true;
  if (!turn.text && !turn.tools.length) turn.text = '*(Stopped.)*';
}

function title(turn: Turn) {
  const source = turn.text || turn.attachments[0] || 'New chat';
  const line = source.split(/\r?\n/)[0] ?? source;
  return line.length > 48 ? `${line.slice(0, 48).trim()}…` : line;
}

function findModel(id?: string): Model {
  return Object.values(models).find((model) => model.id === id) ?? models.opus;
}

/** The chat files in a folder (every .json but the index). */
function chatFiles(dir: string) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'index.json');
  } catch {
    return [];
  }
}

/**
 * Refuses any setting outside what the apps offer: a known model (or none, for the default), an effort
 * level, a permission mode other than bypassPermissions, a skill that's really there, and nothing but
 * "checkin" as a kind. Empty values mean "leave as is", as before.
 */
function checkSettings(settings: Settings, currentSkill?: string) {
  if (!settings || typeof settings !== 'object') throw new Failure('Those chat settings are malformed.');
  const { modelID, effort, permissionMode, skillName, offRecord, kind } = settings;
  if (modelID && !Object.values(models).some((model) => model.id === modelID)) throw new Failure(`Dash doesn't know the model "${modelID}".`);
  if (effort && !EFFORTS.includes(effort)) throw new Failure(`"${effort}" isn't an effort level (${EFFORTS.join(', ')}).`);
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) {
    throw new Failure(`"${permissionMode}" isn't a permission mode Dash allows (${PERMISSION_MODES.join(', ')}).`);
  }
  if (skillName && skillName !== currentSkill && (!isSkillName(skillName) || !loadSkill(skillName))) throw new Failure(`There's no skill called "${skillName}" on the hub.`);
  if (offRecord !== undefined && offRecord !== null && typeof offRecord !== 'boolean') throw new Failure('"Off the record" must be on or off.');
  if (kind && kind !== 'checkin') throw new Failure(`"${kind}" isn't a kind of chat.`);
}

/**
 * Memory and to-do list edits, and new files saved into ~/Documents/Dash, don't need a card. In an
 * off-the-record chat, memory and deadlines edits do, since nothing from it should end up there.
 */
function autoApproves(request: PermissionRequest, meta: ChatMeta) {
  if (!['Edit', 'Write'].includes(request.toolName) || typeof request.input.file_path !== 'string') return false;
  const target = resolve(request.input.file_path);
  // The advisor's memory is the investor profile; nothing else it writes skips the card.
  if (meta.kind === 'advisor') return target === resolve(paths.investorProfile);
  if (target === resolve(paths.todo)) return true;
  if (!meta.offRecord && (target === resolve(paths.deadlines) || target.startsWith(`${resolve(MEMORY_DIR)}/`))) return true;
  return request.toolName === 'Write' && target.startsWith(`${resolve(paths.outputDir)}/`) && !existsSync(target);
}

/** The gist shown beside a tool call (Tools.summary in the Mac app). */
function summary(name: string, input: Record<string, any>): string {
  const file = (key: string) => (typeof input[key] === 'string' ? basename(input[key]) : undefined);
  switch (name) {
    case 'Bash': return String(input.command ?? '').split('\n')[0];
    case 'Read': case 'Edit': case 'Write': return file('file_path') ?? '';
    case 'Glob': case 'Grep': return input.pattern ?? '';
    case 'WebFetch': return input.url ?? '';
    case 'WebSearch': return input.query ?? '';
    case 'Task': return input.description ?? '';
    default: return input.query ?? input.subject ?? input.title ?? '';
  }
}

/** A conversation as plain text for the summarizer: who said what, with tools as one-line notes. */
function transcript(turns: Turn[]) {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const speaker = profile().named ? profile().name : 'User';
  const lines = turns.flatMap((turn) => {
    if (turn.role === 'user') return [`${speaker}: ${clip(turn.text || '(attachment)', 3_000)}`];
    const tools = turn.tools.length ? `[${turn.tools.map((call) => `${call.name} ${call.summary}`.trim()).join('; ')}] ` : '';
    return turn.text || tools ? [`Dash: ${tools}${clip(turn.isError ? '(error)' : turn.text, 2_000)}`] : [];
  });
  let text = lines.join('\n\n');
  if (text.length > 40_000) text = `…\n\n${text.slice(-40_000)}`;
  return text;
}

/** JSON with sorted keys, like the Mac's ToolCall.json, so the same call always reads the same. */
function stableJSON(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value ?? {}));
}

function writeAtomic(file: string, text: string) {
  try {
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    log(`chat save failed: ${(error as Error).message}`);
  }
}

/** The system prompt for a console chat (Personal.consoleSystem), with a skill's instructions if one is loaded. */
function consoleSystem(meta: ChatMeta, skill?: Skill, memory?: Memory) {
  const parts = [persona(), prompt('console', { TODO_PATH: paths.todo, MEMORY_DIR, CHATS_DIR: paths.chats, DEADLINES_PATH: paths.deadlines }),
                 `<about_me>\n${aboutMe()}\n</about_me>`,
                 `<dash_memory dir="${MEMORY_DIR}">\n${memory?.context() ?? ''}\n</dash_memory>`];
  if (meta.kind === 'checkin') parts.push(prompt('checkin'));
  if (meta.offRecord) {
    parts.push(`This chat is off the record: ${profile().name} asked for it not to go into your memory. Don't write anything from it into the memory folder \
or ${paths.deadlines} (not even a deadline or exam they mention, and not "remember…" lines; tell them to bring it up in a normal chat if they want it kept), \
and don't bring it up in other conversations.`);
  }
  if (skill) {
    parts.push(`${profile().name} launched the "${skill.name}" skill from Dash. Follow its instructions below for this conversation. \
Its folder is ${skill.directory}; read any reference files it mentions from there with Read. \
ABOUT_ME.md is already in <about_me> above, so don't read it again even where the skill says to. \
You can't show question widgets here, so where the skill says to ask the user something, just ask in \
plain text. Save any files it produces in ${paths.outputDir}.

<skill name="${skill.name}">
${skill.instructions}
</skill>`);
  }
  return parts.join('\n\n');
}
