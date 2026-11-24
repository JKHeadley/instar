import { createHash } from 'node:crypto';

/** All identity fields must come from the verifier, never the candidate's manifest. */
export interface DesignVerificationIdentity {
  baseSha: string;
  mergeTree: string;
  rendererBuild: string;
  policyHash: string;
}
export interface DesignEvidenceInput {
  screen: string;
  seedVersion: string;
  /** Ordered captures and traces read from the verifier's own render output. */
  captures: readonly Uint8Array[];
  traces: readonly Uint8Array[];
  rules: readonly { id: string; wording: string }[];
}
export interface DesignEvidenceBinding { version: 1; digest: string }
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
/** Content identity only. This neither authenticates a producer nor certifies a rendered image. */
export function bindDesignEvidence(identity: DesignVerificationIdentity, evidence: DesignEvidenceInput): DesignEvidenceBinding {
  if (!sha.test(identity.baseSha) || !sha.test(identity.mergeTree)
    || !digest.test(identity.rendererBuild) || !digest.test(identity.policyHash)) throw new Error('Invalid verifier identity');
  if (!evidence.screen.trim() || !digest.test(evidence.seedVersion)
    || evidence.captures.length === 0 || evidence.traces.length === 0
    || Array.from(evidence.captures).some(bytes => !(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    || Array.from(evidence.traces).some(bytes => !(bytes instanceof Uint8Array) || bytes.byteLength === 0)) throw new Error('Incomplete render evidence');
  const ids = new Set<string>();
  for (const rule of evidence.rules) {
    if (!/^DS-[A-Z]+-\d+$/.test(rule.id) || !rule.wording.trim() || ids.has(rule.id)) throw new Error('Invalid evidence rule');
    ids.add(rule.id);
  }
  // Fixed structure and sorted rules avoid property-order ambiguity. Capture order remains meaningful.
  const canonical = JSON.stringify({ version: 1, baseSha: identity.baseSha, mergeTree: identity.mergeTree,
    rendererBuild: identity.rendererBuild, policyHash: identity.policyHash,
    screen: evidence.screen, seedVersion: evidence.seedVersion,
    captures: evidence.captures.map(sha256), traces: evidence.traces.map(sha256),
    rules: [...evidence.rules].sort((a, b) => a.id.localeCompare(b.id, 'en')).map(rule => [rule.id, rule.wording]),
  });
  return { version: 1, digest: sha256(canonical) };
}
/** Recompute with the current merge base and current bytes before reusing any review decision. */
export function designEvidenceMatches(binding: unknown, current: DesignVerificationIdentity, evidence: DesignEvidenceInput): boolean {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const candidate = binding as Partial<DesignEvidenceBinding>;
  if (candidate.version !== 1 || typeof candidate.digest !== 'string' || !digest.test(candidate.digest)) return false;
  try { return candidate.digest === bindDesignEvidence(current, evidence).digest; } catch { return false; }
}
