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

const { default: ext, __test } = await import(EXT);

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

// opts.env: extra env set BEFORE the extension loads (restored on cleanup);
// opts.config: a config object written before load; opts.script: endpoint body.
function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-simplesay-test-'));
  const endpoint = path.join(dir, 'endpoint.sh');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(endpoint, `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then
  echo "PLAY|$2|$(date +%s%N)" >> "$log"
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
  echo "SYNTH|$agent|$text|$SAY_INSTRUCTION" >> "$log"
else
  echo "SPEAK|$agent|$text" >> "$log"
fi
`);
  fs.chmodSync(endpoint, 0o755);

  if (opts.script) { fs.writeFileSync(endpoint, opts.script); fs.chmodSync(endpoint, 0o755); }
  const config = path.join(dir, 'simplesay.json');
  if (opts.config) fs.writeFileSync(config, JSON.stringify(opts.config));
  const extraEnv = opts.env ?? {};
  const keys = ['SIMPLESAY_ENDPOINT', 'SIMPLESAY_LOG', 'SIMPLESAY_AGENT', 'SIMPLESAY_CONFIG', 'SIMPLESAY_DEBUG', 'SIMPLESAY_DIRECT', ...Object.keys(extraEnv)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.SIMPLESAY_ENDPOINT = endpoint;
  process.env.SIMPLESAY_LOG = log;
  process.env.SIMPLESAY_CONFIG = config; // never touch the real config
  process.env.SIMPLESAY_DEBUG = '0';
  delete process.env.SIMPLESAY_AGENT;
  delete process.env.SIMPLESAY_DIRECT; // the caller's shell must not pick the transport
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;

  const h = harness(endpoint, log);
  ext(h.pi);

  function cleanup() {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ...h, endpoint, log, config, dir, cleanup };
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

// --- direction attributes (the speech-tag standard shared with claude-simplesay) ---
{
  const t = setup();
  await t.commands.simplesay.handler('mode tag', t.ctx);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  // the opening tag arrives split across two deltas, attributes and all
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'Prose first. <say to' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: 'ne="warm, unhurried" at="but: firm, slower">It went cleanly, but the link is stale.</say>' } });
  const text = 'Prose first. <say tone="warm, unhurried" at="but: firm, slower">It went cleanly, but the link is stale.</say>';
  const result = await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
  await wait(400);
  const log = read(t.log);
  const synth = log.split('\n').find((l) => l.startsWith('SYNTH|')) ?? '';
  check('tone= reaches the endpoint as SAY_INSTRUCTION', /\|It went cleanly, but the link is stale\.\|warm, unhurried\. At the word 'but', firm, slower\.$/.test(synth), synth || 'no synth');
  const stripped = result?.message?.content?.[0]?.text ?? '';
  check('attribute tags are stripped at message_end', !/<\/?say/.test(stripped) && stripped.includes('It went cleanly'), stripped);
  t.cleanup();
}

{
  const t = setup();
  await t.commands.simplesay.handler('mode tag', t.ctx);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: '<say>One thing.</say><say pause="long"/><say>Two things.</say>' } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: '<say>One thing.</say><say pause="long"/><say>Two things.</say>' }] } });
  await wait(1600);
  const plays = read(t.log).split('\n').filter((l) => l.startsWith('PLAY|')).map((l) => Number(l.split('|')[2]));
  check('pause tag is a beat between spans', plays.length === 2 && (plays[1] - plays[0]) / 1e6 >= 800, `plays=${plays.length} gap=${plays.length === 2 ? ((plays[1] - plays[0]) / 1e6).toFixed(0) : '?'}ms`);
  t.cleanup();
}

{
  const t = setup();
  await t.commands.simplesay.handler('mode tag', t.ctx);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  const text = 'Only `<say>` spans are heard, one per breath.\n- a bullet\n<say>This is the only real span.</say>';
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: text } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
  await wait(400);
  const synths = read(t.log).split('\n').filter((l) => l.startsWith('SYNTH|'));
  check('a backticked tag in prose is not a span', synths.length === 1 && /This is the only real span/.test(synths[0]), synths.join(' | ') || 'no synth');
  t.cleanup();
}

// --- direct transport + honest WAV success (0.4.1-unreleased) ---
// Unit tests prove the endpoint/queue contract only; they say nothing about the TUI.

// A normal-mode endpoint that exits 0 WITHOUT a usable WAV (ignores SAY_OUT, or writes
// nothing) must fail the span: no --play call, nothing printed via console.*, the failure
// in the debug log, and the circuit-breaker still counting.
async function wavFailureCase(label, synthBody) {
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-${label}.log`);
  const t = setup({ env: { SIMPLESAY_DEBUG: dbgFile }, script: `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then echo "PLAY|$2" >> "$log"; exit 0; fi
[ "$1" = "--agent" ] && shift 2
echo "SYNTH|$*" >> "$log"
${synthBody}
exit 0
` });
  const printed = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  console.warn = console.error = (...a) => printed.push(a.map(String).join(' '));
  await t.commands.simplesay.handler('mode tag', t.ctx);
  const text = '<say>One.</say><say>Two.</say><say>Three.</say>';
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: text } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
  await wait(700);
  console.warn = orig.warn; console.error = orig.error;
  const log = read(t.log);
  const dbgLog = read(dbgFile);
  check(`rc=0 with ${label} WAV fails the span, no --play`, /SYNTH\|/.test(log) && !/PLAY\|/.test(log), log.trim().split('\n').join(' | '));
  check(`rc=0 with ${label} WAV prints nothing via console.*`, printed.length === 0, printed.join(' / ') || '(silent)');
  check(`rc=0 with ${label} WAV is logged as a span failure`, (dbgLog.match(/span FAIL \(synth\)/g) ?? []).length === 3 && /circuit-breaker/.test(dbgLog), `${(dbgLog.match(/span FAIL/g) ?? []).length} FAIL line(s)`);
  t.notices.length = 0;
  await t.commands.simplesay.handler('', t.ctx);
  check(`circuit-breaker still trips on ${label} WAV (status shows PAUSED)`, /voice PAUSED/.test(t.notices[0]?.m ?? ''), t.notices[0]?.m);
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}
await wavFailureCase('missing', ': # ignores SAY_OUT, writes nothing');
await wavFailureCase('empty', ': > "$SAY_OUT"');

// Direct endpoint: records argv, whether SAY_OUT reached it, and start/end times.
const DIRECT_EP = `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then echo "PLAY|$2" >> "$log"; exit 0; fi
argc=$#
agent=""
if [ "$1" = "--agent" ]; then agent="$2"; shift 2; fi
text="$*"
echo "START|$argc|$agent|$text|\${SAY_OUT-<unset>}|$SAY_INSTRUCTION|$(date +%s%N)" >> "$log"
case "$text" in *Slow*) sleep 0.3 ;; *Hang*) sleep 10 ;; esac
echo "END|$text|$(date +%s%N)" >> "$log"
exit 0
`;
const lines = (log, tag) => log.split('\n').filter((l) => l.startsWith(`${tag}|`));
async function tagReply(t, text) {
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: text } });
  await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

{
  // Direct: inherited SAY_OUT is removed, one call per span, zero --play, strict order,
  // agent args and SAY_INSTRUCTION exactly as the WAV transport passes them.
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-direct.log`);
  const t = setup({ env: { SIMPLESAY_DIRECT: '1', SAY_OUT: '/tmp/inherited-should-not-leak.wav', SIMPLESAY_DEBUG: dbgFile }, script: DIRECT_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await tagReply(t, '<say tone="warm">Slow first span.</say> prose <say>Second span.</say><say>Third span.</say>');
  await wait(1200);
  const log = read(t.log);
  const starts = lines(log, 'START'), ends = lines(log, 'END');
  check('direct: exactly one invocation per span', starts.length === 3 && ends.length === 3, `${starts.length} start(s)`);
  check('direct: zero --play calls', lines(log, 'PLAY').length === 0, log.trim().split('\n').join(' | '));
  check('direct: inherited SAY_OUT is not in the child env', starts.every((l) => l.split('|')[4] === '<unset>'), starts.map((l) => l.split('|')[4]).join(','));
  const [argc, agent, text, , instr] = (starts[0] ?? '').split('|').slice(1);
  check('direct: agent args + SAY_INSTRUCTION preserved', argc === '3' && agent.length > 0 && text === 'Slow first span.' && instr === 'warm', starts[0]);
  const order = log.trim().split('\n').map((l) => l.split('|')[0] + ':' + (l.startsWith('START') ? l.split('|')[3] : l.split('|')[1])).join(' ');
  check('direct: ordered, never overlapping (no synth-ahead)',
    order === 'START:Slow first span. END:Slow first span. START:Second span. END:Second span. START:Third span. END:Third span.', order);
  const dbgLog = read(dbgFile);
  check('direct: receipts say accepted, never played', (dbgLog.match(/receipt: accepted \(direct\)/g) ?? []).length === 3 && !/receipt: played/.test(dbgLog));
  check('direct: no temp WAV written', !fs.readdirSync('/tmp').some((f) => f.startsWith(`simplesay-${process.pid}-`)));
  t.notices.length = 0;
  await t.commands.simplesay.handler('', t.ctx);
  check('direct: status shows transport=direct (env) and the direct command', /transport=direct \(env\)/.test(t.notices[0]?.m ?? '') && /env -u SAY_OUT/.test(t.notices[1]?.m ?? '') && !/--play <tmp.wav>|SAY_OUT=</.test(t.notices[1]?.m ?? ''), JSON.stringify(t.notices.map((n) => n.m)));
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

{
  // Config precedence: env 1 / env 0 (over a saved true) / saved true / default.
  const status = async (t) => { t.notices.length = 0; await t.commands.simplesay.handler('', t.ctx); return t.notices[0]?.m ?? ''; };
  let t = setup({ env: { SIMPLESAY_DIRECT: '1' } });
  check('precedence: SIMPLESAY_DIRECT=1 -> direct (env)', /transport=direct \(env\)/.test(await status(t)));
  t.cleanup();
  t = setup({ env: { SIMPLESAY_DIRECT: '0' }, config: { mode: 'stream', enabled: true, direct: true } });
  check('precedence: SIMPLESAY_DIRECT=0 overrides saved direct:true -> wav (env)', /transport=wav \(env\)/.test(await status(t)));
  await tagReply(t, 'Env zero means the WAV path. It still plays.');
  await wait(500);
  check('precedence: env 0 really uses SAY_OUT + --play', /SYNTH\|/.test(read(t.log)) && /PLAY\|/.test(read(t.log)), read(t.log).trim().split('\n').join(' | '));
  t.cleanup();
  t = setup({ config: { mode: 'stream', enabled: true, direct: true } });
  check('precedence: saved direct:true, env unset -> direct (setting)', /transport=direct \(setting\)/.test(await status(t)));
  t.cleanup();
  t = setup();
  check('precedence: nothing set -> wav (default)', /transport=wav \(default\)/.test(await status(t)));
  await t.commands.simplesay.handler('mode tag', t.ctx);
  check('saving mode does not invent a direct key', !('direct' in JSON.parse(read(t.config))), read(t.config));
  t.cleanup();

  // Persistence: direct survives mode/enable saves and a fresh instance.
  t = setup();
  await t.commands.simplesay.handler('direct on', t.ctx);
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await t.commands.simplesay.handler('disable', t.ctx);
  await t.commands.simplesay.handler('enable', t.ctx);
  const saved = JSON.parse(read(t.config));
  check('direct persists across mode/enable saves', saved.direct === true && saved.mode === 'tag' && saved.enabled === true, JSON.stringify(saved));
  const h2 = harness(t.endpoint, t.log);
  ext(h2.pi);
  const s2 = await status(h2);
  check('direct persists across sessions', /transport=direct \(setting\)/.test(s2) && /mode=tag/.test(s2), s2);
  await t.commands.simplesay.handler('direct off', t.ctx);
  check('direct off saves false', JSON.parse(read(t.config)).direct === false);
  t.cleanup();
}

// Cancellation: shutdown / disable kill the in-flight direct child (whole group) and drop
// every undispatched span; a timeout kills a hung call and the queue moves on in order.
for (const how of ['session_shutdown', 'disable']) {
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-${how}.log`);
  const t = setup({ env: { SIMPLESAY_DIRECT: '1', SIMPLESAY_DEBUG: dbgFile }, script: DIRECT_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await tagReply(t, '<say>Hang here first.</say><say>Second never dispatched.</say><say>Third never dispatched.</say>');
  await wait(300);
  if (how === 'session_shutdown') await t.handlers.session_shutdown();
  else await t.commands.simplesay.handler('disable', t.ctx);
  await wait(500);
  const log = read(t.log);
  check(`direct ${how}: in-flight call killed, later spans never dispatched`,
    lines(log, 'START').length === 1 && lines(log, 'END').length === 0, log.trim().split('\n').join(' | '));
  let leftover = '';
  try { leftover = execSync('pgrep -af "sleep 10" | grep -v grep || true').toString().trim(); } catch {}
  check(`direct ${how}: leaves no child running`, leftover === '', leftover || '(clean)');
  const dbgLog = read(dbgFile);
  check(`direct ${how}: cancellation is not a failure`, /direct cancelled/.test(dbgLog) && !/span FAIL/.test(dbgLog) && (dbgLog.match(/direct DROPPED \(cancelled before dispatch\)/g) ?? []).length === 2);
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

{
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-dtimeout.log`);
  const t = setup({ env: { SIMPLESAY_DIRECT: '1', SIMPLESAY_DIRECT_TIMEOUT_MS: '300', SIMPLESAY_DEBUG: dbgFile }, script: DIRECT_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await tagReply(t, '<say>Hang on this one.</say><say>Next span runs.</say>');
  await wait(1000);
  const log = read(t.log);
  const order = log.trim().split('\n').map((l) => l.split('|')[0] + ':' + (l.startsWith('START') ? l.split('|')[3] : l.split('|')[1])).join(' ');
  check('direct timeout: hung call killed, next span runs after it', order === 'START:Hang on this one. START:Next span runs. END:Next span runs.', order);
  let leftover = '';
  try { leftover = execSync('pgrep -af "sleep 10" | grep -v grep || true').toString().trim(); } catch {}
  check('direct timeout: leaves no child running', leftover === '', leftover || '(clean)');
  check('direct timeout: logged as a span failure', /span FAIL \(direct\).*timed out/.test(read(dbgFile)));
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

{
  // WAV transport: shutdown aborts an in-flight synth — the span never plays and the
  // abort does not count against the circuit-breaker.
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-synthabort.log`);
  const t = setup({ env: { SIMPLESAY_DEBUG: dbgFile }, script: `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then echo "PLAY|$2" >> "$log"; exit 0; fi
echo "SYNTH-START" >> "$log"
sleep 1
printf 'wav' > "$SAY_OUT"
echo "SYNTH-END" >> "$log"
` });
  await tagReply(t, 'A slow synth that shutdown abandons.');
  await wait(300);
  await t.handlers.session_shutdown();
  await wait(1300);
  const log = read(t.log);
  const dbgLog = read(dbgFile);
  check('wav shutdown: in-flight synth aborted, never played', /SYNTH-START/.test(log) && !/SYNTH-END/.test(log) && !/PLAY\|/.test(log), log.trim().split('\n').join(' | '));
  check('wav shutdown: abort is not a failure', /synth cancelled/.test(dbgLog) && !/span FAIL/.test(dbgLog));
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

// --- review round 2: bounded termination, termination beats rc, breaker checked at
// dispatch. Scenarios from an independent review probe, as assertions. ---
// Endpoint behaviours, chosen by the span text:
//   Resist…  : the whole script ignores TERM (trap '' TERM), sleeps (marker: sleep 32)
//   Orphan…  : wrapper dies on TERM but leaves a TERM-ignoring grandchild (sleep 31)
//   ZeroTerm…: exits 0 when it receives TERM (sleep 33 in the meantime)
//   anything else: logs START/END, exits 0
const HOSTILE_EP = `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
[ "$1" = "--agent" ] && shift 2
text="$*"
prior=none
if [ -f "$log.pg" ]; then if kill -0 -- "-$(cat "$log.pg")" 2>/dev/null; then prior=alive; else prior=dead; fi; fi
echo "$$" > "$log.pg"
echo "START|$text|$$|$(date +%s%3N)|$prior" >> "$log"
case "$text" in
  Resist*) trap '' TERM; sleep 32 ;;
  Orphan*) ( trap '' TERM; exec sleep 31 ) & wait ;;
  ZeroTerm*) trap 'echo "TERM-EXIT0|$text" >> "$log"; exit 0' TERM; sleep 33 & wait ;;
esac
echo "END|$text" >> "$log"
exit 0
`;
const survivors = () => { try { return execSync('pgrep -af "sleep 3[1-4]" | grep -v grep || true').toString().trim(); } catch { return ''; } };
const hostileEnv = (extra = {}) => ({ SIMPLESAY_DIRECT: '1', SIMPLESAY_DIRECT_TIMEOUT_MS: '300', SIMPLESAY_KILL_GRACE_MS: '300', ...extra });

for (const [kind, how] of [['Resist', 'timeout'], ['Resist', 'session_shutdown'], ['Orphan', 'timeout'], ['Orphan', 'session_shutdown']]) {
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-${kind}-${how}.log`);
  const t = setup({ env: hostileEnv({ SIMPLESAY_DEBUG: dbgFile }), script: HOSTILE_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  const t0 = Date.now();
  await tagReply(t, `<say>${kind} this span.</say><say>Next span runs.</say>`);
  if (how === 'session_shutdown') { await wait(150); await t.handlers.session_shutdown(); }
  // Timeout at 300 ms, KILL at +300 ms, next span once the group is gone. 1300 ms is ample.
  await wait(1300 - (Date.now() - t0));
  const log = read(t.log);
  const nextRan = /START\|Next span runs\./.test(log) && /END\|Next span runs\./.test(log);
  const label = `${kind === 'Resist' ? 'TERM-ignoring endpoint' : 'TERM-ignoring grandchild of an exiting wrapper'}, ${how}`;
  check(`${label}: nothing survives the TERM->KILL escalation`, survivors() === '', survivors() || '(clean)');
  check(`${label}: ${how === 'timeout' ? 'next span runs' : 'next span never dispatched'}`, how === 'timeout' ? nextRan : !/Next span/.test(log), log.trim().split('\n').join(' | '));
  const dbgLog = read(dbgFile);
  check(`${label}: settled as ${how === 'timeout' ? 'failure' : 'cancellation'}, never accepted`,
    !/receipt: accepted \(direct\) "(Resist|Orphan)/.test(dbgLog)
    && (how === 'timeout' ? /span FAIL \(direct\).*timed out/.test(dbgLog) : /direct cancelled/.test(dbgLog)));
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

// No overlap, bounded progress (review round 2): the outcome is recorded at once, but the
// next call waits until the old process group is gone — at most grace + reap margin.
const startOf = (log, text) => { const l = log.split('\n').find((x) => x.startsWith(`START|${text}`)); if (!l) return null; const f = l.split('|'); return { at: Number(f[3]), prior: f[4] }; };
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return fn(); }
function bargeInEditor(t) {
  let factory;
  t.handlers.session_start({}, { mode: 'tui', ui: { getEditorComponent: () => undefined, setEditorComponent: (f) => { factory = f; }, notify() {} } });
  return factory({}, {}, {});
}
const GRACE = 600, REAP = 500, TIMEOUT = 300, SLACK = 400;
for (const kind of ['Resist', 'Orphan']) {
  const t = setup({ env: hostileEnv({ SIMPLESAY_KILL_GRACE_MS: String(GRACE), SIMPLESAY_REAP_MS: String(REAP) }), script: HOSTILE_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await tagReply(t, `<say>${kind} this span.</say><say>Next span runs.</say>`);
  await waitFor(() => /START\|Next span runs\./.test(read(t.log)), 3000);
  const log = read(t.log), a = startOf(log, `${kind} this span.`), b = startOf(log, 'Next span runs.');
  const label = kind === 'Resist' ? 'TERM-ignoring endpoint' : 'TERM-ignoring grandchild of an exiting wrapper';
  check(`${label}, timeout: next call starts only after the old group is gone (no overlap)`, b?.prior === 'dead', log.trim().split('\n').join(' | '));
  const delta = b && a ? b.at - a.at : NaN;
  check(`${label}, timeout: next call still makes progress within timeout + grace + reap`, delta >= TIMEOUT && delta <= TIMEOUT + GRACE + REAP + SLACK, `${delta}ms`);
  check(`${label}, timeout: nothing survives`, survivors() === '', survivors() || '(clean)');
  t.cleanup();
}

for (const how of ['disable/enable', 'barge-in']) {
  // Cancel mid-call, then a NEW reply: it must wait for the old group too.
  for (const kind of ['Resist', 'Orphan']) {
    const t = setup({ env: hostileEnv({ SIMPLESAY_DIRECT_TIMEOUT_MS: '60000', SIMPLESAY_KILL_GRACE_MS: String(GRACE), SIMPLESAY_REAP_MS: String(REAP) }), script: HOSTILE_EP });
    await t.commands.simplesay.handler('mode tag', t.ctx);
    const editor = how === 'barge-in' ? bargeInEditor(t) : null;
    await tagReply(t, `<say>${kind} this span.</say>`);
    await waitFor(() => /START\|/.test(read(t.log)), 1500);
    await wait(100);
    const tCancel = Date.now();
    if (editor) editor.handleInput('x');
    else { await t.commands.simplesay.handler('disable', t.ctx); await t.commands.simplesay.handler('enable', t.ctx); }
    await tagReply(t, '<say>Next span runs.</say>');
    await waitFor(() => /START\|Next span runs\./.test(read(t.log)), 3000);
    const log = read(t.log), b = startOf(log, 'Next span runs.');
    const label = `${kind === 'Resist' ? 'TERM-ignoring endpoint' : 'TERM-ignoring grandchild'}, ${how} then a new reply`;
    check(`${label}: new call waits for the old group (no overlap)`, b?.prior === 'dead', log.trim().split('\n').join(' | '));
    const delta = b ? b.at - tCancel : NaN;
    check(`${label}: and starts within grace + reap`, delta <= GRACE + REAP + SLACK, `${delta}ms after cancel`);
    await waitFor(() => survivors() === '', 1500);
    check(`${label}: nothing survives`, survivors() === '', survivors() || '(clean)');
    t.cleanup();
  }
}

for (const how of ['timeout', 'session_shutdown']) {
  // An endpoint that exits 0 on TERM must not turn a timeout or a cancellation into success.
  // Limit 2 with two timed-out spans: if either counted as success the breaker would reset.
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-zero-${how}.log`);
  const t = setup({ env: hostileEnv({ SIMPLESAY_DEBUG: dbgFile, SIMPLESAY_FAIL_LIMIT: '2' }), script: HOSTILE_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await tagReply(t, how === 'timeout' ? '<say>ZeroTerm one.</say><say>ZeroTerm two.</say>' : '<say>ZeroTerm one.</say>');
  if (how === 'session_shutdown') { await wait(150); await t.handlers.session_shutdown(); }
  await wait(how === 'timeout' ? 1100 : 600);
  const log = read(t.log), dbgLog = read(dbgFile);
  check(`exit-0-on-TERM endpoint (${how}): it did exit 0 on TERM`, /TERM-EXIT0\|ZeroTerm one/.test(log), log.trim().split('\n').join(' | '));
  check(`exit-0-on-TERM endpoint (${how}): no accepted receipt`, !/receipt: accepted/.test(dbgLog));
  if (how === 'timeout') {
    check('exit-0-on-TERM endpoint (timeout): both are failures and the breaker trips (never reset)',
      (dbgLog.match(/span FAIL \(direct\).*timed out/g) ?? []).length === 2 && /circuit-breaker/.test(dbgLog), dbgLog.split('\n').filter((l) => /FAIL|breaker|receipt/.test(l)).join(' / '));
  } else {
    check('exit-0-on-TERM endpoint (shutdown): cancellation receipt, not a failure', /receipt: cancelled/.test(dbgLog) && !/span FAIL/.test(dbgLog));
  }
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

{
  // Breaker checked at dispatch: 8 prequeued missing-WAV spans, limit 3 -> exactly 3 calls.
  const t = setup({ env: { SIMPLESAY_FAIL_LIMIT: '3' }, script: `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then echo "PLAY|$2" >> "$log"; exit 0; fi
echo "SYNTH|$*" >> "$log"
exit 0
` });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await tagReply(t, Array.from({ length: 8 }, (_, i) => `<say>Queued normal span ${i}.</say>`).join(''));
  await wait(1200);
  const n = lines(read(t.log), 'SYNTH').length;
  check('wav breaker: 8 prequeued failing spans, limit 3 -> exactly 3 endpoint calls', n === 3 && !/PLAY\|/.test(read(t.log)), `${n} call(s)`);
  t.cleanup();
}

{
  // Same bound on the direct path: 5 prequeued failing direct spans, limit 2 -> exactly 2 calls.
  const t = setup({ env: { SIMPLESAY_DIRECT: '1', SIMPLESAY_FAIL_LIMIT: '2' }, script: `#!/usr/bin/env bash
echo "START|$*" >> "$SIMPLESAY_LOG"
exit 7
` });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  await tagReply(t, Array.from({ length: 5 }, (_, i) => `<say>Failing direct span ${i}.</say>`).join(''));
  await wait(800);
  const n = lines(read(t.log), 'START').length;
  check('direct breaker: 5 prequeued failing spans, limit 2 -> exactly 2 endpoint calls', n === 2, `${n} call(s)`);
  t.cleanup();
}

// WAV `played` receipt: termination reason beats the player's exit code (review round 2).
const TERM_ZERO_PLAYER = `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then
  echo "PLAY-START|$2" >> "$log"
  trap 'echo "PLAY-TERM-EXIT0" >> "$log"; exit 0' TERM
  sleep 34 & wait
  exit 0
fi
printf 'wav' > "$SAY_OUT"
exit 0
`;
for (const how of ['disable', 'barge-in', 'timeout']) {
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-play-${how}.log`);
  const t = setup({ env: { SIMPLESAY_DEBUG: dbgFile, SIMPLESAY_PLAY_TIMEOUT_MS: how === 'timeout' ? '300' : '60000', SIMPLESAY_KILL_GRACE_MS: '300' }, script: TERM_ZERO_PLAYER });
  const editor = how === 'barge-in' ? bargeInEditor(t) : null;
  await tagReply(t, 'A player that exits zero when terminated.');
  await waitFor(() => /PLAY-START/.test(read(t.log)), 1500);
  await wait(50);
  if (how === 'disable') await t.commands.simplesay.handler('disable', t.ctx);
  if (editor) editor.handleInput('x');
  await waitFor(() => /PLAY-TERM-EXIT0/.test(read(t.log)), 1500);
  await wait(150);
  const dbgLog = read(dbgFile);
  check(`WAV player exits 0 on TERM (${how}): it did`, /PLAY-TERM-EXIT0/.test(read(t.log)), read(t.log).trim().split('\n').join(' | '));
  check(`WAV player exits 0 on TERM (${how}): no played receipt`, !/receipt: played/.test(dbgLog));
  check(`WAV player exits 0 on TERM (${how}): ${how === 'timeout' ? 'failed (timed out)' : 'cancelled'}`,
    how === 'timeout' ? /play FAIL: timed out/.test(dbgLog) : /receipt: cancelled \(play\)/.test(dbgLog),
    dbgLog.split('\n').filter((l) => /play|receipt/.test(l)).join(' / '));
  check(`WAV player exits 0 on TERM (${how}): nothing survives`, survivors() === '', survivors() || '(clean)');
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

// --- review round 4: the teardown barrier fails CLOSED ---
// Fault injection through the extension's signal seam (__test.signal), aimed only at our
// own fake endpoint's group. 'eperm' throws EPERM for every signal to that group;
// 'deadline' swallows its SIGKILL so the group is still really present at grace + reap.
const realSignal = __test.signal;
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
async function statusOf(t) { t.notices.length = 0; await t.commands.simplesay.handler('', t.ctx); return t.notices[0]?.m ?? ''; }
function inject(kind, victim) {
  __test.signal = (pid, sig) => {
    if (pid === -victim && kind === 'eperm') { const e = new Error('injected EPERM (test)'); e.code = 'EPERM'; throw e; }
    if (pid === -victim && kind === 'deadline' && sig === 'SIGKILL') return true; // teardown never completes
    return realSignal(pid, sig);
  };
}
async function recoverAndResume(t, victim, label, resumeCheck) {
  // Fault removed but the group really still exists: enable must stay held.
  __test.signal = realSignal;
  t.notices.length = 0;
  await t.commands.simplesay.handler('enable', t.ctx);
  check(`${label}: enable stays held while the group really exists (fault removed)`, groupAlive(victim) && t.notices.some((n) => n.k === 'error' && /still HELD/.test(n.m)), JSON.stringify(t.notices));
  // The group dies: the next enable re-probes, sees ESRCH, releases.
  process.kill(-victim, 'SIGKILL');
  await waitFor(() => !groupAlive(victim), 1500);
  t.notices.length = 0;
  await t.commands.simplesay.handler('enable', t.ctx);
  check(`${label}: enable clears once the group is gone (ESRCH)`, t.notices.some((n) => /speech released/.test(n.m)) && !/HELD/.test(await statusOf(t)), JSON.stringify(t.notices));
  await resumeCheck();
}

for (const kind of ['eperm', 'deadline']) {
  const label = `direct, ${kind === 'eperm' ? 'EPERM on the old group' : 'reap deadline exhausted, group still present'}`;
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-held-${kind}.log`);
  const t = setup({ env: hostileEnv({ SIMPLESAY_KILL_GRACE_MS: '200', SIMPLESAY_REAP_MS: '100', SIMPLESAY_DEBUG: dbgFile }), script: HOSTILE_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  let victim = 0;
  try {
    await tagReply(t, '<say>Resist first.</say><say>Second queued.</say><say>Third queued.</say>');
    await waitFor(() => /START\|Resist first/.test(read(t.log)), 1500);
    victim = Number(read(t.log).split('\n').find((l) => l.startsWith('START|Resist first')).split('|')[2]);
    inject(kind, victim);
    await wait(1200); // timeout 300 ms; deadline at 300 + 200 + 100 ms
    let log = read(t.log), dbgLog = read(dbgFile);
    check(`${label}: next call never starts`, !/START\|(Second|Third)/.test(log) && groupAlive(victim), log.trim().split('\n').join(' | '));
    check(`${label}: explicit teardown-failure line`, /teardown FAILED \(unconfirmed\): group -\d+: /.test(dbgLog), dbgLog.split('\n').filter((l) => /teardown/.test(l)).join(' / '));
    check(`${label}: queued spans settle as refused`, (dbgLog.match(/direct REFUSED \(teardown unconfirmed/g) ?? []).length === 2);
    check(`${label}: status shows speech HELD`, /speech HELD: teardown unconfirmed for group -\d+/.test(await statusOf(t)));
    await tagReply(t, '<say>A new reply while held.</say>');
    await wait(150);
    check(`${label}: new spans are refused immediately`, /speak REFUSED \(teardown unconfirmed/.test(read(dbgFile)) && !/START\|A new reply/.test(read(t.log)));
    t.notices.length = 0;
    await t.commands.simplesay.handler('enable', t.ctx);
    check(`${label}: enable stays held while the fault persists`, t.notices.some((n) => n.k === 'error' && /still HELD/.test(n.m)) && /HELD/.test(await statusOf(t)), JSON.stringify(t.notices));
    await recoverAndResume(t, victim, label, async () => {
      await tagReply(t, '<say>Speech resumes.</say>');
      await waitFor(() => /END\|Speech resumes/.test(read(t.log)), 1500);
      const b = startOf(read(t.log), 'Speech resumes.');
      check(`${label}: speech resumes after recovery (queue not stuck, no overlap)`, b?.prior === 'dead' && /END\|Speech resumes/.test(read(t.log)), read(t.log).trim().split('\n').join(' | '));
    });
  } finally {
    __test.signal = realSignal;
    if (victim) { try { process.kill(-victim, 'SIGKILL'); } catch {} }
  }
  await waitFor(() => survivors() === '', 1500);
  check(`${label}: nothing survives`, survivors() === '', survivors() || '(clean)');
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

for (const kind of ['eperm', 'deadline']) {
  // Same latch on the WAV transport: a barge-in on a TERM-ignoring player whose teardown
  // cannot be confirmed holds speech; no new synth or player runs until recovery.
  const label = `wav, ${kind === 'eperm' ? 'EPERM on the old player group' : 'reap deadline exhausted on the player group'}`;
  const dbgFile = path.join(os.tmpdir(), `pi-simplesay-dbg-${process.pid}-wheld-${kind}.log`);
  const t = setup({ env: { SIMPLESAY_DEBUG: dbgFile, SIMPLESAY_PLAY_TIMEOUT_MS: '60000', SIMPLESAY_KILL_GRACE_MS: '200', SIMPLESAY_REAP_MS: '100' }, script: `#!/usr/bin/env bash
log="$SIMPLESAY_LOG"
if [ "$1" = "--play" ]; then echo "PLAY-START|$$|$2" >> "$log"; trap '' TERM; sleep 34; exit 0; fi
[ "$1" = "--agent" ] && shift 2
echo "SYNTH|$*" >> "$log"
printf 'wav' > "$SAY_OUT"
exit 0
` });
  const editor = bargeInEditor(t);
  let victim = 0;
  try {
    await tagReply(t, 'A player that ignores termination.');
    await waitFor(() => /PLAY-START/.test(read(t.log)), 1500);
    victim = Number(read(t.log).split('\n').find((l) => l.startsWith('PLAY-START')).split('|')[1]);
    inject(kind, victim);
    editor.handleInput('x');
    await wait(600);
    await tagReply(t, 'Held reply must not synthesize.');
    await wait(300);
    const log = read(t.log), dbgLog = read(dbgFile);
    check(`${label}: teardown failure latched, status HELD`, /teardown FAILED \(unconfirmed\)/.test(dbgLog) && /speech HELD/.test(await statusOf(t)));
    check(`${label}: no new synth or player while held`, lines(log, 'SYNTH').length === 1 && lines(log, 'PLAY-START').length === 1 && /speak REFUSED/.test(dbgLog), log.trim().split('\n').join(' | '));
    await recoverAndResume(t, victim, label, async () => {
      await tagReply(t, 'Speech resumes on the wav path.');
      await waitFor(() => lines(read(t.log), 'PLAY-START').length === 2, 1500);
      check(`${label}: speech resumes after recovery`, lines(read(t.log), 'PLAY-START').length === 2, read(t.log).trim().split('\n').join(' | '));
      await t.handlers.session_shutdown(); // the resumed player ignores TERM too: KILL after the grace
    });
  } finally {
    __test.signal = realSignal;
    if (victim) { try { process.kill(-victim, 'SIGKILL'); } catch {} }
  }
  await waitFor(() => survivors() === '', 1500);
  check(`${label}: nothing survives`, survivors() === '', survivors() || '(clean)');
  fs.rmSync(dbgFile, { force: true });
  t.cleanup();
}

// --- /simplesay output local|server: user-facing alias over the same `direct` setting ---
{
  // output server -> persists direct:true; the next span is exactly one endpoint call, no --play.
  const t = setup({ script: DIRECT_EP });
  await t.commands.simplesay.handler('mode tag', t.ctx);
  t.notices.length = 0;
  await t.commands.simplesay.handler('output server', t.ctx);
  check('output server: persists direct:true (no new key)', JSON.parse(read(t.config)).direct === true && !('output' in JSON.parse(read(t.config))), read(t.config));
  check('output server: notice says server (setting)', /output: server \(saved\); in effect: output=server \(setting\)/.test(t.notices[0]?.m ?? ''), JSON.stringify(t.notices));
  await tagReply(t, '<say>Server plays this span.</say>');
  await wait(500);
  const log = read(t.log);
  check('output server: next span makes exactly one endpoint call, no --play',
    lines(log, 'START').length === 1 && lines(log, 'PLAY').length === 0 && lines(log, 'START')[0].split('|')[4] === '<unset>', log.trim().split('\n').join(' | '));
  const s = await statusOf(t);
  check('output server: bare status shows output=server (setting) and keeps transport=', /output=server \(setting\)/.test(s) && /transport=direct \(setting\)/.test(s), s);
  // A fresh instance reads it back through the same key.
  const h2 = harness(t.endpoint, t.log);
  ext(h2.pi);
  check('output server: persists across sessions', /output=server \(setting\)/.test(await statusOf(h2)));
  t.cleanup();
}

{
  // output local -> persists direct:false; spans use synth (SAY_OUT) + --play.
  const t = setup({ config: { mode: 'tag', enabled: true, direct: true } });
  t.notices.length = 0;
  await t.commands.simplesay.handler('output local', t.ctx);
  check('output local: persists direct:false', JSON.parse(read(t.config)).direct === false, read(t.config));
  check('output local: notice says local (setting)', /output: local \(saved\); in effect: output=local \(setting\)/.test(t.notices[0]?.m ?? ''), JSON.stringify(t.notices));
  await tagReply(t, '<say>Local plays this span.</say>');
  await wait(500);
  const log = read(t.log);
  check('output local: span uses synth + --play', lines(log, 'SYNTH').length === 1 && lines(log, 'PLAY').length === 1 && !/SPEAK\|/.test(log), log.trim().split('\n').join(' | '));
  // direct on|off keeps working and the two commands agree.
  await t.commands.simplesay.handler('direct on', t.ctx);
  t.notices.length = 0;
  await t.commands.simplesay.handler('output', t.ctx);
  check('direct on is reported by output as server', /SimpleSay output: server \(setting\)/.test(t.notices[0]?.m ?? ''), JSON.stringify(t.notices));
  t.cleanup();
}

{
  // Bare `output` reports value and source; default first.
  const t = setup();
  await t.commands.simplesay.handler('output', t.ctx);
  check('bare output: reports local (default)', t.notices[0]?.k === 'info' && /SimpleSay output: local \(default\) — audio is played on this device/.test(t.notices[0]?.m ?? ''), JSON.stringify(t.notices));
  check('bare output: writes no config', !fs.existsSync(t.config));
  check('bare status: output=local (default)', /output=local \(default\)/.test(await statusOf(t)));
  t.notices.length = 0;
  await t.commands.simplesay.handler('output somewhere', t.ctx);
  check('output with a bad value: usage error, nothing saved', t.notices[0]?.k === 'error' && /Usage: \/simplesay output \[local\|server\]/.test(t.notices[0]?.m ?? '') && !fs.existsSync(t.config), JSON.stringify(t.notices));
  t.cleanup();
}

{
  // Env override is reported by bare output, by output <value>, and in status.
  const t = setup({ env: { SIMPLESAY_DIRECT: '1' } });
  await t.commands.simplesay.handler('output', t.ctx);
  check('env override: bare output reports server (env) and names the override', /output: server \(env\).*SIMPLESAY_DIRECT=1 overrides the setting/.test(t.notices[0]?.m ?? ''), JSON.stringify(t.notices));
  t.notices.length = 0;
  await t.commands.simplesay.handler('output local', t.ctx);
  check('env override: output local saves but says env still wins', JSON.parse(read(t.config)).direct === false && /output: local \(saved\); in effect: output=server \(env\) — SIMPLESAY_DIRECT=1 overrides the setting/.test(t.notices[0]?.m ?? ''), JSON.stringify(t.notices));
  check('env override: status shows output=server (env)', /output=server \(env\)/.test(await statusOf(t)));
  t.cleanup();
  const t0 = setup({ env: { SIMPLESAY_DIRECT: '0' }, config: { mode: 'stream', enabled: true, direct: true } });
  await t0.commands.simplesay.handler('output', t0.ctx);
  check('env override: SIMPLESAY_DIRECT=0 over saved server reports local (env)', /output: local \(env\).*SIMPLESAY_DIRECT=0 overrides/.test(t0.notices[0]?.m ?? ''), JSON.stringify(t0.notices));
  t0.cleanup();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

