import { withSyncOp } from './InFlightSyncOpMarker.js';
import type { execFileSync } from 'node:child_process';

const MAX_INPUT_BYTES = 4000;

/** Pass the key to the Security tool's input stream and verify the exact slot afterward. */
export function writeMacKeychainKey(
  run: typeof execFileSync,
  readBack: () => Buffer | null,
  service: string,
  account: string,
  key: Buffer,
): boolean {
  // The Security tool parses this line itself. Keep both selectors one quoted argument.
  if (!service || !account || /["'\\\u0000-\u001f\u007f]/u.test(service + account) || key.length !== 32) return false;
  const input = `add-generic-password -U -s "${service}" -a "${account}" -w ${key.toString('base64')}\n`;
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) return false;
  withSyncOp(() => run('/usr/bin/security', ['-q', '-i'], { input, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }));
  return readBack()?.equals(key) === true;
}
