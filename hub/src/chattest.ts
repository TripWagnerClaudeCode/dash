/**
 * `npm run chattest`: real chats on Haiku (lightest on limits) in a throwaway data folder, the way the
 * apps drive them: a reply, Deny and Approve on a real shell command, Stop, resuming a closed session
 * with its context, the queue, retry, rename and delete. Uses Claude Code and jarvis on this machine.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'dash-chat-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';

const { Chats } = await import('./chats.ts');
const { paths } = await import('./paths.ts');
const { Memory, dayKey } = await import('./memory.ts');

const haiku = { modelID: 'claude-haiku-4-5' };
const chats = new Chats();
const memory = new Memory();
chats.setMemory(memory);
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}
async function until(test: () => boolean, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (!test() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  return test();
}
const state = (id: string) => chats.liveState(id)!;
const lastText = (id: string) => state(id).tail.at(-1)?.text ?? '';
const idle = (id: string) => state(id).status === 'idle';

try {
  // A plain reply, saved with its session.
  const first = chats.send(undefined, 'Reply with exactly the word: pong', [], [], haiku).chat;
  check('starts a new chat', /^[0-9A-F-]{36}$/.test(first));
  check('answers', await until(() => idle(first) && lastText(first).length > 0) && /pong/i.test(lastText(first)), lastText(first));
  const saved = JSON.parse(readFileSync(join(paths.chats, `${first}.json`), 'utf8'));
  check('saves the chat with a started session', saved.meta.sessionStarted === true && saved.turns.length === 2
        && saved.meta.title.startsWith('Reply with exactly'), JSON.stringify(saved.meta));
  check('lists it in the index', chats.list().chats[0]?.id === first);

  // Deny, then Approve, a command that changes something.
  const marker = join(data, 'approved-marker');
  chats.send(first, `Use the Bash tool to run exactly this command and nothing else: mkdir ${marker}`);
  check('asks before running a command that writes', await until(() => state(first).approvals.length > 0), JSON.stringify(state(first)));
  const ask = state(first).approvals[0];
  check('the card shows the command', ask?.toolName === 'Bash' && String(ask.input.command).includes(marker));
  chats.decide(first, ask.id, false);
  await until(() => idle(first));
  check('a denied command does not run', !existsSync(marker));
  chats.send(first, `Now please run it: mkdir ${marker}`);
  check('asks again', await until(() => state(first).approvals.length > 0));
  chats.decide(first, state(first).approvals[0].id, true);
  check('an approved command runs', await until(() => idle(first) && existsSync(marker)));

  // Stop keeps the session; a queued message runs after the current answer.
  const counting = chats.send(undefined, 'Count from 1 to 400, one number per line, no other text.', [], [], haiku).chat;
  await until(() => lastText(counting).length > 20, 60);
  chats.send(counting, 'Reply with exactly: queued-ok');
  check('queues a message sent mid-answer', state(counting).queue.length === 1);
  chats.unqueue(counting, state(counting).queue[0].id);
  check('a queued message can be removed', state(counting).queue.length === 0);
  // Apps send every setting each time (skill: none). Mid-answer that's fine and applies after the turn;
  // a real skill change is refused without changing anything.
  let settingsError = '';
  try {
    chats.settings(counting, { modelID: 'claude-haiku-4-5', effort: 'low', permissionMode: 'default', skillName: null });
  } catch (error) {
    settingsError = (error as Error).message;
  }
  check('changing the model mid-answer is accepted', !settingsError && state(counting).meta.effort === 'low', settingsError);
  let skillError = '';
  try {
    chats.settings(counting, { effort: 'high', skillName: 'essay-outliner' });
  } catch (error) {
    skillError = (error as Error).message;
  }
  check('a skill change mid-answer is refused and changes nothing', /Wait/.test(skillError)
        && state(counting).meta.effort === 'low' && !state(counting).meta.skillName, skillError);
  chats.send(counting, 'Reply with exactly: queued-ok');
  chats.stop(counting);
  check('Stop ends the answer and clears the queue', await until(() => idle(counting), 30)
        && state(counting).tail.at(-1)?.stopped === true && state(counting).queue.length === 0, JSON.stringify(state(counting).tail.at(-1)?.stopped));

  // Resume: close every session, then ask about earlier context.
  chats.closeAll();
  chats.send(first, 'What single word did you reply with at the very start of this chat? Answer with just that word.');
  check('resumes a closed session with its context', await until(() => idle(first)) && /pong/i.test(lastText(first)), lastText(first));

  // Retry, rename, delete.
  const before = state(first).count;
  chats.retry(first, state(first).tail.at(-1)!.id);
  check('retry asks the last question again', await until(() => idle(first) && state(first).count === before + 2)
        && /pong/i.test(lastText(first)), lastText(first));
  // Memory across chats: one conversation is summarized (real Haiku), and a new chat knows it.
  const telling = chats.send(undefined, "Heads up: my new roommate's name is Bartholomew Quince and he snores. Just say ok.", [], [], haiku).chat;
  await until(() => idle(telling) && lastText(telling).length > 0);
  await chats.summarizePending();
  const remembered = memory.entries(dayKey()).find((entry) => entry.chat === telling);
  check('summarizes a chat into memory', !!remembered && /Bartholomew/.test(remembered.text), JSON.stringify(remembered));
  const asking = chats.send(undefined, "What's my roommate's name? Answer from what you remember, in one line, without using any tools.", [], [], haiku).chat;
  check('a new chat remembers it', await until(() => idle(asking) && lastText(asking).length > 0) && /Bartholomew/.test(lastText(asking)), lastText(asking));
  const secret = chats.send(undefined, 'My locker code is 4417. Just say ok.', [], [], { ...haiku, offRecord: true }).chat;
  await until(() => idle(secret) && lastText(secret).length > 0);
  await chats.summarizePending();
  check('an off-the-record chat stays out of memory', !JSON.stringify(memory.entries(dayKey())).includes('4417'));

  // Dash knows who he is.
  const who = chats.send(undefined, "Quick one: what's your name, and what pronouns do you go by? One line, no tools.", [], [], haiku).chat;
  check('Dash knows his name and pronouns', await until(() => idle(who) && lastText(who).length > 0)
        && /Dash/.test(lastText(who)) && /\bhe\b|he\/him/i.test(lastText(who)), lastText(who));

  chats.rename(first, 'Ping test');
  check('renames', chats.list().chats.find((meta) => meta.id === first)?.title === 'Ping test');
  chats.delete(counting);
  check('deletes', !chats.list().chats.some((meta) => meta.id === counting) && !existsSync(join(paths.chats, `${counting}.json`)));
} catch (error) {
  check('chat test ran to the end', false, (error as Error).stack ?? String(error));
} finally {
  chats.closeAll();
  rmSync(data, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll chat checks passed');
process.exit(failures ? 1 : 0);
