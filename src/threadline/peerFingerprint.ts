/**
 * Shared peer-fingerprint resolution for Threadline local attribution.
 *
 * The anti-hijack guard compares an inbound sender's identity against the
 * thread owner. The owner is RECORDED (captureOrigin / recordSent) by the
 * derivation `fingerprint || publicKey[:32] || name`. The inbound COMPARE side
 * must derive the same way, or a legitimate reply mismatches and is isolated.
 * Both sides funnel through this one module so record and compare can never
 * diverge.
 *
 * Convergence keystone: the live known-agents.json records some peers (e.g.
 * sagemind) with NO `fingerprint` field — only a `publicKey` — so the owner was
 * recorded as `publicKey[:32]`. A resolver reading only `fingerprint` returns
 * null and the fix no-ops on the exact incident. The chain below is identical to
 * the record-site chain (minus the final `|| name`, which the record site keeps).
 *
 * Spec: docs/specs/threadline-local-delivery-fingerprint-attribution.md
 */

import fs from 'node:fs';
import path from 'node:path';

interface KnownAgentLike {
  name?: string;
  publicKey?: string;
  fingerprint?: string;
}

/** Max known-agents.json size we will parse on the hot path (fail to null above). */
const MAX_KNOWN_AGENTS_BYTES = 1_000_000;

/**
 * Derive a peer's canonical routing fingerprint from a known-agents entry:
 * `fingerprint`, else first-32 chars of `publicKey`, else null. Lowercased.
 * Mirrors the owner-record derivation (sans the record site's `|| name` fallback).
 */
export function resolvePeerFingerprint(
  entry: KnownAgentLike | null | undefined,
): string | null {
  if (!entry) return null;
  const fp = entry.fingerprint || entry.publicKey?.substring(0, 32);
  return fp ? fp.toLowerCase() : null;
}

/**
 * Resolve a peer NAME → canonical fingerprint via
 * `{stateDir}/threadline/known-agents.json`.
 *
 * Returns null when: the file is missing/unreadable/oversized/malformed, the
 * name is absent, the matching entry has neither `fingerprint` nor `publicKey`,
 * OR multiple entries match the name with DIFFERENT derived fingerprints
 * (collision → never guess; cf. #1032). Never throws.
 */
export function resolvePeerFingerprintByName(
  stateDir: string,
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  try {
    const filePath = path.join(stateDir, 'threadline', 'known-agents.json');
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_KNOWN_AGENTS_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const agents: KnownAgentLike[] = Array.isArray(data?.agents) ? data.agents : [];
    const lower = name.toLowerCase();
    const derived = new Set<string>();
    for (const a of agents) {
      if (a?.name && a.name.toLowerCase() === lower) {
        const fp = resolvePeerFingerprint(a);
        if (fp) derived.add(fp);
      }
    }
    // Exactly one distinct derived fingerprint (a fingerprint entry and its
    // publicKey twin collapse to the same value — not a collision). 0 matches or
    // >1 DISTINCT fingerprints → null (fail-safe to isolation).
    return derived.size === 1 ? [...derived][0] : null;
  } catch {
    return null;
  }
}
