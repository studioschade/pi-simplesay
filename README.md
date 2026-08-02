<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="SimpleSay — a pi extension that speaks an agent's reply live while it is still streaming, instead of waiting for the full response to finish generating before speech starts.">
</p>

[Pi](https://pi.dev) is a terminal coding agent that supports extensions, small TypeScript/JavaScript modules that hook into its lifecycle to add commands, tools, and behavior. SimpleSay is one such extension: it voices an agent's replies automatically by watching the response stream.

## Why this is different

Most voice systems, including ones from large AI companies, wait for the
entire response to finish generating before speech starts. SimpleSay speaks
**live, while the model is still writing**: the first paragraph or `<say>`
span is already playing back before the reply is done streaming. No
waiting on a full response, no separate "now read this back" pass.

It also decides what's worth saying **without spending any tokens on the
decision**. `stream` mode's skip logic (code blocks, tables, non-prose) is
plain text parsing over the streamed output as it arrives. It is not a model
call, not a tool the LLM has to remember to invoke, and nothing added to
the context window to make it happen. The model just writes normally; the
extension decides what's speech-worthy for free, out-of-band.

`tag` mode goes a step further: instead of relying on tool-calling to
trigger speech, which routinely fails on smaller local models that miss
or malform tool calls, the agent just wraps text it wants spoken in
`<say>…</say>`. Plain text markers are far more reliable than a structured
tool call for a small model, and they give you direct, fine-grained control
over phrasing and tone in the prompt itself, right down to models that
couldn't reliably drive a `say` tool at all.

Underneath both modes it's a deliberately small, unopinionated tool: no
bundled TTS engine, no required cloud service, just a documented shell-out
contract. Point it at anything, whether a local model, a cloud voice API, or
`espeak`, and wire up whatever behavior you want around it.

## Modes
- **`stream`** (default): no tags, zero agent config. The reply is spoken paragraph by
  paragraph as it streams, with code, tables, and non-prose skipped.
- **`tag`**: the agent wraps spoken text in `<say>…</say>`; spans are spoken live and the
  tags are stripped from the transcript. Requires the agent to emit the markers.

Switch at runtime: `/simplesay mode <tag|stream>` — the choice persists across
sessions (stored in `~/.pi/agent/simplesay.json`). Run `/simplesay` with no
arguments to see the current mode, agent, endpoint, and config path.

## Install / run

This repo follows the pi package layout: `package.json` declares
`pi.extensions = ["./src"]`, with the entrypoint at `src/index.ts`.

Install from npm once published:

```bash
pi install npm:pi-simplesay
```

Install from GitHub:

```bash
pi install git:github.com/studioschade/pi-simplesay      # global
# or
pi install git:github.com/studioschade/pi-simplesay -l   # project-local
```

For a manual source checkout, symlink `src/index.ts` into pi's extension
auto-discovery path (recommended, so this repo stays the single source of truth):

```bash
ln -s /path/to/pi-simplesay/src/index.ts ~/.pi/agent/extensions/simplesay.ts   # global
# or
ln -s /path/to/pi-simplesay/src/index.ts .pi/extensions/simplesay.ts           # project-local
```

To try it ad hoc without installing: `pi -e /path/to/pi-simplesay/src/index.ts`

## How it works

<p align="center">
  <img src="./assets/readme/pipeline.svg" width="100%" alt="Pipeline: message_update text_delta events feed the active mode's parser (stream or tag), which flushes speakable spans to clean(), which strips code/tables/markup, then dispatches via execFile with no shell involved; the next utterance synthesizes while the current one plays, so there's no dead air.">
</p>

- **Streaming input:** `pi.on("message_update")` delivers `assistantMessageEvent`, a
  union whose text arrives as `{ type: "text_delta", delta }`. Deltas feed the active
  mode's parser. Thinking and tool-call deltas are ignored, so neither is spoken.
- **Tag parser:** accumulates streamed text, keeps a short tail on every delta so a
  tag split across chunks is never missed, and speaks a span the moment `</say>`
  arrives.
- **Stream parser:** consumes complete lines, tracks fenced-code state, and flushes
  a paragraph on the blank line that ends it, or at message end.
- **Cleanup (`clean()`):** strips code blocks and spans, tables, `<say>` tags,
  headers, emphasis markers, links, images, bare URLs, wikilinks, blockquotes,
  bullets, and emoji, then collapses whitespace. Identifiers like `file_name` are
  preserved. Provider-agnostic normalization (spelling out numbers or years, custom
  lexicon) stays the endpoint's job, not the extension's.
- **Dispatch:** `execFile(endpoint, ...)`, with no shell involved, so backticks,
  `$(...)`, or quotes inside a reply can't break or execute anything. To avoid dead
  air between utterances, synthesis is pipelined ahead of playback: each utterance
  renders to a temp WAV (`SAY_OUT`) while the previous one is still playing, then
  plays in order via `--play`. The next paragraph starts the instant the current one
  finishes. Synthesis has a 90s timeout: a hung endpoint (e.g. a wedged TTS server)
  skips one utterance instead of silently freezing the queue for the whole session.
- **Interrupt-on-type (barge-in):** the input editor is wrapped so any keystroke
  stops current playback immediately and drops the rest of that reply's queued
  speech — start typing and the agent goes quiet. Speech state re-arms on pi's
  `message_start` event (which fires for every assistant message), not on the
  provider stream's `start` event: providers that never emit one would otherwise
  leave the mute flag stuck and drop entire replies silently.
- **Debug tracing:** set `SIMPLESAY_DEBUG=/path/to/log` to record one line per
  pipeline decision (events seen, utterances spoken or dropped and why, synth
  failures) — a silent session shows exactly where speech died. `SIMPLESAY_DEBUG=0`
  or unset disables it; `/tmp/simplesay-debug.log` is a good default.
- **Display rewrite (tag mode only):** `message_end` returns a replacement message
  (`MessageEndEventResult.message`) with the tags removed. `message_update` is
  live-only and can't be rewritten, so raw tags are visible for the instant they
  stream before vanishing once the message finalizes.

## Speech endpoint
SimpleSay ships no TTS engine. It shells out to a configurable endpoint with the
contract `<endpoint> [--agent <name>] "<text>"`. All structural text cleanup is done in
the extension, so any endpoint works.

With no configuration at all, it defaults to the bundled
[`examples/endpoint.sh`](examples/endpoint.sh) (a minimal cross-platform reference
endpoint using `say`/`espeak`/`spd-say`), resolved relative to the extension file so it
works regardless of current directory. Voice works out of the box on a fresh clone.

To pin your own endpoint (a shared TTS server, a specific voice setup, etc.) without
editing the source, set environment variables before starting Pi:
```bash
export SIMPLESAY_ENDPOINT=/path/to/your/say/script
export SIMPLESAY_AGENT=your-agent-name   # optional, defaults to 'fabricant'
```
Or override for just the current session:
```
/simplesay <agent> <endpoint> [--no-agent]
```
Defaults: `mode` starts as `stream`, then follows the last `/simplesay mode`
choice saved to `~/.pi/agent/simplesay.json`. `endpoint` reads `SIMPLESAY_ENDPOINT`
if set, otherwise the bundled example endpoint above. Voice identity reads
`SIMPLESAY_AGENT` if set, otherwise derives from a `~/Agents/<name>` working
directory when present, with `fabricant` only as the last-resort fallback.

## Example: a Kokoro-based endpoint
SimpleSay ships no TTS engine by design. It just shells out to whatever endpoint you
point it at, following the contract above. Our own setup runs [Kokoros](https://github.com/lucasjinreal/Kokoros)
(a fast Rust reimplementation of Kokoro TTS) as a resident local server exposing an
OpenAI-compatible speech API, wrapped in a small shell script that:
- POSTs cleaned text to the resident Kokoros server (warm model, sub-second latency)
- Falls back to a CLI invocation if the server isn't up
- Serializes playback box-wide with a file lock, so concurrent speakers queue instead of
  talking over each other
- Maps a `--agent <name>` flag to a per-agent voice (handy if multiple personas share one
  machine)
- Honors the `SAY_OUT=<wav>` / `--play <wav>` split described above for synth-ahead pipelining

None of that is specific to this extension. Any script matching the endpoint contract
works, whether it wraps Kokoro, a cloud TTS API, or `espeak`. `examples/endpoint.sh` is a
minimal cross-platform stand-in (`say`/`espeak`/`spd-say`) to get started without any of
the above.

## Agent prompt (tag mode)
`stream` mode needs no prompting: the extension reads whatever the model writes
normally. `tag` mode does need the model told what to do, since it only speaks text
the agent explicitly wraps. Add something like this to the agent's system prompt or
`AGENTS.md`:

```markdown
## Speech
Wrap the parts of your response you want spoken aloud in `<say>...</say>`. Keep
code, tables, file paths, and anything not meant to be heard outside the tags.
Write the tagged text plainly, it will be spoken live as you write it and the tags
are removed from the visible transcript afterward.
```

## Limitations
- Tag mode shows raw tags for the instant they stream, before the finalize rewrite
  removes them.
- Only the mode persists across sessions (`~/.pi/agent/simplesay.json`, relocatable
  via `SIMPLESAY_CONFIG`); agent/endpoint overrides set by `/simplesay <agent>
  <endpoint>` are per-session — use `SIMPLESAY_AGENT`/`SIMPLESAY_ENDPOINT` to pin
  those permanently.
- Tag mode depends on the model actually emitting the tags. That's reliable in
  practice, but not enforceable the way a schema-validated tool call would be.

- **Source:** `src/index.ts`
