#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const arg = process.argv[2] || 'all';

if (process.platform === 'win32') {
  const script = arg === 'silero' ? 'setup-silero.ps1' : 'setup-all.ps1';
  const scriptPath = path.join(__dirname, script);
  execSync(`powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`, { stdio: 'inherit' });
} else {
  const script = path.join(__dirname, 'setup-macos.sh');
  execSync(`bash "${script}" ${arg}`, { stdio: 'inherit' });
}
