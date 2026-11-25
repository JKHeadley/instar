import fs from 'node:fs';
import path from 'node:path';

const NATIVE_SESSION_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RECEIPT = 'instar-start-receipt';
const RELEASE = 'instar-start-release';

function quoteShellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Install a launch-local hook in a fresh private worker home. */
export function createManagedCodexStartupBarrier(home: string, launchId: string) {
  const hookPath = path.join(home, 'instar-managed-start.cjs');
  const receiptPath = path.join(home, RECEIPT);
  const releasePath = path.join(home, RELEASE);
  fs.writeFileSync(hookPath, `
const fs = require('node:fs');
const path = require('node:path');
const deadline = performance.now() + 20_000;
async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (process.env.INSTAR_SESSION_ID !== ${JSON.stringify(launchId)}
      || typeof input.session_id !== 'string' || !${NATIVE_SESSION_PATTERN}.test(input.session_id)) {
    throw new Error('invalid managed startup receipt');
  }
  const nativeSessionId = input.session_id;
  fs.writeFileSync(path.join(__dirname, ${JSON.stringify(RECEIPT)}), nativeSessionId, { flag: 'wx', mode: 0o600 });
  const release = path.join(__dirname, ${JSON.stringify(RELEASE)});
  while (performance.now() < deadline) {
    try {
      if (fs.readFileSync(release, 'utf8') === nativeSessionId) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('managed startup release timed out');
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
`, { flag: 'wx', mode: 0o600 });

  function readReceipt(): string | undefined {
    try {
      const id = fs.readFileSync(receiptPath, 'utf8');
      if (NATIVE_SESSION_PATTERN.test(id)) return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return {
    hookCommand: [process.execPath, hookPath].map(quoteShellArgument).join(' '),
    readReceipt,
    release(nativeSessionId: string): void {
      if (readReceipt() !== nativeSessionId) throw new Error('managed startup release does not match receipt');
      fs.writeFileSync(releasePath, nativeSessionId, { flag: 'wx', mode: 0o600 });
    },
  };
}
