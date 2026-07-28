/**
 * Tier-1 unit — CredentialAuditEmit (the §2.9 single secret-scrub chokepoint) + the manual-lever
 * detective controls (per-pair cooldown + §0.g force budget) + restore-enrollment coherence-park.
 *
 * THE BLOCKER LENS (secret-leak-via-audit): feed a record carrying a real-looking `sk-ant-…`
 * token through ALL THREE emit surfaces (jsonl write, /credentials/* response, attention-item) and
 * assert the token substring appears in NONE of the three emitted surfaces.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CredentialAuditEmit,
  scrub,
  scrubString,
} from '../../src/core/CredentialAuditEmit.js';
import { CredentialManualLevers } from '../../src/core/CredentialManualLevers.js';
import { classifyRestoreCoherence } from '../../src/core/CredentialRestoreEnrollment.js';

// A real-shaped Anthropic oauth access token (the canonical leak vector).
const REAL_TOKEN = 'sk-ant-oat01-AbCdEf1234567890_GhIjKlMnOpQrStUvWxYz-9876543210';
const TOKEN_CORE = 'AbCdEf1234567890_GhIjKlMnOpQrStUvWxYz-9876543210';

describe('CredentialAuditEmit.scrub — secret-leak-via-audit (THE blocker)', () => {
  it('redacts a token on ALL THREE surfaces: jsonl write, response body, attention item', async () => {
    let writtenLine = '';
    let deliveredAttention: unknown = null;
    const emit = new CredentialAuditEmit({
      writeLine: (line) => { writtenLine = line; },
      emitAttention: (item) => { deliveredAttention = item; },
      now: () => 'T',
    });

    // The record carries the token inside a free-text `reason` — the leak a field-name scan misses.
    const record = { event: 'swap-step', reason: `security stderr: token was ${REAL_TOKEN} oops`, slotA: '~/.claude' };

    // Surface 1 — jsonl write.
    emit.audit(record);
    // Surface 2 — response body.
    const responded = emit.response({ ...record, nested: { deep: REAL_TOKEN, arr: [REAL_TOKEN] } });
    // Surface 3 — attention item.
    await emit.attention({
      id: 'x', title: 't', summary: `leaked ${REAL_TOKEN}`, category: 'credential-repointing', priority: 'HIGH',
    });

    // The token CORE must appear in NONE of the three emitted surfaces.
    expect(writtenLine).not.toContain(TOKEN_CORE);
    expect(writtenLine).not.toContain(REAL_TOKEN);
    expect(JSON.stringify(responded)).not.toContain(TOKEN_CORE);
    expect(JSON.stringify(deliveredAttention)).not.toContain(TOKEN_CORE);

    // And the redaction marker IS present (proving it was scrubbed, not dropped).
    expect(writtenLine).toContain('[TOKEN:');
    expect(JSON.stringify(responded)).toContain('[TOKEN:');
    expect(JSON.stringify(deliveredAttention)).toContain('[TOKEN:');
  });

  it('deep-scrubs nested objects and arrays (no token survives anywhere in the tree)', () => {
    const out = scrub({ a: REAL_TOKEN, b: { c: [REAL_TOKEN, { d: REAL_TOKEN }] } });
    expect(JSON.stringify(out)).not.toContain(TOKEN_CORE);
  });

  it('scrubs a bare sk-ant token and a long high-entropy run, leaves ids/paths/timestamps intact', () => {
    expect(scrubString(REAL_TOKEN)).not.toContain(TOKEN_CORE);
    // A long opaque bearer with no sk-ant prefix is still caught.
    const bearer = 'Bearer ZyXwVuTsRqPoNmLkJiHgFeDcBa0987654321ZyXwVuTs';
    expect(scrubString(bearer)).toContain('[TOKEN:');
    // Account ids, slot paths, 8-hex suffixes, ISO timestamps are NOT mangled.
    expect(scrubString('account claude-1 in ~/.claude at 2026-06-13T00:00:00.000Z')).toBe(
      'account claude-1 in ~/.claude at 2026-06-13T00:00:00.000Z',
    );
    expect(scrubString('Claude Code-credentials-a1b2c3d4')).toBe('Claude Code-credentials-a1b2c3d4');
  });

  it('audit() never throws when the writeLine sink throws (observability is best-effort)', () => {
    const emit = new CredentialAuditEmit({ writeLine: () => { throw new Error('disk full'); } });
    expect(() => emit.audit({ event: 'x', reason: REAL_TOKEN })).not.toThrow();
  });

  it('attention() never throws when delivery throws; the item was scrubbed before delivery', async () => {
    let seen: unknown = null;
    const emit = new CredentialAuditEmit({ emitAttention: (i) => { seen = i; throw new Error('telegram down'); } });
    await expect(emit.attention({ id: 'x', title: 't', summary: REAL_TOKEN, category: 'c', priority: 'HIGH' })).resolves.toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(TOKEN_CORE);
  });
});

describe('CredentialManualLevers — per-pair cooldown + §0.g force budget', () => {
  it('refuses a second swap of the same pair on cooldown; force:true overrides', () => {
    let t = 1_000_000;
    const lv = new CredentialManualLevers({ pairCooldownMs: 10_000, now: () => t });
    expect(lv.evaluateSwap('A', 'B', false)).toMatchObject({ allowed: true, forced: false });
    lv.recordSwap('A', 'B', false);
    // Within cooldown → refused (surfaced reason, not silent).
    t += 5_000;
    const refused = lv.evaluateSwap('A', 'B', false);
    expect(refused.allowed).toBe(false);
    expect((refused as { code: string }).code).toBe('pair-cooldown');
    // force:true overrides the cooldown.
    expect(lv.evaluateSwap('A', 'B', true)).toMatchObject({ allowed: true, forced: true });
    // The pair is order-independent.
    expect(lv.evaluateSwap('B', 'A', false).allowed).toBe(false);
    // After the cooldown rolls, a normal swap is allowed again.
    t += 6_000;
    expect(lv.evaluateSwap('A', 'B', false).allowed).toBe(true);
  });

  it('§0.g: force:true is budgeted — exhaustion refuses further FORCED swaps until the window rolls', () => {
    let t = 1_000_000;
    const lv = new CredentialManualLevers({ pairCooldownMs: 0, maxForcedPerWindow: 2, forcedWindowMs: 60_000, now: () => t });
    // Two forced swaps consume the budget.
    expect(lv.evaluateSwap('A', 'B', true).allowed).toBe(true); lv.recordSwap('A', 'B', true);
    expect(lv.evaluateSwap('C', 'D', true).allowed).toBe(true); lv.recordSwap('C', 'D', true);
    expect(lv.forcedBudgetRemaining()).toBe(0);
    // The third FORCED swap is refused with a named reason (non-destructive).
    const refused = lv.evaluateSwap('E', 'F', true);
    expect(refused.allowed).toBe(false);
    expect((refused as { code: string }).code).toBe('force-budget-exhausted');
    // A NON-forced swap is never blocked by the force budget.
    expect(lv.evaluateSwap('E', 'F', false).allowed).toBe(true);
    // The window rolls → forced budget restores.
    t += 61_000;
    expect(lv.evaluateSwap('E', 'F', true).allowed).toBe(true);
  });
});

describe('classifyRestoreCoherence — one-directional park (restore-enrollment poison)', () => {
  const ok = { raw: '{}', oauth: { refreshToken: 'r', accessToken: 'a' } };

  it('coherent: parse + refresh-token + access-tenant == refresh-lineage → safe to exchange', () => {
    const v = classifyRestoreCoherence(ok, { accessTenant: 'acc-A', refreshLineage: 'acc-A' });
    expect(v).toEqual({ coherent: true, tenant: 'acc-A' });
  });

  it('Frankenstein (access-tenant != refresh-lineage) → parked one-directionally, NEVER exchanged', () => {
    const v = classifyRestoreCoherence(ok, { accessTenant: 'acc-B', refreshLineage: 'acc-A' });
    expect(v.coherent).toBe(false);
    expect((v as { park: string }).park).toBe('one-directional');
  });

  it('unparseable blob (no oauth) → parked one-directionally', () => {
    const v = classifyRestoreCoherence({ raw: 'garbage', oauth: null }, { accessTenant: 'acc-A', refreshLineage: 'acc-A' });
    expect(v.coherent).toBe(false);
    expect((v as { park: string }).park).toBe('one-directional');
  });

  it('refresh-token-less blob → parked one-directionally', () => {
    const v = classifyRestoreCoherence({ raw: '{}', oauth: { accessToken: 'a' } }, { accessTenant: 'acc-A', refreshLineage: 'acc-A' });
    expect(v.coherent).toBe(false);
  });

  it('oracle unavailable (access-tenant null) → cannot certify → parked (safe direction)', () => {
    const v = classifyRestoreCoherence(ok, { accessTenant: null, refreshLineage: 'acc-A' });
    expect(v.coherent).toBe(false);
    expect((v as { park: string }).park).toBe('one-directional');
  });
});
