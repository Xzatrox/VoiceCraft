# Qwen3-TTS Setup Script for Windows

param(
    [Parameter(Mandatory=$false)]
    [ValidateSet('cpu', 'cuda', 'directml')]
    [string]$Accelerator = 'cpu'
)

$ErrorActionPreference = "Stop"

# Get script and project directories
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
Set-Location $projectDir

Write-Host "====================================" -ForegroundColor Cyan
Write-Host "   Qwen3-TTS Setup Script" -ForegroundColor Cyan
Write-Host "   Accelerator: $Accelerator" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""

# Check if Python is installed
Write-Host "Checking for Python installation..." -ForegroundColor Yellow
$pythonCmd = $null

$pythonPaths = @("python", "python3", "py")
foreach ($cmd in $pythonPaths) {
    try {
        $version = & $cmd --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            $pythonCmd = $cmd
            Write-Host "Found Python: $version" -ForegroundColor Green
            break
        }
    } catch {
        continue
    }
}

if (-not $pythonCmd) {
    Write-Host "ERROR: Python not found!" -ForegroundColor Red
    Write-Host "Please install Python 3.9 or newer from https://www.python.org/downloads/" -ForegroundColor Yellow
    exit 1
}

# Create resources directory
$resourcesDir = "tts_resources"
$qwenDir = "$resourcesDir\qwen-$Accelerator"
$venvPython = "$qwenDir\venv\Scripts\python.exe"

# Check if Qwen is already installed
if (Test-Path $venvPython) {
    Write-Host "`nChecking existing Qwen installation..." -ForegroundColor Yellow
    $testResult = & $venvPython -c "import torch; import transformers; print('OK')" 2>&1
    if ($testResult -match "OK") {
        Write-Host "Qwen3-TTS already installed and working, skipping..." -ForegroundColor Green

        # Just update the generation script if needed
        $genScript = "$scriptDir\qwen_generate.py"
        if (Test-Path $genScript) {
            Copy-Item $genScript "$qwenDir\generate.py" -Force
        }

        Write-Host "`n====================================" -ForegroundColor Cyan
        Write-Host "   Qwen3-TTS Ready!" -ForegroundColor Green
        Write-Host "====================================" -ForegroundColor Cyan
        exit 0
    }
}

Write-Host "`nCreating directory structure..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $qwenDir | Out-Null

# Create virtual environment
Write-Host "`nCreating Python virtual environment..." -ForegroundColor Yellow
& $pythonCmd -m venv "$qwenDir\venv"

if (-not (Test-Path $venvPython)) {
    Write-Host "ERROR: Failed to create virtual environment" -ForegroundColor Red
    exit 1
}

Write-Host "Virtual environment created successfully" -ForegroundColor Green

# Upgrade pip
Write-Host "`nUpgrading pip..." -ForegroundColor Yellow
& $venvPython -m pip install --upgrade pip --no-input

# Install PyTorch based on accelerator
Write-Host "`nInstalling PyTorch for $Accelerator..." -ForegroundColor Yellow
Write-Host "This may take several minutes..." -ForegroundColor Gray

switch ($Accelerator) {
    'cuda' {
        Write-Host "Installing CUDA version (~3.5 GB download)..." -ForegroundColor Gray
        & $venvPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121 --no-input
    }
    'directml' {
        Write-Host "Installing DirectML version (~1.4 GB download)..." -ForegroundColor Gray
        & $venvPython -m pip install torch-directml --no-input
    }
    'cpu' {
        Write-Host "Installing CPU version (~1.3 GB download)..." -ForegroundColor Gray
        & $venvPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu --no-input
    }
}

# Install transformers and dependencies
Write-Host "`nInstalling transformers and dependencies..." -ForegroundColor Yellow
& $venvPython -m pip install transformers accelerate soundfile --no-input

# Copy generation script
Write-Host "`nCopying generation script..." -ForegroundColor Yellow
Copy-Item "$scriptDir\qwen_generate.py" "$qwenDir\generate.py" -Force

# Create accelerator config file
Write-Host "`nCreating accelerator configuration..." -ForegroundColor Yellow
$configContent = @{
    accelerator = $Accelerator
    created = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json
Set-Content -Path "$qwenDir\accelerator.json" -Value $configContent -Encoding UTF8

# Create wrapper script
$wrapperScript = @"
@echo off
"%~dp0venv\Scripts\python.exe" "%~dp0generate.py" %*
"@

Set-Content -Path "$qwenDir\qwen_generate.bat" -Value $wrapperScript -Encoding ASCII

Write-Host "`nTesting Qwen installation..." -ForegroundColor Yellow
$testResult = & $venvPython -c "import torch; import transformers; print('OK')" 2>&1

if ($testResult -match "OK") {
    Write-Host "Qwen3-TTS installed successfully!" -ForegroundColor Green
} else {
    Write-Host "WARNING: Qwen installation test failed" -ForegroundColor Yellow
    Write-Host "Error: $testResult" -ForegroundColor Red
}

Write-Host "`n====================================" -ForegroundColor Cyan
Write-Host "   Setup Complete!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Qwen3-TTS has been installed in: $qwenDir" -ForegroundColor White
Write-Host "Accelerator: $Accelerator" -ForegroundColor White
Write-Host ""
Write-Host "NOTE: First-time usage will download the Qwen3-TTS model (~1.5 GB)" -ForegroundColor Yellow
Write-Host "The model will be cached in the Hugging Face cache directory." -ForegroundColor Yellow
Write-Host ""
Write-Host "You can now use Qwen voices with instruction-based control!" -ForegroundColor Green
