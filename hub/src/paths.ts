import { mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where everything lives. The hub's own state (to-do, memory, chats, paired devices…) is in DATA,
 * which only the hub writes; Mac Dash and the phone change it through the hub. The rest are the same
 * home-relative paths as on the Mac, kept in step by Syncthing, so prompts and skills work unchanged.
 */
export const HOME = homedir();
// Absolute even when DASH_DATA is relative (`npm run dev`), so Claude Code's `Read(//…)` deny rules match.
export const DATA = resolve(process.env.DASH_DATA ?? join(HOME, '.local/share/dash'));
/**
 * Tests set DASH_DATA, and must never reach the synced folders in HOME: an earlier selftest wrote over
 * a real course syllabus. With DASH_DATA set, the home-relative paths below live under DATA/home
 * unless DASH_HOME says otherwise. The real hub doesn't set DASH_DATA, so it uses HOME as before.
 */
const SYNCED = process.env.DASH_HOME ?? (process.env.DASH_DATA ? join(DATA, 'home') : HOME);
mkdirSync(DATA, { recursive: true, mode: 0o700 });

export const PORT = Number(process.env.DASH_HUB_PORT ?? 47900);
/** A Unix socket for `npm run pair` and other local admin commands. Not reachable over Tailscale. */
export const ADMIN_SOCKET = join(DATA, 'admin.sock');
/** What the apps call this hub ("Connected to dash-hub"). */
export const HUB_NAME = process.env.DASH_HUB_NAME ?? hostname().split('.')[0];

/** Dash's long-term memory: the raw log, the journal, core facts, follow-ups and "remember…" lines. */
export const MEMORY_DIR = join(DATA, 'memory');
mkdirSync(join(MEMORY_DIR, 'log'), { recursive: true, mode: 0o700 });
mkdirSync(join(MEMORY_DIR, 'journal'), { recursive: true, mode: 0o700 });

export const paths = {
  todo: join(DATA, 'todo.md'),
  /** "Remember…" lines. Before the memory folder this was DATA/memory.md, which memory.ts migrates. */
  memory: join(MEMORY_DIR, 'remember.md'),
  oldMemory: join(DATA, 'memory.md'),
  core: join(MEMORY_DIR, 'core.md'),
  /** Dash's notes on himself: how he and the user work, running jokes, opinions he's formed. */
  self: join(MEMORY_DIR, 'self.md'),
  threads: join(MEMORY_DIR, 'threads.md'),
  memoryLog: join(MEMORY_DIR, 'log'),
  journal: join(MEMORY_DIR, 'journal'),
  memoryVersions: join(MEMORY_DIR, '.versions'),
  scheduler: join(DATA, 'scheduler.json'),
  deadlines: join(DATA, 'deadlines.md'),
  deadlinesState: join(DATA, 'deadlines-state.json'),
  /** Proactive jobs' memory: calendar events already looked at, syllabus versions read, follow-ups pushed. */
  secretaryState: join(DATA, 'secretary.json'),
  syllabi: process.env.DASH_SYLLABI ?? join(SYNCED, 'Documents/Syllabi'),
  investorProfile: join(DATA, 'investor_profile.md'),
  devices: join(DATA, 'hub_devices.json'),
  usage: join(DATA, 'usage.json'),
  brief: join(DATA, 'brief.json'),
  chats: join(DATA, 'chats'),
  log: join(DATA, 'hub.log'),
  aboutMe: join(SYNCED, 'ABOUT_ME.md'),
  /** Name, time zone, crisis line and the phone's school links (see personal.ts). Untracked; shared with Mac Dash. */
  profile: join(SYNCED, '.dash-shared/profile.json'),
  brightspace: join(SYNCED, 'BrightspaceToDo/todo.md'),
  outputDir: join(SYNCED, 'Documents/Dash'),
  skills: join(HOME, '.claude/skills'),
  jarvis: join(HOME, '.claude/mcp-servers/jarvis-mcp'),
};
