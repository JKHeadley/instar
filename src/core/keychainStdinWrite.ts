/**
 * keychainStdinWrite — write a macOS keychain item without putting the secret on a command line (SEC-155).
 *
 * `security add-generic-password ... -w <secret>` puts the secret in the process arguments, and on macOS
 * `ps` shows every user's process arguments, so another local account on the same Mac (a shared Mac
 * mini, a second login) could read an OAuth credential or a vault master key while the write runs.
 * Instead the command goes to `security -i` on STANDARD INPUT, with the secret hex-encoded behind `-X`
 * (the same bytes `-w` would store, so every reader's `find-generic-password -w` returns the same text).
 * This is the pattern `KeychainCredentialProvider.writeCredentials` already used.
 *
 * `security -i` exits with the failing command's status (a duplicate item exits 45, bad arguments 2),
 * so a failed write still throws and every caller's existing fallback still runs.
 */
import { execFile, execFileSync, type StdioOptions } from 'node:child_process';

/**
 * Account and service names go inside double quotes on the `-i` line: plain printable text only. No quote,
 * backslash, `$` or backtick, since the `-i` tokenizer is undocumented, and no control character.
 */
const SAFE_NAME = /^[^"\\$`\x00-\x1f\x7f]{1,256}$/;

/** The longest line `security -i` reads whole, newline included (a secret of about 2,000 bytes once hex-encoded). */
export const KEYCHAIN_STDIN_MAX_LINE = 4096;

/**
 * The one `security -i` input line that adds (or with `update`, updates) a generic password.
 * Throws on an account or service name that cannot be quoted safely: never a partial or reinterpreted line.
 */
export function keychainAddInput(opts: { account: string; service: string; secret: string; update?: boolean }): string {
  if (!SAFE_NAME.test(opts.account)) throw new Error('keychain write: account name cannot be passed safely');
  if (!SAFE_NAME.test(opts.service)) throw new Error('keychain write: service name cannot be passed safely');
  const hex = Buffer.from(opts.secret, 'utf8').toString('hex');
  const line = `add-generic-password${opts.update ? ' -U' : ''} -a "${opts.account}" -s "${opts.service}" -X "${hex}"\n`;
  // `security -i` reads at most 4096 bytes per line. A longer line is not refused: it is split, the first
  // part runs as its own command and stores a TRUNCATED item (with -U, over the real one), and only the
  // rest fails. Measured on macOS 2026-11-22. So an over-long write is refused here, before any process starts.
  if (Buffer.byteLength(line, 'utf8') > KEYCHAIN_STDIN_MAX_LINE) throw new Error('keychain write: secret too long for a safe stdin write');
  return line;
}

/** Synchronous write. Throws as `execFileSync` would when the write fails or times out. */
export function keychainWriteSync(
  opts: { account: string; service: string; secret: string; update?: boolean },
  run: { timeout: number; stdio?: StdioOptions; exec?: typeof execFileSync },
): void {
  const input = keychainAddInput(opts);
  const stdio: StdioOptions = run.stdio === 'pipe' || run.stdio === undefined ? 'pipe' : ['pipe', ...(Array.isArray(run.stdio) ? run.stdio.slice(1) : [run.stdio, run.stdio])] as StdioOptions;
  (run.exec ?? execFileSync)('security', ['-i'], { input, stdio, timeout: run.timeout });
}

/** Asynchronous write, off the event loop. Rejects when the write fails or times out. */
export function keychainWriteAsync(
  opts: { account: string; service: string; secret: string; update?: boolean },
  run: { timeout: number },
): Promise<void> {
  let input: string;
  try { input = keychainAddInput(opts); } catch (err) { return Promise.reject(err as Error); }
  return new Promise((resolve, reject) => {
    try {
      const child = execFile('security', ['-i'], { timeout: run.timeout }, (err) => (err ? reject(err) : resolve()));
      child.stdin?.on('error', () => { /* @silent-fallback-ok — the exit callback reports the failure */ });
      child.stdin?.end(input);
    } catch (err) {
      reject(err as Error);
    }
  });
}
