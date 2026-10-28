/**
 * Chats and the Claude runtime, against a stand-in `claude` (DASH_CLAUDE) that records how it was started
 * and answers, or hangs, as told: the permission rules every session gets, the advisor's narrower ones,
 * the chat-setting allow-lists, off-the-record storage, timeouts, a failed spawn, jarvis restarts and the
 * per-call usage line. Nothing here reaches the real Claude, jarvis or the synced folders.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'dash-chats-test-'));
process.env.DASH_DATA = data;
process.env.TZ ??= 'America/New_York';

// The stand-in claude: logs its arguments, answers `auth status`, and answers each message (or not).
const fakeClaude = join(data, 'fake-claude.mjs');
const argsLog = join(data, 'claude-args.jsonl');
writeFileSync(fakeClaude, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'auth') {
  process.stdout.write(JSON.stringify(mode === 'signed-out' ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(mode === 'signed-out' ? 1 : 0);
}
createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type !== 'user' || mode === 'hang') return;
  const say = (object) => process.stdout.write(JSON.stringify(object) + '\\n');
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Noted.' } } });
  say({ type: 'result', result: 'Noted.', stop_reason: 'end_turn', num_turns: 1,
        usage: { input_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 1 } });
});
`);
chmodSync(fakeClaude, 0o755);
process.env.DASH_CLAUDE = fakeClaude;

const { paths, DATA, HOME } = await import('../paths.ts');
for (const path of [paths.syllabi, paths.aboutMe, paths.brightspace, paths.outputDir]) {
  if (!path.startsWith(data)) { console.error(`chats.test: ${path} is outside the test folder; stopping`); process.exit(1); }
}
const { ClaudeSession, claudeSignInProblem, denyRules, models } = await import('../claude.ts');
const { ADVISOR_ID, Chats } = await import('../chats.ts');
const { Usage } = await import('../usage.ts');
const { Jarvis } = await import('../jarvis.ts');
const { Memory } = await import('../memory.ts');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !test()) await sleep(20);
  return test();
}
/** The arguments of every claude started so far. */
const spawned = (): string[][] => (existsSync(argsLog) ? readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1].split(',') : [];
};
const newID = () => crypto.randomUUID().toUpperCase();

try {
  // The rules themselves: absolute-path Read denies for the secrets, ntfy, off-the-record chats, jarvis, Claude Code.
  const rules = denyRules();
  for (const path of [join(DATA, 'secrets/**'), join(DATA, 'ntfy/**'), join(DATA, 'chats/off-record/**'), join(DATA, 'mcp-*.json'),
                      join(HOME, '.jarvis/**'), join(HOME, '.claude.json')]) {
    check(`deny rule for ${path.replace(DATA, 'DATA').replace(HOME, '~')}`, rules.includes(`Read(/${path})`), JSON.stringify(rules));
  }
  check('deny rules are absolute (//) and leave skills readable', rules.every((rule) => rule.startsWith('Read(//'))
        && !rules.some((rule) => rule.includes('/.claude/skills')));

  // A console chat: its claude gets the deny rules, no jarvis file_read, no NotebookEdit.
  const chats = new Chats();
  const summarized: string[] = [];
  chats.setMemory(new Memory(), async (text) => {
    summarized.push(text);
    return 'Alex asked something.';
  });
  const plain = newID();
  chats.send(plain, 'Hello there');
  await until(() => chats.liveState(plain)?.status === 'idle' && spawned().length >= 1);
  const chatArgs = spawned().at(-1)!;
  const denied = flag(chatArgs, '--disallowedTools');
  check('a chat answers through the stand-in claude', chats.open(plain).turns.at(-1)?.text === 'Noted.', JSON.stringify(chats.open(plain).turns));
  check("a chat's claude is started with every deny rule", rules.every((rule) => denied.includes(rule)), JSON.stringify(denied));
  check("a chat can't use jarvis file_read, which has no path limits", denied.includes('mcp__jarvis__file_read')
        && !flag(chatArgs, '--allowedTools').includes('mcp__jarvis__file_read'));
  check('chats no longer carry NotebookEdit', !flag(chatArgs, '--tools').includes('NotebookEdit') && flag(chatArgs, '--tools').includes('Read'));

  // Per-call usage, from the result event.
  const hubLog = readFileSync(paths.log, 'utf8');
  check('one usage line per call in hub.log', /claude usage caller=chat model=claude-opus-5-5 in=3 cache_write=5 cache_read=7 out=1 turns=1/.test(hubLog), hubLog.slice(-400));

  // The advisor: only sec.gov fetches and the investor profile skip the card, and the deny rules still apply.
  chats.setAdvisor({ relay: () => ({ type: 'http', url: 'http://127.0.0.1:9/mcp' }), snapshot: () => '{}' });
  chats.send(ADVISOR_ID, 'How concentrated am I?');
  await until(() => chats.liveState(ADVISOR_ID)?.status === 'idle' && spawned().length >= 2);
  const advisorArgs = spawned().at(-1)!;
  const allowed = flag(advisorArgs, '--allowedTools');
  check('the advisor may fetch sec.gov without a card, nothing else', allowed.includes('WebFetch(domain:sec.gov)') && !allowed.includes('WebFetch'),
        JSON.stringify(allowed));
  check('the advisor has no bare Read, only its investor profile', !allowed.includes('Read') && allowed.includes(`Read(/${paths.investorProfile})`)
        && !advisorArgs.includes('--add-dir'), JSON.stringify(allowed));
  check("the advisor's claude gets the deny rules too", rules.every((rule) => flag(advisorArgs, '--disallowedTools').includes(rule)));

  // Settings from devices are allow-listed; a bad value is refused, never replaced.
  const refused = (settings: Record<string, unknown>) => {
    try {
      chats.send(newID(), 'hi', [], [], settings as any);
      return false;
    } catch {
      return true;
    }
  };
  check('refuses bypassPermissions', refused({ permissionMode: 'bypassPermissions' }));
  check('refuses a skill name with path parts', refused({ skillName: '../../.ssh' }) && refused({ skillName: 'a/b' }));
  check("refuses a skill that isn't there", refused({ skillName: 'no-such-skill-here' }));
  check('refuses an unknown effort', refused({ effort: 'turbo' }));
  check('refuses an unknown model', refused({ modelID: 'gpt-9' }));
  check('refuses an unknown kind', refused({ kind: 'admin' }));
  check('refused settings leave no chat behind', chats.list().chats.length === 1);
  const tuned = newID();
  chats.send(tuned, 'hi', [], [], { modelID: models.sonnet.id, effort: 'high', permissionMode: 'acceptEdits' });
  await until(() => chats.liveState(tuned)?.status === 'idle');
  check('accepts allowed settings', chats.open(tuned).meta.modelID === models.sonnet.id && chats.open(tuned).meta.permissionMode === 'acceptEdits');
  let changed = true;
  try {
    chats.settings(tuned, { permissionMode: 'bypassPermissions', effort: 'low' });
  } catch {
    changed = false;
  }
  check('a refused settings change changes nothing', !changed && chats.open(tuned).meta.effort === 'high' && chats.open(tuned).meta.permissionMode === 'acceptEdits');

  // Off the record: its own folder (which the deny rules cover), with its own index.
  const secret = newID();
  chats.send(secret, 'Something private about my roommate', [], [], { offRecord: true });
  await until(() => chats.liveState(secret)?.status === 'idle');
  const offDir = join(paths.chats, 'off-record');
  check('an off-the-record chat is saved in off-record/', existsSync(join(offDir, `${secret}.json`)) && !existsSync(join(paths.chats, `${secret}.json`)));
  check("the main index doesn't list it; off-record/index.json does",
        !readFileSync(join(paths.chats, 'index.json'), 'utf8').includes(secret) && readFileSync(join(offDir, 'index.json'), 'utf8').includes(secret)
        && chats.list().chats.some((meta) => meta.id === secret));
  // Back on the record: what came before counts as remembered, and the file stays private.
  chats.settings(secret, { offRecord: false });
  const back = chats.open(secret).meta;
  check('turning off-the-record off marks it summarized up to now', back.summarized === chats.open(secret).turns.length && !back.offRecord, JSON.stringify(back));
  check('a chat that was off the record stays in off-record/', existsSync(join(offDir, `${secret}.json`)) && !existsSync(join(paths.chats, `${secret}.json`)));
  chats.send(secret, 'Now about my HIST essay');
  await until(() => chats.liveState(secret)?.status === 'idle');
  summarized.length = 0;
  await chats.summarizePending();
  const secretSummary = summarized.find((text) => text.includes('HIST essay'));
  check('only the on-record part is summarized', !!secretSummary && !secretSummary.includes('roommate'), JSON.stringify(summarized));

  // A summary still running while the chat goes off and back on the record can't move `summarized` back.
  {
    let release: ((text: string) => void) | undefined;
    const slow = new Chats();
    slow.setMemory(new Memory(), () => new Promise<string>((done) => { release = done; }));
    const racy = newID();
    slow.send(racy, 'On the record first');
    await until(() => slow.liveState(racy)?.status === 'idle');
    const pending = slow.summarizePending();
    await until(() => !!release);
    slow.settings(racy, { offRecord: true });
    slow.send(racy, 'Something about my roommate');
    await until(() => slow.liveState(racy)?.status === 'idle');
    slow.settings(racy, { offRecord: false });
    release!('Alex said hello.');
    await pending;
    check("a late summary doesn't reopen the off-the-record turns", slow.open(racy).meta.summarized === slow.open(racy).turns.length,
          JSON.stringify(slow.open(racy).meta));
  }

  // A chat's existing skill doesn't block other settings after its folder is gone.
  {
    const skilled = newID();
    chats.send(skilled, 'hi');
    await until(() => chats.liveState(skilled)?.status === 'idle');
    chats.open(skilled).meta.skillName = 'renamed-since';
    let ok = true;
    try {
      chats.settings(skilled, { skillName: 'renamed-since', effort: 'low' });
    } catch {
      ok = false;
    }
    check("a chat whose skill was renamed can still change effort", ok && chats.open(skilled).meta.effort === 'low');
  }

  // An off-the-record chat from before the folder existed moves into it.
  const legacyDir = join(data, 'legacy-chats');
  mkdirSync(legacyDir);
  const legacy = newID();
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const legacyMeta = { id: legacy, title: 'Old secret', titleIsCustom: false, createdAt: stamp, updatedAt: stamp, sessionID: legacy, sessionStarted: true,
                       effort: 'medium', permissionMode: 'default', offRecord: true };
  writeFileSync(join(legacyDir, `${legacy}.json`), JSON.stringify({ meta: legacyMeta, turns: [{ id: 'T1', role: 'user', text: 'old' }] }));
  writeFileSync(join(legacyDir, 'index.json'), JSON.stringify([legacyMeta]));
  const migrated = new Chats(legacyDir);
  check('existing off-the-record chats move into off-record/', existsSync(join(legacyDir, 'off-record', `${legacy}.json`))
        && !existsSync(join(legacyDir, `${legacy}.json`)) && migrated.list().chats.length === 1
        && !readFileSync(join(legacyDir, 'index.json'), 'utf8').includes(legacy) && migrated.open(legacy).turns[0].text === 'old');

  // Timeouts: a hung one-off call fails cleanly, and so does the usage ping (so `refreshing` settles).
  process.env.FAKE_CLAUDE_MODE = 'hang';
  const started = Date.now();
  const hung = await ClaudeSession.ask('hi', 'say hi', models.haiku, 'low', undefined, { timeout: 300 }).then(() => 'answered', (error: Error) => error.message);
  check('a hung one-off call fails after its timeout', /didn't answer within/.test(hung) && Date.now() - started < 3000, hung);
  const usage = new Usage({ pingTimeout: 300 });
  const pinged = await Promise.race([usage.refresh().then(() => 'settled'), sleep(3000).then(() => 'stuck')]);
  check('a hung usage ping still settles, with the error', pinged === 'settled' && /didn't answer/.test(usage.snapshot.error ?? ''), JSON.stringify(usage.snapshot));

  // Sign-in checks use `claude auth status`, not a model call.
  process.env.FAKE_CLAUDE_MODE = 'signed-out';
  const signedOut = await claudeSignInProblem();
  process.env.FAKE_CLAUDE_MODE = 'ok';
  const signedIn = await claudeSignInProblem();
  check('claude auth status tells signed in from signed out', !!signedOut && /signed in/.test(signedOut) && signedIn === undefined, `${signedOut} / ${signedIn}`);
  check('the sign-in check makes no model call', spawned().at(-1)?.join(' ') === 'auth status');

  // A claude that can't start (EACCES) fails the turn and leaves the chat idle, so it can be deleted.
  const unrunnable = join(data, 'not-executable');
  writeFileSync(unrunnable, 'not a program');
  chmodSync(unrunnable, 0o644);
  process.env.DASH_CLAUDE = unrunnable;
  const broken = newID();
  chats.send(broken, 'hello?');
  const settled = await until(() => chats.liveState(broken)?.status === 'idle');
  const last = chats.open(broken).turns.at(-1);
  check('a failed spawn ends the turn with an error', settled && !!last?.isError && /didn't start|EACCES/.test(last.text), JSON.stringify(last));
  let deleted = true;
  try {
    chats.stop(broken);
    chats.delete(broken);
  } catch {
    deleted = false;
  }
  check('a chat whose claude failed to start can be stopped and deleted', deleted && !chats.list().chats.some((meta) => meta.id === broken));
  process.env.DASH_CLAUDE = fakeClaude;

  // jarvis: a call that hangs restarts it, and the next call gets a fresh process.
  const fakeJarvis = join(data, 'fake-jarvis.mjs');
  writeFileSync(fakeJarvis, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'tools/call' && message.params.name === 'hang') return;
  const result = message.method === 'initialize' ? {} : { content: [{ type: 'text', text: String(process.pid) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`);
  const jarvis = new Jarvis({ timeout: 300, python: process.execPath, server: fakeJarvis });
  const firstPid = await jarvis.call('pid');
  const stuck = await jarvis.call('hang').then(() => 'answered', (error: Error) => error.message);
  const secondPid = await jarvis.call('pid');
  check('a jarvis call that hangs fails, and jarvis is restarted', /in time/.test(stuck) && /^\d+$/.test(secondPid) && secondPid !== firstPid,
        `${firstPid} → ${stuck} → ${secondPid}`);
  jarvis.shutdown();
  chats.closeAll();
} catch (error) {
  check('chats.test ran to the end', false, (error as Error).stack ?? String(error));
} finally {
  ClaudeSession.closeAll();
  await sleep(100);
  rmSync(data, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll chat checks passed');
process.exit(failures ? 1 : 0);
