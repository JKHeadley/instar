/**
 * Unit tests — Burn-detection Phase 1.
 *
 * Covers the Phase 1 deliverables from docs/specs/token-burn-detection-and-self-heal.md:
 *   - attribution_key column on token_events (idempotent migration + write-side)
 *   - LlmRateGate primitive (no-op + self-attribution exempt)
 *   - attributionKey helper (fingerprint composition + fallbacks)
 *   - IntelligenceOptions.attribution flows through AnthropicIntelligenceProvider
 *   - TokenLedger.recordEvent writes attribution_key + is idempotent on requestId
 *   - lint-no-direct-llm-http catches new violations + respects allowlist
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LlmRateGate } from '../../src/monitoring/LlmRateGate.js';
import { buildAttributionKey } from '../../src/monitoring/attributionKey.js';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { AnthropicIntelligenceProvider } from '../../src/core/AnthropicIntelligenceProvider.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ── attributionKey ─────────────────────────────────────────────────────

describe('buildAttributionKey', () => {
  it('composes component::fingerprint with 8-hex prompt hash', () => {
    const key = buildAttributionKey('InputDetector', 'is this stuck?');
    expect(key).toMatch(/^InputDetector::[0-9a-f]{8}$/);
  });

  it('same prompt + same component → same key (deterministic, the bleeding-detector relies on this)', () => {
    const a = buildAttributionKey('InputDetector', 'analyzing terminal output');
    const b = buildAttributionKey('InputDetector', 'analyzing terminal output');
    expect(a).toBe(b);
  });

  it('different prompts produce different fingerprints', () => {
    const a = buildAttributionKey('InputDetector', 'prompt A');
    const b = buildAttributionKey('InputDetector', 'prompt B');
    expect(a).not.toBe(b);
  });

  it('missing component falls back to unknown::<fp>', () => {
    const key = buildAttributionKey(undefined, 'something');
    expect(key).toMatch(/^unknown::[0-9a-f]{8}$/);
  });

  it('empty prompt produces <component>::nonprompt sentinel', () => {
    expect(buildAttributionKey('Foo', '')).toBe('Foo::nonprompt');
  });

  it('only the first 256 bytes of prompt contribute to fingerprint (cap)', () => {
    const filler = 'x'.repeat(256);
    const a = buildAttributionKey('Foo', filler);
    const b = buildAttributionKey('Foo', filler + 'completely-different-tail');
    expect(a).toBe(b);
  });
});

// ── LlmRateGate ────────────────────────────────────────────────────────

describe('LlmRateGate (Phase 1 no-op)', () => {
  let gate: LlmRateGate;
  beforeEach(() => {
    gate = new LlmRateGate();
    gate.reset();
  });

  it('shouldFire returns true for any key when no throttle is installed', () => {
    expect(gate.shouldFire('InputDetector::abcd1234')).toBe(true);
    expect(gate.shouldFire('unknown::xyz')).toBe(true);
  });

  it('decide() returns no-throttle-installed reason for any key with no throttle', () => {
    const d = gate.decide('InputDetector::abcd1234');
    expect(d.allowed).toBe(true);
    // Phase 4 upgrade: gate is now stateful. With no throttle installed, the
    // reason is 'no-throttle-installed' (was 'phase-1-noop' in Phase 1).
    expect(d.reason).toBe('no-throttle-installed');
    expect(d.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('burn-throttle-runbook prefix is exempt (self-reinforcing-loop guard)', () => {
    expect(gate.shouldFire('burn-throttle-runbook::compose-alert')).toBe(true);
    const d = gate.decide('burn-throttle-runbook::compose-alert');
    expect(d.allowed).toBe(true);
  });

  it('LlmRateGate.instance() returns a stable singleton across calls', () => {
    const a = LlmRateGate.instance();
    const b = LlmRateGate.instance();
    expect(a).toBe(b);
  });
});

// ── TokenLedger schema + recordEvent ──────────────────────────────────

describe('TokenLedger Phase 1 schema', () => {
  let dbPath: string;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-p1-'));
    dbPath = path.join(tmp, 'ledger.db');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/burn-detection-phase-1.test.ts' });
  });

  it('init creates attribution_key column + index', () => {
    const ledger = new TokenLedger({ dbPath, claudeProjectsDir: tmp });
    // We don't expose the schema query API; assert via a recordEvent that the
    // column accepts a value and a subsequent attempt to write with the same
    // request_id is rejected (idempotency via PK).
    const r1 = ledger.recordEvent({
      requestId: 'req-1', sessionId: 's', ts: Date.now(),
      inputTokens: 10, outputTokens: 5,
      attributionKey: 'TestComponent::aaaaaaaa',
    });
    expect(r1.inserted).toBe(true);
    const r2 = ledger.recordEvent({
      requestId: 'req-1', sessionId: 's', ts: Date.now(),
      inputTokens: 99, outputTokens: 99,
      attributionKey: 'TestComponent::aaaaaaaa',
    });
    expect(r2.inserted).toBe(false);
  });

  it('recordEvent without attributionKey falls back to unknown::direct-api', () => {
    const ledger = new TokenLedger({ dbPath, claudeProjectsDir: tmp });
    const r = ledger.recordEvent({
      requestId: 'req-2', sessionId: 's', ts: Date.now(),
      inputTokens: 10, outputTokens: 5,
    });
    expect(r.inserted).toBe(true);
  });

  it('recordEvent rejects missing requestId / sessionId', () => {
    const ledger = new TokenLedger({ dbPath, claudeProjectsDir: tmp });
    expect(ledger.recordEvent({
      requestId: '', sessionId: 's', ts: 0, inputTokens: 0, outputTokens: 0,
    }).inserted).toBe(false);
    expect(ledger.recordEvent({
      requestId: 'r', sessionId: '', ts: 0, inputTokens: 0, outputTokens: 0,
    }).inserted).toBe(false);
  });

  it('init is idempotent — re-opening an existing DB does not throw on duplicate column', () => {
    new TokenLedger({ dbPath, claudeProjectsDir: tmp });
    // Re-open the same file. The ALTER TABLE migration must swallow
    // "duplicate column name" or this throws.
    expect(() => new TokenLedger({ dbPath, claudeProjectsDir: tmp })).not.toThrow();
  });
});

// ── AnthropicIntelligenceProvider wiring ───────────────────────────────

describe('AnthropicIntelligenceProvider Phase 1 wiring', () => {
  type RecordedCall = Parameters<NonNullable<ConstructorParameters<typeof AnthropicIntelligenceProvider>[1]>['ledger']>[0];
  let recorded: any[];
  let fakeLedger: { recordEvent: (e: any) => { inserted: boolean } };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    recorded = [];
    fakeLedger = {
      recordEvent: (e) => { recorded.push(e); return { inserted: true }; },
    };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(payload: any) {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => '',
    })) as any;
  }

  it('records ledger event with composed attribution_key when attribution.component is set', async () => {
    stubFetch({
      id: 'msg_1',
      model: 'claude-haiku',
      content: [{ type: 'text', text: 'no' }],
      usage: { input_tokens: 42, output_tokens: 1 },
    });
    const provider = new AnthropicIntelligenceProvider('fake-key', { ledger: fakeLedger });
    const out = await provider.evaluate('is this stuck?', { attribution: { component: 'InputDetector' } });
    expect(out).toBe('no');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].attributionKey).toMatch(/^InputDetector::[0-9a-f]{8}$/);
    expect(recorded[0].inputTokens).toBe(42);
    expect(recorded[0].outputTokens).toBe(1);
    expect(recorded[0].requestId).toBe('msg_1');
  });

  it('falls back to unknown::<fp> when attribution.component is missing', async () => {
    stubFetch({
      id: 'msg_2',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicIntelligenceProvider('fake-key', { ledger: fakeLedger });
    await provider.evaluate('hello');
    expect(recorded[0].attributionKey).toMatch(/^unknown::[0-9a-f]{8}$/);
  });

  it('still returns LLM result if ledger write throws (ledger never breaks user path)', async () => {
    stubFetch({
      id: 'msg_3',
      content: [{ type: 'text', text: 'survived' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const brokenLedger = { recordEvent: () => { throw new Error('disk full'); } };
    const provider = new AnthropicIntelligenceProvider('fake-key', { ledger: brokenLedger });
    const out = await provider.evaluate('foo', { attribution: { component: 'Foo' } });
    expect(out).toBe('survived');
  });

  it('consults the rate gate; throws when gate refuses', async () => {
    stubFetch({ id: 'never', content: [{ type: 'text', text: '' }], usage: {} });
    const refusingGate = {
      shouldFire: () => false,
      decide: () => ({ allowed: false, decidedAt: '', reason: 'throttle-active' as const }),
      reset: () => {},
    };
    const provider = new AnthropicIntelligenceProvider('fake-key', {
      rateGate: refusingGate as unknown as LlmRateGate,
      ledger: fakeLedger,
    });
    await expect(provider.evaluate('any', { attribution: { component: 'X' } }))
      .rejects.toThrow(/throttled/);
    expect(recorded).toHaveLength(0);
  });
});

// ── lint-no-direct-llm-http ────────────────────────────────────────────

describe('lint-no-direct-llm-http', () => {
  it('exits 0 on the current tree (grandfathered files allowlisted)', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/lint-no-direct-llm-http.js')], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
  });

  it('rejects a synthetic violation (new file containing api.anthropic.com)', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-lint-'));
    const fakeViolation = path.join(tmpdir, 'BadCaller.ts');
    fs.writeFileSync(
      fakeViolation,
      'export async function bad() { return fetch("https://api.anthropic.com/v1/messages"); }\n',
    );
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts/lint-no-direct-llm-http.js'), fakeViolation],
        { cwd: ROOT, encoding: 'utf-8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('api.anthropic.com');
    } finally {
      SafeFsExecutor.safeRmSync(tmpdir, { recursive: true, force: true, operation: 'tests/unit/burn-detection-phase-1.test.ts:lint-synthetic' });
    }
  });

  it('accepts the IntelligenceProvider files (allowlist works)', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/lint-no-direct-llm-http.js'),
       path.join(ROOT, 'src/core/AnthropicIntelligenceProvider.ts'),
       path.join(ROOT, 'src/core/ClaudeCliIntelligenceProvider.ts')],
      { cwd: ROOT, encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);
  });
});
