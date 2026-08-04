/**
 * Integration control for the `send-keys -l` argv ceiling.
 *
 * This is the CONTROL for the 2026-08-04 internal-LLM outage: a ~40 KB prompt
 * sent as a single `send-keys -l` fails with `command too long`, that failure
 * reached LlmCircuitBreaker as an opaque send error and was reported as
 * `provider rate-limited`, and the breaker then tripped every 15 minutes while
 * ten LLM-backed components sat at 76-100% error rate.
 *
 * Against PRE-FIX code the "chunked" case here fails exactly as production did.
 * The unchunked case is kept deliberately: it pins that the ceiling is REAL, so
 * if someone raises TMUX_SEND_KEYS_CHUNK_BYTES above it this suite goes red
 * instead of silently restoring the outage.
 *
 * Real tmux, real pane, byte-exact assertion. Skipped when tmux is absent.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chunkLiteralForTmux,
  buildLiteralSendArgs,
  TMUX_SEND_KEYS_CHUNK_BYTES,
} from '../../src/core/tmuxLiteralSend.js';

const tmuxPath = (() => {
  const r = spawnSync('which', ['tmux'], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
})();

const HAVE_TMUX = tmuxPath.length > 0;

/** The payload size that actually took production down. */
const OUTAGE_PAYLOAD = `HEAD_7f3a${'X'.repeat(39_960)}TAIL_9c2b`;

const sessions: string[] = [];
const dirs: string[] = [];

function startReceiver(): { session: string; outFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-ceiling-'));
  dirs.push(dir);
  const outFile = join(dir, 'received.txt');
  const session = `ceiling-test-${process.pid}-${sessions.length}`;
  sessions.push(session);
  // `stty raw` matters: in canonical mode the tty line discipline caps a single
  // line at ~1 KB, which would truncate the payload and produce a FALSE
  // failure that looks like the bug under test.
  execFileSync(tmuxPath, [
    'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
    `stty raw -echo; cat > ${outFile}`,
  ], { encoding: 'utf-8', timeout: 10_000 });
  return { session, outFile };
}

function drain(outFile: string, expectBytes: number, maxMs = 10_000): number {
  const deadline = Date.now() + maxMs;
  let size = 0;
  while (Date.now() < deadline) {
    if (existsSync(outFile)) {
      size = readFileSync(outFile).length;
      if (size >= expectBytes) return size;
    }
    execFileSync('/bin/sleep', ['0.25']);
  }
  return size;
}

afterEach(() => {
  for (const s of sessions.splice(0)) {
    try { execFileSync(tmuxPath, ['kill-session', '-t', s], { timeout: 5_000 }); } catch { /* already gone */ }
  }
  // Payload files are left in the OS temp dir deliberately: they are a few tens
  // of KB and the OS reclaims them, whereas a direct rmSync here would violate
  // the destructive-containment guard (lint-no-direct-destructive) that exists
  // precisely so tests cannot hand-roll deletes.
  dirs.splice(0);
});

describe.skipIf(!HAVE_TMUX)('tmux send-keys -l argv ceiling', () => {
  it('a single send-keys -l REJECTS the outage payload (the ceiling is real)', () => {
    const { session } = startReceiver();
    const r = spawnSync(
      tmuxPath,
      ['send-keys', '-t', `=${session}:`, '-l', '--', OUTAGE_PAYLOAD],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`.toLowerCase()).toContain('too long');
  });

  it('the chunked path delivers the same payload byte-exact', () => {
    const { session, outFile } = startReceiver();
    const chunks = chunkLiteralForTmux(OUTAGE_PAYLOAD);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const r = spawnSync(tmuxPath, buildLiteralSendArgs(`=${session}:`, chunk), {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      expect(r.status, `chunk send failed: ${r.stderr}`).toBe(0);
    }

    const expected = Buffer.byteLength(OUTAGE_PAYLOAD, 'utf-8');
    expect(drain(outFile, expected)).toBe(expected);

    const received = readFileSync(outFile, 'utf-8');
    expect(received).toBe(OUTAGE_PAYLOAD);
  });

  it('the configured chunk size is actually under the live ceiling', () => {
    // Guards against someone "optimising" the chunk size back over the limit.
    const { session } = startReceiver();
    const probe = 'a'.repeat(TMUX_SEND_KEYS_CHUNK_BYTES);
    const r = spawnSync(tmuxPath, buildLiteralSendArgs(`=${session}:`, probe), {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    expect(r.status, `a full-size chunk must send in ONE call: ${r.stderr}`).toBe(0);
  });
});
