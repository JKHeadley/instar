/**
 * outputCredentialScrub — SEC-164 part 1 §3.4: the server's and the lifeline's own standard output
 * and error, masked before they reach a log file.
 *
 * Installed ONLY by the `server start` and `lifeline start` command handlers, never as a side effect
 * of an import: the MCP stdio server and `--json` commands use standard output as a protocol and
 * must stay unwrapped.
 *
 * Line-buffered so a key split across two writes is still caught. A buffer flushes at a newline, at
 * 64 KB, or after one second, and any remainder is written synchronously on exit, so the last line of
 * a crash is never lost. When the setting is off, text passes straight through.
 *
 * Known bypasses (the sweeper is the backstop for anything that reaches a file): a multi-line PEM
 * block; Node's own uncaught-exception print, which writes to the descriptor directly; child
 * processes that inherit the descriptors; a key split across a pause of more than a second; and
 * SIGKILL or out-of-memory losing up to the buffered second. Partial lines (prompts, progress
 * bars) can appear up to a second late. The remainder is flushed on `exit`, which every crash
 * handler ends in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { maskCredentials } from '../messaging/outbound-credential-guard.js';
import { resolveDevAgentGate } from './devAgentGate.js';

const FLUSH_BYTES = 64 * 1024;
const FLUSH_MS = 1000;
const SETTING_TTL_MS = 5000;

/** Mask one chunk of output text. Never throws: a fault passes the text through, so logging never stops. */
export function scrubOutputText(text: string): string {
  try {
    return maskCredentials(text).text;
  } catch {
    // @silent-fallback-ok — the log line still reaches the file; the sweeper masks it there later.
    return text;
  }
}

/** Reads `security.credentialScrub.enabled` live from the settings file (dev-gated by default). */
export function credentialScrubEnabledReader(projectDir: string): () => boolean {
  const configPath = path.join(projectDir, '.instar', 'config.json');
  let cached: { at: number; value: boolean } | null = null;
  return () => {
    const now = Date.now();
    if (cached && now - cached.at < SETTING_TTL_MS) return cached.value;
    let value = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { developmentAgent?: boolean; security?: { credentialScrub?: { enabled?: boolean } } };
      value = resolveDevAgentGate(cfg.security?.credentialScrub?.enabled, cfg as never);
    } catch {
      // @silent-fallback-ok — an unreadable file keeps the last known value (off before the first read).
      value = cached?.value ?? false;
    }
    cached = { at: now, value };
    return value;
  };
}

/** The copy scrub's and the sweeper's mode (§4.4): off, count only (dry run), or mask in place. */
export type CredentialScrubMode = 'off' | 'dry-run' | 'on';

/**
 * Reads `security.credentialScrub.enabled` and `.inPlace` live. `inPlace` resolves in code and starts
 * at dry run: only an explicit `true` (or "on") in the settings file masks in place.
 */
export function credentialScrubModeReader(projectDir: string): () => CredentialScrubMode {
  const enabled = credentialScrubEnabledReader(projectDir);
  const configPath = path.join(projectDir, '.instar', 'config.json');
  let cached: { at: number; value: boolean } | null = null;
  const inPlace = (): boolean => {
    const now = Date.now();
    if (cached && now - cached.at < SETTING_TTL_MS) return cached.value;
    let value = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { security?: { credentialScrub?: { inPlace?: unknown } } };
      const v = cfg.security?.credentialScrub?.inPlace;
      value = v === true || v === 'on';
    } catch {
      // @silent-fallback-ok — an unreadable file keeps the last known value (dry run before the first read).
      value = cached?.value ?? false;
    }
    cached = { at: now, value };
    return value;
  };
  return () => (enabled() ? (inPlace() ? 'on' : 'dry-run') : 'off');
}

type WriteFn = (chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => boolean;

let installed = false;

/** Wrap process.stdout and process.stderr. Idempotent. */
export function installOutputScrub(isEnabled: () => boolean): void {
  if (installed) return;
  installed = true;
  for (const stream of [process.stdout, process.stderr]) wrapStream(stream, isEnabled);
}

/**
 * Mask one run of output bytes. When nothing is masked the ORIGINAL bytes are returned untouched, so
 * any encoding (latin1, binary, a half character at a flush) passes through byte for byte.
 */
function scrubBytes(bytes: Buffer): Buffer {
  if (bytes.length === 0) return bytes;
  let masked: { text: string; kinds: string[] };
  try {
    masked = maskCredentials(bytes.toString('utf8'));
  } catch {
    // @silent-fallback-ok — the log line still reaches the file; the sweeper masks it there later.
    return bytes;
  }
  return masked.kinds.length === 0 ? bytes : Buffer.from(masked.text, 'utf8');
}

/** Wrap one write stream (exported for tests; production goes through installOutputScrub). */
export function wrapStream(stream: NodeJS.WriteStream, isEnabled: () => boolean, onExit: boolean = true): void {
  const original = stream.write.bind(stream) as WriteFn;
  // Pending output is kept as BYTES and split only at a newline byte, which never occurs inside a
  // multi-byte UTF-8 character, so no character is ever cut and nothing is lost when the switch flips.
  let pending: Buffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | null = null;

  const flush = (sync = false) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const out = scrubBytes(pending);
    pending = Buffer.alloc(0);
    if (sync && typeof (stream as unknown as { fd?: number }).fd === 'number') {
      try { fs.writeSync((stream as unknown as { fd: number }).fd, out); return; } catch { /* @silent-fallback-ok — fall through to the stream */ }
    }
    original(out);
  };

  const patched: WriteFn = (chunk, encodingOrCb, cb) => {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : (typeof cb === 'function' ? cb : undefined);
    if (!isEnabled()) {
      if (pending.length) flush();
      return original(chunk, encodingOrCb, cb);
    }
    const enc = (typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8') as BufferEncoding;
    const bytes = typeof chunk === 'string'
      ? Buffer.from(chunk, enc)
      : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
        ? Buffer.from(chunk as Uint8Array)
        : Buffer.from(String(chunk), 'utf8');
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    let result = true;
    const lastNl = pending.lastIndexOf(0x0a);
    if (lastNl >= 0) {
      const complete = pending.subarray(0, lastNl + 1);
      pending = Buffer.from(pending.subarray(lastNl + 1));
      result = original(scrubBytes(complete));
    }
    if (pending.length >= FLUSH_BYTES) flush();
    else if (pending.length && !timer) { timer = setTimeout(() => flush(), FLUSH_MS); timer.unref?.(); }
    // The callback fires once the text is accepted for writing; a buffered partial line follows
    // within a second. The return value is the underlying stream's, so backpressure is kept.
    if (callback) process.nextTick(callback as () => void);
    return result;
  };

  (stream as unknown as { write: WriteFn }).write = patched;
  if (onExit) process.on('exit', () => flush(true));
}
