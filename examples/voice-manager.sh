#!/bin/bash

# Piper Voice Manager for SimpleSay — manage voices for the piper provider.
# Usage: ./voice-manager.sh [list|download <voice>|set <voice>]
#
# Adopted from Alex's Pi 400 setup (2026-08-02), with fixes from that review:
#  - `set` edits tts.conf (where PIPER_VOICE lives), not endpoint.sh.
#  - `set` writes the bare voice id; generate_piper builds
#    "$PIPER_VOICES_DIR/$PIPER_VOICE.onnx", so a full path would double up.
#  - A voice counts as installed only with BOTH .onnx and .onnx.json
#    (piper requires the config alongside the model).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="${SIMPLESAY_TTS_CONF:-$SCRIPT_DIR/tts.conf}"
VOICE_DIR="${PIPER_VOICES_DIR:-$HOME/piper-voices}"

# Available voices (medium quality - good balance of size/quality, runs well
# even on a Raspberry Pi 4)
declare -A VOICES=(
    ["amy"]="en_US-amy-medium"
    ["ryan"]="en_US-ryan-medium"
    ["joe"]="en_US-joe-medium"
    ["kristin"]="en_US-kristin-medium"
    ["ljspeech"]="en_US-ljspeech-medium"
    ["hfc_female"]="en_US-hfc_female-medium"
    ["hfc_male"]="en_US-hfc_male-medium"
)

# A voice is usable only with both the model AND its config (piper requires both).
installed() { [ -f "$VOICE_DIR/$1.onnx" ] && [ -f "$VOICE_DIR/$1.onnx.json" ]; }

current_voice_id() { grep '^PIPER_VOICE=' "$CONF_FILE" 2>/dev/null | head -1 | cut -d'"' -f2; }

friendly_name() {
    local id="$1" name
    for name in "${!VOICES[@]}"; do
        [ "${VOICES[$name]}" = "$id" ] && { echo "$name"; return; }
    done
    echo "${id:-unknown}"
}

case "$1" in
    list)
        echo "Available voices:"
        echo ""
        for name in "${!VOICES[@]}"; do
            voice_id="${VOICES[$name]}"
            if installed "$voice_id"; then
                echo "  ✓ $name ($voice_id) - INSTALLED"
            elif [ -f "$VOICE_DIR/$voice_id.onnx" ]; then
                echo "  ! $name ($voice_id) - model present but .onnx.json missing (unusable)"
            else
                echo "  ○ $name ($voice_id) - not installed"
            fi
        done
        echo ""
        echo "Current voice: $(friendly_name "$(current_voice_id)")"
        ;;

    download)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 download <voice-name>"
            echo "Available voices: ${!VOICES[@]}"
            exit 1
        fi

        voice_name="$2"
        if [ -z "${VOICES[$voice_name]:-}" ]; then
            echo "Error: Unknown voice '$voice_name'"
            echo "Available voices: ${!VOICES[@]}"
            exit 1
        fi

        voice_id="${VOICES[$voice_name]}"
        echo "Downloading $voice_name voice..."

        mkdir -p "$VOICE_DIR"
        cd "$VOICE_DIR" || exit 1
        wget -q "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/${voice_name}/medium/${voice_id}.onnx"
        wget -q "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/${voice_name}/medium/${voice_id}.onnx.json"

        if installed "$voice_id"; then
            echo "✓ Downloaded $voice_name voice successfully!"
            ls -lh "${voice_id}.onnx" "${voice_id}.onnx.json"
        else
            echo "✗ Failed to download $voice_name voice (need both .onnx and .onnx.json)"
            exit 1
        fi
        ;;

    set)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 set <voice-name>"
            echo "Installed voices:"
            for name in "${!VOICES[@]}"; do
                installed "${VOICES[$name]}" && echo "  ✓ $name"
            done
            exit 1
        fi

        voice_name="$2"
        if [ -z "${VOICES[$voice_name]:-}" ]; then
            echo "Error: Unknown voice '$voice_name'"
            echo "Available voices: ${!VOICES[@]}"
            exit 1
        fi
        voice_id="${VOICES[$voice_name]}"

        if ! installed "$voice_id"; then
            echo "Error: Voice '$voice_name' is not installed"
            echo "Download it first: $0 download $voice_name"
            exit 1
        fi

        # PIPER_VOICE lives in tts.conf (sourced by endpoint.sh), and must be the
        # bare voice id — generate_piper builds "$PIPER_VOICES_DIR/$PIPER_VOICE.onnx".
        sed -i "s|^PIPER_VOICE=.*|PIPER_VOICE=\"$voice_id\"|" "$CONF_FILE"
        echo "✓ Set voice to: $voice_name"
        echo "  Model: $VOICE_DIR/$voice_id.onnx"
        ;;

    *)
        echo "Piper Voice Manager for SimpleSay"
        echo ""
        echo "Usage:"
        echo "  $0 list              - List available and installed voices"
        echo "  $0 download <voice>  - Download a voice"
        echo "  $0 set <voice>       - Set the current voice"
        echo ""
        echo "Available voices:"
        echo "  amy        - Female, American (default)"
        echo "  ryan       - Male, American"
        echo "  joe        - Male, American"
        echo "  kristin    - Female, American"
        echo "  ljspeech   - Female, American"
        echo "  hfc_female - Female, American"
        echo "  hfc_male   - Male, American"
        echo ""
        echo "Example:"
        echo "  $0 download ryan"
        echo "  $0 set ryan"
        ;;
esac
