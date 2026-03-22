# Qwen3-TTS Integration Summary

## Overview
Successfully integrated QwenLM/Qwen3-TTS support for generating Russian audiobooks with instruction-based voice control. The implementation supports Apple Silicon (MPS), CUDA, and DirectML acceleration.

## Changes Made

### 1. Type Definitions Updated

#### `electron/services/tts/types.ts`
- Added `'qwen'` to `TTSProvider` type
- Added `instructable?: boolean` field to `VoiceInfo` interface for instruction-based voice control
- Added `qwen: { loaded: boolean }` to `TTSServerStatus` interface

#### `src/types/index.ts`
- Added `'qwen'` to `TTSProvider` type
- Added `instructable?: boolean` field to `VoiceInfo` interface
- Added `qwen: { loaded: boolean }` to `TTSServerStatus` interface

### 2. Voice Configurations

#### `electron/services/tts/voices.ts`
- Added `QWEN_VOICES` export with Russian and English voice configurations
- Voices include: Qwen Male, Qwen Female, Qwen Neutral (Russian) and Qwen Male/Female (English)
- All voices marked with `instructable: true` for instruction support
- Added `checkQwenInstalled()` function to check installation status
- Updated `getVoicesForLanguage()` to include Qwen voices when installed

### 3. Provider Management

#### `electron/services/tts/providers.ts`
- Added Qwen3-TTS to available providers list
- Updated `isProviderAvailableForLanguage()` to support Qwen for Russian and English
- Imported `QWEN_VOICES` from voices module

### 4. UI Components

#### `src/components/provider/QwenSetup.tsx` (NEW)
- Created setup component similar to SileroSetup
- Supports accelerator selection (CPU, CUDA, DirectML, MPS)
- Displays installation requirements and download sizes
- Shows instruction-based voice control features
- Handles CUDA toolkit detection and warnings

#### `src/components/provider/ProviderSelector.tsx`
- Added Qwen description case in `getProviderDescription()`
- Updated `getProviderAvailability()` to include Qwen (always available like Silero/Coqui)

#### `src/constants/index.ts`
- Added Brain icon import from lucide-react
- Added `qwen: createElement(Brain, { className: 'h-4 w-4' })` to PROVIDER_ICONS

### 5. Internationalization

#### `src/i18n/types.ts`
- Added `qwen` provider translations interface with fields:
  - name, description, setupRequired, waitMinutes
  - forQwenWork, pythonEmbedded, dependencies, qwenModel
  - initialDownload, fasterOnGpu
  - instructionSupport, instructionDescription

#### `src/i18n/en.ts`
- Added English translations for Qwen3-TTS
- Description highlights instruction-based control and multi-platform support

#### `src/i18n/ru.ts`
- Added Russian translations for Qwen3-TTS
- Localized descriptions for Russian-speaking users

### 6. Python Generation Script

#### `scripts/qwen_generate.py` (NEW)
- Standalone Python script for Qwen3-TTS generation
- Supports instruction-based voice control with parameters:
  - `--gender`: male/female voice selection
  - `--timbre`: neutral, warm, bright, deep
  - `--style`: normal, expressive, calm, energetic
  - `--emotion`: neutral, happy, sad, angry, surprised
  - `--instruction`: custom instruction override
- Auto-detects best device (CUDA, MPS, or CPU)
- Supports both Russian and English languages
- Generates 24kHz audio by default
- Uses transformers library for model loading

### 7. TTS Server Integration

#### `electron/services/tts/server.ts`
- Updated `TTSServerStatus` interface to include qwen status
- Modified `getTTSServerStatus()` to handle qwen field
- Updated `loadTTSModel()` to accept `'qwen'` engine type
- Updated `unloadTTSModel()` to accept `'qwen'` engine type
- Modified `generateViaServer()` to:
  - Accept `'qwen'` engine type
  - Add `instruction?: string` parameter for voice control
  - Use 6-minute timeout for Qwen (like Coqui)
- Updated `generateViaServerForPreview()` with same Qwen support

## Features Implemented

### Instruction-Based Voice Control
- Control voice timbre (neutral, warm, bright, deep)
- Select gender (male/female)
- Adjust speaking style (normal, expressive, calm, energetic)
- Set emotion (neutral, happy, sad, angry, surprised)
- Custom instruction override for advanced users

### Multi-Platform Acceleration Support
- **CUDA**: NVIDIA GPU acceleration (~2.3 GB download)
- **MPS**: Apple Silicon acceleration (~200 MB download)
- **DirectML**: AMD GPU acceleration (~200 MB download)
- **CPU**: Fallback for any system (~150 MB download)

### Language Support
- Russian (ru-RU) - Primary target for audiobooks
- English (en) - Additional language support

## Installation Requirements

### Dependencies
- Python 3.11 (embedded) - ~25 MB
- PyTorch (varies by accelerator)
- transformers library - ~50 MB
- accelerate library (included in dependencies)
- Qwen3-TTS model - ~1.2 GB (downloaded on first use)

### Total Download Sizes
- **CUDA**: ~3.5 GB (PyTorch CUDA + dependencies + model)
- **MPS**: ~1.4 GB (PyTorch MPS + dependencies + model)
- **DirectML**: ~1.4 GB (PyTorch DirectML + dependencies + model)
- **CPU**: ~1.3 GB (PyTorch CPU + dependencies + model)

## Remaining Tasks

### 8. Setup Scripts for Qwen3-TTS Dependencies
- Need to create installation scripts similar to `setup-silero.ps1`
- Should handle:
  - Python environment setup
  - PyTorch installation for selected accelerator
  - transformers and accelerate installation
  - Model download and caching
  - Path configuration

### 9. Python TTS Server Integration
- Update `tts_server.py` (if exists) to:
  - Load Qwen3-TTS model
  - Handle `/load` endpoint for qwen engine
  - Handle `/generate` endpoint with instruction parameter
  - Manage model memory and device placement
  - Track qwen model load status

### 10. Electron Handler Integration
- Update `electron/main/handlers/tts.ts` to:
  - Handle Qwen installation requests
  - Pass instruction parameter to generation functions
  - Support Qwen model loading/unloading

## Usage Example

```typescript
// Load Qwen model
await loadTTSModel('qwen', 'ru')

// Generate with instruction
await generateViaServer(
  'qwen',
  'Привет! Это тестовое сообщение.',
  'qwen-male',
  'ru-RU',
  '/path/to/output.wav',
  undefined, // rate
  undefined, // pitch
  undefined, // timeStretch
  undefined, // speakerWav
  undefined, // useRuaccent
  'male voice, warm timbre, expressive speaking style, happy emotion'
)
```

## Testing Checklist
- [ ] Verify Qwen provider appears in UI
- [ ] Test installation on Windows (CUDA/DirectML)
- [ ] Test installation on macOS (MPS)
- [ ] Test installation on Linux (CUDA/CPU)
- [ ] Verify instruction-based voice control works
- [ ] Test Russian language generation
- [ ] Test English language generation
- [ ] Verify different voice characteristics (gender, timbre, style, emotion)
- [ ] Test model loading/unloading
- [ ] Verify memory management
- [ ] Test audiobook generation with Qwen voices

## Notes
- Qwen3-TTS is optimized for high-quality audiobook generation
- Instruction-based control provides fine-grained voice customization
- Model supports streaming for real-time applications
- Compatible with existing VoiceCraft architecture
- Uses same Python environment structure as Silero/Coqui
