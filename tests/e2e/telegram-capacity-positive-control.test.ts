import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, access, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

let active: ChildProcess | undefined;
afterEach(async () => {
  if (active && active.exitCode === null && active.signalCode === null) {
    const child = active;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}, 60_000);

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function listenerExists(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('exact listener check timed out')); }, 1500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', error => {
      clearTimeout(timer); socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

// OriginNoticeIpc is a chmod-protected POSIX filesystem socket. This is an
// explicit platform boundary, not a successful proof on an unsupported host.
it.skipIf(process.platform === 'win32')('persists the real IPC lease refusal on the built distribution and exits with verified teardown', async () => {
  const invocationId = randomUUID();
  const evidenceParent = path.resolve('.instar/test-evidence/n82-capacity');
  await mkdir(evidenceParent, { recursive: true, mode: 0o700 });
  const evidenceDir = path.join(evidenceParent, invocationId);
  await mkdir(evidenceDir, { mode: 0o700 }); // Refuse reuse rather than inheriting any prior receipt.
  const receiptPath = path.join(evidenceDir, 'receipt.json');
  expect(await access(receiptPath).then(() => true, () => false)).toBe(false);
  const child = spawn(process.execPath, [path.resolve('tests/fixtures/telegram-capacity-positive-control/front.mjs')], {
    cwd: process.cwd(),
    env: { HOME: process.env.HOME!, PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? '/tmp',
      N82_PROOF_INVOCATION_ID: invocationId, N82_PROOF_RECEIPT_PATH: receiptPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active = child;
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await Promise.all([writeFile(path.join(evidenceDir, 'stdout.log'), stdout), writeFile(path.join(evidenceDir, 'stderr.log'), stderr)]);
  expect(exit, stderr + stdout).toEqual({ code: 0, signal: null }); // Natural front-process exit is mandatory.
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  expect(receipt.invocationId).toBe(invocationId);
  expect(receipt.receiptPath).toBe(receiptPath);
  expect(receipt.frontPid).toBe(child.pid);
  expect(Number.isSafeInteger(receipt.ownerPid) && receipt.ownerPid > 0).toBe(true);
  expect(receipt.ownerPid).not.toBe(receipt.frontPid);
  expect(receipt.routeTimersCleared).toBeGreaterThan(0);
  expect(receipt.routeTimersBeforeOperation.some((timer: { delayMs: number; refNow: boolean }) => timer.delayMs === 300_000 && timer.refNow)).toBe(true);
  expect(receipt).toMatchObject({ verdict: 'PASS', transportStarts: 0, homeExistsAfterCleanup: false,
    ownerStopped: { reserveCalls: 1, consumeCalls: 0 }, ownerExit: { code: 0, signal: null }, cleanupErrors: [] });
  const independentTeardown = {
    frontExists: processExists(receipt.frontPid), ownerExists: processExists(receipt.ownerPid),
    listenerExists: await listenerExists(receipt.port),
    homeExists: await access(receipt.root).then(() => true, () => false),
    socketExists: await access(receipt.socketPath).then(() => true, () => false),
  };
  await writeFile(path.join(evidenceDir, 'independent-teardown.json'), JSON.stringify(independentTeardown, null, 2));
  expect(independentTeardown).toEqual({ frontExists: false, ownerExists: false, listenerExists: false, homeExists: false, socketExists: false });
  // Retained in normal verification stdout even if the successful checkout is later removed.
  console.info('N82 positive-control receipt:', JSON.stringify({ ...receipt, independentTeardown }));
});
