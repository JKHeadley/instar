/**
 * Mechanical pre-release gate for the crash-safe inbound delivery observer.
 * Absence is dark. An operator's explicit false is absolute. A true setting is
 * only active when a signed Echo RC artifact matches the exact running build
 * and proves the complete two-hour / fifty-delivery canary.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SHIPPED_CODEX_STAGE_B_RELEASE_EVIDENCE } from '../data/codexStageBReleaseEvidence.js';

export const STAGE_B_REQUIRED_CASES = [
  'identical', 'multiline', 'active-turn', 'resize', 'outage', 'transfer',
] as const;

export interface StageBFailureCounters {
  falseUnknown: number;
  falseExhaustion: number;
  duplicateKeyOwnership: number;
  lostInbound: number;
  staleOwnerAction: number;
}

export interface StageBRcArtifactUnsigned {
  schemaVersion: 1;
  packageVersion: string;
  gitCommit: string;
  configSha256: string;
  echoMachineId: string;
  startedAt: number;
  endedAt: number;
  deliveryCount: number;
  caseCounts: Record<(typeof STAGE_B_REQUIRED_CASES)[number], number>;
  failures: StageBFailureCounters;
  rawEvidenceDigests: string[];
  reviewerDecision: 'approved' | 'rejected';
}

export interface StageBRcArtifact extends StageBRcArtifactUnsigned {
  signature: string;
}

export interface StageBConfigSurface {
  ledgerObserverEnabled?: boolean;
  /** Explicit pre-release dogfood only; accepted solely on a development agent. */
  candidateCanaryEnabled?: boolean;
  /** Written by migration after artifact verification; consumed at restart. */
  stageBPendingActivation?: boolean;
  /** Autonomous recovery remains an independently graduated dark stage. */
  stageCRecoveryEnabled?: boolean;
}

export interface StageBActivationBindings {
  packageVersion: string;
  gitCommit: string;
  configSha256: string;
  echoMachineId: string;
  echoPublicKeyPem: string;
  developmentAgent?: boolean;
}

export interface StageBProductionActivationInput {
  stateDir: string;
  config: StageBConfigSurface | undefined;
  packageVersion: string;
  gitCommit: string;
  echoMachineId: string;
  echoPublicKeyPem: string;
  developmentAgent?: boolean;
  /** Test/release-tool override. Production uses the package-bundled evidence. */
  shippedEvidence?: StageBShippedReleaseEvidence | null;
}

export interface StageBShippedReleaseEvidence {
  schemaVersion: 1;
  echoPublicKeyPem: string;
  artifact: StageBRcArtifact;
}

export type StageBInactiveReason =
  | 'unconfigured-dark' | 'explicitly-disabled' | 'not-pending-restart'
  | 'artifact-missing' | 'artifact-shape-invalid' | 'artifact-binding-mismatch'
  | 'artifact-signature-invalid' | 'canary-too-short' | 'delivery-threshold-not-met'
  | 'required-case-missing' | 'canary-failures' | 'review-not-approved'
  | 'startup-schema-failed' | 'startup-full-failed' | 'startup-lock-failed'
  | 'startup-old-callback-live' | 'startup-attempt-owner-failed';

export interface StageBActivationStatus {
  configured: boolean | null;
  pendingActivation: boolean;
  active: boolean;
  reason: 'active' | 'candidate-canary' | StageBInactiveReason;
  artifactDigest: string | null;
}

/** Stable, field-ordered bytes covered by the Echo signature. */
export function canonicalStageBRcArtifact(row: StageBRcArtifactUnsigned): string {
  return JSON.stringify([
    row.schemaVersion, row.packageVersion, row.gitCommit, row.configSha256,
    row.echoMachineId, row.startedAt, row.endedAt, row.deliveryCount,
    STAGE_B_REQUIRED_CASES.map((name) => [name, row.caseCounts[name]]),
    [row.failures.falseUnknown, row.failures.falseExhaustion,
      row.failures.duplicateKeyOwnership, row.failures.lostInbound, row.failures.staleOwnerAction],
    row.rawEvidenceDigests, row.reviewerDecision,
  ]);
}

export class StageBActivationGate {
  constructor(private readonly bindings: StageBActivationBindings) {}

  evaluate(config: StageBConfigSurface | undefined, artifact?: StageBRcArtifact): StageBActivationStatus {
    const configured = config?.ledgerObserverEnabled ?? null;
    const pendingActivation = config?.stageBPendingActivation === true;
    const base = { configured, pendingActivation, active: false, artifactDigest: artifact ? digestArtifact(artifact) : null };
    if (configured === false) return { ...base, reason: 'explicitly-disabled' };
    if (config?.candidateCanaryEnabled === true && this.bindings.developmentAgent === true) {
      return { ...base, configured: true, active: true, reason: 'candidate-canary' };
    }
    if (configured !== true) return { ...base, reason: 'unconfigured-dark' };
    if (!pendingActivation) return { ...base, reason: 'not-pending-restart' };
    if (!artifact) return { ...base, reason: 'artifact-missing' };
    const reason = this.verifyArtifact(artifact);
    if (reason) return { ...base, reason };
    return { ...base, active: true, reason: 'active' };
  }

  verifyArtifact(artifact: StageBRcArtifact): StageBInactiveReason | null {
    if (!validArtifactShape(artifact)) return 'artifact-shape-invalid';
    const b = this.bindings;
    if (artifact.packageVersion !== b.packageVersion || artifact.gitCommit !== b.gitCommit
      || artifact.configSha256 !== b.configSha256 || artifact.echoMachineId !== b.echoMachineId) {
      return 'artifact-binding-mismatch';
    }
    let signatureValid = false;
    try {
      const { signature, ...unsigned } = artifact;
      signatureValid = crypto.verify(null, Buffer.from(canonicalStageBRcArtifact(unsigned)),
        b.echoPublicKeyPem, Buffer.from(signature, 'base64'));
    } catch { /* @silent-fallback-ok: invalid signature keeps activation dark */ signatureValid = false; }
    if (!signatureValid) return 'artifact-signature-invalid';
    if (artifact.endedAt - artifact.startedAt < 2 * 60 * 60 * 1_000) return 'canary-too-short';
    if (artifact.deliveryCount < 50) return 'delivery-threshold-not-met';
    if (STAGE_B_REQUIRED_CASES.some((name) => artifact.caseCounts[name] < 1)) return 'required-case-missing';
    if (Object.values(artifact.failures).some((count) => count !== 0)) return 'canary-failures';
    if (artifact.reviewerDecision !== 'approved') return 'review-not-approved';
    return null;
  }
}

/** Production composition seam: bind the exact config bytes and load the
 * restart-time RC artifact from the canonical state path. Tests use this same
 * resolver so activation cannot be replaced by a hand-written ACTIVE value. */
export function resolveStageBProductionActivation(input: StageBProductionActivationInput): StageBActivationStatus {
  const configSha256 = stageBConfigSha256(input.config);
  let localArtifact: StageBRcArtifact | undefined;
  try {
    localArtifact = JSON.parse(fs.readFileSync(path.join(input.stateDir, 'state', 'codex-stage-b-rc.json'), 'utf8')) as StageBRcArtifact;
  } catch { /* @silent-fallback-ok: artifact absence is the intended dark default */ }
  const localGate = new StageBActivationGate({
    packageVersion: input.packageVersion,
    gitCommit: input.gitCommit,
    configSha256,
    echoMachineId: input.echoMachineId,
    echoPublicKeyPem: input.echoPublicKeyPem,
    developmentAgent: input.developmentAgent,
  });
  const localStatus = localGate.evaluate(input.config, localArtifact);
  if (localStatus.active || localStatus.reason === 'candidate-canary'
    || localStatus.reason === 'explicitly-disabled' || localStatus.reason === 'unconfigured-dark'
    || localStatus.reason === 'not-pending-restart') {
    return localStatus;
  }

  // A release artifact is package evidence, not machine-local state. Every
  // fleet machine verifies it against the Echo public key pinned in the
  // reviewed package; using the target machine's own key/id here would make
  // fleet activation impossible while looking correctly fail-closed.
  const shipped = input.shippedEvidence === undefined
    ? parseShippedStageBEvidence(SHIPPED_CODEX_STAGE_B_RELEASE_EVIDENCE)
    : input.shippedEvidence;
  if (!shipped) return localStatus;
  return new StageBActivationGate({
    packageVersion: input.packageVersion,
    gitCommit: input.gitCommit,
    configSha256,
    echoMachineId: shipped.artifact.echoMachineId,
    echoPublicKeyPem: shipped.echoPublicKeyPem,
    developmentAgent: input.developmentAgent,
  }).evaluate(input.config, shipped.artifact);
}

/** The release candidate and fleet activation share this behavioral config
 * digest. Rollout-only switches are deliberately excluded: candidateCanary is
 * how Echo gathers evidence, while pendingActivation is the restart fence that
 * consumes it. Both execute the same Stage-B behavior. */
export function stageBConfigSha256(config: StageBConfigSurface | undefined): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    ledgerObserverEnabled: config?.ledgerObserverEnabled === true,
  })).digest('hex');
}

export function parseShippedStageBEvidence(value: unknown): StageBShippedReleaseEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<StageBShippedReleaseEvidence>;
  if (row.schemaVersion !== 1 || typeof row.echoPublicKeyPem !== 'string'
    || row.echoPublicKeyPem.length < 32 || !row.artifact) return null;
  return row as StageBShippedReleaseEvidence;
}

export function bundledStageBReleaseEvidence(): StageBShippedReleaseEvidence | null {
  return parseShippedStageBEvidence(SHIPPED_CODEX_STAGE_B_RELEASE_EVIDENCE);
}

export function verifyBundledStageBReleaseEvidence(packageVersion: string): StageBInactiveReason | null {
  const shipped = bundledStageBReleaseEvidence();
  if (!shipped) return 'artifact-missing';
  return new StageBActivationGate({
    packageVersion,
    gitCommit: `package:${packageVersion}`,
    configSha256: stageBConfigSha256({ ledgerObserverEnabled: true }),
    echoMachineId: shipped.artifact.echoMachineId,
    echoPublicKeyPem: shipped.echoPublicKeyPem,
  }).verifyArtifact(shipped.artifact);
}

/**
 * Idempotent migration decision. Explicit false is never changed. A valid RC
 * moves absent/already-true installs to pending activation for the next restart.
 */
export function migrateStageBConfig(
  config: StageBConfigSurface | undefined,
  artifact: StageBRcArtifact | undefined,
  gate: StageBActivationGate,
): StageBConfigSurface {
  const current = { ...(config ?? {}) };
  if (current.ledgerObserverEnabled === false) return { ...current, stageBPendingActivation: false };
  if (!artifact || gate.verifyArtifact(artifact) !== null) return current;
  return { ...current, ledgerObserverEnabled: true, stageBPendingActivation: true };
}

/** Release-time config reconciliation. The candidate switch is operational,
 * not operator policy, so verified package evidence retires it. The pending
 * bit is likewise an internal restart fence and must reflect the installed
 * package's evidence instead of preserving a stale candidate-era false. */
export function migrateStageBReleaseConfig(
  config: StageBConfigSurface | undefined,
  releaseEvidenceValid: boolean,
): StageBConfigSurface {
  const current = { ...(config ?? {}) };
  if (current.ledgerObserverEnabled === undefined) {
    current.ledgerObserverEnabled = releaseEvidenceValid;
  }
  if (current.candidateCanaryEnabled === undefined || releaseEvidenceValid) {
    current.candidateCanaryEnabled = false;
  }
  current.stageBPendingActivation = releaseEvidenceValid && current.ledgerObserverEnabled === true;
  if (current.stageCRecoveryEnabled === undefined) current.stageCRecoveryEnabled = false;
  return current;
}

function digestArtifact(artifact: StageBRcArtifact): string {
  return crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
}

function validArtifactShape(value: StageBRcArtifact): boolean {
  if (!value || value.schemaVersion !== 1 || typeof value.signature !== 'string'
    || typeof value.packageVersion !== 'string' || typeof value.gitCommit !== 'string'
    || typeof value.configSha256 !== 'string' || typeof value.echoMachineId !== 'string'
    || !Number.isFinite(value.startedAt) || !Number.isFinite(value.endedAt)
    || !Number.isInteger(value.deliveryCount) || value.deliveryCount < 0
    || !Array.isArray(value.rawEvidenceDigests) || value.rawEvidenceDigests.length === 0 || value.rawEvidenceDigests.length > 100
    || value.rawEvidenceDigests.some((d) => !/^[a-f0-9]{64}$/.test(d))) return false;
  if (!value.caseCounts || STAGE_B_REQUIRED_CASES.some((name) => !Number.isInteger(value.caseCounts[name]) || value.caseCounts[name] < 0)) return false;
  const failureKeys: Array<keyof StageBFailureCounters> = [
    'falseUnknown', 'falseExhaustion', 'duplicateKeyOwnership', 'lostInbound', 'staleOwnerAction',
  ];
  if (!value.failures || failureKeys.some((name) => !Number.isInteger(value.failures[name]) || value.failures[name] < 0)) return false;
  if (value.reviewerDecision !== 'approved' && value.reviewerDecision !== 'rejected') return false;
  return true;
}
