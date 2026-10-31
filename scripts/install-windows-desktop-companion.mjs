/** Explicit WSL-side installer for the interactive Windows desktop companion.
 * Never runs from ordinary package installation or on a non-WSL host. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--enable')) throw new Error('Pass --enable after operator opt-in');
if (process.platform !== 'linux' || !/microsoft|wsl/i.test(os.release())) {
  throw new Error('Windows companion installer requires WSL');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'dist/native/windows/InstarDesktopCompanion.cs');
if (!fs.existsSync(source)) throw new Error('Packaged Windows companion source is missing');
const appData = execFileSync('cmd.exe', ['/c', 'echo', '%LOCALAPPDATA%'], {
  encoding: 'utf8', timeout: 3_000, maxBuffer: 4_096,
}).replace(/\r/g, '').trim();
if (!/^[A-Za-z]:\\/.test(appData) || appData.includes('%')) throw new Error('Windows user directory unavailable');
const linuxAppData = execFileSync('wslpath', ['-u', appData], {
  encoding: 'utf8', timeout: 3_000, maxBuffer: 4_096,
}).trim();
const route = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)
  .map(line => line.trim().split(/\s+/))
  .find(parts => parts[1] === '00000000' && /^[a-f0-9]{8}$/i.test(parts[2] || ''));
if (!route) throw new Error('WSL gateway unavailable');
const gateway = route[2].match(/../g).reverse().map(byte => parseInt(byte, 16)).join('.');
const octets = gateway.split('.').map(Number);
if (!(octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  || (octets[0] === 192 && octets[1] === 168))) throw new Error('WSL gateway is not private');
const dest = path.join(linuxAppData, 'InstarDesktop');
fs.mkdirSync(dest, { recursive: true });
const lockPath = path.join(dest, 'install.lock');
if (!process.argv.includes('--locked')) {
  // flock owns the file descriptor for the entire child process and the kernel
  // releases it on crash or timeout. The lock file itself may safely persist.
  const receipt = execFileSync('flock', ['-n', '-F', lockPath, process.execPath,
    fileURLToPath(import.meta.url), '--enable', '--locked'], {
    encoding: 'utf8', timeout: 130_000, maxBuffer: 16_384,
  });
  process.stdout.write(receipt);
  process.exit(0);
}
const destSource = path.join(dest, 'InstarDesktopCompanion.cs');
const destScript = path.join(dest, 'install.ps1');
fs.copyFileSync(source, destSource);
fs.copyFileSync(path.join(root, 'scripts/install-windows-desktop-companion.ps1'), destScript);
const toWindows = localPath => execFileSync('wslpath', ['-w', localPath], {
  encoding: 'utf8', timeout: 3_000, maxBuffer: 4_096,
}).trim();
const existingSecret = path.join(dest, 'companion.secret');
const runPhase = phase => {
  const receipt = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', toWindows(destScript),
    '-Source', toWindows(destSource), '-BindAddress', gateway, '-Port', '44818', '-Phase', phase,
  ], { encoding: 'utf8', timeout: 55_000, maxBuffer: 16_384 }).trim();
  return JSON.parse(receipt.split(/\r?\n/).at(-1));
};
const staged = runPhase('Stage');
if (staged.staged !== true || typeof staged.taskRunning !== 'boolean') {
  throw new Error('Windows companion stage did not confirm its task state');
}
let updateToken;
let cancelUpdate;
if (staged.taskRunning) {
  if (!fs.existsSync(existingSecret)) throw new Error('Running companion has no shared secret');
  const secret = fs.readFileSync(existingSecret);
  if (secret.length !== 32) throw new Error('Existing Windows companion secret is invalid');
  const request = async (op, data) => {
    const body = JSON.stringify(data);
    const timestamp = String(Date.now());
    const nonce = randomBytes(24).toString('base64url');
    const digest = createHash('sha256').update(body).digest('hex');
    const mac = createHmac('sha256', secret)
      .update(`instar-windows-desktop-v1\n${op}\n${timestamp}\n${nonce}\n${digest}`)
      .digest('base64url');
      const response = await fetch(`http://${gateway}:44818/${op}`, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(2_000),
        headers: { 'Content-Type': 'application/json', 'X-Instar-Desktop-Time': timestamp,
          'X-Instar-Desktop-Nonce': nonce, 'X-Instar-Desktop-Mac': mac },
      });
      if (response.ok && response.headers.get('content-type')?.split(';')[0] === 'application/json') {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Companion update reply empty');
        const chunks = []; let size = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4_096) { await reader.cancel(); throw new Error('Companion update reply too large'); }
          chunks.push(Buffer.from(value));
        }
        const result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        return result;
      }
      throw new Error(`Windows companion ${op} refused`);
  };
  for (let attempt = 0; attempt < 8 && !updateToken; attempt++) {
    try {
      const prepared = await request('prepare-update', {});
      if (prepared?.ok === true && /^[A-Za-z0-9_-]{32}$/.test(prepared.updateToken)) {
        updateToken = prepared.updateToken;
      }
    } catch {
      if (attempt === 7) throw new Error('Running Windows companion did not prepare for update');
    }
    if (!updateToken) await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  if (!updateToken) throw new Error('Running Windows companion did not return an update token');
  cancelUpdate = () => request('cancel-update', { updateToken });
  try {
    const committed = await request('commit-update', { updateToken });
    if (committed?.ok !== true) throw new Error('Windows companion did not commit update');
  } catch {
    // A self-exit can race its final TCP reply. The next phase only replaces
    // the binary after Task Scheduler confirms that the old task has stopped.
  }
}
let installed;
try { installed = runPhase('InstallPrepared'); }
catch (error) {
  if (cancelUpdate) {
    try { await cancelUpdate(); } catch { /* The process may have exited. */ }
  }
  throw error;
}
if (installed.installed !== true || installed.bindAddress !== gateway || installed.port !== 44818) {
  throw new Error('Windows companion installer did not confirm its task');
}
console.log('Installed interactive Windows desktop companion on the WSL bridge');
