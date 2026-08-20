import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { runLint } from '../../scripts/lint-llm-attribution.js';
import { createGuardPostureProbes } from '../../src/monitoring/probes/GuardPostureProbe.js';
import { StandardsConformanceReviewer } from '../../src/core/reviewers/standards-conformance.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import type { StandardArticle } from '../../src/core/StandardsRegistryParser.js';
import { HumanAsDetectorLog } from '../../src/monitoring/HumanAsDetectorLog.js';
import { deriveCheckerPopulation } from '../../scripts/lib/checker-blind-input-ratchet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const id = process.argv[2];
const phase = process.argv[3];

if (phase !== 'control' && phase !== 'blind') {
  console.error('checker child requires phase control|blind');
  process.exit(2);
}

async function observe(): Promise<{ clean: boolean; evidence: unknown }> {
  switch (id) {
    case 'script:scripts/lint-llm-attribution.js': {
      if (phase === 'blind') {
        const file = path.join(ROOT, 'src', `.checker-blind-attribution-missing-${process.pid}.ts`);
        const result = runLint([file]);
        return { clean: result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0, evidence: result };
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-control-attribution-'));
      try {
        const file = path.join(dir, 'readable.ts');
        fs.writeFileSync(file, 'export const readable = true;\n');
        const result = runLint([file]);
        return { clean: result.real.length === 0 && result.stale.length === 0 && result.blind.length === 0, evidence: result };
      } finally {
        SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'checker-child:attribution-control' });
      }
    }
    case 'probe:src/monitoring/probes/GuardPostureProbe.ts': {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `checker-${phase}-guard-`));
      try {
        const [probe] = createGuardPostureProbes(phase === 'control' ? {
          getLocalPosture: () => ({
            guards: [],
            summary: {
              onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
              off: 0, offDeviant: 0, offDarkDefault: 0, divergedPendingRestart: 0,
              errored: 0, missing: 0, offRuntimeDivergent: 0, runtimeEnriched: '0/0',
            },
          }),
          getPeerPostures: () => [],
          emitAttention: async () => {},
          stateDir,
        } : {
          getLocalPosture: () => null,
          getPeerPostures: () => [{ machineId: 'blind-peer', online: true, posture: null, postureAgeMs: null }],
          deepReadPeer: async () => { throw new Error('unreachable'); },
          emitAttention: async () => {},
          stateDir,
        });
        const result = await probe.run();
        return { clean: result.passed, evidence: result };
      } finally {
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: `checker-child:guard-${phase}` });
      }
    }
    case 'reviewer:src/core/reviewers/standards-conformance.ts': {
      const articles: StandardArticle[] = [{
        family: 'Interaction', name: 'Signal vs. Authority', rule: 'Independent judgment.', inPractice: '',
      }];
      let calls = 0;
      const provider: IntelligenceProvider = phase === 'control' ? {
        async evaluate() {
          calls += 1;
          return calls === 1 ? '[]' : '{"verdict":"fit","reason":"control"}';
        },
      } : { async evaluate() { throw new Error('provider down'); } };
      const reviewer = new StandardsConformanceReviewer(provider);
      const report = await reviewer.review('spec', articles);
      const fit = await reviewer.judgeFit('spec', 'Signal vs. Authority', articles);
      return {
        clean: phase === 'control'
          ? report.conclusion === 'fits' && fit.verdict === 'fit'
          : report.conclusion === 'fits' || fit.verdict === 'fit',
        evidence: { report, fit },
      };
    }
    case 'detector:src/monitoring/HumanAsDetectorLog.ts': {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `checker-${phase}-detector-`));
      try {
        if (phase === 'blind') fs.writeFileSync(path.join(stateDir, 'metrics'), 'not a directory');
        HumanAsDetectorLog.resetForTesting();
        const log = HumanAsDetectorLog.getInstance();
        log.configure({ stateDir, agentName: `${phase}-case` });
        const originalWarn = console.warn;
        const originalError = console.error;
        console.warn = () => {};
        console.error = () => {};
        try { log.observe({ text: "that's wrong", source: 'test', topicId: 29723 }); }
        finally { console.warn = originalWarn; console.error = originalError; }
        const failures = log.getCaptureFailures();
        return { clean: failures.length === 0, evidence: failures };
      } finally {
        HumanAsDetectorLog.resetForTesting();
        SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: `checker-child:detector-${phase}` });
      }
    }
    case 'script:scripts/lint-checker-blind-input-coverage.mjs': {
      if (phase === 'control') {
        const population = deriveCheckerPopulation(ROOT);
        return { clean: population.length > 0, evidence: { population: population.length } };
      }
      let rejected = false;
      try { deriveCheckerPopulation(path.join(ROOT, '__missing-checker-root__')); }
      catch { rejected = true; }
      return { clean: !rejected, evidence: { rejectedMissingRoot: rejected } };
    }
    default:
      throw new Error(`checker child has no executable case for ${String(id)}`);
  }
}

try {
  const observation = await observe();
  const passed = phase === 'control' ? observation.clean : !observation.clean;
  process.stdout.write(`CHECKER_CHILD_RESULT ${JSON.stringify({ id, phase, passed, evidence: observation.evidence })}\n`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(`checker child failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
