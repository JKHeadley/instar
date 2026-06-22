// safe-git-allow: test file — direct fs usage is fixture setup only.
/**
 * CodexCliIntelligenceProvider exec-json mode (token-audit-completeness,
 * Slice 1): both-modes hygiene args, stdin prompt, file-only result
 * semantics, kill-switch resolution, both-levers error text, and the
 * END-TO-END funnel error row carrying post-SIGTERM tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CodexCliIntelligenceProvider,
  createCodexExecJsonConfigResolver,
  _resetUsageDriftEmissionForTest,
} from '../../src/core/CodexCliIntelligenceProvider.js';
import {
  CircuitBreakingIntelligenceProvider,
  setFeatureMetricsRecorder,
} from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { LlmCircuitBreaker } from '../../src/core/LlmCircuitBreaker.js';

let fixtureDir: string;
let prevEnv: string | undefined;

function argvFile(): string {
  return path.join(fixtureDir, 'argv.txt');
}
function stdinFile(): string {
  return path.join(fixtureDir, 'stdin.txt');
}
function readArgv(): string[] {
  return fs.readFileSync(argvFile(), 'utf-8').split('\n').filter(Boolean);
}

/**
 * Fake codex: records argv + stdin; in json mode (--output-last-message
 * present) emits a token_count event on stdout and writes the result FILE;
 * in plain mode prints the result to stdout.
 */
function writeFakeCodex(opts: { resultText?: string; writeFile?: boolean } = {}): string {
  const resultText = opts.resultText ?? 'RESULT';
  const writeFile = opts.writeFile !== false;
  const p = path.join(fixtureDir, 'fake-codex.sh');
  fs.writeFileSync(
    p,
    `#!/bin/sh
ARGS_OUT="${argvFile()}"
: > "$ARGS_OUT"
OUTFILE=""
PREV=""
for a in "$@"; do
  printf '%s\\n' "$a" >> "$ARGS_OUT"
  if [ "$PREV" = "--output-last-message" ]; then OUTFILE="$a"; fi
  PREV="$a"
done
cat > "${stdinFile()}"
if [ -n "$OUTFILE" ]; then
  echo '{"msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":42,"cached_input_tokens":12,"output_tokens":7,"total_tokens":49}}}}'
  ${writeFile ? `printf '%s' '${resultText}' > "$OUTFILE"` : ': # deliberately no result file'}
else
  printf '%s' '${resultText}'
fi
exit 0
`,
    { mode: 0o755 },
  );
  return p;
}

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-fixture-'));
  prevEnv = process.env.INSTAR_CODEX_EXEC_JSON;
  delete process.env.INSTAR_CODEX_EXEC_JSON;
  _resetUsageDriftEmissionForTest();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.INSTAR_CODEX_EXEC_JSON;
  else process.env.INSTAR_CODEX_EXEC_JSON = prevEnv;
  setFeatureMetricsRecorder(null);
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('exec-json mode (default)', () => {
  it('passes --json + absolute --output-last-message, keeps ALL hygiene args, moves the prompt to stdin', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: writeFakeCodex() });
    const usages: Array<{ inputTokens: number; outputTokens: number; cachedTokens?: number }> = [];
    const result = await provider.evaluate('the json prompt', {
      onUsage: (u) => usages.push(u),
    });

    expect(result).toBe('RESULT');
    const argv = readArgv();
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--json');
    const outIdx = argv.indexOf('--output-last-message');
    expect(outIdx).toBeGreaterThan(-1);
    expect(path.isAbsolute(argv[outIdx + 1])).toBe(true);
    // Hygiene set preserved (clean-call spec) in json mode:
    expect(argv).toContain('--sandbox');
    expect(argv).toContain('read-only');
    expect(argv).toContain('--cd');
    expect(argv).toContain('-c');
    expect(argv).toContain('project_doc_max_bytes=0');
    expect(argv).toContain('--skip-git-repo-check');
    // The prompt is OFF argv — positional is '-', prompt arrives via stdin.
    expect(argv[argv.length - 1]).toBe('-');
    expect(argv).not.toContain('the json prompt');
    expect(fs.readFileSync(stdinFile(), 'utf-8')).toBe('the json prompt');
    // Per-call usage parsed from the event stream, cachedTokens included.
    expect(usages).toEqual([{ inputTokens: 42, outputTokens: 7, cachedTokens: 12 }]);
  });

  it('result comes from the FILE only — never stdout events', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: writeFakeCodex({ resultText: 'file-authority' }),
    });
    await expect(provider.evaluate('p')).resolves.toBe('file-authority');
  });

  it('empty-after-trim file with exit 0 resolves "" (mode-equivalent with plain)', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: writeFakeCodex({ resultText: '  \n ' }),
    });
    await expect(provider.evaluate('p')).resolves.toBe('');
  });

  it('missing result file after exit 0 rejects loudly (masking would hide argument rot)', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: writeFakeCodex({ writeFile: false }),
    });
    await expect(provider.evaluate('p')).rejects.toThrow(/output-last-message file missing/);
  });

  it('rejects an oversized result file instead of an unbounded read', async () => {
    const script = path.join(fixtureDir, 'oversize.sh');
    fs.writeFileSync(
      script,
      `#!/bin/sh
OUTFILE=""
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--output-last-message" ]; then OUTFILE="$a"; fi
  PREV="$a"
done
cat > /dev/null
head -c 17000000 /dev/zero > "$OUTFILE"
exit 0
`,
      { mode: 0o755 },
    );
    const provider = new CodexCliIntelligenceProvider({ codexPath: script });
    await expect(provider.evaluate('p')).rejects.toThrow(/refusing unbounded read/);
  }, 15000);

  it('unknown-flag fast-exit (old CLI) rejects naming BOTH recovery levers — while a ≥1MB prompt write is in flight, without crashing', async () => {
    const script = path.join(fixtureDir, 'oldcli.sh');
    fs.writeFileSync(
      script,
      `#!/bin/sh\necho "error: unexpected argument '--json' found" >&2\nexit 2\n`,
      { mode: 0o755 },
    );
    const provider = new CodexCliIntelligenceProvider({ codexPath: script });
    const bigPrompt = 'P'.repeat(1024 * 1024 + 16);
    await expect(provider.evaluate(bigPrompt)).rejects.toThrow(
      /intelligence\.codexExecJson.*INSTAR_CODEX_EXEC_JSON=0|INSTAR_CODEX_EXEC_JSON=0.*intelligence\.codexExecJson/s,
    );
  });

  it('cleans up the per-call out-dir on success', async () => {
    // Snapshot the PRE-EXISTING out-dirs first — other tests in this file (and
    // other codex test files in the shared vitest pool) legitimately leave
    // out-dirs on their error/timeout paths, and they share os.tmpdir(). The
    // assertion must be scoped to the out-dir THIS call created, not the global
    // population (the old <10s-mtime heuristic flaked when a sibling test ran
    // within the window).
    const listOutDirs = (): Set<string> =>
      new Set(
        fs
          .readdirSync(os.tmpdir())
          .filter((n) => n.startsWith('instar-codex-out-'))
          .map((n) => path.join(os.tmpdir(), n)),
      );
    const before = listOutDirs();
    const provider = new CodexCliIntelligenceProvider({ codexPath: writeFakeCodex() });
    await provider.evaluate('p');
    // Only NEW out-dirs (created by THIS call) must be gone — pre-existing ones
    // from sibling tests are not this test's concern.
    const newLeftovers = [...listOutDirs()].filter((p) => !before.has(p));
    expect(newLeftovers).toEqual([]);
  });
});

describe('kill-switch (plain mode)', () => {
  it('env INSTAR_CODEX_EXEC_JSON=0 restores the plain invocation byte-for-byte', async () => {
    process.env.INSTAR_CODEX_EXEC_JSON = '0';
    const provider = new CodexCliIntelligenceProvider({ codexPath: writeFakeCodex({ resultText: 'plain-out' }) });
    const result = await provider.evaluate('the plain prompt');
    expect(result).toBe('plain-out');
    const argv = readArgv();
    expect(argv[0]).toBe('exec');
    expect(argv).not.toContain('--json');
    expect(argv).not.toContain('--output-last-message');
    expect(argv[argv.length - 1]).toBe('the plain prompt'); // positional prompt
    // Hygiene set identical in plain mode:
    expect(argv).toContain('--cd');
    expect(argv).toContain('project_doc_max_bytes=0');
    expect(argv).toContain('--skip-git-repo-check');
  });

  it('a resolveExecJson closure returning false selects plain mode per call', async () => {
    let on = false;
    const provider = new CodexCliIntelligenceProvider({
      codexPath: writeFakeCodex({ resultText: 'either' }),
      resolveExecJson: () => on,
    });
    await provider.evaluate('p1');
    expect(readArgv()).not.toContain('--json');
    on = true; // per-call read survives provider caching
    await provider.evaluate('p2');
    expect(readArgv()).toContain('--json');
  });
});

describe('createCodexExecJsonConfigResolver', () => {
  it('config key wins when present; flip applies after the TTL', async () => {
    const cfg = path.join(fixtureDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ intelligence: { codexExecJson: false } }));
    const resolve = createCodexExecJsonConfigResolver(cfg, 1);
    expect(resolve()).toBe(false);
    fs.writeFileSync(cfg, JSON.stringify({ intelligence: { codexExecJson: true } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(resolve()).toBe(true);
  });

  it('corrupt config + env=0 → plain mode (the env lever stays honest)', () => {
    const cfg = path.join(fixtureDir, 'config.json');
    fs.writeFileSync(cfg, '{ this is not json');
    process.env.INSTAR_CODEX_EXEC_JSON = '0';
    expect(createCodexExecJsonConfigResolver(cfg, 1)()).toBe(false);
  });

  it('corrupt config without the env lever → default ON', () => {
    const cfg = path.join(fixtureDir, 'config.json');
    fs.writeFileSync(cfg, '{ nope');
    expect(createCodexExecJsonConfigResolver(cfg, 1)()).toBe(true);
  });

  it('missing config file falls through to the env default', () => {
    const resolve = createCodexExecJsonConfigResolver(path.join(fixtureDir, 'absent.json'), 1);
    expect(resolve()).toBe(true);
    process.env.INSTAR_CODEX_EXEC_JSON = '0';
    expect(createCodexExecJsonConfigResolver(path.join(fixtureDir, 'absent.json'), 1)()).toBe(false);
  });

  it('config present but key absent → env default applies', () => {
    const cfg = path.join(fixtureDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ intelligence: {} }));
    expect(createCodexExecJsonConfigResolver(cfg, 1)()).toBe(true);
  });
});

describe('end-to-end: funnel error row carries post-SIGTERM tokens', () => {
  it('timeout-mid-stream records an error row WITH the final flushed usage', async () => {
    const script = path.join(fixtureDir, 'trap.sh');
    fs.writeFileSync(
      script,
      `#!/bin/sh
trap 'printf %s\\\\n "{\\"msg\\":{\\"type\\":\\"token_count\\",\\"info\\":{\\"total_token_usage\\":{\\"input_tokens\\":777,\\"cached_input_tokens\\":300,\\"output_tokens\\":111,\\"total_tokens\\":888}}}}"; exit 1' TERM
cat > /dev/null
printf %s\\\\n '{"msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}}'
i=0; while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
`,
      { mode: 0o755 },
    );
    const captured: Array<Record<string, unknown>> = [];
    setFeatureMetricsRecorder({ record: (e) => captured.push(e as Record<string, unknown>) });

    const provider = new CircuitBreakingIntelligenceProvider(
      new CodexCliIntelligenceProvider({ codexPath: script }),
      new LlmCircuitBreaker(),
    );

    await expect(
      provider.evaluate('p', {
        timeoutMs: 500,
        attribution: { component: 'CanaryTimeoutFeature' },
      }),
    ).rejects.toThrow(/timed out/);

    const errorRow = captured.find((r) => r.outcome === 'error');
    expect(errorRow).toBeDefined();
    expect(errorRow!.feature).toBe('CanaryTimeoutFeature');
    // The END-TO-END assertion: the final post-SIGTERM token_count flush
    // reached the ledger row, not just the provider callback.
    expect(errorRow!.tokensIn).toBe(777);
    expect(errorRow!.tokensOut).toBe(111);
    expect(errorRow!.tokensCached).toBe(300);
    expect(errorRow!.framework).toBe('codex-cli');
  }, 20000);
});
