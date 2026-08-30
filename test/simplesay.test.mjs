// pi-simplesay self-test — uses a fake speech endpoint so no audio is played.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'src/index.ts');

// The extension imports CustomEditor at runtime from pi's core package. For the
// self-test we don't need the real TUI, so install a tiny local stub if the
// package isn't resolvable (keeps CI dependency-free).
try {
  await import('@earendil-works/pi-coding-agent');
} catch {
  const stubDir = path.join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' } }));
  fs.writeFileSync(path.join(stubDir, 'index.js'), 'export class CustomEditor { constructor() {} handleInput() {} render() { return []; } }\n');
}

const ext = (await import(EXT)).default;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function harness(endpoint, log) {
  const handlers = {};
  const commands = {};
  const notices = [];
  const pi = {
    on(evt, fn) { handlers[evt] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    sendMessage() {},
  };
  const ctx = { mode: 'rpc', ui: { notify(m, k) { notices.push({ m, k }); } } };
  return { handlers, commands, notices, pi, ctx };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-simplesay-test-'));
  const endpoint = path.join(dir, 'endpoint.sh');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(endpoint, `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then
  echo "PLAY|$2" >> "$log"
  exit 0
fi
agent=""
if [ "$1" = "--agent" ]; then
  agent="$2"
  shift 2
fi
text="$*"
if [ -n "$SAY_OUT" ]; then
  printf 'wav' > "$SAY_OUT"
  echo "SYNTH|$agent|$text" >> "$log"
else
  echo "SPEAK|$agent|$text" >> "$log"
fi
`);
  fs.chmodSync(endpoint, 0o755);

  const saved = { SIMPLESAY_ENDPOINT: process.env.SIMPLESAY_ENDPOINT, SIMPLESAY_LOG: process.env.SIMPLESAY_LOG, SIMPLESAY_AGENT: process.env.SIMPLESAY_AGENT, SIMPLESAY_CONFIG: process.env.SIMPLESAY_CONFIG, SIMPLESAY_DEBUG: process.env.SIMPLESAY_DEBUG };
  process.env.SIMPLESAY_ENDPOINT = endpoint;
  process.env.SIMPLESAY_LOG = log;
  process.env.SIMPLESAY_CONFIG = path.join(dir, 'simplesay.json'); // never touch the real config
  process.env.SIMPLESAY_DEBUG = '0';
  delete process.env.SIMPLESAY_AGENT;

  const h = harness(endpoint, log);
  ext(h.pi);

  function cleanup() {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ...h, endpoint, log, cleanup };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

{
  const t = setup();
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'First sentence is here. Second sentence follows quickly. ' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'Third sentence closes it out.' } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'First sentence is here. Second sentence follows quickly. Third sentence closes it out.' }] } });
  await wait(400);
  const log = read(t.log);
  const synths = log.split('\n').filter((l) => l.startsWith('SYNTH|'));
  check('stream mode speaks progressively', synths.length >= 2, `${synths.length} synth calls`);
  t.cleanup();
}

{
  const t = setup();
  // Bare command reports current state instead of erroring.
  await t.commands.simplesay.handler('', t.ctx);
  const status = t.notices.find((n) => n.k === 'info');
  check('bare /simplesay reports status', !!status && /mode=stream/.test(status.m) && /endpoint=/.test(status.m), JSON.stringify(t.notices));

  // Mode persists: a fresh extension instance (same config file) restores it.
  await t.commands.simplesay.handler('mode tag', t.ctx);
  const h2 = harness(t.endpoint, t.log);
  ext(h2.pi);
  await h2.commands.simplesay.handler('', h2.ctx);
  const status2 = h2.notices.find((n) => n.k === 'info');
  check('mode persists across sessions', !!status2 && /mode=tag/.test(status2.m), JSON.stringify(h2.notices));
  t.cleanup();
}

{
  const t = setup();
  // Disable: status reports it and nothing is spoken.
  await t.commands.simplesay.handler('disable', t.ctx);
  check('disable notifies', t.notices.some((n) => /disabled/.test(n.m)), JSON.stringify(t.notices));
  await t.commands.simplesay.handler('', t.ctx);
  const status = t.notices.find((n) => n.m.startsWith('SimpleSay:'));
  check('bare status shows DISABLED', !!status && /DISABLED/.test(status.m), JSON.stringify(t.notices));
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'This should never be spoken. Never ever.' } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'This should never be spoken. Never ever.' }] } });
  await wait(400);
  check('disabled silences speech', read(t.log).trim() === '', read(t.log));

  // Disabled state persists across sessions like mode does.
  const h2 = harness(t.endpoint, t.log);
  ext(h2.pi);
  await h2.commands.simplesay.handler('', h2.ctx);
  const status2 = h2.notices.find((n) => n.k === 'info');
  check('disabled persists across sessions', !!status2 && /DISABLED/.test(status2.m), status2?.m);

  // Re-enable (via the 'on' alias) and speech works again.
  await t.commands.simplesay.handler('on', t.ctx);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'Back from silence. Speech works again.' } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'Back from silence. Speech works again.' }] } });
  await wait(400);
  check('enable restores speech', /SYNTH\|/.test(read(t.log)), read(t.log));
  t.cleanup();
}

{
  const t = setup();
  // Connecting an endpoint prints the exact commands speech will run.
  await t.commands.simplesay.handler(`testagent ${t.endpoint}`, t.ctx);
  const preview = t.notices.find((n) => n.m.startsWith('Speak runs:'));
  check('connect prints the speech command', !!preview && preview.m.includes(`--agent testagent`) && preview.m.includes('SAY_OUT=') && preview.m.includes('--play'), JSON.stringify(t.notices));
  // Bare status shows it too, following the current agent/endpoint.
  await t.commands.simplesay.handler('', t.ctx);
  const statusPreview = t.notices.filter((n) => n.m.startsWith('Speak runs:')).pop();
  check('bare status prints the speech command', !!statusPreview && statusPreview.m.includes('--agent testagent'), JSON.stringify(t.notices));
  t.cleanup();
}

{
  const t = setup();
  await t.commands.simplesay.handler('mode tag', t.ctx);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: '<say>Hello tagged world</say> trailing prose' } });
  const result = await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: '<say>Hello tagged world</say> trailing prose' }] } });
  await wait(400);
  const log = read(t.log);
  const stripped = result?.message?.content?.[0]?.text ?? '';
  // Agent name derives from the cwd (~/Agents/<name>), so don't hardcode it —
  // it differs per machine (fabricant on the box, sovy on the Pi).
  check('tag mode speaks tagged span', /SYNTH\|[^|]*\|Hello tagged world/.test(log), log.trim().split('\n')[0] ?? 'no calls');
  check('tag mode strips say tags at message_end', !stripped.includes('<say>') && stripped.includes('Hello tagged world'), stripped);
  t.cleanup();
}

// --- orphan-prevention tests: wedged audio player must not hold pi alive ---
// A detached play child keeps pi's event loop alive via its stdio pipes; if
// the player wedges (accepts the file, never exits) pi orphans on quit. Both
// halves of the fix are exercised: the playWav timeout (hard bound) and the
// session_shutdown handler (courtesy flush). Observable: the wedged endpoint
// logs PLAY-START on entry and PLAY-END only if it completes its sleep — a
// kill (by timeout or by shutdown) prevents PLAY-END from ever appearing.
{
  const t = setup();
  process.env.SIMPLESAY_PLAY_TIMEOUT_MS = '300';
  fs.writeFileSync(t.endpoint, `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then
  echo "PLAY-START|$2" >> "$log"
  sleep 10
  echo "PLAY-END|$2" >> "$log"
  exit 0
fi
agent=""
if [ "$1" = "--agent" ]; then agent="$2"; shift 2; fi
text="$*"
if [ -n "$SAY_OUT" ]; then printf 'wav' > "$SAY_OUT"; echo "SYNTH|$agent|$text" >> "$log"; fi
`);
  fs.chmodSync(t.endpoint, 0o755);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'Wedged player test sentence for the timeout kill path.' } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'Wedged player test sentence for the timeout kill path.' }] } });
  await wait(900); // > 300ms timeout + margin, well under the 10s sleep
  const log = read(t.log);
  check('playWav timeout kills a wedged player', /PLAY-START/.test(log) && !/PLAY-END/.test(log), log.trim().split('\n').join(' | '));
  // The kill must reach the grandchild `sleep`, not just the wrapper — a
  // leftover is exactly the orphan we're preventing. (Checks the whole process
  // table, not just our pid tree, since the child is detached.)
  let leftover = '';
  try { leftover = execSync('pgrep -af "sleep 10" | grep -v grep || true').toString().trim(); } catch {}
  check('playWav timeout leaves no wedged sleep', leftover === '', leftover || '(clean)');
  delete process.env.SIMPLESAY_PLAY_TIMEOUT_MS;
  t.cleanup();
}

{
  const t = setup();
  process.env.SIMPLESAY_PLAY_TIMEOUT_MS = '60000'; // long: shutdown is what kills it, not the timer
  fs.writeFileSync(t.endpoint, `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then
  echo "PLAY-START|$2" >> "$log"
  sleep 10
  echo "PLAY-END|$2" >> "$log"
  exit 0
fi
agent=""
if [ "$1" = "--agent" ]; then agent="$2"; shift 2; fi
text="$*"
if [ -n "$SAY_OUT" ]; then printf 'wav' > "$SAY_OUT"; echo "SYNTH|$agent|$text" >> "$log"; fi
`);
  fs.chmodSync(t.endpoint, 0o755);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'Wedged player test sentence for the shutdown kill path.' } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'Wedged player test sentence for the shutdown kill path.' }] } });
  await wait(400); // let synth + play spawn so PLAY-START is logged
  await t.handlers.session_shutdown();
  await wait(400);
  const log = read(t.log);
  check('session_shutdown kills a wedged player', /PLAY-START/.test(log) && !/PLAY-END/.test(log), log.trim().split('\n').join(' | '));
  let leftover2 = '';
  try { leftover2 = execSync('pgrep -af "sleep 10" | grep -v grep || true').toString().trim(); } catch {}
  check('session_shutdown leaves no wedged sleep', leftover2 === '', leftover2 || '(clean)');
  delete process.env.SIMPLESAY_PLAY_TIMEOUT_MS;
  t.cleanup();
}

{
  // Regression: a missing / non-executable endpoint must NOT crash the agent — it
  // degrades to silence with a SINGLE warning, never a per-utterance error wall.
  // (The 2026-08-30 halo crash: the endpoint curled a TTS server that wasn't there
  // and errored on every utterance, reading like a crash.)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-simplesay-noEP-'));
  const saved = { SIMPLESAY_ENDPOINT: process.env.SIMPLESAY_ENDPOINT, SIMPLESAY_CONFIG: process.env.SIMPLESAY_CONFIG, SIMPLESAY_DEBUG: process.env.SIMPLESAY_DEBUG };
  process.env.SIMPLESAY_ENDPOINT = path.join(dir, 'does-not-exist.sh');
  process.env.SIMPLESAY_CONFIG = path.join(dir, 'simplesay.json');
  process.env.SIMPLESAY_DEBUG = '0';
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  let threw = false;
  try {
    const h = harness(process.env.SIMPLESAY_ENDPOINT, '');
    ext(h.pi); // activation runs the endpoint preflight
    h.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
    h.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'This must not crash. ' } });
    await h.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'This must not crash.' }] } });
    await wait(200);
  } catch { threw = true; }
  console.warn = origWarn;
  check('missing endpoint does not crash', !threw);
  check('missing endpoint warns exactly once (not per-utterance)',
    warns.filter((w) => /not found or not executable/.test(w)).length === 1, `${warns.length} warn(s)`);
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
