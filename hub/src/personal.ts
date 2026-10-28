import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paths } from './paths.ts';

/** Times in prompts and the brief are Eastern, wherever the hub runs. */
export const TIME_ZONE = 'America/New_York';

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '../prompts');

/** A link on the phone's Study page. `icon` is an SF Symbol name. */
export type ProfileLink = { title: string; subtitle?: string; icon?: string; url: string };

/**
 * Who the user is, from ~/.dash-shared/profile.json (untracked, synced between the Mac and the hub, and read
 * by Mac Dash too). The file and every field in it are optional: anything missing gets a neutral default, so
 * a fresh copy of Dash works before it's filled in. `named` says whether the file gave a name at all.
 */
export type Profile = {
  name: string;
  fullName: string;
  /** How prompts describe the times they're given ("Eastern"). */
  timezone: string;
  /** Where Dash points the user in a crisis, after 988. */
  crisisHelp: string;
  links: ProfileLink[];
  studyApps: ProfileLink[];
  named: boolean;
};

let cachedProfile: { stamp: string; profile: Profile } | undefined;

/** The profile, read again whenever the file changes. A missing or broken file gives all the defaults. */
export function profile(): Profile {
  let stamp = 'missing';
  try {
    const stat = statSync(paths.profile);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {}
  if (cachedProfile?.stamp === stamp) return cachedProfile.profile;
  let raw: Record<string, any> = {};
  try {
    const parsed = JSON.parse(readFileSync(paths.profile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch {}
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  // Links without a title or a URL are skipped rather than shown broken.
  const links = (value: unknown): ProfileLink[] => (Array.isArray(value) ? value : []).flatMap((link) => {
    const title = text(link?.title), url = text(link?.url), subtitle = text(link?.subtitle), icon = text(link?.icon);
    return title && url ? [{ title, url, ...(subtitle ? { subtitle } : {}), ...(icon ? { icon } : {}) }] : [];
  });
  const name = text(raw.name);
  const result: Profile = {
    name: name ?? 'the user',
    fullName: text(raw.fullName) ?? name ?? 'the user',
    timezone: text(raw.timezone) ?? 'local time',
    crisisHelp: text(raw.crisisHelp) ?? 'a local or campus counseling service',
    links: links(raw.links),
    studyApps: links(raw.studyApps),
    named: !!name,
  };
  cachedProfile = { stamp, profile: result };
  return result;
}

/**
 * A prompt from hub/prompts, with {{PLACEHOLDERS}} filled in. Every prompt gets {{USER_NAME}},
 * {{USER_FULL_NAME}}, {{TIMEZONE}} and {{CRISIS_HELP}} from the profile; `values` adds more or overrides them.
 */
export function prompt(name: string, values: Record<string, string> = {}): string {
  const user = profile();
  const all = { USER_NAME: user.name, USER_FULL_NAME: user.fullName, TIMEZONE: user.timezone, CRISIS_HELP: user.crisisHelp, ...values };
  let text = readFileSync(join(promptsDir, `${name}.md`), 'utf8').trimEnd();
  for (const [key, value] of Object.entries(all)) text = text.replaceAll(`{{${key}}}`, value);
  return text;
}

function read(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** ~/ABOUT_ME.md: courses, professors, schedule, weak spots (synced from the Mac). */
export const aboutMe = () => read(paths.aboutMe);

const profileNotSetUp = '<!-- Not set up yet: the advisor fills this in during the first session. -->';

/** The user's goals as an investor, kept by the portfolio advisor and loaded into every advisor session. */
export function investorProfile() {
  if (!existsSync(paths.investorProfile)) {
    writeFileSync(paths.investorProfile, `# ${profile().name}'s investor profile\n${profileNotSetUp}\n\n## Goals\n\n## Time horizon & contributions\n\n` +
      '## Risk tolerance & limits\n\n## Preferences & exclusions\n\n## Tax situation\n\n## Options comfort\n\n## Decisions log\n\n');
  }
  return read(paths.investorProfile);
}

/** "Tuesday, October 27, 2026 at 3:05 PM", Eastern. */
export function now(date = new Date()) {
  const day = date.toLocaleDateString('en-US', { timeZone: TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}

/** Dash's personality, shared by chats, the brief, check-ins, pushes and (trimmed) the lens. */
export const persona = () => prompt('persona');

/**
 * Context for one-off prompts with no tools (the brief, pushes): about_me plus Dash's memory (from
 * Memory.context). No timestamp, so it caches; the caller adds the time.
 */
export function personalBackground(memoryContext: string) {
  return `<about_me>\n${aboutMe()}\n</about_me>\n\n<dash_memory>\n${memoryContext}\n</dash_memory>`;
}
