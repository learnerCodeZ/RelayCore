import { execFileSync, spawn } from 'node:child_process';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexReviewEnvironment } from '../src/review.mjs';

const mode = process.argv[2];
if (mode !== undefined && mode !== '--status') throw new Error('Usage: node scripts/login-codex-review.mjs [--status]');
const root = fileURLToPath(new URL('../', import.meta.url));
const data = join(root, '.RelayCore');
const home = join(data, 'codex-review-home');
for (const directory of [data, home]) {
  await mkdir(directory).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Review login directory must be a plain directory');
}
if (process.platform === 'win32') {
  const script = `$ErrorActionPreference = 'Stop'; $target = [Console]::In.ReadToEnd();
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User;
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18');
    $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false);
    foreach ($identity in @($owner, $system)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')); }
    [IO.Directory]::SetAccessControl($target, $acl);
    $auth = [IO.Path]::Combine($target, 'auth.json');
    if ([IO.File]::Exists($auth)) {
      if ([IO.File]::GetAttributes($auth) -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked credential file'; }
      $fileAcl = [Security.AccessControl.FileSecurity]::new(); $fileAcl.SetAccessRuleProtection($true, $false);
      foreach ($identity in @($owner, $system)) { $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')); }
      [IO.File]::SetAccessControl($auth, $fileAcl);
    }`;
  try {
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: home, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, timeout: 10000 });
  } catch { throw new Error('Cannot protect the dedicated review login directory'); }
} else {
  await chmod(home, 0o700);
}
const cli = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));
const child = spawn(process.execPath, [cli, '-c', 'cli_auth_credentials_store="file"', 'login', ...(mode === '--status' ? ['status'] : [])], {
  env: codexReviewEnvironment(home), stdio: mode === '--status' ? 'ignore' : 'inherit', windowsHide: mode === '--status'
});
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
if (mode === '--status') process.stdout.write(`${JSON.stringify({ authenticated: code === 0 })}\n`);
process.exitCode = code ?? 1;
