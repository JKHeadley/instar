// safe-git-allow: test file — direct fs/child usage is fixture setup only.
/**
 * spawnCodexExecJson + out-dir lifecycle (token-audit-completeness, Slice 1).
 *
 * Spawn mechanics use REAL children (/bin/sh fixtures) — the stderr-drain and
 * EPIPE hang classes are OS-pipe-level and a fake child can't exercise them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  spawnCodexExecJson,
  CodexExecJsonTimeoutError,
  EXEC_JSON_CARRY_CAP_BYTES,
  createCodexOutDir,
  cleanupCodexOutDir,
  maybeSweepStaleCodexOutDirs,
  CODEX_OUT_SWEEP_AGE_MS,
  CODEX_OUT_SWEEP_MAX_DELETIONS,
  CODEX_OUT_SWEEP_MAX_CANDIDATES,
  _codexOutDirInternals,
} from '../../src/providers/adapters/openai-codex/transport/codexSpawn.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SH = '/bin/sh';

let fixtureDir: string;

function writeScript(name: string, body: string): string {
  const p = path.join(fixtureDir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-fixture-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('spawnCodexExecJson — stream mechanics', () => {
  it('assembles a usage event split mid-JSON across two data chunks', async () => {
    // printf without trailing newline, then complete the line in a second write.
    const script = writeScript(
      'split.sh',
      `printf '%s' '{"msg":{"type":"token_count","info":{"total_'\nsleep 0.05\nprintf '%s\\n' 'token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}'\nexit 0`,
    );
    const lines: string[] = [];
    const res = await spawnCodexExecJson(SH, [script], {
      timeoutMs: 5000,
      env: process.env,
      prompt: 'p',
      onLine: (l) => lines.push(l),
    });
    expect(res.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg.type).toBe('token_count');
  });

  it('discards a single over-cap line (counted) and still parses a following usage event', async () => {
    const big = path.join(fixtureDir, 'big.txt');
    // One giant line (cap + slack), then a small valid line.
    fs.writeFileSync(big, 'x'.repeat(EXEC_JSON_CARRY_CAP_BYTES + 1024) + '\n{"ok":true}\n');
    const script = writeScript('big.sh', `cat '${big}'\nexit 0`);
    const lines: string[] = [];
    let oversized = 0;
    const res = await spawnCodexExecJson(SH, [script], {
      timeoutMs: 20000,
      env: process.env,
      prompt: 'p',
      onLine: (l) => lines.push(l),
      onOversizedLine: () => oversized++,
    });
    expect(res.exitCode).toBe(0);
    expect(oversized).toBe(1);
    expect(lines).toEqual(['{"ok":true}']);
  });

  it('drains ≥256KB of stderr continuously — normal exit, no timeout wedge', async () => {
    const script = writeScript(
      'stderr.sh',
      `i=0\nwhile [ $i -lt 300 ]; do printf '%s' '${'e'.repeat(64)}' | tr 'e' 'E' >&2; printf '%s' '${'e'.repeat(960)}' >&2; i=$((i+1)); done\necho '{"done":true}'\nexit 0`,
    );
    const lines: string[] = [];
    const res = await spawnCodexExecJson(SH, [script], {
      timeoutMs: 15000,
      env: process.env,
      prompt: 'p',
      onLine: (l) => lines.push(l),
    });
    expect(res.exitCode).toBe(0);
    expect(lines).toEqual(['{"done":true}']);
    expect(res.stderrTail.length).toBeLessThanOrEqual(600);
  }, 20000);

  it('stdin EPIPE: child exits immediately while a ≥1MB prompt write is in flight — no crash, exit surfaces', async () => {
    const script = writeScript('fastexit.sh', `echo 'error: unexpected argument' >&2\nexit 2`);
    const res = await spawnCodexExecJson(SH, [script], {
      timeoutMs: 5000,
      env: process.env,
      prompt: 'P'.repeat(1024 * 1024 + 16),
      onLine: () => {},
    });
    expect(res.exitCode).toBe(2);
    expect(res.stderrTail).toContain('unexpected argument');
  });

  it('timeout-mid-stream: the final post-SIGTERM token_count flush is parsed BEFORE the reject settles', async () => {
    const script = writeScript(
      'trap.sh',
      [
        `trap 'printf %s\\\\n "{\\"msg\\":{\\"type\\":\\"token_count\\",\\"info\\":{\\"total_token_usage\\":{\\"input_tokens\\":777,\\"output_tokens\\":111,\\"total_tokens\\":888}}}}"; exit 1' TERM`,
        `printf %s\\\\n '{"msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}}'`,
        `i=0; while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
      ].join('\n'),
    );
    const lines: string[] = [];
    let rejected: unknown;
    try {
      await spawnCodexExecJson(SH, [script], {
        timeoutMs: 500,
        env: process.env,
        prompt: 'p',
        onLine: (l) => lines.push(l),
      });
    } catch (err) {
      rejected = err;
      // Settlement contract: every onLine (including the post-SIGTERM flush)
      // completed BEFORE this rejection was observable.
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]).msg.info.total_token_usage.input_tokens).toBe(777);
    }
    expect(rejected).toBeInstanceOf(CodexExecJsonTimeoutError);
  }, 15000);

  it('held-open-fd grandchild: settles within the bounded post-exit grace, not at close', async () => {
    // Background sleep inherits stdout, deferring `close` ~3s past `exit`.
    const script = writeScript('grandchild.sh', `sleep 3 &\necho '{"ev":1}'\nexit 0`);
    const started = Date.now();
    const lines: string[] = [];
    const res = await spawnCodexExecJson(SH, [script], {
      timeoutMs: 10000,
      env: process.env,
      prompt: 'p',
      onLine: (l) => lines.push(l),
      postExitGraceMs: 300,
    });
    const elapsed = Date.now() - started;
    expect(res.exitCode).toBe(0);
    expect(lines).toEqual(['{"ev":1}']);
    expect(elapsed).toBeLessThan(2500); // settled at grace, not at the 3s close
  }, 15000);

  it('rejects with the spawn error when the binary does not exist', async () => {
    await expect(
      spawnCodexExecJson(path.join(fixtureDir, 'no-such-binary'), [], {
        timeoutMs: 1000,
        env: process.env,
        prompt: 'p',
        onLine: () => {},
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('flushes a newline-less final carry as a line at settlement', async () => {
    const script = writeScript('nonewline.sh', `printf '%s' '{"tail":"no-newline"}'\nexit 0`);
    const lines: string[] = [];
    await spawnCodexExecJson(SH, [script], {
      timeoutMs: 5000,
      env: process.env,
      prompt: 'p',
      onLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(['{"tail":"no-newline"}']);
  });
});

// ── early-terminal-settle (codex 0.144 shutdown-linger regression) ──────────
//
// codex 0.144 `exec --json` emits the agent_message + turn.completed, then
// LINGERS ~16-30s (writing --output-last-message + exiting only at shutdown).
// spawnCodexExecJson settles on the terminal line + reaps the lingering child
// instead of stalling the caller's timeout on an already-completed call.
describe('spawnCodexExecJson — early-terminal-settle (codex 0.144 linger)', () => {
  it('settles BEFORE the linger and reaps the child when settleOnTerminalLine fires', async () => {
    // Emit the two terminal events, then linger for 5s (the shutdown-linger).
    const script = writeScript(
      'linger.sh',
      `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"HELLO"}}'\n` +
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}'\n` +
        `sleep 5\nexit 0`,
    );
    const lines: string[] = [];
    let sawMsg = false;
    let sawTurn = false;
    const started = Date.now();
    const res = await spawnCodexExecJson(SH, [script], {
      timeoutMs: 30000,
      env: process.env,
      prompt: 'p',
      onLine: (l) => {
        lines.push(l);
        if (l.includes('agent_message')) sawMsg = true;
        if (l.includes('turn.completed')) sawTurn = true;
      },
      settleOnTerminalLine: () => sawMsg && sawTurn,
      terminalSettleGraceMs: 150,
    });
    const elapsed = Date.now() - started;
    // Settled well before the 5s linger (grace 150ms + event latency).
    expect(elapsed).toBeLessThan(2500);
    expect(res.terminalCompletion).toBe(true);
    // Both terminal events reached onLine BEFORE settlement (usage-parse safety).
    expect(lines.some((l) => l.includes('turn.completed'))).toBe(true);
    expect(lines.some((l) => l.includes('agent_message'))).toBe(true);
  }, 15000);

  it('does NOT early-settle when the child exits promptly (no linger) — terminalCompletion stays false', async () => {
    // Same terminal events, but exit IMMEDIATELY (no linger): the close path
    // wins the grace race, so behavior is byte-for-byte the normal exit.
    const script = writeScript(
      'promptexit.sh',
      `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"HELLO"}}'\n` +
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}'\n` +
        `exit 0`,
    );
    let sawMsg = false;
    let sawTurn = false;
    const res = await spawnCodexExecJson(SH, [script], {
      timeoutMs: 5000,
      env: process.env,
      prompt: 'p',
      onLine: (l) => {
        if (l.includes('agent_message')) sawMsg = true;
        if (l.includes('turn.completed')) sawTurn = true;
      },
      settleOnTerminalLine: () => sawMsg && sawTurn,
      terminalSettleGraceMs: 2000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.terminalCompletion).toBeFalsy();
  }, 10000);
});

describe('out-dir lifecycle + bounded stale sweep', () => {
  beforeEach(() => {
    _codexOutDirInternals.resetSweepClock();
  });

  it('createCodexOutDir registers in-flight; cleanup removes dir AND the Set entry', () => {
    const dir = createCodexOutDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(_codexOutDirInternals.inFlightOutDirs.has(dir)).toBe(true);
    cleanupCodexOutDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(_codexOutDirInternals.inFlightOutDirs.has(dir)).toBe(false);
  });

  it('a throwing deletion cannot leak the in-flight Set entry (pinned finally nesting)', () => {
    const dir = createCodexOutDir();
    const spy = vi.spyOn(SafeFsExecutor, 'safeRmSync').mockImplementation(() => {
      throw new Error('EPERM: sandbox revoked tmp access');
    });
    expect(() => cleanupCodexOutDir(dir)).not.toThrow();
    expect(_codexOutDirInternals.inFlightOutDirs.has(dir)).toBe(false);
    spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sweep: rate floor — two back-to-back calls perform exactly one pass', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-floor-'));
    const first = maybeSweepStaleCodexOutDirs({ tmpDirOverride: tmp });
    const second = maybeSweepStaleCodexOutDirs({ tmpDirOverride: tmp });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sweep: deletes only own-uid, real-directory, stale, not-in-flight candidates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-verify-'));
    const staleMs = Date.now() - CODEX_OUT_SWEEP_AGE_MS - 60_000;

    const stale = path.join(tmp, 'instar-codex-out-stale');
    fs.mkdirSync(stale);
    fs.utimesSync(stale, staleMs / 1000, staleMs / 1000);

    const fresh = path.join(tmp, 'instar-codex-out-fresh');
    fs.mkdirSync(fresh);

    const inflight = path.join(tmp, 'instar-codex-out-inflight');
    fs.mkdirSync(inflight);
    fs.utimesSync(inflight, staleMs / 1000, staleMs / 1000);
    _codexOutDirInternals.inFlightOutDirs.add(inflight);

    const symlinkTarget = path.join(tmp, 'real-target');
    fs.mkdirSync(symlinkTarget);
    const planted = path.join(tmp, 'instar-codex-out-symlink');
    fs.symlinkSync(symlinkTarget, planted);
    // lutimes is not portable; the symlink is skipped on type, not age.

    const foreign = path.join(tmp, 'instar-codex-out-foreign');
    fs.mkdirSync(foreign);
    fs.utimesSync(foreign, staleMs / 1000, staleMs / 1000);

    const realLstat = fs.promises.lstat.bind(fs.promises);
    const sweep = maybeSweepStaleCodexOutDirs({
      tmpDirOverride: tmp,
      lstatImpl: async (p: string) => {
        const st = await realLstat(p);
        if (p === foreign) {
          return new Proxy(st, {
            get(target, prop) {
              if (prop === 'uid') return (process.getuid?.() ?? 0) + 1;
              const v = Reflect.get(target, prop);
              return typeof v === 'function' ? v.bind(target) : v;
            },
          }) as fs.Stats;
        }
        return st;
      },
    });
    expect(sweep).not.toBeNull();
    await sweep;

    expect(fs.existsSync(stale)).toBe(false); // reaped
    expect(fs.existsSync(fresh)).toBe(true); // too young
    expect(fs.existsSync(inflight)).toBe(true); // in-flight skip
    expect(fs.existsSync(symlinkTarget)).toBe(true); // symlink target untouched
    expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true); // planted symlink skipped
    expect(fs.existsSync(foreign)).toBe(true); // foreign-uid skip

    _codexOutDirInternals.inFlightOutDirs.delete(inflight);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sweep: per-pass deletion and candidate caps hold', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-caps-'));
    const staleMs = Date.now() - CODEX_OUT_SWEEP_AGE_MS - 60_000;
    const total = CODEX_OUT_SWEEP_MAX_DELETIONS + 10;
    for (let i = 0; i < total; i++) {
      const d = path.join(tmp, `instar-codex-out-${String(i).padStart(3, '0')}`);
      fs.mkdirSync(d);
      fs.utimesSync(d, staleMs / 1000, staleMs / 1000);
    }
    const sweep = maybeSweepStaleCodexOutDirs({ tmpDirOverride: tmp });
    await sweep;
    const remaining = fs.readdirSync(tmp).filter((n) => n.startsWith('instar-codex-out-'));
    expect(remaining.length).toBe(total - CODEX_OUT_SWEEP_MAX_DELETIONS);

    // Candidate cap: lstat is consulted at most MAX_CANDIDATES times.
    _codexOutDirInternals.resetSweepClock();
    let lstatCalls = 0;
    const realLstat = fs.promises.lstat.bind(fs.promises);
    await maybeSweepStaleCodexOutDirs({
      tmpDirOverride: tmp,
      lstatImpl: async (p: string) => {
        lstatCalls++;
        return realLstat(p);
      },
    });
    expect(lstatCalls).toBeLessThanOrEqual(CODEX_OUT_SWEEP_MAX_CANDIDATES);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
