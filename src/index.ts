import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, type ChildProcess } from "node:child_process";
import { unlink, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// tag:    agent wraps spoken text in <say>…</say>; spans are spoken live and the
//         tags are stripped from the transcript.
// stream: no tags; speak the reply paragraph by paragraph, skipping code/tables.
type Mode = "tag" | "stream";

const OPEN = "<say>";
const CLOSE = "</say>";

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

export default function (pi: ExtensionAPI) {
  // Defaults so voice works on load; /simplesay overrides for the session.
  // Default to stream so it works with zero agent config (tag mode needs the
  // agent to emit <say> markers).
  let mode: Mode = "stream";
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

  // Per-message stream state.
  let acc = "";         // streamed text not yet parsed
  let speaking = false; // inside a <say> span (tag mode)
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

  function stopSpeaking() {
    epoch++;
    muted = true;
    if (currentPlayChild?.pid) {
      try { process.kill(-currentPlayChild.pid, "SIGTERM"); } catch { /* already exited */ }
      currentPlayChild = null;
    }
  }

  function reset() {
    acc = buf = para = "";
    speaking = inFence = sawText = false;
    muted = false;
  }

  // Provider-agnostic: strip everything that reads badly aloud, leave plain prose.
  function clean(t: string): string {
    return t
      .replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ") // code blocks
      .split(OPEN).join("").split(CLOSE).join("")                      // say tags
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
  // stopSpeaking() can kill it mid-playback. `detached: true` makes the
  // child its own process-group leader, so killing `-pid` also reaches the
  // audio player it shells out to (aplay/paplay/pw-play), not just the
  // wrapper script.
  function playWav(wav: string, myEpoch: number): Promise<void> {
    return new Promise((resolve) => {
      if (myEpoch !== epoch) { resolve(); return; }
      const child = execFile(endpoint, ["--play", wav], { detached: true }, (err) => {
        if (err && (err as any).signal !== "SIGTERM") console.error("[simplesay]", err);
        resolve();
      });
      currentPlayChild = child;
      child.on("exit", () => { if (currentPlayChild === child) currentPlayChild = null; });
    });
  }

  function speak(raw: string) {
    if (muted) return; // interrupted mid-message; drop the rest silently
    const text = clean(raw);
    if (!text || !endpoint) return;
    const myEpoch = epoch;
    const args = agentFlag ? ["--agent", agentName, text] : [text];
    const wav = `/tmp/simplesay-${process.pid}-${seq++}.wav`;

    // Synthesize to a WAV ahead of playback (SAY_OUT skips the endpoint's play step).
    const synth = (synthChain = synthChain
      .then(() => {
        if (myEpoch !== epoch) return false; // stopped before synth started
        return execFileAsync(endpoint, args, { env: { ...process.env, SAY_OUT: wav } }).then(() => true);
      })
      .catch((e) => { console.error("[simplesay]", e); return false; }));

    // Play in order once this utterance is ready, then clean up the WAV.
    playChain = playChain
      .then(() => synth)
      .then((ok) => ((ok && myEpoch === epoch) ? playWav(wav, myEpoch) : undefined))
      .catch((e) => console.error("[simplesay]", e))
      .finally(() => unlink(wav, () => {}));
  }

  // tag mode: speak each <say>…</say> span as one utterance once it closes.
  function parseTags(final: boolean) {
    const tail = Math.max(OPEN.length, CLOSE.length) - 1; // hold for a split marker
    for (;;) {
      if (!speaking) {
        const i = acc.indexOf(OPEN);
        if (i < 0) { acc = final ? "" : acc.slice(-tail); return; }
        acc = acc.slice(i + OPEN.length);
        speaking = true;
      } else {
        const j = acc.indexOf(CLOSE);
        if (j < 0) {
          const safe = final ? acc.length : Math.max(0, acc.length - tail);
          buf += acc.slice(0, safe);
          acc = acc.slice(safe);
          if (final && buf.trim()) { speak(buf); buf = ""; speaking = false; }
          return;
        }
        buf += acc.slice(0, j);
        acc = acc.slice(j + CLOSE.length);
        if (buf.trim()) speak(buf);
        buf = "";
        speaking = false;
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
    description: "Configure SimpleSay voice: /simplesay mode <tag|stream> | /simplesay <agent> <endpoint> [--no-agent]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      if (parts[0] === "mode") {
        const m = parts[1];
        if (m !== "tag" && m !== "stream") {
          ctx.ui.notify("Usage: /simplesay mode <tag|stream>", "error");
          return;
        }
        mode = m;
        ctx.ui.notify(`SimpleSay mode: ${mode}`, "info");
        return;
      }

      if (parts.length < 2) {
        ctx.ui.notify("Usage: /simplesay mode <tag|stream> | /simplesay <agent> <endpoint> [--no-agent]", "error");
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
    },
  });

  pi.on("message_update", async (event) => {
    const a: any = (event as any).assistantMessageEvent;
    if (!a) return;
    if (a.type === "start") { reset(); return; }
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
      (c: any) => c.type === "text" && (c.text.includes(OPEN) || c.text.includes(CLOSE)),
    );
    if (!tagged) return;
    const content = msg.content.map((c: any) =>
      c.type === "text"
        ? { ...c, text: c.text.split(OPEN).join("").split(CLOSE).join("").replace(/[ \t]{2,}/g, " ") }
        : c,
    );
    return { message: { ...msg, content } };
  });
}
