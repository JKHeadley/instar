import { describe, expect, it } from 'vitest';
import {
  auditCanonicalPipelineCompleteness,
  validateCanonicalPipelineManifest,
} from '../../scripts/lint-canonical-pipeline-completeness.mjs';

const citations = {
  stageA: 'src/a.ts#A_STAGE',
  stageB: 'src/b.ts#B_STAGE',
  implementationA: 'src/a.ts#A',
  implementationB: 'src/b.ts#B',
  wiring: 'src/wiring.ts#wire',
  cadence: 'src/job.md#pipeline-job',
  metrics: 'src/metrics.ts#metrics',
};

const pipeline = {
  id: 'example-pipeline',
  owner: 'development-agent',
  stages: [
    { id: 'accept', metadataCitation: citations.stageA, implementationCitation: citations.implementationA },
    { id: 'handoff', metadataCitation: citations.stageB, implementationCitation: citations.implementationB },
  ],
  ingress: { surfaceIds: ['example-route'], wiringCitation: citations.wiring },
  transitions: [{
    from: 'accept', to: 'handoff', implementationCitation: citations.implementationB,
    persistentState: 'outbox row', idempotencyKey: 'input id',
  }],
  terminalHandoff: { stage: 'handoff', consumer: 'B', consumerCitation: citations.implementationB },
  cadence: { triggerCitation: citations.cadence },
  metrics: { readinessCitation: citations.metrics },
  runtimeSmoke: {
    test: 'tests/e2e/example-pipeline.test.ts', command: 'test:canonical-pipeline-runtime',
    productionConsumerAdapter: true, authoritativeReadBack: true,
  },
  rollout: { posture: 'development-live-fleet-dark', rollbackSwitch: 'example.enabled' },
};

const manifest = { schemaVersion: 1, pipelines: [pipeline] };
const surface = {
  id: 'example-route', kind: 'route', sourcePath: 'src/routes.ts',
  method: 'POST', route: '/example/accepted', canonicalPipelineId: 'example-pipeline',
};

const files = new Map<string, string>([
  ['src/a.ts', "export const A_STAGE = { canonicalPipelineId: 'example-pipeline', stage: 'accept' }; export class A {}"],
  ['src/b.ts', "export const B_STAGE = { canonicalPipelineId: 'example-pipeline', stage: 'handoff' }; export class B {}"],
  ['src/wiring.ts', 'export function wire() {}'],
  ['src/job.md', 'slug: pipeline-job'],
  ['src/metrics.ts', 'export const metrics = {}'],
  ['src/routes.ts', "router.post('/example/accepted', handler)"],
  ['tests/e2e/example-pipeline.test.ts', 'production consumer authoritative read-back'],
  ['package.json', JSON.stringify({ scripts: { 'test:canonical-pipeline-runtime': 'vitest run tests/e2e/example-pipeline.test.ts' } })],
]);

const audit = (
  candidateManifest: unknown = manifest,
  intakeDeclarations: Record<string, string>[] = [surface],
  overrides: Map<string, string> = files,
) => auditCanonicalPipelineCompleteness({
  root: '/virtual',
  manifest: candidateManifest,
  intakeDeclarations,
  readText: (file) => overrides.get(file),
  pathExists: (file) => overrides.has(file),
});

describe('canonical pipeline completeness structural lint', () => {
  it('accepts a fully declared, cited, and CI-collected pipeline', () => {
    expect(validateCanonicalPipelineManifest(manifest)).toEqual([]);
    expect(audit()).toEqual([]);
  });

  it('rejects an unregistered accepted-intake route', () => {
    expect(audit(manifest, [{ ...surface, canonicalPipelineId: 'missing-pipeline' }]))
      .toContainEqual(expect.objectContaining({ rule: 'CPC12-unknown-pipeline' }));
  });

  it('rejects intake metadata with neither canonicalPipelineId nor a reviewed exclusion', () => {
    const { canonicalPipelineId: _omitted, ...unmarked } = surface;
    expect(audit(manifest, [unmarked]))
      .toContainEqual(expect.objectContaining({ rule: 'CPC12-intake-classification' }));
  });

  it('rejects comment-only membership because declarations, not source comments, establish coverage', () => {
    const commentOnly = new Map(files);
    commentOnly.set('src/routes.ts', "// canonicalPipelineId: 'example-pipeline'\nrouter.post('/example/accepted', handler)");
    expect(audit(manifest, [], commentOnly))
      .toContainEqual(expect.objectContaining({ rule: 'CPC15-ingress-registry-link' }));
  });

  it.each([
    ['owner', { ...pipeline, owner: '' }, 'CPC1-owner-required'],
    ['handoff', { ...pipeline, terminalHandoff: { stage: 'handoff', consumer: '', consumerCitation: citations.implementationB } }, 'CPC6-terminal-consumer'],
    ['consumer citation', { ...pipeline, terminalHandoff: { stage: 'handoff', consumer: 'B', consumerCitation: '' } }, 'CPC6-terminal-consumer'],
  ])('rejects a missing %s declaration', (_label, changedPipeline, rule) => {
    expect(audit({ schemaVersion: 1, pipelines: [changedPipeline] }))
      .toContainEqual(expect.objectContaining({ rule }));
  });

  it('rejects a stage without typed metadata or implementation citations', () => {
    const changed = { ...pipeline, stages: [{ ...pipeline.stages[0], metadataCitation: '' }, pipeline.stages[1]] };
    expect(audit({ schemaVersion: 1, pipelines: [changed] }))
      .toContainEqual(expect.objectContaining({ rule: 'CPC3-stage-citation' }));
  });

  it('rejects stage metadata whose pipeline or stage value disagrees with the manifest', () => {
    const mismatched = new Map(files);
    mismatched.set('src/b.ts', "export const B_STAGE = { canonicalPipelineId: 'other', stage: 'wrong' }; export class B {}");
    expect(audit(manifest, [surface], mismatched))
      .toContainEqual(expect.objectContaining({ rule: 'CPC3-stage-metadata-mismatch' }));
  });

  it('rejects an incomplete transition path and a transition without idempotency authority', () => {
    const noEdge = { ...pipeline, transitions: [] };
    expect(audit({ schemaVersion: 1, pipelines: [noEdge] }))
      .toContainEqual(expect.objectContaining({ rule: 'CPC5-transition-coverage' }));

    const noKey = { ...pipeline, transitions: [{ ...pipeline.transitions[0], idempotencyKey: '' }] };
    expect(audit({ schemaVersion: 1, pipelines: [noKey] }))
      .toContainEqual(expect.objectContaining({ rule: 'CPC5-transition-contract' }));
  });

  it('rejects an uncollected or missing cited runtime E2E', () => {
    const missingTest = new Map(files);
    missingTest.delete('tests/e2e/example-pipeline.test.ts');
    const findings = audit(manifest, [surface], missingTest);
    expect(findings).toContainEqual(expect.objectContaining({ rule: 'CPC16-runtime-test-missing' }));

    const uncollected = new Map(files);
    uncollected.set('package.json', JSON.stringify({ scripts: { 'test:canonical-pipeline-runtime': 'vitest run tests/e2e/something-else.test.ts' } }));
    expect(audit(manifest, [surface], uncollected))
      .toContainEqual(expect.objectContaining({ rule: 'CPC17-runtime-test-uncollected' }));
  });

  it('rejects a fake runtime contract that does not claim production adapter and authoritative read-back', () => {
    const changed = {
      ...pipeline,
      runtimeSmoke: { ...pipeline.runtimeSmoke, productionConsumerAdapter: false, authoritativeReadBack: false },
    };
    expect(audit({ schemaVersion: 1, pipelines: [changed] }))
      .toContainEqual(expect.objectContaining({ rule: 'CPC9-runtime-contract' }));
  });

  it('rejects missing citation paths and symbols', () => {
    const missingPath = { ...pipeline, metrics: { readinessCitation: 'src/missing.ts#metrics' } };
    expect(audit({ schemaVersion: 1, pipelines: [missingPath] }))
      .toContainEqual(expect.objectContaining({ rule: 'CPC18-citation-path-missing' }));

    const missingSymbol = { ...pipeline, metrics: { readinessCitation: 'src/metrics.ts#notThere' } };
    expect(audit({ schemaVersion: 1, pipelines: [missingSymbol] }))
      .toContainEqual(expect.objectContaining({ rule: 'CPC18-citation-symbol-missing' }));
  });
});
