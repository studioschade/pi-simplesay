// pi-simplesay self-test — uses a fake speech endpoint so no audio is played.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  const saved = { SIMPLESAY_ENDPOINT: process.env.SIMPLESAY_ENDPOINT, SIMPLESAY_LOG: process.env.SIMPLESAY_LOG, SIMPLESAY_AGENT: process.env.SIMPLESAY_AGENT };
  process.env.SIMPLESAY_ENDPOINT = endpoint;
  process.env.SIMPLESAY_LOG = log;
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
  return { ...h, log, cleanup };
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
  await t.commands.simplesay.handler('mode tag', t.ctx);
  t.handlers.message_update({ assistantMessageEvent: { type: 'start' } });
  t.handlers.message_update({ assistantMessageEvent: { type: 'text_delta', delta: '<say>Hello tagged world</say> trailing prose' } });
  const result = await t.handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: '<say>Hello tagged world</say> trailing prose' }] } });
  await wait(400);
  const log = read(t.log);
  const stripped = result?.message?.content?.[0]?.text ?? '';
  check('tag mode speaks tagged span', log.includes('SYNTH|fabricant|Hello tagged world'), log.trim().split('\n')[0] ?? 'no calls');
  check('tag mode strips say tags at message_end', !stripped.includes('<say>') && stripped.includes('Hello tagged world'), stripped);
  t.cleanup();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
