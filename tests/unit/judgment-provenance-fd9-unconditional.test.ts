/**
 * FD9 (llm-decision-quality-meter §5.7): JudgmentProvenanceLog construction is
 * UNCONDITIONAL — out of the mesh block — so the settlement seam has a
 * substrate on every agent, single-machine included.
 *
 * Covers: (a) an E2E-lite construction mirroring commands/server.ts exactly
 * (stateDir + config only, ZERO mesh inputs) that actually WRITES on a
 * single-machine layout; (b) the structural pin that the construction sits
 * BEFORE/OUTSIDE the `if (meshIdMgr && meshSelfId)` mesh block; (c) the
 * routes.ts 503 text + CapabilityIndex descriptions no longer claim the
 * "single-machine / pool dark" cause FD9 removes; (d) the AgentServer wiring
 * calls (recorder singleton + machineId8 injection) are present.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import { CAPABILITY_INDEX } from '../../src/server/CapabilityIndex.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SRC_ROOT = path.join(process.cwd(), 'src');
const serverCmdSource = fs.readFileSync(path.join(SRC_ROOT, 'commands', 'server.ts'), 'utf-8');
const routesSource = fs.readFileSync(path.join(SRC_ROOT, 'server', 'routes.ts'), 'utf-8');
const agentServerSource = fs.readFileSync(path.join(SRC_ROOT, 'server', 'AgentServer.ts'), 'utf-8');

let tmpStateDir: string | null = null;
afterEach(() => {
  if (tmpStateDir) {
    SafeFsExecutor.safeRmSync(tmpStateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/judgment-provenance-fd9-unconditional.test.ts:afterEach',
    });
    tmpStateDir = null;
  }
});

describe('FD9 — E2E-lite single-machine construction', () => {
  it('constructs from stateDir/config alone (zero mesh inputs) and durably writes', async () => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd9-state-'));
    // EXACTLY the commands/server.ts construction shape: stateDir + the
    // provenance config block + a logger. No mesh identity, no pool, nothing.
    const provCfg: { retentionDays?: number; deterministicSampling?: number } = {};
    const log = new JudgmentProvenanceLog({
      dir: path.join(tmpStateDir, 'state', 'judgment-provenance'),
      retentionDays: provCfg.retentionDays,
      sampling: provCfg.deterministicSampling,
      log: () => {},
    });
    const id = log.recordDecision({
      component: 'TestGate',
      decisionPoint: 'test-point',
      context: { fact: 1 },
      optionsPresented: ['a', 'b'],
      decision: 'a',
      reason: 'single-machine boot writes fine',
      floor: 'observe-only',
      fallbackRung: 'deterministic',
    });
    expect(id).toMatch(/^jp-/);
    await log.close();
    const dir = path.join(tmpStateDir, 'state', 'judgment-provenance');
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    expect(files.length).toBe(1);
    const rows = fs.readFileSync(path.join(dir, files[0]), 'utf-8').trim().split('\n');
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]).component).toBe('TestGate');
  });
});

describe('FD9 — structural pin on commands/server.ts', () => {
  it('constructs the JPL BEFORE/OUTSIDE the mesh block (only the assignment moved)', () => {
    const constructionIdx = serverCmdSource.indexOf('new jplMod.JudgmentProvenanceLog(');
    const meshBlockIdx = serverCmdSource.indexOf('if (meshIdMgr && meshSelfId)');
    expect(constructionIdx).toBeGreaterThan(-1);
    expect(meshBlockIdx).toBeGreaterThan(-1);
    expect(constructionIdx).toBeLessThan(meshBlockIdx);
    // Exactly ONE construction site — the mesh-block copy is gone, not duplicated.
    expect(serverCmdSource.split('new jplMod.JudgmentProvenanceLog(').length - 1).toBe(1);
  });
});

describe('FD9 — 503/awareness text no longer claims the removed cause', () => {
  it('routes.ts /judgment-provenance 503 text does not say "single-machine / pool dark"', () => {
    expect(routesSource).not.toContain("'judgment-provenance log not constructed (single-machine / pool dark)'");
    // The replacement names the REAL remaining cause: a failed boot construction.
    expect(routesSource).toContain('judgment-provenance log unavailable');
  });

  it('the judgmentProvenance CapabilityIndex entry describes unconditional construction', () => {
    const entry = CAPABILITY_INDEX.find((e) => e.key === 'judgmentProvenance');
    expect(entry).toBeDefined();
    expect(entry!.description).not.toContain('single-machine / pool dark');
    expect(entry!.description).toContain('UNCONDITIONALLY');
  });

  it('the decisionQuality CapabilityIndex entry describes both routes incl. 503-when-dark', () => {
    const entry = CAPABILITY_INDEX.find((e) => e.key === 'decisionQuality');
    expect(entry).toBeDefined();
    expect(entry!.description).toContain('503');
    expect(entry!.description).toContain('provenance.uniformSeam');
    const built = entry!.build({
      ctx: { config: { developmentAgent: true } } as never,
      scripts: [],
      secretDrop: null as never,
    }) as { configured: boolean; dryRun: boolean; endpoints: string[] };
    expect(built.endpoints).toEqual(['GET /decision-quality', 'POST /decision-quality/grade-pass']);
    expect(built.configured).toBe(true); // dev agent → gate resolves live
    expect(built.dryRun).toBe(true); // dryRun defaults TRUE even on dev
    // P10 routes have landed (GET /decision-quality + POST /decision-quality/grade-pass
    // are registered in routes.ts), so the capabilities-discoverability lint now REQUIRES
    // the '/decision-quality' prefix to be classified in this entry's `prefixes` (its
    // "every route prefix is classified" invariant) — exactly as this test predicted.
    expect(entry!.prefixes).toEqual(['/decision-quality']);
  });
});

describe('FD9 — AgentServer wiring is present (recorder singleton + machineId8)', () => {
  it('installs the decision-quality recorder beside setFeatureMetricsRecorder', () => {
    expect(agentServerSource).toContain('installDecisionQualityRecorder(');
    expect(agentServerSource).toContain('new DecisionQualityRecorderImpl({');
    expect(agentServerSource).toContain('setDecisionQualityMachineId(options.meshSelfId ?? null)');
    expect(agentServerSource).toContain('judgmentProvenance: options.judgmentProvenance ?? null');
  });
});
