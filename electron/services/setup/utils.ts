import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { spawn } from 'child_process'
import { promisify } from 'util'
import { exec } from 'child_process'
import type { PipProgressInfo } from './types'

const execAsync = promisify(exec)

// Run pip install with real-time progress tracking
export async function runPipWithProgress(
  pythonPath: string,
  packages: string,
  options: {
    indexUrl?: string
    timeout?: number
    msvcEnvPath?: string // Path to vcvarsall.bat for MSVC environment
    extraArgs?: string[] // Additional pip arguments like --prefer-binary
    targetDir?: string // Target directory for installation (for embedded Python)
    onProgress?: (info: PipProgressInfo) => void
    onOutput?: (line: string) => void
  } = {}
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let command: string
    let spawnArgs: string[]

    // Note: --progress-bar was removed in newer pip versions, pip shows progress by default
    const pipArgs = ['pip', 'install', '--no-input']

    if (options.indexUrl) {
      pipArgs.push('--index-url', options.indexUrl)
    }

    if (options.targetDir) {
      pipArgs.push('--target', options.targetDir)
    }

    if (options.extraArgs) {
      pipArgs.push(...options.extraArgs)
    }

    // Add packages (split by space, filter out empty strings)
    // On Windows with shell:true, > and < are interpreted as redirects by cmd.exe,
    // so we must quote package specifiers containing these characters
    const pkgs = packages.split(' ').filter(p => p.trim()).map(p =>
      process.platform === 'win32' && /[><]/.test(p) ? `"${p}"` : p
    )
    pipArgs.push(...pkgs)

    // Build environment with Python include/libs paths for C extension compilation
    const env: Record<string, string | undefined> = { ...process.env, PYTHONIOENCODING: 'utf-8' }

    // Get Python directory (parent of python.exe)
    const pythonDir = path.dirname(pythonPath)
    const pythonIncludePath = path.join(pythonDir, 'include')
    const pythonLibsPath = path.join(pythonDir, 'libs')

    // Add Python include and libs to environment if they exist (for compiling C extensions)
    if (existsSync(pythonIncludePath) && existsSync(pythonLibsPath)) {
      // Append to INCLUDE and LIB environment variables
      env.INCLUDE = env.INCLUDE ? `${pythonIncludePath};${env.INCLUDE}` : pythonIncludePath
      env.LIB = env.LIB ? `${pythonLibsPath};${env.LIB}` : pythonLibsPath
      console.log(`[runPipWithProgress] Added Python paths: INCLUDE=${pythonIncludePath}, LIB=${pythonLibsPath}`)
    }

    if (options.msvcEnvPath && process.platform === 'win32') {
      // Run pip within MSVC environment
      // Set INCLUDE and LIB after vcvarsall to preserve them
      command = 'cmd.exe'
      const pipCommand = `"${pythonPath}" -m ${pipArgs.join(' ')}`

      // Build environment setup commands for Python headers
      let envSetup = ''
      if (existsSync(pythonIncludePath) && existsSync(pythonLibsPath)) {
        // Set INCLUDE and LIB after vcvarsall to ensure they're included
        envSetup = ` && set "INCLUDE=${pythonIncludePath};%INCLUDE%" && set "LIB=${pythonLibsPath};%LIB%"`
      }

      spawnArgs = ['/c', `call "${options.msvcEnvPath}" x64 >nul 2>&1${envSetup} && ${pipCommand}`]
      console.log('[runPipWithProgress] MSVC command:', spawnArgs.join(' '))
    } else {
      command = pythonPath
      spawnArgs = ['-m', ...pipArgs]
      console.log('[runPipWithProgress] command:', command, spawnArgs.join(' '))
    }

    // On Windows with MSVC, we already use cmd.exe /c which needs shell.
    // On Windows without MSVC, shell:true is needed for pip progress parsing.
    // On macOS/Linux, shell:false avoids path-with-spaces breakage.
    const useShell = process.platform === 'win32'

    const proc = spawn(command, spawnArgs, {
      shell: useShell,
      env
    })

    let lastPackage = ''
    let stderr = ''
    let lastActivityTime = Date.now()
    let currentPhase: PipProgressInfo['phase'] = 'collecting'

    // Keepalive interval - sends progress updates during long silent operations (like compilation)
    const keepaliveInterval = setInterval(() => {
      const silentSeconds = Math.round((Date.now() - lastActivityTime) / 1000)
      if (silentSeconds > 5 && options.onProgress) {
        // During compilation/building, pip is silent for long periods
        const isCompiling = currentPhase === 'processing'
        const details = isCompiling
          ? `Compiling ${lastPackage || 'packages'}... (${silentSeconds}s)`
          : `Working on ${lastPackage || 'packages'}... (${silentSeconds}s)`
        options.onProgress({
          phase: currentPhase,
          package: lastPackage || 'packages'
        })
        console.log(`[runPipWithProgress] Keepalive: ${details}`)
      }
    }, 5000)

    const clearKeepalive = () => {
      clearInterval(keepaliveInterval)
    }

    const parseProgressLine = (line: string) => {
      // pip progress format: "Downloading package-1.0.0.whl (123.4 MB)" or percentage updates
      // Also: "Downloading torch-2.0.0+cpu... 50%|█████     | 123/246 [00:30<00:30, 4.0MB/s]"

      // Update activity time on any output
      lastActivityTime = Date.now()

      if (options.onOutput) {
        options.onOutput(line)
      }

      // Match "Collecting package"
      const collectMatch = line.match(/Collecting\s+(\S+)/)
      if (collectMatch) {
        lastPackage = collectMatch[1].split('[')[0].split('>')[0].split('<')[0].split('=')[0]
        currentPhase = 'collecting'
        options.onProgress?.({
          phase: 'collecting',
          package: lastPackage
        })
        return
      }

      // Match "Downloading package (size)" - extract package name from URL or filename
      const downloadStartMatch = line.match(/Downloading\s+(\S+)/)
      if (downloadStartMatch) {
        let packageName = downloadStartMatch[1]
        // If it's a URL, extract the filename and parse package name from it
        if (packageName.startsWith('http://') || packageName.startsWith('https://')) {
          // Extract filename from URL path (last segment)
          const urlPath = packageName.split('/').pop() || packageName
          // Parse package name from wheel/archive filename (e.g., torch-2.5.1-cp311-win_amd64.whl -> torch)
          packageName = urlPath.split('-')[0]
        } else {
          // Regular package name, strip version specifiers
          packageName = packageName.split('-')[0]
        }
        lastPackage = packageName
        currentPhase = 'downloading'
        options.onProgress?.({
          phase: 'downloading',
          package: lastPackage
        })
        return
      }

      // Match pip download progress with size: "50%|█████| 100.5/200.0 MB" or just "100.5/200.0 MB"
      // Also handles: "123.4/456.7 MB", "1.2/2.5 GB", "500/1024 kB"
      const sizeMatch = line.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(MB|kB|GB|M|G|k)/i)
      const percentMatch = line.match(/(\d+)%\|/)

      if (sizeMatch) {
        const unit = sizeMatch[3].toLowerCase()
        const multiplier = (unit === 'gb' || unit === 'g') ? 1024 : (unit === 'mb' || unit === 'm') ? 1 : 0.001
        const downloaded = parseFloat(sizeMatch[1]) * multiplier
        const total = parseFloat(sizeMatch[2]) * multiplier
        currentPhase = 'downloading'
        options.onProgress?.({
          phase: 'downloading',
          package: lastPackage,
          downloaded,
          total,
          percentage: Math.round((downloaded / total) * 100)
        })
        return
      }

      // Fallback: Match percentage only if no size info available
      if (percentMatch) {
        currentPhase = 'downloading'
        options.onProgress?.({
          phase: 'downloading',
          package: lastPackage,
          percentage: parseInt(percentMatch[1], 10)
        })
        return
      }

      // Match "Installing collected packages"
      if (line.includes('Installing collected packages')) {
        currentPhase = 'installing'
        options.onProgress?.({
          phase: 'installing',
          package: lastPackage
        })
        return
      }

      // Match "Successfully installed"
      if (line.includes('Successfully installed')) {
        currentPhase = 'processing'
        options.onProgress?.({
          phase: 'processing',
          package: 'complete',
          percentage: 100
        })
        return
      }

      // Match "Building wheel" for compilation progress
      const buildMatch = line.match(/Building wheel for (\S+)/)
      if (buildMatch) {
        lastPackage = buildMatch[1]
        currentPhase = 'processing'
        options.onProgress?.({
          phase: 'processing',
          package: lastPackage
        })
        return
      }
    }

    // Buffer for incomplete lines
    let stdoutBuffer = ''
    let stderrBuffer = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString()
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      lines.forEach(parseProgressLine)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const str = data.toString()
      stderr += str
      stderrBuffer += str
      const lines = stderrBuffer.split(/\r?\n/)
      stderrBuffer = lines.pop() || ''
      // pip often outputs progress to stderr
      lines.forEach(parseProgressLine)
    })

    const timeout = options.timeout || 86400000 // 24 hours
    const timeoutId = setTimeout(() => {
      clearKeepalive()
      proc.kill()
      resolve({ success: false, error: `Installation timeout after ${timeout / 1000} seconds` })
    }, timeout)

    proc.on('close', (code) => {
      clearTimeout(timeoutId)
      clearKeepalive()
      // Process remaining buffer
      if (stdoutBuffer) parseProgressLine(stdoutBuffer)
      if (stderrBuffer) parseProgressLine(stderrBuffer)

      if (code === 0) {
        resolve({ success: true })
      } else {
        console.error('[runPipWithProgress] pip failed with code:', code)
        console.error('[runPipWithProgress] stderr:', stderr.slice(-2000)) // Last 2000 chars
        resolve({ success: false, error: stderr || `pip exited with code ${code}` })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeoutId)
      clearKeepalive()
      resolve({ success: false, error: err.message })
    })
  })
}

// Download file with progress tracking
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const protocol = urlObj.protocol === 'https:' ? https : http

    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'Book-to-MP3/1.0'
      }
    }, (response) => {
      // Handle redirects (301, 302, 303, 307, 308)
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          // Handle relative redirect URLs by resolving against the original URL
          const absoluteRedirectUrl = new URL(redirectUrl, url).href
          downloadFile(absoluteRedirectUrl, destPath, onProgress).then(resolve).catch(reject)
          return
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: Failed to download ${url}`))
        return
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10)
      console.log(`[downloadFile] Starting download: ${url}, size: ${totalSize} bytes`)
      let downloadedSize = 0

      // Throttle progress updates to avoid UI flickering
      let lastProgressUpdate = 0
      const PROGRESS_THROTTLE_MS = 100 // Update at most every 100ms
      let lastReportedPercent = -1

      // Ensure directory exists
      const dir = path.dirname(destPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const fileStream = createWriteStream(destPath)

      // Live timeout - resets on each data chunk received
      const IDLE_TIMEOUT = 3600000 // 1 hour without data = timeout
      let timeoutId: NodeJS.Timeout | null = null

      const resetTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
        timeoutId = setTimeout(() => {
          request.destroy()
          if (existsSync(destPath)) {
            unlinkSync(destPath)
          }
          reject(new Error('Download timeout - no data received for 30 seconds'))
        }, IDLE_TIMEOUT)
      }

      const clearTimeoutHandler = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
      }

      // Start the timeout
      resetTimeout()

      response.on('data', (chunk: Buffer) => {
        downloadedSize += chunk.length
        resetTimeout() // Reset timeout on each chunk

        if (onProgress && totalSize > 0) {
          const now = Date.now()
          const currentPercent = Math.round((downloadedSize / totalSize) * 100)

          // Only update if enough time passed OR if percentage changed by at least 1%
          // Always update at 100%
          if (
            downloadedSize >= totalSize ||
            (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS && currentPercent !== lastReportedPercent)
          ) {
            lastProgressUpdate = now
            lastReportedPercent = currentPercent
            onProgress(downloadedSize, totalSize)
          }
        }
      })

      response.pipe(fileStream)

      fileStream.on('finish', () => {
        clearTimeoutHandler()
        fileStream.close()
        // Final progress update to ensure we report 100%
        if (onProgress && totalSize > 0) {
          onProgress(totalSize, totalSize)
        }
        // Verify download completed fully
        if (totalSize > 0 && downloadedSize < totalSize) {
          if (existsSync(destPath)) {
            unlinkSync(destPath)
          }
          reject(new Error(`Download incomplete: got ${downloadedSize} bytes, expected ${totalSize} bytes`))
          return
        }
        resolve()
      })

      fileStream.on('error', (err) => {
        clearTimeoutHandler()
        // Clean up partial file
        if (existsSync(destPath)) {
          unlinkSync(destPath)
        }
        reject(err)
      })
    })

    request.on('error', (err) => {
      reject(err)
    })
  })
}

// Extract ZIP file
export async function extractZip(zipPath: string, destPath: string): Promise<void> {
  if (!existsSync(destPath)) {
    mkdirSync(destPath, { recursive: true })
  }

  if (process.platform === 'darwin') {
    // Use system unzip on macOS (more reliable, no native module needed)
    await execAsync(`unzip -o "${zipPath}" -d "${destPath}"`, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 })
  } else {
    // Use adm-zip on Windows
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(zipPath)
    zip.extractAllTo(destPath, true)
  }
}

// Generate.py script content for Silero
export function getGenerateScriptContent(): string {
  return `#!/usr/bin/env python3
"""
Silero TTS Generation Script
Generates speech audio using Silero models
"""

import argparse
import os
import sys
import re
from pathlib import Path

try:
    import torch
except ImportError:
    print("Error: PyTorch not installed.", file=sys.stderr)
    print("Please install: pip install torch", file=sys.stderr)
    sys.exit(1)

try:
    import scipy.io.wavfile as wavfile
    import numpy as np
    from scipy import signal
except ImportError:
    print("Error: scipy/numpy not installed.", file=sys.stderr)
    print("Please install: pip install scipy numpy", file=sys.stderr)
    sys.exit(1)


def parse_rate(rate_str):
    """Parse rate string like '+50%' or '-25%' to a multiplier."""
    if not rate_str:
        return 1.0
    match = re.match(r'^([+-])(\\d+)%$', rate_str)
    if match:
        sign = match.group(1)
        percent = int(match.group(2))
        if sign == '+':
            return 1.0 + percent / 100
        else:
            return 1.0 - percent / 100
    return 1.0


def change_speed(audio, speed_factor):
    """Change audio speed by resampling."""
    if speed_factor == 1.0:
        return audio
    # Resample to change speed (higher speed = shorter audio)
    new_length = int(len(audio) / speed_factor)
    return signal.resample(audio, new_length)


def main():
    parser = argparse.ArgumentParser(description='Generate speech using Silero TTS')
    parser.add_argument('--text', required=True, help='Text to convert to speech')
    parser.add_argument('--speaker', required=True, help='Speaker model (e.g., v3_1_ru/aidar)')
    parser.add_argument('--output', required=True, help='Output WAV file path')
    parser.add_argument('--sample-rate', type=int, default=48000, help='Sample rate (default: 48000)')
    parser.add_argument('--rate', type=str, default='', help='Speed adjustment (e.g., +50%, -25%)')

    args = parser.parse_args()

    try:
        # Parse speaker path
        parts = args.speaker.split('/')
        if len(parts) != 2:
            raise ValueError(f"Invalid speaker path format: {args.speaker}")

        model_id = parts[0]  # e.g., 'v5_ru' or 'v3_en'
        speaker = parts[1]    # e.g., 'aidar', 'baya', etc.

        # Determine language
        if 'ru' in model_id:
            language = 'ru'
            model_name = 'v5_ru'
        elif 'en' in model_id:
            language = 'en'
            model_name = 'v3_en'
        else:
            raise ValueError(f"Unknown language in model: {model_id}")

        print(f"Loading Silero model: {model_name}, speaker: {speaker}", file=sys.stderr)

        # Load Silero model from torch hub
        device = torch.device('cpu')  # Use CPU for compatibility

        # Load model
        model, example_text = torch.hub.load(
            repo_or_dir='snakers4/silero-models',
            model='silero_tts',
            language=language,
            speaker=model_name
        )

        model.to(device)

        print(f"Generating audio for text length: {len(args.text)} characters", file=sys.stderr)

        # Generate audio with auto-stress and yo placement for Russian
        audio = model.apply_tts(
            text=args.text,
            speaker=speaker,
            sample_rate=args.sample_rate,
            put_accent=True,
            put_yo=True
        )

        # Save to WAV file
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Convert to numpy array
        if isinstance(audio, torch.Tensor):
            audio = audio.numpy()

        # Ensure 1D array for mono
        if audio.ndim > 1:
            audio = audio.squeeze()

        # Apply speed change if specified
        speed_factor = parse_rate(args.rate)
        if speed_factor != 1.0:
            print(f"Applying speed factor: {speed_factor}", file=sys.stderr)
            audio = change_speed(audio, speed_factor)

        # Normalize to int16 range
        audio = (audio * 32767).astype(np.int16)

        # Save using scipy
        wavfile.write(str(output_path), args.sample_rate, audio)

        print(f"Successfully generated audio: {args.output}", file=sys.stderr)
        return 0

    except Exception as e:
        print(f"Error generating audio: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
`
}

// Coqui generate script content
export function getCoquiGenerateScriptContent(): string {
  return `#!/usr/bin/env python3
"""Coqui XTTS-v2 TTS Generation Script with built-in speakers"""

import argparse
import os
import sys
from pathlib import Path

os.environ["COQUI_TOS_AGREED"] = "1"

# Fix for PyTorch 2.6+ weights_only default change
import torch
_orig_load = torch.load
def _patched_load(*a, **kw):
    if 'weights_only' not in kw:
        kw['weights_only'] = False
    return _orig_load(*a, **kw)
torch.load = _patched_load

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--text', required=True)
    parser.add_argument('--speaker', required=True, help='Built-in speaker name (e.g., "Claribel Dervla")')
    parser.add_argument('--language', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    from TTS.api import TTS

    # Normalize language code (app uses ru-RU, XTTS uses ru)
    lang = args.language.lower()
    if lang in ['ru-ru', 'ru_ru']:
        lang = 'ru'
    elif lang in ['en-us', 'en-gb', 'en_us', 'en_gb', 'en']:
        lang = 'en'

    device = "cuda" if torch.cuda.is_available() else "mps" if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available() else "cpu"
    # Note: Coqui XTTS-v2 does not support DirectML; use CPU as fallback
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)

    tts.tts_to_file(
        text=args.text,
        speaker=args.speaker,
        language=lang,
        file_path=args.output
    )

    print(f"Audio saved to {args.output}")

if __name__ == "__main__":
    main()
`
}

// TTS Server script content - Universal server for Silero, Coqui, and Qwen
export function getTTSServerScriptContent(): string {
  return `#!/usr/bin/env python3
"""Universal TTS Server for Silero, Coqui XTTS, and Qwen3-TTS"""

import argparse, gc, io, os, sys, re, threading, time
from pathlib import Path

os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

try:
    from flask import Flask, request, jsonify, Response
    import torch
    import psutil
    import numpy as np
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

# scipy is optional - only needed for Silero (WAV writing + speed change)
_scipy_wavfile = None
_scipy_signal = None
def _ensure_scipy():
    global _scipy_wavfile, _scipy_signal
    if _scipy_wavfile is None:
        import scipy.io.wavfile as wavfile
        from scipy import signal
        _scipy_wavfile = wavfile
        _scipy_signal = signal

_orig_load = torch.load
def _patched_load(*a, **kw):
    if 'weights_only' not in kw:
        kw['weights_only'] = False
    return _orig_load(*a, **kw)
torch.load = _patched_load

app = Flask(__name__)
models = {"silero": {"ru": None, "en": None}, "coqui": None, "qwen": None}
coqui_lock = threading.Lock()
qwen_lock = threading.Lock()
ruaccent_model = None

def load_ruaccent():
    """Lazy load ruaccent model for Russian stress placement."""
    global ruaccent_model
    if ruaccent_model is None:
        try:
            from ruaccent import RUAccent
            ruaccent_model = RUAccent()
            ruaccent_model.load(omograph_model_size='turbo', use_dictionary=True)
            print("ruaccent model loaded successfully", file=sys.stderr)
        except ImportError:
            print("ruaccent not installed, stress placement disabled", file=sys.stderr)
            return None
        except Exception as e:
            print(f"Failed to load ruaccent: {e}", file=sys.stderr)
            return None
    return ruaccent_model

def apply_stress_marks(text, lang):
    """Apply Russian stress marks to text if ruaccent is available and lang is Russian."""
    if lang not in ['ru', 'ru-ru', 'ru_ru']:
        return text
    model = load_ruaccent()
    if model is None:
        return text
    try:
        return model.process_all(text)
    except Exception as e:
        print(f"ruaccent processing failed: {e}", file=sys.stderr)
        return text

def detect_device():
    """Detect best available compute device. Priority: CUDA > MPS > DirectML > CPU"""
    device_info = {"device": "cpu", "backend": "cpu", "gpu_name": None}

    # Try CUDA (NVIDIA)
    if torch.cuda.is_available():
        try:
            device_info = {
                "device": "cuda",
                "backend": "cuda",
                "gpu_name": torch.cuda.get_device_name(0)
            }
            return device_info
        except:
            pass

    # Try MPS (Apple Silicon)
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        try:
            import platform
            chip = platform.processor() or "Apple Silicon"
            print(f"MPS available: chip={chip}", file=sys.stderr)
            device_info = {
                "device": "mps",
                "backend": "mps",
                "gpu_name": chip
            }
            return device_info
        except Exception as e:
            print(f"MPS detection failed: {e}", file=sys.stderr)

    # Try DirectML (AMD/Intel/NVIDIA via DirectX 12)
    try:
        import torch_directml
        dml_device = torch_directml.device()
        dml_name = torch_directml.device_name(0)
        print(f"DirectML available: device={dml_device}, name={dml_name}", file=sys.stderr)
        device_info = {
            "device": str(dml_device),
            "backend": "directml",
            "gpu_name": dml_name
        }
        return device_info
    except ImportError as e:
        print(f"DirectML not available (import error): {e}", file=sys.stderr)
    except Exception as e:
        print(f"DirectML detection failed: {e}", file=sys.stderr)

    return device_info

_device_info = detect_device()
device = _device_info["device"]
backend = _device_info["backend"]
gpu_name = _device_info["gpu_name"]
print(f"Using device: {device}, backend: {backend}, GPU: {gpu_name}", file=sys.stderr)

def get_memory_gb():
    """Get total memory used: process RSS + GPU memory (CUDA) or model params (MPS)."""
    rss = psutil.Process().memory_info().rss / (1024**3)
    try:
        if torch.cuda.is_available() and device != "cpu":
            return torch.cuda.memory_allocated() / (1024**3)
        # MPS/DirectML: estimate from model parameters (weights live in unified/GPU memory, not in RSS)
        if device != "cpu":
            total_params_bytes = 0
            for m in models.values():
                if m is None:
                    continue
                obj = m.get("model") if isinstance(m, dict) else m
                if obj is None:
                    continue
                # Walk all submodules looking for parameters
                mod = getattr(obj, "model", obj)
                if hasattr(mod, "parameters"):
                    for p in mod.parameters():
                        total_params_bytes += p.nelement() * p.element_size()
            if total_params_bytes > 0:
                return total_params_bytes / (1024**3)
    except Exception:
        pass
    return rss

def parse_rate(rate_str):
    if not rate_str:
        return 1.0
    m = re.match(r'^([+-])(\\d+)%$', str(rate_str))
    if m:
        return 1.0 + int(m.group(2)) / 100 if m.group(1) == '+' else 1.0 - int(m.group(2)) / 100
    try:
        return float(rate_str)
    except Exception:
        return 1.0

def change_speed(audio, factor):
    if factor == 1.0:
        return audio
    _ensure_scipy()
    return _scipy_signal.resample(audio, int(len(audio) / factor))

def audio_to_wav_bytes(audio, sr=48000):
    if isinstance(audio, torch.Tensor):
        audio = audio.numpy()
    if audio.ndim > 1:
        audio = audio.squeeze()
    _ensure_scipy()
    buf = io.BytesIO()
    _scipy_wavfile.write(buf, sr, (audio * 32767).astype(np.int16))
    buf.seek(0)
    return buf.read()

def load_silero_model(lang):
    global models
    model_name = 'v5_ru' if lang == 'ru' else 'v3_en'
    print(f"Loading Silero {model_name}...", file=sys.stderr)
    model, _ = torch.hub.load('snakers4/silero-models', 'silero_tts', language=lang, speaker=model_name)
    # Try to use detected device, fall back to CPU if it fails
    target_device = device
    try:
        model.to(torch.device(target_device))
    except Exception as e:
        print(f"Failed to load Silero on {target_device}: {e}. Falling back to CPU.", file=sys.stderr)
        target_device = "cpu"
        model.to(torch.device("cpu"))
    models["silero"][lang] = model
    print(f"Silero {lang} loaded on {target_device}. Memory: {get_memory_gb():.2f} GB", file=sys.stderr)
    # Pre-load ruaccent model when loading Russian Silero
    if lang == 'ru':
        print("Pre-loading ruaccent model...", file=sys.stderr)
        load_ruaccent()
        print(f"Silero ready. Memory: {get_memory_gb():.2f} GB", file=sys.stderr)

def generate_silero(text, speaker, lang, rate=1.0, sr=48000):
    if models["silero"].get(lang) is None:
        raise RuntimeError(f"Silero model for '{lang}' is not loaded. Please load it first.")
    model = models["silero"][lang]
    spk = speaker.split('/')[-1] if '/' in speaker else speaker
    audio = model.apply_tts(text=text, speaker=spk, sample_rate=sr, put_accent=True, put_yo=True)
    if isinstance(audio, torch.Tensor):
        audio = audio.numpy()
    if audio.ndim > 1:
        audio = audio.squeeze()
    factor = parse_rate(rate) if isinstance(rate, str) else rate
    if factor != 1.0:
        audio = change_speed(audio, factor)
    return audio_to_wav_bytes(audio, sr)

def patch_gpt2_for_directml():
    """Patch torch for DirectML compatibility.
    1) inference_mode -> no_grad (version_counter errors)
    2) gather: cast int64 indices to int32 (DirectML gather bug)"""
    try:
        torch.inference_mode = lambda mode=True: torch.no_grad()
        _orig_gather = torch.gather
        def _dml_gather(input, dim, index, **kw):
            if index.dtype == torch.int64:
                index = index.to(torch.int32)
            return _orig_gather(input, dim, index, **kw)
        torch.gather = _dml_gather
        _orig_scatter = torch.Tensor.scatter
        def _dml_scatter(self, dim, index, *a, **kw):
            if index.dtype == torch.int64:
                index = index.to(torch.int32)
            return _orig_scatter(self, dim, index, *a, **kw)
        torch.Tensor.scatter = _dml_scatter
        _orig_scatter_ = torch.Tensor.scatter_
        def _dml_scatter_(self, dim, index, *a, **kw):
            if index.dtype == torch.int64:
                index = index.to(torch.int32)
            return _orig_scatter_(self, dim, index, *a, **kw)
        torch.Tensor.scatter_ = _dml_scatter_
        print("Patched torch.inference_mode, gather, scatter for DirectML compatibility", file=sys.stderr)
    except Exception as e:
        print(f"Failed to patch for DirectML: {e}", file=sys.stderr)

def load_coqui_model():
    global models
    print("Loading Coqui XTTS-v2...", file=sys.stderr)
    if backend == "directml":
        patch_gpt2_for_directml()
    from TTS.api import TTS
    models["coqui"] = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
    print(f"Coqui loaded on {device}. Memory: {get_memory_gb():.2f} GB", file=sys.stderr)

def generate_coqui(text, speaker, lang):
    l = lang.lower()
    if l in ['ru-ru', 'ru_ru']:
        l = 'ru'
    elif l in ['en-us', 'en-gb', 'en_us', 'en_gb']:
        l = 'en'
    with coqui_lock:
        if models["coqui"] is None:
            raise RuntimeError("Coqui model is not loaded. Please load it first.")
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            tmp = f.name
        try:
            models["coqui"].tts_to_file(text=text, speaker=speaker, language=l, file_path=tmp)
            with open(tmp, 'rb') as f:
                return f.read()
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

def load_qwen_model():
    global models
    print("Loading Qwen3-TTS...", file=sys.stderr)
    # Enable MPS Flash Attention for faster inference on Apple Silicon
    if backend == "mps":
        try:
            from mps_flash_attn import replace_sdpa
            replace_sdpa()
            print("MPS Flash Attention enabled", file=sys.stderr)
        except ImportError:
            print("mps-flash-attn not installed, using default SDPA", file=sys.stderr)
        except Exception as e:
            print(f"Failed to enable MPS Flash Attention: {e}", file=sys.stderr)
    try:
        from qwen_tts import Qwen3TTSModel
        model_name = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
        print(f"Loading Qwen model: {model_name}", file=sys.stderr)
        target_device = device
        load_kwargs = {}
        # DirectML: device_map is not supported by HuggingFace accelerate (requires CUDA).
        # Load on CPU first, then move to DirectML device manually.
        if backend == "directml":
            patch_gpt2_for_directml()
            load_kwargs["device_map"] = "cpu"
        elif target_device != "cpu":
            load_kwargs["device_map"] = target_device
            load_kwargs["dtype"] = torch.bfloat16
        else:
            load_kwargs["device_map"] = "cpu"
        try:
            model = Qwen3TTSModel.from_pretrained(model_name, **load_kwargs)
            # DirectML: move model to GPU after loading on CPU
            if backend == "directml" and target_device != "cpu":
                try:
                    dml_dev = torch.device(target_device)
                    # Convert to float16 first to halve VRAM usage (DirectML does not support bfloat16)
                    model.model.to(dtype=torch.float16)
                    model.model.to(dml_dev)
                    model.device = dml_dev
                    print(f"Qwen model moved to {target_device} (float16)", file=sys.stderr)
                except Exception as move_err:
                    print(f"Failed to move Qwen to {target_device}: {move_err}. Recovering to CPU.", file=sys.stderr)
                    target_device = "cpu"
                    # Recover from partial .to() — move everything back to CPU
                    model.model.to(dtype=torch.float32, device=torch.device("cpu"))
                    model.device = torch.device("cpu")
        except Exception as e:
            if target_device != "cpu":
                print(f"Failed to load Qwen on {target_device}: {e}. Falling back to CPU.", file=sys.stderr)
                target_device = "cpu"
                model = Qwen3TTSModel.from_pretrained(model_name, device_map="cpu")
            else:
                raise
        # torch.compile with aot_eager was tested but gives no measurable benefit
        # for autoregressive token-by-token decoding on MPS (Qwen3-TTS 1.7B).
        # The overhead of compilation + warmup outweighs any per-token speedup.
        # if backend == "mps":
        #     try:
        #         model.model.talker = torch.compile(model.model.talker, backend="aot_eager")
        #         model.generate_custom_voice(text="Test.", language="English", speaker=list(model.get_supported_speakers())[0])
        #         print("torch.compile applied to Qwen talker (aot_eager)", file=sys.stderr)
        #     except Exception as ce:
        #         print(f"torch.compile failed, using eager mode: {ce}", file=sys.stderr)
        models["qwen"] = {"model": model, "device": target_device}
        print(f"Qwen loaded on {target_device}. Memory: {get_memory_gb():.2f} GB", file=sys.stderr)
        try:
            speakers = model.get_supported_speakers()
            print(f"Qwen speakers: {speakers}", file=sys.stderr)
        except Exception:
            pass
    except Exception as e:
        print(f"Failed to load Qwen: {e}", file=sys.stderr)
        raise

def generate_qwen(text, speaker, lang, instruction=None):
    with qwen_lock:
        if models["qwen"] is None:
            raise RuntimeError("Qwen model is not loaded. Please load it first.")
        
        model_data = models["qwen"]
        model = model_data["model"]
        
        # Map language codes to Qwen language names
        lang_map = {
            "ru": "Russian", "ru-ru": "Russian", "ru_ru": "Russian",
            "en": "English", "en-us": "English", "en-gb": "English", "en_us": "English", "en_gb": "English",
            "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
            "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese"
        }
        language = lang_map.get(lang.lower(), "Auto")
        
        try:
            import soundfile as sf
            wavs, sr = model.generate_custom_voice(
                text=text,
                language=language,
                speaker=speaker,
                instruct=instruction or "",
            )
            # Convert to WAV bytes
            buf = io.BytesIO()
            sf.write(buf, wavs[0], sr, format='WAV')
            buf.seek(0)
            return buf.read()
        except Exception as e:
            print(f"Qwen generation failed: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            raise

@app.route("/status", methods=["GET"])
def status():
    return jsonify({
        "silero": {"ru_loaded": models["silero"]["ru"] is not None, "en_loaded": models["silero"]["en"] is not None},
        "coqui": {"loaded": models["coqui"] is not None},
        "qwen": {"loaded": models["qwen"] is not None},
        "memory_gb": round(get_memory_gb(), 2),
        "device": device,
        "backend": backend,
        "gpu_name": gpu_name
    })

@app.route("/load", methods=["POST"])
def load_model():
    data = request.json or {}
    engine, lang = data.get("engine"), data.get("language", "ru")
    if not engine:
        return jsonify({"error": "Missing engine"}), 400
    try:
        if engine == "silero" and models["silero"].get(lang) is None:
            load_silero_model(lang)
        elif engine == "coqui" and models["coqui"] is None:
            load_coqui_model()
        elif engine == "qwen" and models["qwen"] is None:
            load_qwen_model()
        return jsonify({"success": True, "memory_gb": round(get_memory_gb(), 2)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/unload", methods=["POST"])
def unload_model():
    data = request.json or {}
    engine, lang = data.get("engine"), data.get("language")
    if engine == "silero":
        if lang:
            models["silero"][lang] = None
        else:
            models["silero"] = {"ru": None, "en": None}
    elif engine == "coqui":
        models["coqui"] = None
    elif engine == "qwen":
        models["qwen"] = None
    elif engine == "all":
        models["silero"] = {"ru": None, "en": None}
        models["coqui"] = None
        models["qwen"] = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return jsonify({"success": True, "memory_gb": round(get_memory_gb(), 2)})

@app.route("/generate", methods=["POST"])
def generate():
    data = request.json or {}
    engine, text, speaker = data.get("engine"), data.get("text"), data.get("speaker")
    lang, rate = data.get("language", "ru"), data.get("rate", 1.0)
    use_ruaccent = data.get("use_ruaccent", False)
    instruction = data.get("instruction")
    if not all([engine, text, speaker]):
        return jsonify({"error": "Missing params"}), 400
    try:
        if engine == "silero":
            # Apply ruaccent stress marks only for Silero
            processed_text = apply_stress_marks(text, lang) if use_ruaccent else text
            audio = generate_silero(processed_text, speaker, lang, rate)
        elif engine == "coqui":
            audio = generate_coqui(text, speaker, lang)
        elif engine == "qwen":
            audio = generate_qwen(text, speaker, lang, instruction)
        else:
            return jsonify({"error": f"Unknown engine: {engine}"}), 400
        return Response(audio, mimetype="audio/wav")
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        error_msg = str(e) or repr(e) or "Unknown error occurred"
        return jsonify({"error": error_msg}), 500

@app.route("/generate-batch", methods=["POST"])
def generate_batch():
    """Batch generation for Qwen — generates multiple texts in one model call."""
    data = request.json or {}
    items = data.get("items", [])
    if not items:
        return jsonify({"error": "Missing items"}), 400
    engine = items[0].get("engine", "qwen")
    if engine != "qwen":
        return jsonify({"error": "Batch generation only supported for qwen"}), 400
    try:
        with qwen_lock:
            if models["qwen"] is None:
                raise RuntimeError("Qwen model is not loaded.")
            model_data = models["qwen"]
            model = model_data["model"]
            lang_map = {
                "ru": "Russian", "ru-ru": "Russian", "ru_ru": "Russian",
                "en": "English", "en-us": "English", "en-gb": "English",
                "en_us": "English", "en_gb": "English",
                "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
                "de": "German", "fr": "French", "es": "Spanish",
                "it": "Italian", "pt": "Portuguese"
            }
            texts = [it["text"] for it in items]
            speakers = [it["speaker"] for it in items]
            languages = [lang_map.get(it.get("language", "en").lower(), "Auto") for it in items]
            instructs = [it.get("instruction") or "" for it in items]
            wavs_list, sr = model.generate_custom_voice(
                text=texts,
                language=languages,
                speaker=speakers,
                instruct=instructs,
            )
            import base64 as b64mod
            import soundfile as sf
            results = []
            for i, wav_data in enumerate(wavs_list):
                wav_buf = io.BytesIO()
                sf.write(wav_buf, wav_data, sr, format="WAV")
                wav_buf.seek(0)
                results.append(b64mod.b64encode(wav_buf.read()).decode("ascii"))
            return jsonify({"wavs": results, "sr": sr})
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return jsonify({"error": str(e) or repr(e)}), 500

@app.route("/shutdown", methods=["POST"])
def shutdown():
    global models
    models = {"silero": {"ru": None, "en": None}, "coqui": None, "qwen": None}
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    threading.Thread(target=lambda: (time.sleep(0.5), os._exit(0))).start()
    return jsonify({"success": True})

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=5050)
    p.add_argument("--host", type=str, default="127.0.0.1")
    args = p.parse_args()
    print(f"TTS Server on {args.host}:{args.port}, device={device}", file=sys.stderr)
    app.run(host=args.host, port=args.port, threaded=True)
`
}

// Find vcvarsall.bat path for setting up MSVC environment (Windows only)
export async function findVcvarsallPath(): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null
  }

  const checkVcvarsall = (basePath: string): string | null => {
    const vcvarsallPath = path.join(basePath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
    if (existsSync(vcvarsallPath)) {
      return vcvarsallPath
    }
    return null
  }

  const vswherePaths = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe'
  ]

  for (const vswherePath of vswherePaths) {
    if (existsSync(vswherePath)) {
      try {
        const { stdout } = await execAsync(
          `"${vswherePath}" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
          { timeout: 10000 }
        )
        if (stdout.trim()) {
          const vcvarsall = checkVcvarsall(stdout.trim())
          if (vcvarsall) return vcvarsall
        }
      } catch {
        // Continue to fallback
      }
    }
  }

  const possibleVsPaths = [
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools',
    'C:\\Program Files\\Microsoft Visual Studio\\2019\\BuildTools',
  ]

  for (const vsPath of possibleVsPaths) {
    const vcvarsall = checkVcvarsall(vsPath)
    if (vcvarsall) return vcvarsall
  }

  return null
}
