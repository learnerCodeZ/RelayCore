import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function protectForCurrentUser(value, decrypt = false) {
  const operation = decrypt
    ? '$bytes = [Convert]::FromBase64String($inputText); $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))'
    : '$bytes = [Text.Encoding]::UTF8.GetBytes($inputText); $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))';
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; $inputText = [Console]::In.ReadToEnd(); $entropy = [Text.Encoding]::UTF8.GetBytes('RelayCore control v1'); ${operation}`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((done, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let output = '';
    const fail = (message) => {
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('Local credential operation timed out'), 10000);
    child.stderr.resume();
    child.on('error', () => fail('Cannot start Windows local credential helper'));
    child.stdin.on('error', () => fail('Local credential helper input failed'));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 16384) fail('Local credential helper output exceeded limit');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Local credential protection failed; use the same Windows user and profile'));
      else done(output.trim());
    });
    child.stdin.end(value);
  });
}

export async function getControlToken(root, { create = false } = {}) {
  const supplied = process.env.RELAYCORE_TOKEN;
  if (supplied !== undefined) {
    if (supplied.length < 32) throw new Error('RELAYCORE_TOKEN must contain at least 32 characters');
    return supplied;
  }
  if (process.platform !== 'win32') throw new Error('Set RELAYCORE_TOKEN to a private value of at least 32 characters');
  const dataDir = join(resolve(root), '.RelayCore');
  const bridgeDir = join(dataDir, 'bridge');
  for (const directory of [dataDir, bridgeDir]) {
    if (create) await mkdir(directory).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Local control credential is missing; start the RelayCore Daemon for this project first');
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local credential directory must be a plain directory');
  }
  const path = join(bridgeDir, 'control-token.dpapi');
  let protectedToken;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('Local credential must be a plain file of at most 16 KiB');
    protectedToken = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) {
      if (error.code === 'ENOENT') throw new Error('Local control credential is missing; start the RelayCore Daemon for this project first');
      throw error;
    }
    const token = randomBytes(32).toString('hex');
    const encrypted = await protectForCurrentUser(token);
    if (!encrypted || encrypted.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new Error('Invalid protected credential output');
    await writeFile(path, encrypted, { flag: 'wx', mode: 0o600 });
    return token;
  }
  if (!protectedToken || protectedToken.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(protectedToken)) throw new Error('Invalid local credential file; it has not been replaced');
  const token = await protectForCurrentUser(protectedToken, true);
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid decrypted local credential');
  return token;
}
