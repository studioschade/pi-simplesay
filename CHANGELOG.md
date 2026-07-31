# Changelog

## Unreleased — README redesign (2026-07-14)

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
