/**
 * Unit tests for NovelFailureReviewer (Tier-3 S-1).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A10, §A18, §A26, §A32, §A47,
 * §A50, §A57 Tier-3, §A60, §A65.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  NovelFailureReviewer,
  parseAndSanitizeLlmOutput,
  redactInjectionArtifacts,
  computeClusterSignature,
  tokenClassify,
  LLM_MODEL_ALLOWLIST,
  type NovelFailureReviewerOpts,
  type ObservabilityEvent,
} from '../../src/remediation/NovelFailureReviewer.js';
import {
  AuditWriter,
  type AuditEntry,
} from '../../src/remediation/audit/AuditWriter.js';
import { AuditProjection } from '../../src/remediation/audit/AuditProjection.js';
import { RemediationKeyVault } from '../../src/remediation/RemediationKeyVault.js';
import { TrustElevationSource } from '../../src/remediation/TrustElevationSource.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const VALID_PASSPHRASE = 'novel-failure-reviewer-passphrase-of-sufficient-length';

function envOpts() {
  return {
    forceBackend: 'env-passphrase' as const,
    allowEnvPassphraseFallback: true,
    passphraseResolver: () => VALID_PASSPHRASE,
  };
}

function makeAuditEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    entryId: overrides?.entryId ?? crypto.randomUUID(),
    attemptId: overrides?.attemptId ?? `none:${crypto.randomUUID()}`,
    outcome: overrides?.outcome ?? 'no-matching-runbook',
    runbookId: overrides?.runbookId,
    subsystem: overrides?.subsystem ?? 'memory',
    reason: overrides?.reason ?? { redacted: 'SQLITE_BUSY at handler X' },
    errorCode: overrides?.errorCode ?? 'SQLITE_BUSY',
    timestamp: overrides?.timestamp ?? Date.now(),
    monotonicTs: overrides?.monotonicTs ?? process.hrtime.bigint(),
    auditToken: overrides?.auditToken ?? Buffer.from('valid-token'),
  };
}

async function setup(opts?: {
  config?: Partial<NovelFailureReviewerOpts['config']>;
  llmCaller?: NovelFailureReviewerOpts['llmCaller'];
  trustSource?: TrustElevationSource;
  getActiveRunbookErrorCodes?: () => ReadonlySet<string>;
  now?: () => number;
  processLifetimeToken?: string;
  events?: ObservabilityEvent[];
}): Promise<{
  reviewer: NovelFailureReviewer;
  writer: AuditWriter;
  projection: AuditProjection;
  tmpDir: string;
  events: ObservabilityEvent[];
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-fr-'));
  const vault = await RemediationKeyVault.forStateDir(tmpDir, envOpts());
  const writer = new AuditWriter(tmpDir, {
    machineId: 'm-test',
    tokenVerifier: (e) => e.auditToken.toString() === 'valid-token',
  });
  const projection = new AuditProjection(tmpDir, { machineId: 'm-test' });
  const events: ObservabilityEvent[] = opts?.events ?? [];
  const reviewer = new NovelFailureReviewer({
    stateDir: tmpDir,
    auditProjection: projection,
    llmCaller:
      opts?.llmCaller ??
      (async () =>
        JSON.stringify({
          summary: 'recurring sqlite busy contention',
          suggestedErrorCode: 'SQLITE_BUSY_CONTENTION',
          hypothesis: 'two callers contending on a shared writer handle',
        })),
    keyVault: vault,
    agentId: 'echo-test',
    machineId: 'm-test',
    trustSource: opts?.trustSource,
    getActiveRunbookErrorCodes: opts?.getActiveRunbookErrorCodes,
    onEvent: (e) => events.push(e),
    now: opts?.now,
    processLifetimeToken: opts?.processLifetimeToken,
    config: opts?.config as NovelFailureReviewerOpts['config'],
  });
  return { reviewer, writer, projection, tmpDir, events };
}

function cleanup(tmpDir: string): void {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/NovelFailureReviewer.test.ts:cleanup',
  });
}

async function appendUnmatched(writer: AuditWriter, n: number, overrides?: Partial<AuditEntry>): Promise<void> {
  for (let i = 0; i < n; i++) {
    await writer.append(makeAuditEntry(overrides));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('NovelFailureReviewer (Tier-3 S-1)', () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(() => {
    for (const d of tmpDirs) cleanup(d);
  });

  function track<T extends { tmpDir: string }>(s: T): T {
    tmpDirs.push(s.tmpDir);
    return s;
  }

  // ── 1. runTick with no audit entries → 0 clusters, 0 proposals ──
  it('1. runTick with no audit entries → 0 clusters, 0 proposals', async () => {
    const s = track(await setup());
    const out = await s.reviewer.runTick();
    expect(out).toEqual({ clusters: 0, proposals: 0 });
    expect(await s.reviewer.listProposals()).toHaveLength(0);
  });

  // ── 2. Below threshold → no proposal ──
  it('2. Below threshold (2 occurrences) → no proposal', async () => {
    const s = track(await setup());
    await appendUnmatched(s.writer, 2);
    const out = await s.reviewer.runTick();
    expect(out.clusters).toBe(1);
    expect(out.proposals).toBe(0);
  });

  // ── 3. At threshold → proposal generated ──
  it('3. At threshold (3 occurrences × 2 lifetimes) → proposal emitted', async () => {
    const s = track(await setup({ processLifetimeToken: 'pid-A' }));
    await appendUnmatched(s.writer, 3);
    // Simulate first lifetime tick.
    await s.reviewer.runTick();

    // Second lifetime: re-instantiate reviewer with a fresh lifetime token.
    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    const events2: ObservabilityEvent[] = [];
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () =>
        JSON.stringify({
          summary: 'cluster keeps recurring',
          suggestedErrorCode: 'NOVEL_SQLITE_BUSY',
          hypothesis: 'shared writer contention across restarts',
        }),
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      onEvent: (e) => events2.push(e),
      processLifetimeToken: 'pid-B',
    });
    await appendUnmatched(s.writer, 3);
    const out = await reviewer2.runTick();
    expect(out.proposals).toBe(1);
    const proposals = await reviewer2.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].suggestedErrorCode).toBe('NOVEL_SQLITE_BUSY');
    expect(proposals[0].producingAgentId).toBe('echo-test');
    expect(proposals[0].producingAgentSignature.length).toBeGreaterThan(0);
  });

  // ── 4. Outstanding cap (3) → 4th cluster queues silently ──
  it('4. Outstanding-proposal cap → 4th cluster queues silently (§A10)', async () => {
    const s = track(await setup({ processLifetimeToken: 'pid-A' }));
    // Helper: drive a cluster to threshold (3 occurrences × 2 lifetimes).
    async function emitForCluster(suffix: string): Promise<void> {
      await appendUnmatched(s.writer, 3, {
        subsystem: `subsys-${suffix}`,
        errorCode: `CODE_${suffix}`,
        reason: { redacted: `cluster ${suffix} reason` },
      });
    }
    // Drive 4 distinct clusters across 2 lifetimes.
    for (const k of ['A', 'B', 'C', 'D']) await emitForCluster(k);
    await s.reviewer.runTick();

    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    let llmCalls = 0;
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () => {
        llmCalls += 1;
        return JSON.stringify({
          summary: `proposal #${llmCalls}`,
          suggestedErrorCode: `NOVEL_CODE_${llmCalls}`,
          hypothesis: `hyp ${llmCalls}`,
        });
      },
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      onEvent: (e) => s.events.push(e),
      processLifetimeToken: 'pid-B',
    });
    for (const k of ['A', 'B', 'C', 'D']) await emitForCluster(k);
    const out = await reviewer2.runTick();
    expect(out.proposals).toBe(3);
    expect(llmCalls).toBe(3);
    const queueDepthEvents = s.events.filter(
      (e) => e.event === 'remediation.novel-failure-reviewer.proposal-queue-depth',
    );
    expect(queueDepthEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── 5. Collision with existing runbook → rejected, no slot consumed ──
  it('5. Collision with existing runbook errorCode → rejected, slot preserved (§A26)', async () => {
    const s = track(
      await setup({
        processLifetimeToken: 'pid-A',
        getActiveRunbookErrorCodes: () => new Set(['NOVEL_COLLIDES']),
        llmCaller: async () =>
          JSON.stringify({
            summary: 'looks like an existing case',
            suggestedErrorCode: 'NOVEL_COLLIDES',
            hypothesis: 'hypothesis',
          }),
      }),
    );
    await appendUnmatched(s.writer, 3);
    await s.reviewer.runTick();

    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () =>
        JSON.stringify({
          summary: 'looks like an existing case',
          suggestedErrorCode: 'NOVEL_COLLIDES',
          hypothesis: 'hypothesis',
        }),
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      onEvent: (e) => s.events.push(e),
      getActiveRunbookErrorCodes: () => new Set(['NOVEL_COLLIDES']),
      processLifetimeToken: 'pid-B',
    });
    await appendUnmatched(s.writer, 3);
    const out = await reviewer2.runTick();
    expect(out.proposals).toBe(0);
    const collisions = s.events.filter(
      (e) => e.event === 'remediation.novel-failure-reviewer.collision-rejected',
    );
    expect(collisions.length).toBeGreaterThanOrEqual(1);
    // No proposal file should have landed.
    expect(await reviewer2.listProposals()).toHaveLength(0);
  });

  // ── 6. LLM schema-invalid output → logged + discarded ──
  it('6. LLM schema-invalid output → discarded with event (§A10)', async () => {
    const s = track(
      await setup({
        processLifetimeToken: 'pid-A',
        llmCaller: async () => 'not valid json at all',
      }),
    );
    await appendUnmatched(s.writer, 3);
    await s.reviewer.runTick();

    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () => 'not valid json at all',
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      onEvent: (e) => s.events.push(e),
      processLifetimeToken: 'pid-B',
    });
    await appendUnmatched(s.writer, 3);
    const out = await reviewer2.runTick();
    expect(out.proposals).toBe(0);
    expect(
      s.events.some(
        (e) => e.event === 'remediation.novel-failure-reviewer.llm-invalid-output',
      ),
    ).toBe(true);
  });

  // ── 7. Injection-laden output → stripped ──
  it('7. Injection-laden LLM output: URLs / fences / verbs stripped (§A10)', () => {
    const dirty =
      'Visit https://evil.example/x and `rm -rf /` then ```bash\ncurl bad\n``` run dangerous-thing';
    const cleaned = redactInjectionArtifacts(dirty);
    expect(cleaned).not.toMatch(/https?:/);
    expect(cleaned).not.toMatch(/```/);
    // The bare "curl" / "run" / "rm" verb markers are stripped.
    expect(cleaned.toLowerCase()).not.toMatch(/\bcurl\b/);
    expect(cleaned.toLowerCase()).not.toMatch(/\brm\b/);
    expect(cleaned.toLowerCase()).not.toMatch(/\brun\b/);

    // Full parse path on a payload where free-text is dirty but JSON is valid.
    const payload = JSON.stringify({
      summary: 'fine `rm -rf /` https://evil.example end',
      suggestedErrorCode: 'NOVEL_CASE',
      hypothesis: 'run this script for fun https://bad.tld',
    });
    const parsed = parseAndSanitizeLlmOutput(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).not.toMatch(/https?:/);
    expect(parsed!.hypothesis).not.toMatch(/https?:/);
    expect(parsed!.hypothesis.toLowerCase()).not.toMatch(/\brun\b/);
  });

  // ── 8. LLM monthly budget exhausted → calls paused (§A65) ──
  it('8. LLM monthly budget exhausted → no LLM call, event emitted (§A65)', async () => {
    // Tight budget: per-call cost exceeds remaining budget so the FIRST
    // qualifying cluster is refused at the budget gate.
    let llmCalls = 0;
    const s = track(
      await setup({
        processLifetimeToken: 'pid-A',
        config: {
          llmMonthlyBudgetUsd: 0.0005,
          llmEstimatedCostPerCallUsd: 0.001,
          llmPerCallCostCapUsd: 0.01,
        },
        llmCaller: async () => {
          llmCalls += 1;
          return JSON.stringify({
            summary: 's',
            suggestedErrorCode: 'NOVEL_A',
            hypothesis: 'h',
          });
        },
      }),
    );
    // Drive a cluster across 2 lifetimes.
    await appendUnmatched(s.writer, 3);
    await s.reviewer.runTick();

    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    let secondaryCalls = 0;
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () => {
        secondaryCalls += 1;
        return JSON.stringify({
          summary: 's',
          suggestedErrorCode: 'NOVEL_B',
          hypothesis: 'h',
        });
      },
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      onEvent: (e) => s.events.push(e),
      processLifetimeToken: 'pid-B',
      config: {
        llmMonthlyBudgetUsd: 0.0005,
        llmEstimatedCostPerCallUsd: 0.001,
        llmPerCallCostCapUsd: 0.01,
      },
    });
    await appendUnmatched(s.writer, 3);
    const out = await reviewer2.runTick();
    expect(out.proposals).toBe(0);
    expect(secondaryCalls).toBe(0);
    expect(
      s.events.some(
        (e) => e.event === 'remediation.novel-failure-reviewer.llm-budget-exhausted',
      ),
    ).toBe(true);
    void llmCalls;
  });

  // ── 9. Per-signature counter persists across ticks ──
  it('9. Per-signature counter persists across ticks (§A47)', async () => {
    const s = track(await setup({ processLifetimeToken: 'pid-A' }));
    await appendUnmatched(s.writer, 2);
    await s.reviewer.runTick();

    // Counters file should exist with HMAC-protected body.
    const countersPath = path.join(
      s.tmpDir,
      'remediation',
      'cluster-counters-m-test.json',
    );
    expect(fs.existsSync(countersPath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(countersPath, 'utf8'));
    expect(persisted.hmac).toBeTruthy();
    expect(persisted.body.counters.length).toBeGreaterThan(0);

    // Spin up a fresh reviewer — it should LOAD the counters and pick up
    // where we left off.
    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () =>
        JSON.stringify({
          summary: 'continues',
          suggestedErrorCode: 'NOVEL_CONTINUES',
          hypothesis: 'continues',
        }),
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      processLifetimeToken: 'pid-B',
    });
    // One more occurrence puts us at 3 occurrences across 2 lifetimes
    // → threshold crossed.
    await appendUnmatched(s.writer, 1);
    const out = await reviewer2.runTick();
    expect(out.proposals).toBe(1);
  });

  // ── 10. LRU eviction at 500 ──
  it('10. Cluster LRU evicts oldest at cap (§A10)', async () => {
    const s = track(
      await setup({
        processLifetimeToken: 'pid-A',
        config: { clusterLruCap: 5 },
      }),
    );
    // Drive 7 distinct clusters → 2 should be evicted.
    for (let i = 0; i < 7; i++) {
      await s.writer.append(
        makeAuditEntry({
          subsystem: `subsys-${i}`,
          errorCode: `CODE_${i}`,
          reason: { redacted: `cluster ${i} reason` },
        }),
      );
    }
    await s.reviewer.runTick();
    const evictionEvents = s.events.filter(
      (e) => e.event === 'remediation.novel-failure-reviewer.cluster-evicted',
    );
    expect(evictionEvents.length).toBeGreaterThanOrEqual(2);
  });

  // ── 11. dismissProposal requires collaborative trust ──
  it('11. dismissProposal requires collaborative trust (§A26)', async () => {
    const lowTrust = new TrustElevationSource({
      profile: 'supervised',
      channels: [],
    });
    const highTrust = new TrustElevationSource({
      profile: 'collaborative',
      channels: [],
    });

    const s = track(
      await setup({
        processLifetimeToken: 'pid-A',
        trustSource: lowTrust,
      }),
    );
    await appendUnmatched(s.writer, 3);
    await s.reviewer.runTick();

    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () =>
        JSON.stringify({
          summary: 's',
          suggestedErrorCode: 'NOVEL_DISMISS',
          hypothesis: 'h',
        }),
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      trustSource: lowTrust,
      processLifetimeToken: 'pid-B',
    });
    await appendUnmatched(s.writer, 3);
    await reviewer2.runTick();
    const proposals = await reviewer2.listProposals();
    expect(proposals).toHaveLength(1);

    await expect(
      reviewer2.dismissProposal(proposals[0].proposalId, { userId: 'justin' }),
    ).rejects.toThrow(/trust-level-below-collaborative/);

    // High-trust reviewer succeeds.
    const reviewer3 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () => '{}',
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      trustSource: highTrust,
    });
    await reviewer3.dismissProposal(proposals[0].proposalId, { userId: 'justin' });
    const after = await reviewer3.listProposals();
    expect(after[0].status).toBe('dismissed');
  });

  // ── 12. proposalId deterministic per §A60 ──
  it('12. proposalId is deterministic per §A60', async () => {
    const fixedNow = 1700_000_000_000;
    const s = track(
      await setup({
        processLifetimeToken: 'pid-A',
        now: () => fixedNow,
      }),
    );
    await appendUnmatched(s.writer, 3);
    await s.reviewer.runTick();

    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () =>
        JSON.stringify({
          summary: 's',
          suggestedErrorCode: 'NOVEL_DET',
          hypothesis: 'h',
        }),
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      now: () => fixedNow,
      processLifetimeToken: 'pid-B',
    });
    await appendUnmatched(s.writer, 3);
    await reviewer2.runTick();
    const first = await reviewer2.listProposals();
    expect(first).toHaveLength(1);
    const firstId = first[0].proposalId;

    // Running again with same window + signature should NOT create a new
    // proposal (deterministic id, idempotent emission).
    await appendUnmatched(s.writer, 1);
    await reviewer2.runTick();
    const second = await reviewer2.listProposals();
    expect(second).toHaveLength(1);
    expect(second[0].proposalId).toBe(firstId);
  });

  // ── 13. producingAgentId signed via F-1 capability leaf ──
  it('13. producingAgentSignature is verifiable against the capability leaf (§A32)', async () => {
    const s = track(await setup({ processLifetimeToken: 'pid-A' }));
    await appendUnmatched(s.writer, 3);
    await s.reviewer.runTick();

    const vault = await RemediationKeyVault.forStateDir(s.tmpDir, envOpts());
    const reviewer2 = new NovelFailureReviewer({
      stateDir: s.tmpDir,
      auditProjection: s.projection,
      llmCaller: async () =>
        JSON.stringify({
          summary: 's',
          suggestedErrorCode: 'NOVEL_SIGNED',
          hypothesis: 'h',
        }),
      keyVault: vault,
      agentId: 'echo-test',
      machineId: 'm-test',
      processLifetimeToken: 'pid-B',
    });
    await appendUnmatched(s.writer, 3);
    await reviewer2.runTick();
    const [proposal] = await reviewer2.listProposals();
    expect(proposal.producingAgentId).toBe('echo-test');
    // Independently re-derive the signature with the same leaf and confirm.
    const leaf = vault.deriveLeafKey('capability', 'echo-test');
    const expected = crypto
      .createHmac('sha256', leaf)
      .update(`${proposal.proposalId}:echo-test:${proposal.generatedAt}`)
      .digest('hex');
    expect(proposal.producingAgentSignature).toBe(expected);
  });

  // ── 14. suggestedErrorCode regex enforced ──
  it('14. suggestedErrorCode regex enforced (§A10)', () => {
    expect(
      parseAndSanitizeLlmOutput(
        JSON.stringify({
          summary: 's',
          suggestedErrorCode: 'lower_case_not_allowed',
          hypothesis: 'h',
        }),
      ),
    ).not.toBeNull(); // because we upper-case BEFORE checking — confirms sanitization works
    expect(
      parseAndSanitizeLlmOutput(
        JSON.stringify({
          summary: 's',
          suggestedErrorCode: 'A', // too short after regex check
          hypothesis: 'h',
        }),
      ),
    ).toBeNull();
    expect(
      parseAndSanitizeLlmOutput(
        JSON.stringify({
          summary: 's',
          suggestedErrorCode: '1STARTSWITHDIGIT',
          hypothesis: 'h',
        }),
      ),
    ).toBeNull();
    expect(
      parseAndSanitizeLlmOutput(
        JSON.stringify({
          summary: 's',
          suggestedErrorCode:
            'WAY_TOO_LONG_TO_BE_VALID_AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          hypothesis: 'h',
        }),
      ),
    ).toBeNull();
    // Length / regex constraints on summary + hypothesis.
    const bigSummary = 'x'.repeat(300);
    const parsed = parseAndSanitizeLlmOutput(
      JSON.stringify({
        summary: bigSummary,
        suggestedErrorCode: 'GOOD_CODE',
        hypothesis: 'h',
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.summary.length).toBeLessThanOrEqual(200);

    // Allowlist enforcement.
    expect(LLM_MODEL_ALLOWLIST.has('claude-haiku-class-default')).toBe(true);
    expect(LLM_MODEL_ALLOWLIST.has('not-an-allowlisted-model')).toBe(false);
  });

  // ── 15. Token-class fingerprint collapses cardinality ──
  it('15. tokenClassify collapses paths / hex / numbers (§A10)', () => {
    expect(tokenClassify('error in /usr/local/lib/x.so at line')).toMatch(/<path>/);
    expect(tokenClassify('0123456789abcdef0123 deadbeefcafe1234')).toMatch(/<hex>/);
    expect(tokenClassify('count=99999 retries=12345')).toMatch(/<num>/);
    // Different paths / hex / numbers collapse to identical signatures.
    const a = makeAuditEntry({
      subsystem: 's',
      errorCode: 'CODE',
      reason: { redacted: 'error at /var/foo/123 with hex deadbeefdeadbeef' },
    });
    const b = makeAuditEntry({
      subsystem: 's',
      errorCode: 'CODE',
      reason: { redacted: 'error at /var/bar/999 with hex cafebabecafebabe' },
    });
    expect(computeClusterSignature(a)).toBe(computeClusterSignature(b));
  });

  // ── 16. Module-name guard: NovelFailureReviewer is exported (§A18 / §A50) ──
  it('16. module name is NovelFailureReviewer (§A18) at src/remediation/ (§A50)', async () => {
    const s = track(await setup());
    expect(s.reviewer.constructor.name).toBe('NovelFailureReviewer');
    // File path is under src/remediation/ — verified at the import site;
    // re-asserting here pins the spec invariant.
    expect(NovelFailureReviewer.name).toBe('NovelFailureReviewer');
  });

  // ── 17. LLM model allowlist enforced at construction (§A26) ──
  it('17. llmModel outside allowlist refused at construction (§A26)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-fr-allowlist-'));
    tmpDirs.push(tmpDir);
    const vault = await RemediationKeyVault.forStateDir(tmpDir, envOpts());
    const projection = new AuditProjection(tmpDir, { machineId: 'm-test' });
    expect(
      () =>
        new NovelFailureReviewer({
          stateDir: tmpDir,
          auditProjection: projection,
          llmCaller: async () => '',
          keyVault: vault,
          agentId: 'echo-test',
          machineId: 'm-test',
          config: { llmModel: 'sketchy-uncertified-model-v0' },
        }),
    ).toThrow(/not in allowlist/);
  });
});
