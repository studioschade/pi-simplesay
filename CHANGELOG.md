# Changelog

## 0.6.0 — 2026-10-01

Circuit breaker retries automatically.

- **Half-open auto-retry for the circuit breaker.** A RUNTIME trip (SYNTH_FAIL_LIMIT
  consecutive synth/direct failures) no longer pauses voice for the rest of the session.
  Once `retryMs` has elapsed since the trip (default 60 s), the next span to arrive is let
  through as a single half-open probe. Success closes the breaker outright — `synthFails`
  resets and voice resumes — and logs `circuit-breaker: endpoint recovered`. Failure
  re-opens it with the cooldown doubled, capped at 15 minutes by default. This is checked
  lazily, only when a span actually arrives; no timer runs on its own and nothing keeps the
  process alive. Applies to both transports (WAV and direct), since both funnel through the
  same breaker.
- **`SIMPLESAY_RETRY_MS`** sets the initial cooldown in ms (default `60000`); `0` disables
  auto-retry entirely (the pre-0.6.0 behaviour — only `/simplesay enable` reopens it).
  **`SIMPLESAY_RETRY_MAX_MS`** caps the doubling (default `900000`, 15 min).
- **A config error never auto-retries.** A missing or non-executable endpoint (the
  preflight check) is a config problem, not a transient one — fixing a typo in
  `SIMPLESAY_ENDPOINT` is the only way back, so it stays paused no matter how long the
  process runs, same as before. Only a RUNTIME failure (a present endpoint that fails to
  synthesize or exits non-zero) is eligible for auto-retry.
- **Only one probe in flight.** While a half-open probe is outstanding, every other span is
  dropped — same as a fully open breaker — rather than queued for later; a span that
  arrives during the open period is lost, not replayed once the breaker recovers.
- **`/simplesay enable` still force-closes immediately**, bypassing any cooldown, and is a
  full close rather than a single-shot probe (every span right after it speaks, not just
  the first). The trip message now says voice is paused and will retry automatically in
  N seconds, or that `/simplesay enable` retries right away. Bare `/simplesay` shows the
  breaker state while open, e.g. `(voice PAUSED: breaker open, retry in 42s; /simplesay
  enable retries now)`.
- **A granted probe can never wedge the breaker open.** Every path that can abandon a
  half-open probe without a verdict — an empty-after-clean span (now checked before the
  probe is even granted), barge-in/disable/shutdown cancelling it before or during
  dispatch, a refused-by-teardown guard, a direct call settling as `cancelled` — explicitly
  releases it (`breaker stays open, next span may probe again`, no backoff, not counted as
  a failure) instead of leaving `probing` stuck true. Each probe also carries its own token,
  so a stale one can never close or re-trip a breaker a newer probe has since moved past. As
  a backstop for anything not explicitly covered, a probe that's been outstanding longer
  than any legitimate synth/direct call could take is declared lost and the next span is
  granted a new probe in its place.

## 0.5.0 — 2026-10-01

A declared **direct transport** for endpoints that cannot write a WAV, WAV success that
means a WAV exists, and a plain-language switch for where the voice plays.

- **`/simplesay output local|server`.** Chooses where the voice comes out, in user terms:
  `local` plays the endpoint's WAV on this device (the WAV transport), `server` hands each
  span to the endpoint, which plays it wherever it plays, with nothing returned (the
  direct transport). `/simplesay output` alone shows the current output and its source
  (`env`, `setting` or `default`). It is an alias over the same saved `direct` setting, so
  no new config key and no change for existing users; `/simplesay direct on|off` keeps
  working, and `SIMPLESAY_DIRECT` still overrides both (the command says so when it does).
  Bare `/simplesay` now shows `output=local|server (<source>)` next to `transport=`.
- **`examples/endpoint-remote-ssh.sh`.** A generic endpoint for TTS that runs on another
  machine over SSH. `local`: pipes the text (and an optional `#instruction <tone>` line)
  to `ssh $SIMPLESAY_REMOTE_HOST $SIMPLESAY_REMOTE_CMD`, writes the returned WAV to
  `SAY_OUT` via a `.part` file (empty or failed = non-zero), and plays `--play <wav>` with
  the first of pw-play / paplay / aplay / afplay. `server`: runs the remote command with a
  play-here flag (`--play-here` by convention, `SIMPLESAY_REMOTE_PLAY_FLAG` to change it).

- **WAV success requires a WAV.** In the default transport a span succeeds only if the
  endpoint leaves a regular, non-empty file at `SAY_OUT`. Exit 0 with a missing or empty
  file is a failed span: it never reaches `--play` and counts toward the circuit-breaker.
  (Found with a sandboxed endpoint that hands the text to a relay, ignores `SAY_OUT`,
  and exits 0 — the later `--play` then failed.)
- **Direct transport (opt-in).** `SIMPLESAY_DIRECT=1` or `/simplesay direct on`: one
  ordered `<endpoint> [--agent <name>] "<text>"` call per span, no synth-ahead, no temp
  WAV, no `--play`; an inherited `SAY_OUT` is removed from the child env; agent args and
  `SAY_INSTRUCTION` are unchanged. `SIMPLESAY_DIRECT=0` overrides a saved `direct: true`;
  unset uses the saved setting, default off. The setting persists alongside mode/enabled.
  Bare `/simplesay` shows `transport=<wav|direct> (<env|setting|default>)`.
- **Honest receipts.** Direct calls log `receipt: accepted (direct)`, never `played`; for a
  relay endpoint that means accepted by the relay's queue.
- **Bounded cancellation.** Direct calls run as their own process group, bounded by
  `SIMPLESAY_DIRECT_TIMEOUT_MS` (default 120 s). Timeout, barge-in, disable and shutdown
  send the group SIGTERM, then SIGKILL after `SIMPLESAY_KILL_GRACE_MS` (default 1 s), so
  a TERM-ignoring endpoint, or a TERM-ignoring descendant of a wrapper that exited, cannot
  survive. The outcome is recorded immediately, but calls never overlap: the next direct
  call or `--play` waits at a teardown barrier until the old process group is gone,
  bounded by the grace plus `SIMPLESAY_REAP_MS` (default 500 ms). The barrier holds across
  cancellation, disable/enable and the next reply. The play-timeout and barge-in kills of
  the WAV player use the same escalation and barrier. In the WAV transport barge-in /
  disable / shutdown now also abort an in-flight synth wrapper (it was left to run out its
  90 s timeout).
- **Teardown fails closed.** Only `ESRCH` counts as a gone process group. A signal error
  other than `ESRCH` (e.g. `EPERM`), or a group still present at grace + reap, is an
  unconfirmed teardown: it logs `teardown FAILED (unconfirmed)`, latches a held state
  (queued spans settle as refused, new spans refused at once, both transports), and shows
  `speech HELD` in bare `/simplesay` status. `/simplesay enable` re-probes the recorded
  groups and releases only when every one returns `ESRCH`; otherwise it stays held and
  says why. Confirmed teardown keeps the bounded-progress behaviour; shutdown still kills
  without waiting. Group signals go through an exported `__test.signal` seam (production
  still calls `process.kill`) so tests can inject faults.
- **Termination beats the exit code.** A timed-out direct call is a failure (counts toward
  the breaker) and a cancelled one gets a `cancelled` receipt, even if the endpoint then
  exits 0 on SIGTERM; neither is `accepted` and neither resets the breaker. Same for the
  WAV player: exit 0 after a timeout is `play FAIL: timed out`, after barge-in / disable /
  shutdown it is `receipt: cancelled (play)`; only an uninterrupted exit 0 is `played`.
- **Breaker checked at dispatch (pre-existing gap).** A span queued before the breaker
  tripped no longer invokes the endpoint once it has: eight prequeued failing WAV spans
  with limit 3 now make exactly three calls (previously all eight, while status said
  PAUSED). Same check on the direct path.
- **Span failures no longer print to the terminal.** The synth/play `console.warn` /
  `console.error` paths now write to the debug log only; a tripped circuit-breaker shows
  as `voice PAUSED` in bare `/simplesay` status. (Whether those prints caused ghost
  lines seen in a Pi TUI is unconfirmed; this removes them either way.) The
  load-time "endpoint not found" preflight warning is unchanged.
- Tests (157 total, offline). Output toggle (17 new): `output server` persists
  `direct: true` and the next span is exactly one endpoint call with no `--play`; `output
  local` persists `direct: false` and uses synth + `--play`; bare `output` reports value
  and source; the env override is reported; bad values are refused.
- Tests for the direct transport and teardown (118 new at the time, offline): rc 0 with missing and with empty WAV; inherited `SAY_OUT` not
  reaching a direct child; one call per span and zero `--play`; strict ordering;
  precedence env 1 / env 0 / setting / default and persistence across mode/enable saves;
  shutdown, disable and timeout cancellation with no leftover child; synth abort on
  shutdown; independent review cases (a TERM-ignoring endpoint and a TERM-ignoring grandchild
  of an exiting wrapper, each on timeout, shutdown, disable/enable + new reply and
  barge-in + new reply: nothing survives, the next call never overlaps the old group and
  still starts within timeout + grace + reap; an exit-0-on-TERM endpoint yielding
  failure/cancellation, never accepted; an exit-0-on-TERM player on disable, barge-in and
  timeout, never `played`; N > limit prequeued failing spans making exactly `limit` calls,
  both transports; fault injection (EPERM on the old group, and a reap deadline exhausted
  with the group present) on both transports: the next call never starts, queued spans are
  refused, status shows HELD, enable stays held while the fault or the group persists,
  clears on ESRCH, and speech resumes). These prove the endpoint/queue contract only, not TUI rendering.
- **Known limitation, not fixed:** WAV synthesis is not run as a process group. Its 90 s
  timeout and the new abort terminate the endpoint wrapper only; a descendant the wrapper
  started can survive it, and SimpleSay does not bound that survivor.

## 0.4.0 — 2026-09-07

Direction attributes on the say tag (the speech-tag standard shared with claude-simplesay).

- **`<say tone="…">`** passes the span's delivery to the endpoint as `SAY_INSTRUCTION`;
  **`at="word: delivery"`** folds a mid-span shift into it. Endpoints that ignore the
  variable speak the words unchanged.
- **`<say pause="short|long|<s>"/>`** queues a beat of silence between spans, in playback
  order, dropped by barge-in like any utterance.
- Opening tags may be long and may arrive split across deltas; an unterminated `<say` is
  held until its `>` lands.
- A `<say>` inside backticks in prose is text about the tag, not a span.
- Attribute-bearing tags are stripped from the transcript at `message_end` like bare ones.
- Tests: tone/at through the endpoint, split opening tag, pause timing, backtick guard.

## 0.3.2 — 2026-08-30

Resilience: a speech failure must never crash or spam the agent.

- **Endpoint preflight.** On load, check the endpoint exists and is executable
  (`accessSync X_OK`). If not, voice is disabled for the session with ONE clear
  warning instead of erroring on every utterance.
- **Synth circuit-breaker.** A present-but-failing endpoint (unreachable TTS
  server, wrong host — the 2026-08-30 "kokoro on core, not halo" crash) now
  warns up to `SIMPLESAY_FAIL_LIMIT` (default 3) consecutive failures, then
  pauses voice for the session. A success resets the counter; `/simplesay
  enable` re-preflights and re-arms it.
- **Quieter failures.** The raw `Command failed: …<full spoken text>` dump is
  replaced by a concise, actionable warning.
- Regression test: a missing endpoint degrades to silence with exactly one
  warning, never a crash.

## 0.3.1 — 2026-08-16

Orphan-prevention hardening on the play path, surfaced during a six-hour pi
orphan investigation (the orphan's actual trigger is still OPEN — this fix
closes a real bug of the same class, not the trigger itself).

- **Bounded playback with a timeout + process-group kill.** `playWav` spawned
  the audio player via `execFile(..., { detached: true })` with no timeout, so a
  wedged player (hung PipeWire, absent device — accepts the file then never
  exits) held pi's event loop alive indefinitely via the child's stdio pipes —
  the same orphan class as a blocking `session_shutdown` handler, on the play
  path. Now a timer kills the whole process group (negative pid, like
  `stopSpeaking`) after `SIMPLESAY_PLAY_TIMEOUT_MS` (default 120 s; overridable
  so a long-utterance setup can tune it). The synth path was already bounded
  (90 s `execFile` timeout + `curl --max-time 60` in the endpoint).
- **Fixed the play child actually becoming a session leader (latent barge-in
  bug).** `execFile` with `detached: true` does NOT call `setsid()` — the child
  stays in pi's process group, so `process.kill(-child.pid)` ESRCH's and the
  audio player the wrapper shelled out to leaks. `stopSpeaking()`'s
  interrupt-on-type relied on that same negative-pid group kill, so barge-in
  only "worked" because real utterances are short enough to end on their own;
  a long/hung utterance would have kept playing after the user typed. Switched
  `playWav` to `spawn({ detached: true, stdio: 'ignore' })` + `unref()`, which
  really does `setsid()` — now the group kill reaches the player, and `unref()`
  means a wedged child no longer holds pi's event loop at all (timeout +
  shutdown handler are belt to that suspender).
- **Added a `session_shutdown` handler that calls `stopSpeaking()`.** Kills any
  in-flight playback on quit so a detached audio child can't outlive the
  session. The playWav timeout is the hard bound; this is the courtesy flush
  that ends cleanly. Bounded at 5 s by pi's `session_shutdown` cap
  (`0.84.2+fortshady.1`); `stopSpeaking` is synchronous and well within that.

## 0.3.0 — 2026-08-02

Found and fixed during a live total-silence incident (kokoro TTS server wedge
plus two extension bugs it exposed); every fix verified against the running
session's debug trace.

- **Fixed total-silence bug: speech state now re-arms on pi's `message_start`
  event instead of the provider stream's `start` event.** Providers that never
  emit a stream `start` (observed with a Kimi/Code Fireworks setup: only
  thinking/tool/text deltas arrive) left the interrupt-on-type `muted` flag
  stuck after the user's own typing, so every reply was silently dropped at
  `message_end` — no audio in any mode with a perfectly healthy TTS server.
  Barge-in behavior is unchanged (typing mid-stream still mutes the rest).
- **Fixed a permanent pipeline stall: synthesis now has a 90s timeout.** A
  hung endpoint previously blocked the serial synth chain forever, silently
  killing all speech for the rest of the session; now it skips one utterance
  and the queue moves on. (Paired with a `--max-time` in `examples/endpoint.sh`
  so a wedged kokoro server fails fast instead of hanging.)
- **Added a master on/off switch: `/simplesay disable` / `/simplesay enable`
  (`on`/`off` also accepted).** Disabled silences all speech — anything playing
  is cut off immediately and nothing new queues — without uninstalling the
  extension or changing mode. The state persists across sessions alongside
  mode in the config file; a bare `/simplesay` shows it as the first field.
- **Mode persists across sessions** in `~/.pi/agent/simplesay.json`
  (relocatable via `SIMPLESAY_CONFIG`, which the test suite uses so it never
  touches the real file).
- **Bare `/simplesay` now reports current settings** (mode, agent, endpoint,
  config path) instead of showing a usage error. Connecting an endpoint (and the
  bare status) also prints the exact synth/play commands speech will run, so a
  silent session can be debugged by running the same command by hand.
- **Added `examples/voice-manager.sh`** — piper voice management
  (list/download/set), adopted from Alex's Raspberry Pi voice-box setup with
  fixes from that review: `set` edits `tts.conf` (not `endpoint.sh`) and writes
  the bare voice id (not a path), and a voice only counts as installed with both
  `.onnx` and `.onnx.json` present.
- **Debug tracing** (`SIMPLESAY_DEBUG`): one line per pipeline decision —
  events seen, utterances spoken or dropped and why, synth failures — so a
  silent session shows exactly where speech died.

## 0.2.0 — 2026-08-02

- Renamed the npm package to `pi-simplesay` for pi ecosystem consistency and to
  avoid bare-name collisions; command stays `/simplesay`.
- Packaged like a proper pi plugin: `files` allowlist, `npm test`, GitHub
  Actions CI, and a self-test that drives stream/tag modes through a fake
  speech endpoint (no audio played).
- Fixed a model-change re-arm bug: `session_start` no longer nests the
  interrupt-on-type editor wrapper each time it re-fires.

## README redesign (2026-07-14)

Same `beautify-github-readme` pass as simplecontext (Zulip #Builds > SimpleContext,
Allen approved 2026-07-14), applied to this already-published repo.

- **New `assets/readme/hero.svg`** — the real differentiator (speaks on the first
  sentence while still streaming, vs. typical TTS waiting for the full reply) as an
  actual before/after timeline, not a mockup screenshot.
- **New `assets/readme/pipeline.svg`** — the real `message_update` → parser →
  `clean()` → `execFile()` dispatch chain (incl. the synth-ahead-of-playback detail),
  visualizing the existing "How it works" bullet list rather than replacing it.
- Distinct visual identity from simplecontext's redesign (warm amber/coral accent vs.
  indigo/mint, a timeline motif vs. a branching-decision motif) — same near-black
  background and typography system so the two studioschade repos read as siblings,
  not identical templates forced onto different projects.
- **Reordered, not rewritten**: `Install / run` moved up ahead of `How it works` (first
  use before mechanism deep-dive); all existing prose preserved as-is.
- Verified: `python3 scripts/audit_readme.py README.md` clean, both SVGs rendered and
  visually inspected — caught and fixed one real clipping bug (hero's "first sentence
  already speaking…" text partly unreadable where it crossed a color transition).
- **Not pushed** — this repo is already public/live, so this needs an explicit go before
  anything touches it, not just a default "safe to land." Generated and locally reviewed
  only; posted to Zulip #Builds > SimpleContext for approval.

- **Fixed: long unbroken paragraphs (no internal line breaks) went silent
  entirely instead of speaking.** `stream` mode used to only flush on a
  blank line, a fence, or the final chunk — so one long paragraph (or a
  comma-spliced run-on with no periods at all) buffered until the whole
  message finished, then spoke as a single utterance. Combined with
  barge-in, if the user typed anything before that one flush happened,
  `muted` got set first and the entire reply silently vanished — it looked
  like content was being skipped, not delayed. Fixed by speaking complete
  sentences as they arrive (`extractSentences`), with a length-based
  fallback (cuts at the last comma/dash, or word boundary, past ~160 chars)
  for text that never hits a period at all. Verified with a harness that
  streams deltas through the real extension code and confirms multiple
  utterances fire progressively, and that a mid-stream keystroke now cuts
  off partway through instead of before-anything-plays or after-everything.
- **`kokoro` TTS provider** added to `examples/endpoint.sh` /
  `examples/tts.conf`: hits a resident Kokoro server's OpenAI-compatible
  `/v1/audio/speech` endpoint (default `http://127.0.0.1:7790`). Needs
  `curl` + `python3` (python3 only used to JSON-escape text safely, no
  other dependency). Config: `KOKORO_URL`, `KOKORO_MODEL`, `KOKORO_VOICE`.
- **Barge-in: typing interrupts speech.** Any keystroke in the pi editor
  now stops audio immediately — kills the in-flight player process (by
  process group, so it reaches the actual `aplay`/`paplay`/`pw-play` under
  the endpoint script, not just the wrapper) and drops any already-queued
  but unplayed utterances from the current message. Lets you keep typing
  over a long reply you don't need to hear out. Speech resumes normally on
  the next assistant message. Installed via a thin `CustomEditor` wrapper
  that composes with any editor another extension may have already set
  (e.g. vim mode) — no config needed, no-ops outside the TUI (RPC/print/JSON).

## 0.1.0 — 2026-06-21

Initial version.

- **Two speech modes**, both live (speech starts while the reply is still
  streaming), selectable at runtime via `/simplesay mode <tag|stream>`:
  - `tag` — the agent wraps spoken text in `<say>…</say>`; each span is
    spoken as one utterance when its closing tag arrives, then stripped
    from the displayed message at `message_end` (inner text kept).
  - `stream` — no tags required. The reply is spoken paragraph by
    paragraph (blank-line delimited) as it streams; fenced code blocks,
    table rows, and other non-prose lines are skipped automatically.
- **Provider-agnostic endpoint contract**: `<endpoint> [--agent <name>]
  "<text>"`. The extension does all structural text cleanup and owns
  nothing about synthesis — any script matching the contract works,
  whether it wraps a cloud TTS API, Kokoro, or `espeak`.
- **Synth-ahead pipelining**: each utterance renders to a temp WAV
  (`SAY_OUT=<wav>`) while the previous one still plays, then plays in
  order via `--play <wav>` — no dead air between utterances. An endpoint
  without those flags still works, just without the pipelining.
- **`clean()` text normalizer**: strips code blocks/spans, tables, `<say>`
  tags, headers, emphasis markers, links/images/bare URLs, wikilinks,
  blockquotes, bullets, and emoji; collapses whitespace; preserves
  identifiers like `file_name` so they aren't mangled before reaching the
  endpoint.
- **Safe dispatch**: `execFile(endpoint, …)` — no shell involved, so
  backticks, `$(…)`, or quotes inside a reply can't break or execute
  anything on the way to the speech endpoint.
- `examples/endpoint.sh` — a minimal cross-platform reference endpoint
  (`say` / `espeak` / `spd-say`) so the extension is speech-ready without
  any particular TTS stack installed.
- Runtime configuration commands: `/simplesay mode <tag|stream>` and
  `/simplesay <agent> <endpoint> [--no-agent]`. Defaults are hardcoded
  since Pi has no persistent config store, so voice works immediately on
  load without any setup.
