#!/usr/bin/env bash
# SimpleSay endpoint: the TTS engine runs on ANOTHER machine, reached over SSH.
#
#   SIMPLESAY_ENDPOINT=/path/to/endpoint-remote-ssh.sh
#   SIMPLESAY_REMOTE_HOST=tts-server        # anything `ssh` accepts: host, user@host, an ssh_config alias
#   SIMPLESAY_REMOTE_CMD=say-return         # command on the remote host (see the contract below)
#   SIMPLESAY_REMOTE_PLAY_FLAG=--play-here  # optional; the flag that tells it to play there
#
# Works with both SimpleSay outputs:
#
#   output=local  (WAV transport, the default)
#     SimpleSay runs:  SAY_OUT=<tmp.wav> endpoint-remote-ssh.sh [--agent <name>] "<text>"
#     -> the text is piped to `ssh tts-server say-return`, the WAV it prints on stdout is
#        written to SAY_OUT, then SimpleSay runs `endpoint-remote-ssh.sh --play <tmp.wav>`
#        and the audio plays HERE (pw-play, paplay, aplay or afplay, first found).
#     Use this on a laptop or handheld that has a speaker but not the horsepower for TTS.
#
#   output=server (direct transport)
#     SimpleSay runs:  endpoint-remote-ssh.sh [--agent <name>] "<text>"   (no SAY_OUT)
#     -> the text is piped to `ssh tts-server say-return --play-here`; the server speaks
#        it on ITS speakers and nothing comes back. Use this when the speakers you hear are
#        the server's (a desktop that is itself the TTS box, or a room speaker on it).
#
# Remote command contract (you write this half; it is not part of SimpleSay):
#   stdin   the text to speak. If the first line starts with "#instruction ", the rest of
#           that line is a delivery direction (from <say tone="…">); the text follows.
#   args    `--agent <name>` when SimpleSay passes one (a voice/persona hint), and
#           $SIMPLESAY_REMOTE_PLAY_FLAG (default --play-here) in direct mode.
#   stdout  without the play flag: a complete WAV file. With it: nothing required.
#   exit    0 on success, non-zero on failure.
# The flag name is a convention between this script and your server-side command; change
# SIMPLESAY_REMOTE_PLAY_FLAG if your command spells it differently.
#
# Text travels on stdin, never on the remote command line, so quotes, backticks and $(…)
# in a reply cannot be interpreted by the remote shell.

set -euo pipefail

REMOTE_HOST="${SIMPLESAY_REMOTE_HOST:-tts-server}"
REMOTE_CMD="${SIMPLESAY_REMOTE_CMD:-say-return}"
PLAY_FLAG="${SIMPLESAY_REMOTE_PLAY_FLAG:---play-here}"
# Bound the network leg so a dead server fails the span instead of hanging it.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout="${SIMPLESAY_REMOTE_CONNECT_TIMEOUT:-5}")

die() { echo "[endpoint-remote-ssh] $*" >&2; exit 1; }

# --- --play <wav>: play a WAV that is already on this machine -----------------------
if [ "${1:-}" = "--play" ]; then
  wav="${2:-}"
  [ -s "$wav" ] || die "--play: no such WAV or empty: $wav"
  for player in pw-play paplay aplay afplay; do
    if command -v "$player" >/dev/null 2>&1; then
      exec "$player" "$wav"
    fi
  done
  die "no audio player found (pw-play, paplay, aplay, afplay)"
fi

# --- parse [--agent <name>] "<text>" ------------------------------------------------
agent_args=()
if [ "${1:-}" = "--agent" ]; then
  agent_args=(--agent "${2:-}")
  shift 2
fi
text="$*"
[ -n "$text" ] || die "no text"

# Build the remote command as one quoted string (ssh joins its arguments with spaces and
# hands them to the remote shell, so each piece is quoted here exactly once).
remote="$(printf '%q' "$REMOTE_CMD")"
for a in ${agent_args[@]+"${agent_args[@]}"}; do remote+=" $(printf '%q' "$a")"; done

payload() {
  if [ -n "${SAY_INSTRUCTION:-}" ]; then
    # One line only: a newline in the direction would end the header early.
    printf '#instruction %s\n' "$(printf '%s' "$SAY_INSTRUCTION" | tr '\n' ' ')"
  fi
  printf '%s\n' "$text"
}

# --- output=local: synthesize remotely, write the WAV to SAY_OUT --------------------
if [ -n "${SAY_OUT:-}" ]; then
  part="${SAY_OUT}.part"
  trap 'rm -f "$part"' EXIT
  payload | ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "$remote" > "$part" \
    || die "remote synth failed on $REMOTE_HOST"
  [ -s "$part" ] || die "remote synth returned no audio"
  mv -f "$part" "$SAY_OUT"
  trap - EXIT
  exit 0
fi

# --- output=server: the server speaks it; nothing comes back ------------------------
payload | ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "$remote $(printf '%q' "$PLAY_FLAG")" >/dev/null \
  || die "remote speak failed on $REMOTE_HOST"
