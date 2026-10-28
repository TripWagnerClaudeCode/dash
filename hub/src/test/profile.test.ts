/**
 * The user's profile (~/.dash-shared/profile.json): neutral defaults when it's missing, its values reaching
 * every prompt and the new memory files, a change to the file being picked up without a restart, and the
 * phone's `profile.get` request (name null until set, links without a title or URL left out).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const data = mkdtempSync(join(tmpdir(), 'dash-profile-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';

const { paths, MEMORY_DIR } = await import('../paths.ts');
for (const path of [paths.profile, paths.aboutMe, paths.syllabi]) {
  if (!path.startsWith(data)) { console.error(`profile.test: ${path} is outside the test folder; stopping`); process.exit(1); }
}
const { profile, prompt } = await import('../personal.ts');
const { Memory } = await import('../memory.ts');
const { HubServer } = await import('../server.ts');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

const promptNames = readdirSync(join(dirname(fileURLToPath(import.meta.url)), '../../prompts')).map((file) => file.replace(/\.md$/, ''));
const leftover = /\{\{(USER_NAME|USER_FULL_NAME|TIMEZONE|CRISIS_HELP)\}\}/;
const stub: any = new Proxy({}, { get: () => () => {} });
const server = new HubServer({ devices: stub, today: stub, todos: stub, usage: stub, chats: stub, portfolio: stub, robinhood: stub,
                               health: () => ({}), appURL: () => undefined });
const profileGet = () => (server as any).handlers['profile.get']({}, { socket: stub });

// No profile file: every field has its default, and no prompt is left with a profile placeholder.
const defaults = profile();
check('defaults without a profile file', defaults.name === 'the user' && defaults.fullName === 'the user' && defaults.timezone === 'local time'
      && defaults.crisisHelp === 'a local or campus counseling service' && !defaults.links.length && !defaults.studyApps.length && !defaults.named,
      JSON.stringify(defaults));
const unfilled = promptNames.filter((name) => leftover.test(prompt(name)));
check('every prompt fills the profile placeholders', !unfilled.length, unfilled.join(', '));
check('the defaults reach the prompts', prompt('persona').startsWith("You are Dash: the user's chief of staff")
      && prompt('persona').includes('988 (Suicide & Crisis Lifeline), or a local or campus counseling service.')
      && prompt('console').includes('Times are local time.'));
check('profile.get has no name, links or study apps yet', JSON.stringify(profileGet()) === JSON.stringify({ name: null, links: [], studyApps: [] }),
      JSON.stringify(profileGet()));

// A filled-in profile, picked up on the next call. Links missing a title or URL are dropped.
mkdirSync(dirname(paths.profile), { recursive: true });
writeFileSync(paths.profile, JSON.stringify({
  name: 'Alex', fullName: 'Alex Rivera', timezone: 'Pacific', crisisHelp: "Example College's counseling center",
  links: [{ title: 'School email', subtitle: 'Outlook', icon: 'envelope', url: 'https://mail.example.edu' }, { title: 'No URL' }, 'junk'],
  studyApps: [{ title: 'History flashcards', url: 'https://example.com/cards' }],
}));
const filled = profile();
check('reads the profile file', filled.name === 'Alex' && filled.fullName === 'Alex Rivera' && filled.timezone === 'Pacific' && filled.named
      && filled.links.length === 1 && filled.studyApps.length === 1, JSON.stringify(filled));
const persona = prompt('persona');
check('profile values reach the prompts', persona.startsWith("You are Dash: Alex Rivera's chief of staff") && persona.includes('how you and Alex work')
      && persona.includes("or Example College's counseling center.") && prompt('console').includes('Times are Pacific.')
      && prompt('push').includes('"Hey Alex"') && prompt('consolidate').includes('starting with "# Alex, right now"'));
check('a caller can still override a placeholder', prompt('persona', { USER_NAME: 'Sam' }).includes('how you and Sam work'));
check('profile.get returns the name and the usable links', JSON.stringify(profileGet()) === JSON.stringify({
  name: 'Alex',
  links: [{ title: 'School email', url: 'https://mail.example.edu', subtitle: 'Outlook', icon: 'envelope' }],
  studyApps: [{ title: 'History flashcards', url: 'https://example.com/cards' }],
}), JSON.stringify(profileGet()));

// New memory files start with the user's name.
rmSync(MEMORY_DIR, { recursive: true, force: true });
mkdirSync(join(MEMORY_DIR, 'log'), { recursive: true });
mkdirSync(join(MEMORY_DIR, 'journal'), { recursive: true });
const memory = new Memory();
check('new memory files use the name', memory.core().startsWith('# Alex, right now') && memory.self().includes("Alex's chief of staff")
      && readFileSync(paths.memory, 'utf8').includes('Things Alex asked Dash to remember'));

// A name alone fills the full name too; a broken file falls back to the defaults.
writeFileSync(paths.profile, JSON.stringify({ name: 'Jordan' }));
check('the full name falls back to the name', profile().fullName === 'Jordan' && prompt('persona').startsWith("You are Dash: Jordan's chief of staff"));
writeFileSync(paths.profile, '{ not json');
check('a broken profile file gives the defaults', profile().name === 'the user' && profileGet().name === null);

rmSync(data, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll profile checks passed');
process.exit(failures ? 1 : 0);
