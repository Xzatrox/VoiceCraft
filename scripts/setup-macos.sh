#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_DIR/tts_resources"

echo "=== VoiceCraft macOS Setup ==="
echo ""

setup_ffmpeg() {
  echo "--- FFmpeg ---"
  FFMPEG_DIR="$RESOURCES_DIR/ffmpeg"
  mkdir -p "$FFMPEG_DIR"

  if [ -f "$FFMPEG_DIR/ffmpeg" ]; then
    echo "FFmpeg already installed."
    return
  fi

  if command -v ffmpeg &>/dev/null; then
    SYSTEM_FFMPEG="$(command -v ffmpeg)"
    echo "Using system FFmpeg: $SYSTEM_FFMPEG"
    cp "$SYSTEM_FFMPEG" "$FFMPEG_DIR/ffmpeg"
    chmod +x "$FFMPEG_DIR/ffmpeg"
  elif command -v brew &>/dev/null; then
    echo "Installing FFmpeg via Homebrew..."
    brew install ffmpeg
    SYSTEM_FFMPEG="$(command -v ffmpeg)"
    cp "$SYSTEM_FFMPEG" "$FFMPEG_DIR/ffmpeg"
    chmod +x "$FFMPEG_DIR/ffmpeg"
  else
    echo "ERROR: FFmpeg not found and Homebrew not available."
    echo "Install Homebrew (https://brew.sh) then run: brew install ffmpeg"
    exit 1
  fi

  echo "FFmpeg installed."
}

setup_piper() {
  echo "--- Piper TTS ---"
  PIPER_DIR="$RESOURCES_DIR/piper/bin/piper"
  mkdir -p "$PIPER_DIR"

  if [ -f "$PIPER_DIR/piper" ]; then
    echo "Piper already installed."
    return
  fi

  ARCH="$(uname -m)"
  if [ "$ARCH" = "arm64" ]; then
    PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_aarch64.tar.gz"
  else
    PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_x64.tar.gz"
  fi

  echo "Downloading Piper ($ARCH)..."
  TEMP_FILE="$RESOURCES_DIR/piper/piper_macos.tar.gz"
  curl -L -o "$TEMP_FILE" "$PIPER_URL"

  echo "Extracting..."
  tar -xzf "$TEMP_FILE" -C "$RESOURCES_DIR/piper/bin/"
  rm -f "$TEMP_FILE"
  chmod +x "$PIPER_DIR/piper" 2>/dev/null || true

  echo "Piper installed."
}

setup_silero() {
  echo "--- Silero TTS ---"
  echo "Silero models download automatically on first use via the app."
  echo "Ensure Python 3.9+ is available: python3 --version"

  if ! command -v python3 &>/dev/null; then
    echo "WARNING: python3 not found. Install Python 3.9+ to use Silero/Coqui."
  else
    echo "Python found: $(python3 --version)"
  fi
}

ARG="${1:-all}"

mkdir -p "$RESOURCES_DIR"

case "$ARG" in
  all)
    setup_ffmpeg
    setup_piper
    setup_silero
    ;;
  silero)
    setup_silero
    ;;
  ffmpeg)
    setup_ffmpeg
    ;;
  piper)
    setup_piper
    ;;
  *)
    echo "Usage: $0 [all|silero|ffmpeg|piper]"
    exit 1
    ;;
esac

echo ""
echo "=== Setup complete ==="
