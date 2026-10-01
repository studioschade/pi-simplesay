import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { unlink, realpathSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, accessSync, statSync, constants } from "node:fs";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// tag:    agent wraps spoken text in <say>…</say>; spans are spoken live and the
//         tags are stripped from the transcript.
// stream: no tags; speak the reply paragraph by paragraph, skipping code/tables.
type Mode = "tag" | "stream";

const CLOSE = "</say>";
// The speech-tag standard (shared with claude-simplesay): the opening tag may carry direction
// attributes, and a self-closing pause tag is a beat of silence between spans.
//   <say tone="warm, unhurried">…</say>          tone  -> the span's delivery (SAY_INSTRUCTION)
//   <say tone="even" at="but: firm, slower">…    at    -> a shift inside the span, folded into the instruction
//   <say pause="short"/>  /  <say pause="long"/>   pause -> 0.35 s / 0.9 s / seconds of silence
// A bare <say> is unchanged. Attributes never carry information the sentence lacks: the
// endpoint is free to ignore SAY_INSTRUCTION, and the transcript reads correctly with tags gone.
const OPEN_RE = /<say(\s[^<>]*?)?\s*(\/?)>/;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;
const TAG_ANY_RE = /<say(?:\s[^<>]*?)?\s*\/?>|<\/say>/g;
const PAUSES: Record<string, number> = { short: 350, long: 900 };

function parseAttrs(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (body ?? "").matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2];
  return out;
}

// tone + at -> the instruction the endpoint receives. "at" is `word: delivery`, several split
// by ";", folded as the model is trained to read it: "At the word 'w', delivery."
function instructionFor(attrs: Record<string, string>): string {
  const tone = (attrs.tone ?? "").trim();
  const shifts = (attrs.at ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      if (i < 0) return "";
      const w = p.slice(0, i).trim().replace(/^["']|["']$/g, "");
      const d = p.slice(i + 1).trim().replace(/\.$/, "");
      return w && d ? `At the word '${w}', ${d}.` : "";
    })
    .filter(Boolean);
  if (!shifts.length) return tone;
  return (tone ? tone.replace(/\.$/, "") + ". " : "") + shifts.join(" ");
}

function pauseMs(attrs: Record<string, string>): number {
  const v = (attrs.pause ?? "").trim();
  if (!v) return 0;
  if (PAUSES[v] !== undefined) return PAUSES[v];
  const n = Number(v.replace(/s$/, ""));
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 10_000) : PAUSES.short;
}

// Wraps the editor so any keystroke interrupts current speech ("barge-in").
// Composes with a previously-set custom editor (e.g. vim mode) if present:
// we stop audio first, then delegate to that editor's handleInput/render so
// its own behavior is untouched.
class SimpleSayEditor extends CustomEditor {
  private base?: { handleInput(data: string): void; render(width: number): string[] };
  private onKey: () => void;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    onKey: () => void,
    base?: { handleInput(data: string): void; render(width: number): string[] },
  ) {
    super(tui, theme, keybindings);
    this.onKey = onKey;
    this.base = base;
  }

  handleInput(data: string): void {
    this.onKey();
    this.base ? this.base.handleInput(data) : super.handleInput(data);
  }

  render(width: number): string[] {
    return this.base ? this.base.render(width) : super.render(width);
  }
}

// Test seam: every process-group signal the extension sends goes through this. Production
// never reassigns it (it calls process.kill at call time, exactly as before); the test
// suite swaps it to inject EPERM or a teardown that never completes.
export const __test = {
  signal: (pid: number, sig: NodeJS.Signals | 0): boolean => process.kill(pid, sig),
  // Clock seam for the circuit-breaker's cooldown math. Production never reassigns it;
  // the test suite swaps it to fast-forward past a cooldown without a real sleep.
  now: (): number => Date.now(),
};

export default function (pi: ExtensionAPI) {
  // Mode persists across sessions in a tiny JSON config, written only when
  // changed via /simplesay mode (SIMPLESAY_CONFIG relocates it — the test
  // suite uses that so it never touches the real file). A missing or corrupt
  // file just falls back to the default: stream, so voice works with zero
  // agent config (tag mode needs the agent to emit <say> markers).
  const configFile = process.env.SIMPLESAY_CONFIG ?? join(homedir(), ".pi", "agent", "simplesay.json");
  function loadConfig(): { mode: Mode; enabled: boolean; direct: boolean | undefined } {
    try {
      const c = JSON.parse(readFileSync(configFile, "utf8"));
      const m = c.mode;
      return {
        mode: m === "tag" || m === "stream" ? m : "stream",
        // Config written before `enabled` existed just lacks the key → on.
        enabled: c.enabled !== false,
        // Absent key = never chosen; the default (WAV transport) applies.
        direct: typeof c.direct === "boolean" ? c.direct : undefined,
      };
    } catch { /* no config yet — use the defaults */ }
    return { mode: "stream", enabled: true, direct: undefined };
  }
  function saveConfig() {
    try {
      mkdirSync(dirname(configFile), { recursive: true });
      // `direct` rides along so saving mode/enabled never drops it (omitted while unset).
      writeFileSync(configFile, JSON.stringify({ mode, enabled, direct: directSetting }, null, 2) + "\n");
    } catch (e) { dbg(`config save FAIL: ${e}`); }
  }
  const loaded = loadConfig();
  let mode: Mode = loaded.mode;
  // Master switch: /simplesay disable mutes all speech until re-enabled.
  // Persists like mode, so a muted session stays muted across restarts.
  let enabled: boolean = loaded.enabled;

  // Transport. "wav" (the default) is the synth-ahead pipeline: SAY_OUT=<tmp.wav>, then
  // `--play <tmp.wav>`. "direct" is one plain `endpoint [--agent] "<text>"` call per span,
  // in order, for endpoints that speak (or hand off) the text themselves and write no WAV —
  // e.g. a sandboxed agent whose endpoint hands the text to a relay outside the sandbox, or
  // a TTS server that plays on its own speakers. Explicit opt-in only:
  // SIMPLESAY_DIRECT=1 selects it, SIMPLESAY_DIRECT=0 forces the WAV transport over a saved
  // `direct: true`, unset defers to the saved setting (`/simplesay direct on|off`), else off.
  // User-facing alias: `/simplesay output local|server` — local = WAV (played on this
  // device), server = direct (the endpoint/server plays it). Same `direct` key, no new setting.
  let directSetting: boolean | undefined = loaded.direct;
  const directEnv = process.env.SIMPLESAY_DIRECT;
  function transport(): { direct: boolean; source: "env" | "setting" | "default" } {
    if (directEnv === "1") return { direct: true, source: "env" };
    if (directEnv === "0") return { direct: false, source: "env" };
    if (directSetting !== undefined) return { direct: directSetting, source: "setting" };
    return { direct: false, source: "default" };
  }
  const transportLabel = () => { const t = transport(); return `${t.direct ? "direct" : "wav"} (${t.source})`; };
  const outputLabel = () => { const t = transport(); return `${t.direct ? "server" : "local"} (${t.source})`; };
  const envOverrideNote = () => (transport().source === "env" ? ` — SIMPLESAY_DIRECT=${directEnv} overrides the setting` : "");
  // Voice identity: explicit env wins; else derive the agent from the working
  // dir (~/Agents/<name>, the box convention) so each agent speaks as ITSELF
  // with zero per-agent config; "fabricant" only as a last resort. This
  // extension loads globally for every Pi agent, so without the cwd derivation
  // every agent would default to fabricant's voice. (Portable: a non-box user
  // just sets SIMPLESAY_AGENT.)
  const agentFromCwd = process.cwd().match(/\/Agents\/([^/]+)(?:\/|$)/)?.[1];
  let agentName = process.env.SIMPLESAY_AGENT ?? agentFromCwd ?? "fabricant";
  // SIMPLESAY_ENDPOINT lets a given machine pin its own speech endpoint
  // (e.g. a shared box-wide `say` script) without editing this file. With
  // no env var set, falls back to the bundled example endpoint shipped in
  // this repo (../examples/endpoint.sh), resolved relative to this file so
  // it works regardless of CWD.
  // Resolve symlinks so the path works when the extension is symlinked
  // into pi's extensions dir (e.g. ~/.pi/agent/extensions/simplesay.ts →
  // /path/to/simplesay/src/index.ts). Without realpathSync, import.meta.url
  // points to the symlink location, not the real file, so the relative
  // path to examples/endpoint.sh breaks.
  const realPath = realpathSync(fileURLToPath(import.meta.url));
  const bundledDefault = join(dirname(realPath), "..", "examples", "endpoint.sh");
  let endpoint = process.env.SIMPLESAY_ENDPOINT ?? bundledDefault;
  let agentFlag = true;

  // A TTS extension must NEVER crash or spam the agent because speech failed.
  // Preflight the endpoint once: if it is missing or not executable, disable
  // voice for the session with ONE clear warning instead of erroring on every
  // utterance. This is a CONFIG error (wrong path, bad permissions) and never
  // auto-retries on its own — nothing short of a fixed path makes a missing binary
  // start existing. A present-but-failing endpoint (an unreachable TTS server, a
  // wrong host — the 2026-08-30 "kokoro on core, not halo" crash) is a RUNTIME
  // failure instead, caught by the synth/direct circuit-breaker below — that one
  // DOES auto-retry, since what it's waiting on (a server, a network path) can come
  // back on its own.
  let preflightFailed = false;
  function checkEndpoint(): boolean {
    try { accessSync(endpoint, constants.X_OK); return true; }
    catch {
      console.warn(`[simplesay] endpoint not found or not executable: ${endpoint} — voice disabled this session (set SIMPLESAY_ENDPOINT to a working one, then /simplesay enable)`);
      return false;
    }
  }
  preflightFailed = !checkEndpoint();
  let synthFails = 0;                                                  // consecutive synth failures
  const SYNTH_FAIL_LIMIT = Number(process.env.SIMPLESAY_FAIL_LIMIT) || 3;

  // --- Auto-recovery (half-open circuit breaker) — RUNTIME trips only ------------
  // Once SYNTH_FAIL_LIMIT consecutive synth/direct failures trip the breaker, voice
  // no longer stays paused forever: after `retryMs` has elapsed since the trip, the
  // NEXT span to arrive is let through as a single probe (half-open). Success closes
  // the breaker (synthFails resets, voice resumes); failure re-opens it with the
  // cooldown doubled, capped at RETRY_MS_MAX. This is evaluated lazily, only when a
  // span actually arrives — no timer and nothing keeps the process alive on its own.
  // SIMPLESAY_RETRY_MS=0 disables auto-retry entirely (the pre-0.6.0 behaviour: only
  // /simplesay enable reopens it).
  function parseMsEnv(name: string, def: number): number {
    const v = process.env[name];
    if (v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : def;
  }
  const RETRY_MS_INITIAL = parseMsEnv("SIMPLESAY_RETRY_MS", 60_000);
  // Math.max guards a misconfigured cap smaller than the initial value — the cap can
  // never be below where backoff starts, or doubling would shrink the cooldown.
  const RETRY_MS_MAX = Math.max(RETRY_MS_INITIAL, parseMsEnv("SIMPLESAY_RETRY_MAX_MS", 15 * 60_000));
  let breakerOpenedAt: number | null = null; // __test.now() at the trip; null = closed
  let retryMs = RETRY_MS_INITIAL;            // current cooldown; doubles on each failed probe
  let probing = false;                       // a half-open probe is in flight — at most one
  // Identifies WHICH probe is currently valid. Bumped every time tryBreaker() grants a new
  // probe; every dispatch path that was handed a probe carries ITS token (`myProbe` in
  // speak()) and only that token may close/re-trip the breaker or clear `probing` for it.
  // Without this, a stale probe reclaimed by the deadline backstop below could still land
  // late (its synth/direct call finally settling) and stomp on whatever probe replaced it.
  let probeToken = 0;
  let probeStartedAt: number | null = null; // __test.now() when probeToken was granted

  // Backstop for a granted probe that never reaches spanSucceeded()/spanFailed() through
  // any path we explicitly release (releaseProbe, below) — an unanticipated throw or drop
  // between the grant and dispatch would otherwise wedge the breaker open "probe in
  // flight" forever, the exact failure auto-retry exists to remove. The deadline is the
  // longest a legitimate probe could still be outstanding: a synth call (90 s, see the
  // execFileAsync timeout in speak()) or a direct call (SIMPLESAY_DIRECT_TIMEOUT_MS),
  // whichever is larger, plus the teardown grace + reap margin a cancelled/timed-out call
  // waits out, plus headroom.
  const PROBE_SYNTH_TIMEOUT_MS = 90_000; // mirrors the execFileAsync timeout in speak()
  const PROBE_DIRECT_TIMEOUT_MS = Number(process.env.SIMPLESAY_DIRECT_TIMEOUT_MS) || 120_000;
  const PROBE_PLAY_TIMEOUT_MS = Number(process.env.SIMPLESAY_PLAY_TIMEOUT_MS) || 120_000;
  const PROBE_TEARDOWN_MARGIN_MS =
    (Number(process.env.SIMPLESAY_KILL_GRACE_MS) || 1000) + (Number(process.env.SIMPLESAY_REAP_MS) || 500);
  const PROBE_DEADLINE_MS =
    Math.max(PROBE_SYNTH_TIMEOUT_MS, PROBE_DIRECT_TIMEOUT_MS, PROBE_PLAY_TIMEOUT_MS) + PROBE_TEARDOWN_MARGIN_MS + 10_000;

  // Per-message stream state.
  let acc = "";         // streamed text not yet parsed
  let speaking = false; // inside a <say> span (tag mode)
  let direction = "";   // the open span's instruction (tag mode; from tone= / at=)
  let buf = "";         // text held for the next utterance
  let para = "";        // current paragraph (stream mode)
  let inFence = false;  // inside a ``` block (stream mode)
  let sawText = false;  // any streamed text this message

  // Pipeline so there's no dead air between utterances: synthChain renders each
  // WAV ahead (fast), playChain plays them in order (slow). The next utterance
  // synthesizes while the current one is still playing.
  let synthChain: Promise<unknown> = Promise.resolve();
  let playChain: Promise<unknown> = Promise.resolve();
  let seq = 0;

  // Interrupt-on-type: typing in the editor stops audio immediately.
  // `epoch` invalidates anything already queued (synth in flight, WAVs
  // waiting to play); `muted` blocks new utterances from this message from
  // queuing at all. Both clear on the next assistant message (reset()).
  let epoch = 0;
  let muted = false;
  let currentPlayChild: ChildProcess | null = null;
  // Set while a direct call is in flight: cancels it (group kill) and records its outcome
  // at once; the next call still waits at the teardown barrier (see killGroup).
  let currentDirectCancel: (() => void) | null = null;
  // Aborted by stopSpeaking so an in-flight synth wrapper is terminated on barge-in /
  // disable / shutdown instead of running out its 90 s timeout. The synth is NOT a process
  // group: neither this abort nor the timeout reaches descendants the wrapper started.
  let abortCtl = new AbortController();

  // Debug tracing: one line per pipeline decision, so a silent session shows
  // exactly where speech died (no events? muted? synth fail? play fail?).
  // Defaults ON to /tmp (cleared on reboot, tiny volume); SIMPLESAY_DEBUG=0
  // disables, or set SIMPLESAY_DEBUG=<path> to relocate.
  const DEBUG = process.env.SIMPLESAY_DEBUG === "0" ? null : (process.env.SIMPLESAY_DEBUG ?? "/tmp/simplesay-debug.log");
  function dbg(msg: string) {
    if (!DEBUG) return;
    try { appendFileSync(DEBUG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`); } catch { /* never break speech over logging */ }
  }
  dbg(`loaded mode=${mode} enabled=${enabled} output=${outputLabel()} transport=${transportLabel()} agent=${agentName} endpoint=${endpoint}`);
  if (directEnv !== undefined && directEnv !== "0" && directEnv !== "1") dbg(`SIMPLESAY_DIRECT='${directEnv}' ignored (use 1 or 0)`);

  // True iff a span may be dispatched right now: preflight passed, and either the
  // breaker is closed (any span) or `myProbe` names the CURRENTLY valid half-open probe
  // (null never matches while open — see tryBreaker). Read-only — safe to call again for
  // the SAME span as it moves through a queue (the synth chain, the direct chain) without
  // changing the decision already made for it.
  function usableFor(myProbe: number | null): boolean {
    if (preflightFailed) return false;
    if (breakerOpenedAt === null) return true; // closed: nothing to gate
    return probing && myProbe !== null && myProbe === probeToken;
  }

  // The single decision point per span: called once, synchronously, before anything is
  // queued (speak()'s top-level gate, shared by both transports). Grants exactly one
  // probe once the cooldown has elapsed; every other span — while fully open, or while
  // a probe is already outstanding — is refused. On a successful grant, `probeToken` is
  // bumped and `probing`/`probeStartedAt` reflect the new probe; the caller reads
  // `probeToken` right after (see `myProbe` in speak()) to get its own token.
  function tryBreaker(): boolean {
    if (preflightFailed) return false;
    if (breakerOpenedAt === null) return true; // closed: normal operation
    if (probing) {
      // Backstop: a probe that never reached spanSucceeded/spanFailed/releaseProbe (an
      // unanticipated throw or drop between the grant and dispatch) would otherwise wedge
      // the breaker "probe in flight" forever — exactly the failure auto-retry exists to
      // remove. Past PROBE_DEADLINE_MS it can't still be a legitimate in-flight call, so
      // declare it lost and let THIS span take over as the new probe.
      if (probeStartedAt !== null && __test.now() - probeStartedAt > PROBE_DEADLINE_MS) {
        dbg(`circuit-breaker: probe #${probeToken} never settled within ${PROBE_DEADLINE_MS}ms — treating it as lost, granting a new probe`);
        probing = false;
        probeStartedAt = null;
      } else {
        return false; // one probe at a time
      }
    }
    if (retryMs <= 0) return false; // SIMPLESAY_RETRY_MS=0: auto-retry off
    if (__test.now() - breakerOpenedAt < retryMs) return false; // still cooling down
    probing = true;
    probeToken += 1;
    probeStartedAt = __test.now();
    dbg(`circuit-breaker: cooldown elapsed (${retryMs}ms) — probing with this span (#${probeToken})`);
    return true;
  }

  // Status-line fragment for why voice might be paused. A preflight failure is a
  // config error and never auto-retries; a runtime trip (breaker open) shows the
  // retry countdown, e.g. "breaker open, retry in 42s".
  function breakerStatusNote(): string {
    if (preflightFailed) return " (voice PAUSED: endpoint not usable — fix SIMPLESAY_ENDPOINT, then /simplesay enable)";
    if (breakerOpenedAt === null) return "";
    if (probing) return " (breaker open, probing now)";
    if (retryMs <= 0) return " (voice PAUSED: endpoint failing, see debug log; /simplesay enable retries)";
    const remaining = Math.max(0, Math.ceil((retryMs - (__test.now() - breakerOpenedAt)) / 1000));
    return ` (voice PAUSED: breaker open, retry in ${remaining}s; /simplesay enable retries now)`;
  }

  // Called on every path where a granted probe is abandoned WITHOUT a verdict — cancelled
  // before dispatch, refused by an unrelated guard (held teardown), barge-in/disable mid
  // synth, etc. The breaker stays OPEN with the SAME retryMs/breakerOpenedAt (unchanged),
  // so the cooldown has already elapsed and the very next span may probe again at once —
  // it just isn't treated as a failure (no doubling) since the endpoint was never actually
  // asked anything. A no-op unless `myProbe` is still the CURRENT probe: a stale/reclaimed
  // token (see tryBreaker's deadline backstop) must never touch a probe that replaced it.
  function releaseProbe(myProbe: number | null, reason: string) {
    if (!probing || myProbe === null || myProbe !== probeToken) return;
    probing = false;
    probeStartedAt = null;
    dbg(`circuit-breaker: probe #${myProbe} ${reason} before it could settle — breaker stays open, next span may probe again`);
  }

  // A success clears the circuit-breaker; if `myProbe` is still the current half-open
  // probe, it CLOSES the breaker outright (not just resets the counter) and voice resumes
  // from here on. A stale/reclaimed token (see tryBreaker) is ignored for that part — only
  // `synthFails` still resets, same as any ordinary success.
  function spanSucceeded(myProbe: number | null = null) {
    if (probing && myProbe !== null && myProbe === probeToken) {
      probing = false;
      probeStartedAt = null;
      breakerOpenedAt = null;
      retryMs = RETRY_MS_INITIAL;
      dbg(`circuit-breaker: endpoint recovered (probe #${myProbe})`);
    }
    synthFails = 0;
  }

  // A failed span is logged, never printed: console.* from inside a running TUI writes
  // straight over the frame. Failures go to the debug log and count toward the
  // circuit-breaker; a tripped breaker is visible in bare /simplesay status.
  function spanFailed(what: string, e: unknown, myProbe: number | null = null) {
    if (probing && myProbe !== null && myProbe === probeToken) {
      // The probe itself failed: re-open at once with the cooldown doubled (capped) —
      // no need to re-accumulate SYNTH_FAIL_LIMIT consecutive failures a second time.
      probing = false;
      probeStartedAt = null;
      breakerOpenedAt = __test.now();
      retryMs = Math.min(retryMs * 2, RETRY_MS_MAX);
      dbg(`circuit-breaker: probe #${myProbe} failed (${what}) via ${endpoint}: ${e} — re-opened, retry in ${Math.round(retryMs / 1000)}s`);
      return;
    }
    synthFails++;
    dbg(`span FAIL (${what}) via ${endpoint} (${synthFails}/${SYNTH_FAIL_LIMIT}): ${e}`);
    if (synthFails >= SYNTH_FAIL_LIMIT && breakerOpenedAt === null) {
      breakerOpenedAt = __test.now();
      retryMs = RETRY_MS_INITIAL;
      dbg(
        retryMs > 0
          ? `circuit-breaker: endpoint failed ${SYNTH_FAIL_LIMIT}x; voice paused for this session — will retry automatically in ${Math.round(retryMs / 1000)}s (or /simplesay enable now)`
          : `circuit-breaker: endpoint failed ${SYNTH_FAIL_LIMIT}x; voice paused for this session — fix the endpoint and /simplesay enable to retry`,
      );
    }
  }

  // The exact commands speech will run, shown when an endpoint is connected
  // (and in bare-status output) so a silent session can be debugged by running
  // the same command by hand. Evaluated at call time — follows /simplesay changes.
  const speakCmdPreview = () => {
    const call = `${endpoint}${agentFlag ? ` --agent ${agentName}` : ""} "<text>"`;
    return transport().direct
      ? `env -u SAY_OUT ${call}  (direct: one call per span, no --play; rc 0 = accepted, not proof of playback)`
      : `SAY_OUT=<tmp.wav> ${call}  ->  ${endpoint} --play <tmp.wav>`;
  };

  function stopSpeaking() {
    epoch++;
    muted = true;
    dbg(`barge-in: muted=true epoch=${epoch}`);
    abortCtl.abort();
    abortCtl = new AbortController();
    if (currentDirectCancel) currentDirectCancel(); // kills its group and settles the span
    if (currentPlayChild?.pid) {
      killGroup(currentPlayChild.pid, "barge-in");
      currentPlayChild = null;
    }
  }

  // Bounded termination of a child's whole process group: SIGTERM now, SIGKILL after a
  // short grace (SIMPLESAY_KILL_GRACE_MS, default 1 s) to whatever is still in the group —
  // a TERM-ignoring endpoint, or a TERM-ignoring descendant left behind by a wrapper that
  // did exit. The KILL goes to the group, so it lands even after the leader is gone.
  //
  // Teardown is also a queue BARRIER. A span's outcome (cancelled / timed out) is recorded
  // the moment it is terminated, but the next direct call or --play must not start while
  // the old group still exists — that would overlap two endpoint calls. Every teardown
  // joins `teardownBarrier`, which is global: it holds across cancellation,
  // disable/enable and the next reply.
  //
  // The barrier FAILS CLOSED. Only ESRCH proves a group is gone. Any other signal error
  // (EPERM, …) or a group still present at grace + SIMPLESAY_REAP_MS (default 500 ms)
  // is an UNCONFIRMED teardown: the pgid is recorded in `heldGroups`, which refuses every
  // further endpoint execution (queued spans settle as refused, new spans are refused at
  // once) until `/simplesay enable` re-probes and every held group returns ESRCH. The
  // barrier promise itself still resolves on time, so Pi's promise chains never hang.
  type Probe = "gone" | "present" | "unknown";
  const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? String(e);
  function signalGroup(pid: number, sig: NodeJS.Signals | 0): { r: Probe; code?: string } {
    try { __test.signal(-pid, sig); return { r: "present" }; }
    catch (e) { const code = errCode(e); return { r: code === "ESRCH" ? "gone" : "unknown", code }; }
  }
  const heldGroups = new Map<number, string>(); // pgid -> why its teardown is unconfirmed
  function holdTeardown(pid: number, reason: string) {
    heldGroups.set(pid, reason);
    dbg(`teardown FAILED (unconfirmed): group -${pid}: ${reason} — speech HELD; /simplesay enable re-probes`);
  }
  const heldSummary = () => [...heldGroups].map(([g, why]) => `-${g} (${why})`).join(", ");
  let teardownBarrier: Promise<void> = Promise.resolve();
  function killGroup(pid: number | undefined, why: string): Promise<void> {
    if (!pid) return Promise.resolve();
    const term = signalGroup(pid, "SIGTERM");
    if (term.r === "gone") return Promise.resolve();
    if (term.r === "unknown") { holdTeardown(pid, `SIGTERM failed: ${term.code} (${why})`); return Promise.resolve(); }
    const graceMs = Number(process.env.SIMPLESAY_KILL_GRACE_MS) || 1000;
    const reapMs = Number(process.env.SIMPLESAY_REAP_MS) || 500;
    const t0 = Date.now();
    const done = new Promise<void>((resolve) => {
      let killed = false;
      const tick = () => {
        const probe = signalGroup(pid, 0);
        if (probe.r === "gone") { dbg(`teardown: group -${pid} gone after ${Date.now() - t0}ms (${why})`); resolve(); return; }
        if (probe.r === "unknown") { holdTeardown(pid, `probe failed: ${probe.code} (${why})`); resolve(); return; }
        const elapsed = Date.now() - t0;
        if (!killed && elapsed >= graceMs) {
          killed = true;
          const k = signalGroup(pid, "SIGKILL");
          if (k.r === "unknown") { holdTeardown(pid, `SIGKILL failed: ${k.code} (${why})`); resolve(); return; }
          if (k.r === "present") dbg(`${why}: group -${pid} survived SIGTERM ${graceMs}ms; sent SIGKILL`);
        }
        if (elapsed >= graceMs + reapMs) {
          holdTeardown(pid, `still present ${elapsed}ms after SIGTERM, past grace + reap (${why})`);
          resolve();
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });
    teardownBarrier = Promise.all([teardownBarrier, done]).then(() => undefined);
    return done;
  }
  // Wait until every teardown started so far — including any started while waiting — is done.
  async function awaitTeardown(): Promise<void> {
    for (;;) {
      const b = teardownBarrier;
      await b;
      if (b === teardownBarrier) return;
    }
  }

  function reset() {
    acc = buf = para = direction = "";
    speaking = inFence = sawText = false;
    muted = false;
    dbg(`reset: muted=false`);
  }

  // Provider-agnostic: strip everything that reads badly aloud, leave plain prose.
  function clean(t: string): string {
    return t
      .replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ") // code blocks
      .replace(TAG_ANY_RE, "")                                         // say tags, with or without attributes
      .replace(/^\s*\|.*\|\s*$/gm, " ")                                // table rows
      .replace(/\$\$?([^$]*[\\^_][^$]*)\$\$?/g, " $1 ")                // unwrap $…$ math; leaves $5 currency
      .replace(/[A-Z]:\\[\w\\.-]+/g, " ")                               // Windows paths (before backslash removal)
      .replace(/\\(?:rightarrow|to|longrightarrow|Rightarrow|implies|mapsto)\b/g, " to ")
      .replace(/\\(?:leftarrow|gets|longleftarrow|Leftarrow)\b/g, " from ")
      .replace(/\\[a-zA-Z]+\*?/g, " ")                                 // other LaTeX commands
      .replace(/[{}\\^]/g, " ")                                        // stray braces/backslashes/carets
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")                  // [[wikilinks]]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")                       // [text](url), images
      .replace(/`([^`]*)`/g, "$1")                                     // inline code
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1") // **bold**/*italic*
      .replace(/__([^_]+)__/g, "$1")                                   // __bold__
      .replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, "$1")      // _italic_ (not file_name)
      .replace(/\*/g, " ")                                             // stray asterisks
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")                              // headers
      .replace(/^\s*[-*+]\s+/gm, "")                                   // bullets
      .replace(/^\s*>\s?/gm, "")                                       // blockquotes
      .replace(/https?:\/\/\S+/g, " ")                                 // bare URLs
      .replace(/(?:\.\/|\.\.\/)[\w/.-]+/g, " ")                         // relative paths (./file, ../file) - before Unix paths
      .replace(/(?:\/[\w.-]+){2,}/g, " ")                               // Unix file paths (2+ segments)
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Plays a WAV via the endpoint, keeping a handle to the child process so
  // stopSpeaking() can kill it mid-playback, and bounding it so a wedged
  // player can't orphan pi on quit.
  //
  // Spawn with `detached: true` + `stdio: 'ignore'` + `unref()` is what
  // ACTUALLY makes the child its own session/process-group leader (setsid).
  // execFile with `detached: true` alone does NOT — its child stays in pi's
  // process group, so `process.kill(-child.pid)` ESRCH's and the audio player
  // the wrapper shelled out to (aplay/paplay/pw-play) leaks. That was a latent
  // bug in stopSpeaking()'s barge-in too; switching the play child to a real
  // session leader fixes both — a negative-pid kill now reaches the whole
  // group, player included. `unref()` is the second orphan defence: the child
  // no longer keeps pi's event loop alive via stdio pipes, so pi can quit even
  // if the player hangs (the timeout + shutdown handler are the belt to this
  // suspender).
  //
  // `playTimeoutMs` is the hard bound: a wedged audio player (hung PipeWire,
  // absent device — accepts the file then never exits) would otherwise play
  // forever after pi quits. The timer kills the whole process group (negative
  // pid, like stopSpeaking). Override via SIMPLESAY_PLAY_TIMEOUT_MS.
  async function playWav(wav: string, myEpoch: number): Promise<void> {
    await awaitTeardown(); // never start a player while a killed one's group still exists
    return new Promise((resolve) => {
      if (myEpoch !== epoch) { resolve(); return; }
      if (heldGroups.size) { dbg(`play REFUSED (teardown unconfirmed: ${heldSummary()}): ${wav}`); resolve(); return; }
      const playTimeoutMs = Number(process.env.SIMPLESAY_PLAY_TIMEOUT_MS) || 120_000;
      const child = spawn(endpoint, ["--play", wav], { detached: true, stdio: "ignore" });
      child.unref();
      currentPlayChild = child;
      let killTimer: NodeJS.Timeout | undefined;
      let done = false;
      let timedOut = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        if (currentPlayChild === child) currentPlayChild = null;
        resolve();
      };
      // Termination reason beats the exit code: a player that exits 0 on SIGTERM after a
      // timeout or a cancellation (barge-in / disable / shutdown bump the epoch) did not play.
      child.on("exit", (code, signal) => {
        if (timedOut) dbg(`play FAIL: timed out after ${playTimeoutMs}ms (exit code=${code} signal=${signal})`);
        else if (myEpoch !== epoch) dbg(`receipt: cancelled (play) ${wav}`);
        else if (code === 0) dbg(`receipt: played ${wav}`);
        else dbg(`play FAIL: player exited code=${code} signal=${signal}`);
        finish();
      });
      child.on("error", (err) => {
        dbg(`play FAIL: ${err}`);
        finish();
      });
      killTimer = setTimeout(() => {
        if (currentPlayChild === child && child.pid) {
          dbg(`play TIMEOUT (${playTimeoutMs}ms): killing group -${child.pid}`);
          timedOut = true;
          killGroup(child.pid, "play timeout");
        }
      }, playTimeoutMs);
    });
  }

  // A beat of silence between spans, in playback order, dropped by barge-in like any utterance.
  function queuePause(ms: number) {
    if (!enabled || muted || ms <= 0) return;
    const myEpoch = epoch;
    dbg(`pause: ${ms}ms`);
    playChain = playChain.then(() => (myEpoch === epoch ? new Promise<void>((r) => setTimeout(r, ms)) : undefined));
  }

  // Direct transport: one ordered call per span, no SAY_OUT, no WAV, no --play. Spawned
  // as its own session leader like playWav and bounded by SIMPLESAY_DIRECT_TIMEOUT_MS
  // (default 120 s, since a local direct endpoint may play before it exits).
  // Settlement is deterministic: a timeout or a cancellation (barge-in / disable /
  // shutdown) group-kills the call (TERM, then KILL after the grace) and records the
  // outcome immediately. The termination reason wins over any later exit code: timeout =
  // failure (counts toward the breaker), cancellation = cancelled; neither is success and
  // neither resets the breaker. The NEXT call still waits at the teardown barrier until
  // the old group is gone (bounded by grace + reap margin), so calls never overlap.
  // rc 0 means the endpoint ACCEPTED the text — for a relay endpoint, accepted by the
  // relay's queue, never proof it was audibly played — so the receipt says "accepted".
  async function runDirect(
    args: string[],
    dirEnv: Record<string, string>,
    myEpoch: number,
    text: string,
    myProbe: number | null,
  ): Promise<void> {
    await awaitTeardown(); // the previous call's group must be gone before this one starts
    return new Promise((resolve) => {
      if (myEpoch !== epoch) {
        releaseProbe(myProbe, "cancelled before dispatch");
        dbg(`direct DROPPED (cancelled before dispatch): "${text.slice(0, 60)}"`);
        resolve();
        return;
      }
      if (heldGroups.size) {
        releaseProbe(myProbe, "refused (teardown unconfirmed) before dispatch");
        dbg(`direct REFUSED (teardown unconfirmed: ${heldSummary()}): "${text.slice(0, 60)}"`);
        resolve();
        return;
      }
      if (!enabled || !usableFor(myProbe)) {
        releaseProbe(myProbe, enabled ? "found unusable" : "disabled before dispatch");
        dbg(`direct DROPPED (${enabled ? "endpoint unusable" : "disabled"})`);
        resolve();
        return;
      }
      const env: NodeJS.ProcessEnv = { ...process.env, ...dirEnv };
      // Removed, not just not-added: an inherited SAY_OUT would tell a WAV-capable endpoint
      // to write a file that nothing will ever play.
      delete env.SAY_OUT;
      const timeoutMs = Number(process.env.SIMPLESAY_DIRECT_TIMEOUT_MS) || 120_000;
      let child: ChildProcess;
      try {
        child = spawn(endpoint, args, { detached: true, stdio: "ignore", env });
      } catch (e) { spanFailed("direct", e, myProbe); resolve(); return; }
      child.unref();
      currentPlayChild = child;
      let done = false;
      let killTimer: NodeJS.Timeout | undefined;
      type Outcome = { kind: "accepted" } | { kind: "failed"; why: string } | { kind: "cancelled" };
      const settle = (o: Outcome) => {
        if (done) return; // first outcome wins; a later exit (even rc 0) changes nothing
        done = true;
        if (killTimer) clearTimeout(killTimer);
        if (currentPlayChild === child) currentPlayChild = null;
        if (currentDirectCancel === cancel) currentDirectCancel = null;
        if (o.kind === "accepted") { spanSucceeded(myProbe); dbg(`receipt: accepted (direct) "${text.slice(0, 60)}"`); }
        else if (o.kind === "cancelled") {
          releaseProbe(myProbe, "cancelled");
          dbg(`direct cancelled (barge-in/disable/shutdown) — receipt: cancelled "${text.slice(0, 60)}"`);
        }
        else spanFailed("direct", o.why, myProbe);
        resolve();
      };
      const cancel = () => { killGroup(child.pid, "direct cancel"); settle({ kind: "cancelled" }); };
      currentDirectCancel = cancel;
      child.on("exit", (code, signal) =>
        settle(code === 0 ? { kind: "accepted" } : { kind: "failed", why: `exit code=${code} signal=${signal}` }));
      child.on("error", (err) => settle({ kind: "failed", why: String(err) }));
      killTimer = setTimeout(() => {
        dbg(`direct TIMEOUT (${timeoutMs}ms): killing group -${child.pid}`);
        killGroup(child.pid, "direct timeout");
        settle({ kind: "failed", why: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    });
  }

  function speak(raw: string, dir = "") {
    if (!enabled) { dbg(`speak DROPPED (disabled): ${raw.length}ch`); return; } // /simplesay disable — silence everything
    if (muted) { dbg(`speak DROPPED (muted): ${raw.length}ch`); return; } // interrupted mid-message; drop the rest silently
    if (heldGroups.size) { dbg(`speak REFUSED (teardown unconfirmed: ${heldSummary()}): ${raw.length}ch`); return; } // fail closed
    // Clean BEFORE the breaker gate: an empty-after-clean span (whitespace, a bare tag)
    // must never consume a probe grant — it was never going to reach the endpoint anyway.
    const text = clean(raw);
    if (!text || !endpoint) { dbg(`speak DROPPED (empty after clean): raw=${raw.length}ch`); return; }
    // The one decision point per span: closed -> always true; open -> true only for the
    // single span granted as the half-open probe (see tryBreaker/usableFor above).
    if (!tryBreaker()) {
      const why = preflightFailed ? "preflight failed" : probing ? "probe in flight" : "breaker open";
      dbg(`speak DROPPED (${why})`);
      return;
    }
    // Captured once, synchronously, right after a successful grant: null when the breaker
    // is closed (no probe involved), else the token identifying THIS span as the probe.
    // Threaded through to every place that can settle or abandon it (usableFor/
    // releaseProbe/spanSucceeded/spanFailed), so a stale/reclaimed probe can never close
    // or re-trip a breaker that has since moved on to a different one.
    const myProbe = probing ? probeToken : null;
    dbg(`speak: "${text.slice(0, 60)}"${dir ? ` [${dir}]` : ""}`);
    const myEpoch = epoch;
    // Direction rides as SAY_INSTRUCTION, the documented env contract; an
    // endpoint that does not know it simply speaks the words.
    const dirEnv = dir ? { SAY_INSTRUCTION: dir } : {};
    const args = agentFlag ? ["--agent", agentName, text] : [text];

    // Direct transport: queue on the playback chain itself, so spans dispatch strictly one
    // at a time in order (no synth-ahead), after anything already queued in either transport.
    if (transport().direct) {
      playChain = playChain
        .then(() => runDirect(args, dirEnv, myEpoch, text, myProbe))
        .catch((e) => { dbg(`direct chain error: ${e}`); releaseProbe(myProbe, "direct chain error"); });
      return;
    }

    const wav = `/tmp/simplesay-${process.pid}-${seq++}.wav`;
    const signal = abortCtl.signal;

    // Synthesize to a WAV ahead of playback (SAY_OUT skips the endpoint's play step).
    // `timeout` is load-bearing: if the endpoint hangs (wedged TTS server —
    // kokoro accepted connections but never answered, 2026-08-02), the synth
    // promise would never settle and this serial chain would silently block
    // EVERY later utterance for the rest of the session. Killing the child
    // surfaces an error to .catch, which logs and lets the queue move on.
    const synth = (synthChain = synthChain
      .then(() => {
        if (myEpoch !== epoch) { releaseProbe(myProbe, "cancelled before synth started"); return false; }
        // Breaker tripped while this span waited in the queue: don't invoke the endpoint.
        if (!usableFor(myProbe)) { dbg(`synth DROPPED (endpoint unusable): "${text.slice(0, 60)}"`); return false; }
        if (heldGroups.size) {
          releaseProbe(myProbe, "refused (teardown unconfirmed) before synth started");
          dbg(`synth REFUSED (teardown unconfirmed: ${heldSummary()}): "${text.slice(0, 60)}"`);
          return false;
        }
        return execFileAsync(endpoint, args, { env: { ...process.env, ...dirEnv, SAY_OUT: wav }, timeout: 90_000, signal })
          .then(() => {
            // rc 0 is not proof of audio: success needs a regular, non-empty WAV. An
            // endpoint that ignores SAY_OUT (spools or plays the text itself) fails
            // here instead of reaching --play; such endpoints belong on the direct transport.
            const st = statSync(wav, { throwIfNoEntry: false });
            if (!st || !st.isFile() || st.size === 0)
              throw new Error(`endpoint exited 0 but ${!st ? "wrote no" : !st.isFile() ? "wrote a non-regular" : "wrote an empty"} output file (SAY_OUT=${wav})`);
            spanSucceeded(myProbe); // a success clears the circuit-breaker (closes it if this was the probe)
            return true;
          });
      })
      .catch((e) => {
        // Degrade, don't spam: log and count toward the circuit-breaker, which pauses
        // voice for the session at the limit. Never console.* — see spanFailed.
        if (myEpoch !== epoch) { dbg(`synth cancelled (barge-in/disable/shutdown): ${e}`); releaseProbe(myProbe, "cancelled (synth aborted)"); }
        else spanFailed("synth", e, myProbe);
        return false;
      }));

    // Play in order once this utterance is ready, then clean up the WAV.
    playChain = playChain
      .then(() => synth)
      .then((ok) => ((ok && myEpoch === epoch) ? playWav(wav, myEpoch) : undefined))
      .catch((e) => dbg(`play chain error: ${e}`))
      .finally(() => unlink(wav, () => {}));
  }

  // tag mode: speak each <say …>…</say> span as one utterance once it closes; a self-closing
  // <say pause="…"/> queues silence. An opening tag may be long (attributes) and may arrive
  // split across deltas, so an unterminated "<say" is held until its ">" lands.
  function parseTags(final: boolean) {
    const tail = CLOSE.length - 1; // hold for a split closer
    for (;;) {
      if (!speaking) {
        const i = acc.search(/<say\b/);
        if (i < 0) { acc = final ? "" : acc.slice(-3); return; }
        // A tag in backticks is prose about the tag, not a span (an agent discussing the
        // feature will write "only `<say>` spans are heard").
        if (i > 0 && acc[i - 1] === "`") { acc = acc.slice(i + 4); continue; }
        const m = OPEN_RE.exec(acc.slice(i));
        if (!m) { if (final) { acc = ""; return; } acc = acc.slice(i); return; } // "<say …" without its ">" yet
        const attrs = parseAttrs(m[1]);
        acc = acc.slice(i + m[0].length);
        if (m[2] === "/") { queuePause(pauseMs(attrs)); continue; }   // <say pause="long"/>
        direction = instructionFor(attrs);
        speaking = true;
      } else {
        const j = acc.indexOf(CLOSE);
        if (j < 0) {
          const safe = final ? acc.length : Math.max(0, acc.length - tail);
          buf += acc.slice(0, safe);
          acc = acc.slice(safe);
          if (final && buf.trim()) { speak(buf, direction); buf = ""; speaking = false; direction = ""; }
          return;
        }
        buf += acc.slice(0, j);
        acc = acc.slice(j + CLOSE.length);
        if (buf.trim()) speak(buf, direction);
        buf = "";
        speaking = false;
        direction = "";
      }
    }
  }

  // Speaks complete sentences out of a buffer as soon as they finish, rather
  // than waiting for a blank-line paragraph break. Without this, a reply
  // that's one long unbroken paragraph (no internal newlines — the common
  // case for plain prose answers) never gets spoken until the ENTIRE message
  // finishes, since flushPara() below only fires on blank lines, fences, or
  // final. That's not just "not live" — combined with barge-in, if the user
  // types anything (e.g. to test interrupting) before that single end-of-
  // message flush happens, `muted` gets set first and the whole utterance is
  // silently dropped, looking like the reply was skipped entirely.
  // Only a punctuation mark followed by whitespace counts as a sentence end
  // (so "3.14" or an abbreviation mid-word doesn't false-trigger), and
  // whatever's left over keeps accumulating for the next pass.
  // Secondary boundary for long comma-spliced run-ons with no terminal
  // punctuation at all — without this fallback, a stretch of text can grow
  // unbounded waiting for a period that never comes (plain prose sometimes
  // just runs long on commas/dashes), reintroducing the exact "nothing gets
  // spoken until the whole message ends" problem this is meant to fix.
  const SENTENCE_END = /[.!?]["'\)\]]*\s/;
  const CLAUSE_BREAK = /[,;:\u2014\u2013-]\s/g;
  const MAX_BUFFER = 160; // chars
  function extractSentences(text: string): { spoken: string[]; rest: string } {
    const spoken: string[] = [];
    let rest = text;
    for (;;) {
      const m = SENTENCE_END.exec(rest);
      if (m) {
        const cut = m.index + m[0].length;
        spoken.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
        continue;
      }
      if (rest.length < MAX_BUFFER) break; // not long enough to force a cut yet
      const window = rest.slice(0, MAX_BUFFER);
      let cut = -1;
      for (const m2 of window.matchAll(CLAUSE_BREAK)) cut = m2.index + m2[0].length;
      if (cut < 0) {
        const lastSpace = window.lastIndexOf(" ");
        cut = lastSpace > 0 ? lastSpace + 1 : MAX_BUFFER;
      }
      spoken.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    return { spoken, rest };
  }

  // stream mode: emit a paragraph (blank-line delimited) once complete, skipping
  // fenced code, table rows, and non-prose lines. Also speaks complete
  // sentences progressively within a paragraph — see extractSentences above.
  function parseStream(final: boolean) {
    let chunk: string;
    if (final) { chunk = acc; acc = ""; }
    else {
      const nl = acc.lastIndexOf("\n");
      if (nl < 0) {
        // No complete line yet — this is the case that used to buffer
        // silently for an entire unbroken paragraph. Speak what we can.
        if (!inFence) {
          const { spoken, rest } = extractSentences(acc);
          for (const s of spoken) if (s && /[A-Za-z]/.test(s)) speak(s);
          acc = rest;
        }
        return;
      }
      chunk = acc.slice(0, nl + 1);
      acc = acc.slice(nl + 1);
    }
    const lines = chunk.split("\n");
    if (chunk.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; flushPara(); continue; }
      if (inFence) continue;
      if (line.trim() === "") { flushPara(); continue; }
      const s = line.trim();
      if ((s.startsWith("|") && s.endsWith("|")) || !/[A-Za-z]/.test(s)) continue; // tables, symbol soup
      para += (para ? " " : "") + s;
    }
    if (!final && !inFence) {
      const { spoken, rest } = extractSentences(para);
      for (const s of spoken) if (s && /[A-Za-z]/.test(s)) speak(s);
      para = rest;
    }
    if (final) flushPara();
  }

  function flushPara() {
    if (para.trim()) speak(para);
    para = "";
  }

  const textOf = (m: any): string =>
    m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");

  // Barge-in: install the interrupt-on-type editor once the TUI is up.
  // Guarded by ctx.mode so RPC/JSON/print runs (no terminal editor) skip it.
  // Also guard against session_start re-firing on a model change: without this,
  // each re-fire wraps the previous SimpleSayEditor again, nesting wrappers.
  let editorInstalled = false;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || editorInstalled) return;
    editorInstalled = true;
    const previousFactory = ctx.ui.getEditorComponent?.();
    ctx.ui.setEditorComponent?.((tui, theme, keybindings) => {
      const base = previousFactory?.(tui, theme, keybindings) as any;
      return new SimpleSayEditor(tui, theme, keybindings, stopSpeaking, base);
    });
  });

  pi.registerCommand("simplesay", {
    description: "SimpleSay voice: /simplesay (status) | /simplesay enable|disable | /simplesay mode <tag|stream> | /simplesay output [local|server] | /simplesay direct <on|off> | /simplesay <agent> <endpoint> [--no-agent]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      // Bare command: report current state instead of erroring.
      if (parts.length === 0) {
        ctx.ui.notify(
          `SimpleSay: ${enabled ? "enabled" : "DISABLED"}, mode=${mode}, output=${outputLabel()}, transport=${transportLabel()}, agent='${agentName}', endpoint='${endpoint}'${agentFlag ? "" : " (no --agent)"}${breakerStatusNote()}${heldGroups.size ? ` (speech HELD: teardown unconfirmed for group ${heldSummary()}; /simplesay enable re-probes)` : ""}, config=${configFile}`,
          "info",
        );
        ctx.ui.notify(`Speak runs: ${speakCmdPreview()}`, "info");
        return;
      }

      if (parts[0] === "mode") {
        const m = parts[1];
        if (m !== "tag" && m !== "stream") {
          ctx.ui.notify("Usage: /simplesay mode <tag|stream>", "error");
          return;
        }
        mode = m;
        saveConfig(); // persists across sessions
        ctx.ui.notify(`SimpleSay mode: ${mode} (saved)`, "info");
        return;
      }

      // Where the voice plays, in user terms: local = the WAV transport (this device plays
      // it), server = the direct transport (the endpoint/server plays it; nothing returns).
      // An alias over the same saved `direct` setting; SIMPLESAY_DIRECT still overrides it.
      if (parts[0] === "output") {
        const v = parts[1];
        if (v === undefined) {
          const t = transport();
          ctx.ui.notify(
            `SimpleSay output: ${outputLabel()} — ${t.direct ? "the endpoint/server plays the audio; nothing comes back" : "audio is played on this device"}${envOverrideNote()}`,
            "info",
          );
          return;
        }
        if (v !== "local" && v !== "server") {
          ctx.ui.notify(`Usage: /simplesay output [local|server]  (now: output=${outputLabel()})`, "error");
          return;
        }
        directSetting = v === "server";
        saveConfig();
        ctx.ui.notify(`SimpleSay output: ${v} (saved); in effect: output=${outputLabel()}${envOverrideNote()}`, "info");
        return;
      }

      // Transport switch. Saved like mode; SIMPLESAY_DIRECT (1/0) still overrides it.
      if (parts[0] === "direct") {
        const v = parts[1];
        if (v !== "on" && v !== "off") {
          ctx.ui.notify(`Usage: /simplesay direct <on|off>  (now: transport=${transportLabel()})`, "error");
          return;
        }
        directSetting = v === "on";
        saveConfig();
        const t = transport();
        ctx.ui.notify(
          `SimpleSay direct transport: ${v} (saved); in effect: transport=${transportLabel()}${t.source === "env" ? " — SIMPLESAY_DIRECT overrides the setting" : ""}`,
          "info",
        );
        return;
      }

      // Master switch, on aliases included so /simplesay on/off do the
      // obvious thing too. Toggling back on re-arms immediately — the next
      // assistant message speaks normally.
      if (parts[0] === "enable" || parts[0] === "on" || parts[0] === "disable" || parts[0] === "off") {
        const turningOn = parts[0] === "enable" || parts[0] === "on";
        // A held (unconfirmed) teardown is cleared only by proof: re-probe every recorded
        // group; each must now return ESRCH. Anything else keeps speech held.
        if (turningOn && heldGroups.size) {
          for (const g of [...heldGroups.keys()]) {
            const probe = signalGroup(g, 0);
            if (probe.r === "gone") { heldGroups.delete(g); dbg(`teardown confirmed on re-probe: group -${g} gone (ESRCH)`); }
            else heldGroups.set(g, probe.r === "present" ? "still exists on re-probe" : `re-probe failed: ${probe.code}`);
          }
          if (heldGroups.size) {
            dbg(`enable refused: teardown still unconfirmed: ${heldSummary()}`);
            ctx.ui.notify(`SimpleSay still HELD: teardown unconfirmed for group ${heldSummary()}. Speech stays off until that group is gone; retry /simplesay enable.`, "error");
            return;
          }
          ctx.ui.notify("SimpleSay: previously unconfirmed teardown now confirmed (group gone); speech released", "info");
        }
        enabled = turningOn;
        if (enabled) {
          // Force-close the breaker right now, regardless of cooldown — /simplesay
          // enable is always an immediate retry, by spec — and re-run preflight in
          // case the endpoint path itself was the thing that got fixed.
          synthFails = 0;
          probing = false;
          breakerOpenedAt = null;
          retryMs = RETRY_MS_INITIAL;
          preflightFailed = !checkEndpoint();
        }
        saveConfig(); // persists across sessions
        if (!enabled) stopSpeaking(); // cut off anything playing/queued right now
        ctx.ui.notify(`SimpleSay ${enabled ? "enabled" : "disabled"} (saved)`, "info");
        return;
      }

      if (parts.length < 2) {
        ctx.ui.notify("Usage: /simplesay [enable|disable | mode <tag|stream> | output [local|server] | direct <on|off> | <agent> <endpoint> [--no-agent]]", "error");
        return;
      }
      const [a, ep] = parts;
      try {
        await execFileAsync("test", ["-x", ep]);
      } catch {
        ctx.ui.notify(`Endpoint not executable: ${ep}`, "error");
        return;
      }
      agentName = a;
      endpoint = ep;
      agentFlag = !parts.includes("--no-agent");
      ctx.ui.notify(`SimpleSay: agent='${agentName}', endpoint='${endpoint}'`, "info");
      ctx.ui.notify(`Speak runs: ${speakCmdPreview()}`, "info");
    },
  });

  // Reset on pi's message_start, which fires for EVERY assistant message,
  // instead of relying on the provider stream's "start" event. Root cause of
  // a total-silence bug: if the stream's start event never arrives (provider
  // quirk, non-streaming path), the user's own typing sets muted=true and the
  // ENTIRE reply is silently dropped at message_end. Barge-in still works:
  // typing mid-stream re-mutes after this reset.
  pi.on("message_start", (event) => {
    if ((event.message as any).role === "assistant") reset();
  });

  pi.on("message_update", async (event) => {
    const a: any = (event as any).assistantMessageEvent;
    if (!a) { dbg("message_update with no assistantMessageEvent"); return; }
    if (a.type === "start") { reset(); return; }
    if (a.type !== "text_delta") dbg(`stream event: ${a.type}`);
    if (a.type === "text_delta" && typeof a.delta === "string") {
      sawText = true;
      acc += a.delta;
      mode === "tag" ? parseTags(false) : parseStream(false);
    }
  });

  pi.on("message_end", async (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    if (!sawText) acc = textOf(msg); // provider didn't stream — use final text

    if (mode === "stream") {
      parseStream(true);
      reset();
      return;
    }

    parseTags(true);
    reset();

    // Strip <say> tags from the displayed message (keep the inner text).
    const tagged = msg.content.some(
      (c: any) => c.type === "text" && /<say(?:\s[^<>]*?)?\s*\/?>|<\/say>/.test(c.text),
    );
    if (!tagged) return;
    const content = msg.content.map((c: any) =>
      c.type === "text"
        ? { ...c, text: c.text.replace(TAG_ANY_RE, "").replace(/[ \t]{2,}/g, " ") }
        : c,
    );
    return { message: { ...msg, content } };
  });

  // Kill any in-flight playback on shutdown so a detached, wedged audio child
  // can't hold pi's event loop alive after the session ends (the playWav
  // timeout is the hard bound; this is the courtesy flush that ends cleanly).
  // Bounded at 5 s by pi's session_shutdown cap (0.84.2+fortshady.1);
  // stopSpeaking is synchronous and well within that.
  pi.on("session_shutdown", async () => {
    stopSpeaking();
  });
}
