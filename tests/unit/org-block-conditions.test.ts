/**
 * EXO 3.0 conditions for block mode (docs/specs/org-never-actions.md, "Block mode: Justin's approval and
 * its EXO 3.0 conditions"): 2 (a held action reaches the person), 5 (the judge never swaps provider),
 * 6 (spend from reported tokens; the person is told once when the budget is used).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrgCheck, messageEvidence, setOrgNotify, OrgActionChecker } from '../../src/core/OrgActionCheck.js';
import { OrgPackStore } from '../../src/core/OrgPackStore.js';
import { newOrgKeyPair, sha256Hex, signRecord } from '../../src/core/OrgPack.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/org-block-conditions.test.ts' }); });
afterEach(() => setOrgNotify(null));
const POLICY = '## Never\n- Share personal information about donors outside the organization\n';
function joined(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-blk-')); dirs.push(dir);
  const k = newOrgKeyPair();
  const record = signRecord({ v: 1, orgId: 'org_AAAAAAAAAAAAAAAAAAAA', orgName: 'Monroe Institute', version: 1, policySha256: sha256Hex(POLICY), maxIndependence: 'balanced', publishedAt: 'x', publishedBy: 'Justin', keepers: ['Justin'], updateOrigin: null, signerPublicKey: k.publicKey }, k.privateKeyPem);
  expect(new OrgPackStore(dir, 'm').apply({ record, policy: POLICY }).ok).toBe(true);
  return dir;
}
const BLOCK = { orgPolicy: { actions: { mode: 'block', blockingApproved: true } } };

describe('block-mode conditions', () => {
  it('a held action raises one notice for the person', async () => {
    const dir = joined();
    const seen: string[] = [];
    setOrgNotify((key) => seen.push(key));
    const p: IntelligenceProvider = { frameworkId: 'claude-code', evaluate: async () => '{"breach": true, "rule": 1, "confidence": 0.9}' };
    const r = await runOrgCheck({ stateDir: dir, config: BLOCK as never, provider: p }, messageEvidence('Donor list: Pat, 1 Elm St', 'app', 'c1'), { userRequest: '', deadlineAt: Date.now() + 5000 });
    expect(r.decision).toBe('deny');
    expect(seen).toEqual([`org-check:${(r as { checkId: string }).checkId}`]);
  });

  it('the judge asks for no failure swap, and spend follows reported tokens', async () => {
    const dir = joined();
    let opts: Record<string, unknown> = {};
    const p: IntelligenceProvider = { frameworkId: 'claude-code', evaluate: async (_p: string, o?: unknown) => {
      opts = (o ?? {}) as Record<string, unknown>;
      (opts.onUsage as ((u: object) => void) | undefined)?.({ inputTokens: 1000, outputTokens: 100 });
      return '{"breach": false}';
    } };
    await runOrgCheck({ stateDir: dir, config: {} as never, provider: p }, messageEvidence('Lunch at noon', 'app', 'c1'), { userRequest: '', deadlineAt: Date.now() + 5000 });
    expect((opts.attribution as { noFailureSwap?: boolean }).noFailureSwap).toBe(true);
    expect((opts.attribution as { pinFramework?: string }).pinFramework).toBe('claude-code');
    expect(new OrgActionChecker(dir).spentToday()).toBeCloseTo(1000 * 0.0001 + 100 * 0.0005, 6);
  });

  it('a used budget tells the person once a day', async () => {
    const dir = joined();
    const seen: string[] = [];
    setOrgNotify((key) => seen.push(key));
    const p: IntelligenceProvider = { frameworkId: 'claude-code', evaluate: async () => '{"breach": false}' };
    const cfg = { orgPolicy: { actions: { judgeDailyCents: 0 } } };
    await runOrgCheck({ stateDir: dir, config: cfg as never, provider: p }, messageEvidence('a', 'app', 'c1'), { userRequest: '', deadlineAt: Date.now() + 5000 });
    await runOrgCheck({ stateDir: dir, config: cfg as never, provider: p }, messageEvidence('b', 'app', 'c1'), { userRequest: '', deadlineAt: Date.now() + 5000 });
    expect(seen.filter((k) => k.startsWith('org-budget:'))).toHaveLength(1);
  });
  it('a membership file changed by hand after joining still checks, holds, and tells the person', async () => {
    const dir = joined();
    const seen: string[] = [];
    setOrgNotify((key) => seen.push(key));
    const p: IntelligenceProvider = { frameworkId: 'claude-code', evaluate: async () => '{"breach": false}' };
    await runOrgCheck({ stateDir: dir, config: BLOCK as never, provider: p }, messageEvidence('hello', 'app', 'c1'), { userRequest: '', deadlineAt: Date.now() + 5000 });
    const mf = path.join(dir, 'org', 'membership.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf-8'));
    fs.writeFileSync(mf, JSON.stringify({ ...m, state: 'left' }));
    const r = await runOrgCheck({ stateDir: dir, config: BLOCK as never, provider: p }, messageEvidence('Donor list', 'app', 'c1'), { userRequest: '', deadlineAt: Date.now() + 5000 });
    expect(r.decision).toBe('deny');
    expect(seen.some((k) => k.startsWith('org-membership-tamper:'))).toBe(true);
  });
});
