#!/bin/bash

# SimpleSay TTS Endpoint with Config-Driven Provider Selection
# Usage: ./endpoint.sh [--agent <name>] "<text>"
#        ./endpoint.sh --play <wavfile>
#
# This endpoint reads configuration from tts.conf (in the same directory)
# and supports multiple TTS providers: piper, espeak-ng, pico2wave, kokoro

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/tts.conf"

# Load configuration
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
else
    echo "[Endpoint] Warning: Config file not found at $CONFIG_FILE, using defaults"
    TTS_PROVIDER="espeak-ng"
    ESPEAK_VOICE="en-us"
    ESPEAK_SPEED=150
fi

# Auto-detect audio player if not specified
if [ -z "$AUDIO_PLAYER" ]; then
    if command -v pw-play &> /dev/null; then
        AUDIO_PLAYER="pw-play"
    elif command -v paplay &> /dev/null; then
        AUDIO_PLAYER="paplay"
    elif command -v aplay &> /dev/null; then
        AUDIO_PLAYER="aplay"
    else
        echo "[Endpoint] Error: No audio player found (pw-play, paplay, or aplay)"
        exit 1
    fi
fi

# Parse arguments
AGENT_NAME="unknown"
PLAY_MODE=false
TEXT=""
WAV_FILE=""

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --agent)
            AGENT_NAME="$2"
            shift 2
            ;;
        --play)
            PLAY_MODE=true
            WAV_FILE="$2"
            shift 2
            ;;
        *)
            TEXT="$1"
            shift
            ;;
    esac
done

# Play mode: just play the WAV file
if [ "$PLAY_MODE" = true ]; then
    if [ -z "$WAV_FILE" ] || [ ! -f "$WAV_FILE" ]; then
        echo "[Endpoint] Error: WAV file not found: $WAV_FILE"
        exit 1
    fi
    $AUDIO_PLAYER "$WAV_FILE" 2>/dev/null
    exit 0
fi

# Text-to-speech mode
if [ -z "$TEXT" ]; then
    echo "[Endpoint] Error: No text provided."
    exit 1
fi

# Function to generate WAV using Piper
generate_piper() {
    local text="$1"
    local output="$2"
    local voice_path="${PIPER_VOICES_DIR}/${PIPER_VOICE}.onnx"
    
    if [ ! -x "$PIPER_BIN" ]; then
        echo "[Endpoint] Error: Piper binary not found at $PIPER_BIN"
        return 1
    fi
    
    if [ ! -f "$voice_path" ]; then
        echo "[Endpoint] Error: Piper voice not found at $voice_path"
        return 1
    fi
    
    echo "$text" | "$PIPER_BIN" --model "$voice_path" --output_file "$output" 2>/dev/null
}

# Function to generate WAV using espeak-ng
generate_espeak() {
    local text="$1"
    local output="$2"
    
    if ! command -v espeak-ng &> /dev/null; then
        echo "[Endpoint] Error: espeak-ng not found"
        return 1
    fi
    
    espeak-ng -v "$ESPEAK_VOICE" -s "$ESPEAK_SPEED" "$text" --stdout > "$output" 2>/dev/null
}

# Function to generate WAV using pico2wave
generate_pico2wave() {
    local text="$1"
    local output="$2"
    
    if ! command -v pico2wave &> /dev/null; then
        echo "[Endpoint] Error: pico2wave not found"
        return 1
    fi
    
    pico2wave -l "$PICO2WAVE_LANG" -w "$output" "$text" 2>/dev/null
}

# Function to generate WAV using Kokoro (OpenAI-compatible /v1/audio/speech)
generate_kokoro() {
    local text="$1"
    local output="$2"

    if ! command -v curl &> /dev/null; then
        echo "[Endpoint] Error: curl not found (required for kokoro provider)"
        return 1
    fi

    # jq not assumed present — build the JSON body with a small python/node-free
    # approach: printf + sed-style escaping is fragile for arbitrary text, so
    # use python3 (present on every box we run this on) to escape safely.
    local payload
    payload=$(python3 -c '
import json, sys
print(json.dumps({
    "model": sys.argv[1],
    "input": sys.argv[2],
    "voice": sys.argv[3],
    "response_format": "wav",
}))
' "${KOKORO_MODEL:-kokoro}" "$text" "${KOKORO_VOICE:-am_puck}")

    local http_code
    http_code=$(curl -s -o "$output" -w '%{http_code}' \
        "${KOKORO_URL:-http://127.0.0.1:7790}/v1/audio/speech" \
        -H "Content-Type: application/json" \
        -d "$payload")

    if [ "$http_code" != "200" ]; then
        echo "[Endpoint] Error: kokoro request failed (HTTP $http_code)"
        return 1
    fi
}

# Generate WAV based on provider
if [ -n "$SAY_OUT" ]; then
    # Generate to specified output file
    case "$TTS_PROVIDER" in
        piper)
            generate_piper "$TEXT" "$SAY_OUT"
            ;;
        espeak-ng)
            generate_espeak "$TEXT" "$SAY_OUT"
            ;;
        pico2wave)
            generate_pico2wave "$TEXT" "$SAY_OUT"
            ;;
        kokoro)
            generate_kokoro "$TEXT" "$SAY_OUT"
            ;;
        *)
            echo "[Endpoint] Error: Unknown TTS provider: $TTS_PROVIDER"
            exit 1
            ;;
    esac
    
    if [ ! -f "$SAY_OUT" ] || [ ! -s "$SAY_OUT" ]; then
        echo "[Endpoint] Error: Failed to generate WAV file"
        exit 1
    fi
else
    # Generate to temp file and play
    TEMP_WAV=$(mktemp /tmp/simplesay_XXXXXX.wav)
    trap "rm -f '$TEMP_WAV'" EXIT
    
    case "$TTS_PROVIDER" in
        piper)
            generate_piper "$TEXT" "$TEMP_WAV"
            ;;
        espeak-ng)
            generate_espeak "$TEXT" "$TEMP_WAV"
            ;;
        pico2wave)
            generate_pico2wave "$TEXT" "$TEMP_WAV"
            ;;
        kokoro)
            generate_kokoro "$TEXT" "$TEMP_WAV"
            ;;
        *)
            echo "[Endpoint] Error: Unknown TTS provider: $TTS_PROVIDER"
            exit 1
            ;;
    esac
    
    if [ ! -f "$TEMP_WAV" ] || [ ! -s "$TEMP_WAV" ]; then
        echo "[Endpoint] Error: Failed to generate WAV file"
        exit 1
    fi
    
    $AUDIO_PLAYER "$TEMP_WAV" 2>/dev/null
fi
