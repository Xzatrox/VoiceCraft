#!/bin/bash
# Qwen3-TTS Setup Script for macOS/Linux

set -e

# Parse accelerator argument
ACCELERATOR="${1:-cpu}"

# Validate accelerator
case "$ACCELERATOR" in
    cpu|cuda|mps)
        ;;
    *)
        echo "Invalid accelerator: $ACCELERATOR"
        echo "Usage: $0 [cpu|cuda|mps]"
        exit 1
        ;;
esac

# Get script and project directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "===================================="
echo "   Qwen3-TTS Setup Script"
echo "   Accelerator: $ACCELERATOR"
echo "===================================="
echo ""

# Check if Python is installed
echo "Checking for Python installation..."
PYTHON_CMD=""

for cmd in python3 python; do
    if command -v "$cmd" &> /dev/null; then
        VERSION=$("$cmd" --version 2>&1)
        PYTHON_CMD="$cmd"
        echo "Found Python: $VERSION"
        break
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "ERROR: Python not found!"
    echo "Please install Python 3.9 or newer"
    exit 1
fi

# Create resources directory
RESOURCES_DIR="tts_resources"
QWEN_DIR="$RESOURCES_DIR/qwen-$ACCELERATOR"
VENV_PYTHON="$QWEN_DIR/venv/bin/python3"

# Check if Qwen is already installed
if [ -f "$VENV_PYTHON" ]; then
    echo ""
    echo "Checking existing Qwen installation..."
    if "$VENV_PYTHON" -c "import torch; import transformers; print('OK')" 2>&1 | grep -q "OK"; then
        echo "Qwen3-TTS already installed and working, skipping..."

        # Just update the generation script if needed
        GEN_SCRIPT="$SCRIPT_DIR/qwen_generate.py"
        if [ -f "$GEN_SCRIPT" ]; then
            cp "$GEN_SCRIPT" "$QWEN_DIR/generate.py"
        fi

        echo ""
        echo "===================================="
        echo "   Qwen3-TTS Ready!"
        echo "===================================="
        exit 0
    fi
fi

echo ""
echo "Creating directory structure..."
mkdir -p "$QWEN_DIR"

# Create virtual environment
echo ""
echo "Creating Python virtual environment..."
"$PYTHON_CMD" -m venv "$QWEN_DIR/venv"

if [ ! -f "$VENV_PYTHON" ]; then
    echo "ERROR: Failed to create virtual environment"
    exit 1
fi

echo "Virtual environment created successfully"

# Upgrade pip
echo ""
echo "Upgrading pip..."
"$VENV_PYTHON" -m pip install --upgrade pip --quiet

# Install PyTorch based on accelerator
echo ""
echo "Installing PyTorch for $ACCELERATOR..."
echo "This may take several minutes..."

case "$ACCELERATOR" in
    cuda)
        echo "Installing CUDA version (~3.5 GB download)..."
        "$VENV_PYTHON" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121 --quiet
        ;;
    mps)
        echo "Installing MPS version for Apple Silicon (~1.4 GB download)..."
        "$VENV_PYTHON" -m pip install torch torchaudio --quiet
        ;;
    cpu)
        echo "Installing CPU version (~1.3 GB download)..."
        "$VENV_PYTHON" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu --quiet
        ;;
esac

# Install transformers and dependencies
echo ""
echo "Installing transformers and dependencies..."
"$VENV_PYTHON" -m pip install transformers accelerate soundfile --quiet

# Copy generation script
echo ""
echo "Copying generation script..."
cp "$SCRIPT_DIR/qwen_generate.py" "$QWEN_DIR/generate.py"
chmod +x "$QWEN_DIR/generate.py"

# Create accelerator config file
echo ""
echo "Creating accelerator configuration..."
cat > "$QWEN_DIR/accelerator.json" << EOF
{
  "accelerator": "$ACCELERATOR",
  "created": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

# Create wrapper script
cat > "$QWEN_DIR/qwen_generate.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/venv/bin/python3" "$SCRIPT_DIR/generate.py" "$@"
EOF
chmod +x "$QWEN_DIR/qwen_generate.sh"

echo ""
echo "Testing Qwen installation..."
if "$VENV_PYTHON" -c "import torch; import transformers; print('OK')" 2>&1 | grep -q "OK"; then
    echo "Qwen3-TTS installed successfully!"
else
    echo "WARNING: Qwen installation test failed"
fi

echo ""
echo "===================================="
echo "   Setup Complete!"
echo "===================================="
echo ""
echo "Qwen3-TTS has been installed in: $QWEN_DIR"
echo "Accelerator: $ACCELERATOR"
echo ""
echo "NOTE: First-time usage will download the Qwen3-TTS model (~1.5 GB)"
echo "The model will be cached in the Hugging Face cache directory."
echo ""
echo "You can now use Qwen voices with instruction-based control!"
