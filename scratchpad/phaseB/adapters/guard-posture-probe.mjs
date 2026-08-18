import fs from 'node:fs';
import {
  absolute,
  checksResult,
  commentAll,
  includesChecks,
  read,
  replaceOnce,
  replaceThroughMarker,
  run,
  structuredRelevance,
  write,
  writeVitestConfig,
} from './acceptance-fixtures.mjs';

const GUARD_TEST = 'tests/unit/monitoring/guard-posture-probe.test.ts';
const PROBE = 'src/monitoring/probes/GuardPostureProbe.ts';
const SERVER = 'src/commands/server.ts';
const MACHINE_REGISTRY = '.instar/machines/registry.json';
const POSTURE_STORE = '.instar/state/guard-posture-peers.json';
const SOURCE_PROOF = '.b0-guard-posture-source-proof.ts';
const P4B_PEER_ID = 'm_b0fourpeer0000000000000000000000';

const testCommand = {
  argv: ['node_modules/.bin/vitest', 'run', GUARD_TEST, '--config=.b0-fix-verifier.vitest.config.mjs', '--reporter=verbose'],
  observeAny: ['GuardPostureProbe', 'Test Files', 'No test files found', 'AssertionError'],
  timeoutMs: 120_000,
};

export const pipelineCommands = [testCommand];
export const guardCommands = [testCommand];

export function prepareWorkspace(root) {
  writeVitestConfig(root);
  write(root, SOURCE_PROOF, `import path from 'node:path';
import { MachineIdentityManager } from './src/core/MachineIdentity.js';
import { GuardPostureStore } from './src/core/GuardPostureStore.js';
import { MachinePoolRegistry } from './src/core/MachinePoolRegistry.js';

const stateDir = path.join(process.cwd(), '.instar');
const identities = new MachineIdentityManager(stateDir);
const postureStore = new GuardPostureStore(stateDir);
const pool = new MachinePoolRegistry({
  postureStore,
  listMachines: () => identities.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname })),
  clockSkewToleranceMs: 300_000,
  failoverThresholdMs: 900_000,
  now: () => Date.now(),
});
const active = identities.getActiveMachines().filter((m) => m.machineId === '${P4B_PEER_ID}');
const capacity = pool.getCapacities().find((m) => m.machineId === '${P4B_PEER_ID}');
const offDeviant = capacity?.guardPosture?.offDeviant ?? null;
console.log('B0.4-posture-source active=' + active.length + ' capacity=' + (capacity ? 1 : 0) + ' offDeviant=' + offDeviant + ' enumerated=' + Boolean(capacity));
if (active.length !== 1 || !capacity || offDeviant !== 1 || capacity.guardPosture?.offDeviantKeys[0] !== 'monitoring.sessionReaper.enabled') process.exit(1);
`);
}

export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles, subjectFiles }) {
  const declared = new Set([...guardFiles, ...subjectFiles]);
  if (mutation.id === 'p4b-hidden-real-violation') {
    const sourceProof = run(root, ['node_modules/.bin/vite-node', '--script', SOURCE_PROOF]);
    return {
      status: 'unknown',
      mode: 'outside-enumeration',
      checks: [
        { check: 'real MachineIdentity registry and GuardPostureStore inputs changed outside declared unit-guard paths', passed: changedPaths.includes(MACHINE_REGISTRY) && changedPaths.includes(POSTURE_STORE) && !declared.has(MACHINE_REGISTRY) && !declared.has(POSTURE_STORE) },
        { check: 'production classes load the active peer and actual deviant GuardPostureSummary schema', passed: sourceProof.exitCode === 0 && sourceProof.stdout.includes('active=1 capacity=1 offDeviant=1 enumerated=true') },
        { check: 'production getPeerPostures maps MachinePoolRegistry.getCapacities, so this real source is enumerated rather than escaped', passed: read(root, SERVER).includes('(machinePoolRegistry?.getCapacities() ?? [])') && read(root, SERVER).includes('posture: m.guardPosture ?? null') },
      ],
      reason: 'P4b relevance is unknown: the real active-machine plus durable-posture source is enumerated by production; no honest omitted peer-posture source exists at this unit-guard boundary.',
      decidingOutput: {
        kind: 'production-source-enumeration-proof',
        lines: sourceProof.stdout.split('\n').filter(Boolean),
        exitCode: sourceProof.exitCode,
      },
    };
  }

  const routed = changedPaths.some((rel) => declared.has(rel));
  let semantic = false;
  if (mutation.id === 'p1-symbol-preserving-hollow') semantic = read(root, PROBE).includes('B0.4 inert posture evaluation');
  if (mutation.id === 'p2-subject-self-reports-clean') semantic = read(root, PROBE).includes('B0.4 false clean posture testimony');
  if (mutation.id === 'p3a-delete') semantic = !fs.existsSync(absolute(root, GUARD_TEST));
  if (mutation.id === 'p3b-comment-out') semantic = read(root, GUARD_TEST).split('\n').filter(Boolean).every((line) => line.startsWith('// '));
  if (mutation.id === 'p3c-superstring-rename') semantic = read(root, GUARD_TEST).includes('function makeProbeDisabled(') && !read(root, GUARD_TEST).includes('function makeProbe(');
  if (mutation.id === 'p3d-type-preserving-hollow') semantic = read(root, GUARD_TEST).includes('B0.4 type-preserving hollow makeProbe');
  if (mutation.id === 'p4a-empty-population') semantic = read(root, PROBE).includes('B0.4 empty probe population');
  if (mutation.id === 'p5-blind-input') {
    const text = read(root, GUARD_TEST);
    semantic = text.includes('B0.4 blinded local posture input') && text.includes('local: () => null') && text.includes("expect(result.passed).toBe(true)");
  }
  return structuredRelevance('declared-load-bearing-input', [
    { check: 'changed path intersects the declared load-bearing guard/subject set', passed: routed },
    { check: `semantic mutation ${mutation.id} changes the load-bearing body/input`, passed: semantic },
  ]);
}

export const mutations = [
  {
    id: 'p1-symbol-preserving-hollow', property: 'P1', violationClass: 'hollowing', label: 'SYMBOL-PRESERVING HOLLOW', paths: [PROBE],
    apply(root) {
      replaceThroughMarker(
        root,
        PROBE,
        '  async function runTick(): Promise<ProbeResult> {',
        '\n\n  return [',
        `  async function runTick(): Promise<ProbeResult> {\n    // B0.4 inert posture evaluation: same function/signature, no state read or anomaly transition.\n    return {\n      probeId, name: probeName, tier, durationMs: 0, passed: true,\n      description: 'No guard-posture anomalies across machines',\n    };\n  }`,
      );
    },
    verify(root) { return includesChecks(root, PROBE, ['async function runTick(): Promise<ProbeResult> {', 'B0.4 inert posture evaluation', 'passed: true']); },
  },
  {
    id: 'p2-subject-self-reports-clean', property: 'P2', violationClass: 'self-report / false testimony', label: 'SUBJECT SELF-REPORTS CLEAN', paths: [PROBE],
    apply(root) {
      replaceOnce(
        root,
        PROBE,
        `        return {\n          ...base,\n          passed: false,\n          description: \`Guard-posture anomalies persisting (\${alertable.length}): \${lines.join('; ')}\`,`,
        `        return {\n          ...base,\n          // B0.4 false clean posture testimony: anomaly behavior and emission remain, verdict lies.\n          passed: true,\n          description: \`Guard-posture anomalies persisting (\${alertable.length}): \${lines.join('; ')}\`,`,
      );
    },
    verify(root) { return includesChecks(root, PROBE, ['B0.4 false clean posture testimony', 'passed: true', 'Guard-posture anomalies persisting']); },
  },
  {
    id: 'p3a-delete', property: 'P3', violationClass: 'guard removal', label: 'DELETE', paths: [GUARD_TEST],
    apply(root) { fs.unlinkSync(absolute(root, GUARD_TEST)); },
    verify(root) { return checksResult([{ check: `${GUARD_TEST} is absent`, passed: !fs.existsSync(absolute(root, GUARD_TEST)) }]); },
  },
  {
    id: 'p3b-comment-out', property: 'P3', violationClass: 'guard removal', label: 'COMMENT OUT', paths: [GUARD_TEST],
    apply(root) { commentAll(root, GUARD_TEST); },
    verify(root) {
      const lines = read(root, GUARD_TEST).split('\n').filter(Boolean);
      return checksResult([{ check: `${GUARD_TEST} has no executable non-comment line`, passed: lines.length > 0 && lines.every((line) => line.startsWith('// ')) }]);
    },
  },
  {
    id: 'p3c-superstring-rename', property: 'P3', violationClass: 'guard removal', label: 'SUPERSTRING RENAME', paths: [GUARD_TEST],
    apply(root) { replaceOnce(root, GUARD_TEST, 'function makeProbe(opts:', 'function makeProbeDisabled(opts:'); },
    verify(root) {
      const text = read(root, GUARD_TEST);
      return checksResult([
        { check: 'longer makeProbeDisabled declaration exists', passed: text.includes('function makeProbeDisabled(') },
        { check: 'original makeProbe remains a substring', passed: text.includes('makeProbe') },
        { check: 'original declaration is absent while call sites remain', passed: !text.includes('function makeProbe(') && /\bmakeProbe\(/.test(text) },
      ]);
    },
  },
  {
    id: 'p3d-type-preserving-hollow', property: 'P3', violationClass: 'guard removal', label: 'TYPE-PRESERVING HOLLOW', paths: [GUARD_TEST],
    apply(root) {
      replaceThroughMarker(
        root,
        GUARD_TEST,
        'function makeProbe(opts:',
        '\n\nconst DEVIANT_INV',
        `function makeProbe(opts: {\n  local?: () => GuardInventoryResult | null;\n  peers?: () => PeerPostureRead[];\n  deepReadPeer?: GuardPostureProbeDeps['deepReadPeer'];\n  emitAttention?: GuardPostureProbeDeps['emitAttention'];\n}) {\n  // B0.4 type-preserving hollow makeProbe: name/parameters/return shape retained; constant pass.\n  void opts;\n  const emitted: GuardPostureAttentionItem[] = [];\n  const probe = {\n    id: 'instar.guard-posture.anomalies', name: 'Guard Posture Anomalies', tier: 2 as const,\n    feature: 'Guard Posture', timeoutMs: 10_000, prerequisites: () => true,\n    run: async () => ({ probeId: 'instar.guard-posture.anomalies', name: 'Guard Posture Anomalies', tier: 2 as const, durationMs: 0, passed: true, description: 'No guard-posture anomalies across machines' }),\n  };\n  return { probe, emitted };\n}`,
      );
    },
    verify(root) { return includesChecks(root, GUARD_TEST, ['function makeProbe(opts:', 'B0.4 type-preserving hollow makeProbe', 'passed: true', 'return { probe, emitted };']); },
  },
  {
    id: 'p4a-empty-population', property: 'P4', violationClass: 'vacuous measurement', label: 'EMPTY THE PROBE POPULATION', paths: [PROBE],
    apply(root) {
      replaceThroughMarker(
        root,
        PROBE,
        'export function createGuardPostureProbes(deps: GuardPostureProbeDeps): Probe[] {',
        '\n}',
        `export function createGuardPostureProbes(deps: GuardPostureProbeDeps): Probe[] {\n  // B0.4 empty probe population.\n  void deps;\n  return [];`,
      );
    },
    verify(root) { return includesChecks(root, PROBE, ['export function createGuardPostureProbes(deps: GuardPostureProbeDeps): Probe[] {', 'B0.4 empty probe population', 'return [];']); },
  },
  {
    id: 'p4b-hidden-real-violation', property: 'P4', violationClass: 'population evasion', label: 'P4B RELEVANCE UNKNOWN — REAL SOURCE IS ENUMERATED', paths: [MACHINE_REGISTRY, POSTURE_STORE],
    apply(root) {
      const now = Date.now();
      write(root, MACHINE_REGISTRY, `${JSON.stringify({
        version: 1,
        machines: {
          [P4B_PEER_ID]: {
            name: 'B0.4 real peer source',
            nickname: 'b0-four-peer',
            status: 'active',
            role: 'standby',
            pairedAt: new Date(now - 60_000).toISOString(),
            lastSeen: new Date(now - 30_000).toISOString(),
          },
        },
      }, null, 2)}\n`);
      write(root, POSTURE_STORE, `${JSON.stringify({
        version: 1,
        machines: {
          [P4B_PEER_ID]: {
            receivedAtMs: now,
            posture: {
              onConfirmed: 0,
              onUnverified: 0,
              onStale: 0,
              onBlind: 0,
              onDryRun: 0,
              offDeviant: 1,
              offDeviantKeys: ['monitoring.sessionReaper.enabled'],
              offRuntimeDivergent: 0,
              offRuntimeDivergentKeys: [],
              divergedPendingRestart: 0,
              errored: 0,
              missing: 0,
              generatedAt: new Date(now).toISOString(),
            },
          },
        },
      }, null, 2)}\n`);
    },
    verify(root) {
      const sourceProof = run(root, ['node_modules/.bin/vite-node', '--script', SOURCE_PROOF]);
      return checksResult([
        { check: 'real machine registry contains an active peer', passed: read(root, MACHINE_REGISTRY).includes(`"${P4B_PEER_ID}"`) && read(root, MACHINE_REGISTRY).includes('"status": "active"') },
        { check: 'real posture store contains actual-schema deviance', passed: read(root, POSTURE_STORE).includes('"offDeviant": 1') && read(root, POSTURE_STORE).includes('"monitoring.sessionReaper.enabled"') },
        { check: 'production source loaders prove the peer is enumerated, so no evasion is claimed', passed: sourceProof.exitCode === 0 && sourceProof.stdout.includes('active=1 capacity=1 offDeviant=1 enumerated=true') },
      ]);
    },
  },
  {
    id: 'p5-blind-input', property: 'P5', violationClass: 'blind input / fail-open', label: 'LOCAL POSTURE UNAVAILABLE', paths: [GUARD_TEST],
    apply(root) {
      replaceOnce(
        root,
        GUARD_TEST,
        `    const { probe } = makeProbe({ local: () => CLEAN_INV });\n    expect(probe.id).toBe('instar.guard-posture.anomalies');`,
        `    // B0.4 blinded local posture input: unavailable, not wrong; expectations stay unchanged.\n    const { probe } = makeProbe({ local: () => null });\n    expect(probe.id).toBe('instar.guard-posture.anomalies');`,
      );
    },
    verify(root) { return includesChecks(root, GUARD_TEST, ['B0.4 blinded local posture input', 'local: () => null', 'expect(result.passed).toBe(true)']); },
  },
];
