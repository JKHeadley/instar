/**
 * Capability-honesty marker canary.
 *
 * Per Rule 3.2 of the path constraints: every state-detection /
 * contract-preserving code path needs a paired canary that verifies
 * the mechanism still works correctly. This canary covers the
 * STUB_MARKER symbol (`src/providers/markers.ts`, Bug D fix area):
 * when an adapter's `createStubPrimitive` factory returns a proxy,
 * the marker must be readable via `isStubPrimitive` without tripping
 * the proxy's throwing-method branch.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (capability-declaration honesty — missed marker = lying adapter)
 *   Frequency:   parity test runs (transitively via the parity check)
 *   Stability:   very stable (internal symbol)
 *   Fallback:    none required — symbol identity is deterministic
 *   Verdict:     deterministic + startup canary (startup-only cadence)
 *
 * Drift risk: low for the marker itself (Symbol.for is stable). Real
 * risk is "a future stub factory refactor forgets to attach the
 * marker." This canary catches that regression at startup loudly.
 */

import { CapabilityFlag } from '../capabilities.js';
import { isStubPrimitive, STUB_MARKER } from '../markers.js';
import { createStubPrimitive as headlessStubFactory } from '../adapters/anthropic-headless/stubs.js';
import { createStubPrimitive as poolStubFactory } from '../adapters/anthropic-interactive-pool/stubs.js';
import { createStubPrimitive as codexStubFactory } from '../adapters/openai-codex/stubs.js';

export interface CapabilityHonestyCanaryResult {
  status: 'pass' | 'fail';
  message: string;
  details: {
    headlessStubDetected: boolean;
    poolStubDetected: boolean;
    codexStubDetected: boolean;
    realPrimitiveCorrectlyNotDetected: boolean;
    markerReadDidNotThrow: boolean;
  };
}

/**
 * Verify the STUB_MARKER infrastructure is intact across both
 * Anthropic stub factories AND that reading the marker on a stub
 * does NOT trip the proxy's throwing-method branch.
 *
 * Runs at startup. Cheap (no I/O, no real upstream). If this canary
 * ever fails, the parity test's stub-vs-real detection is broken
 * and adapters can re-acquire the ability to lie about capabilities.
 */
export function runCapabilityHonestyCanary(): CapabilityHonestyCanaryResult {
  // Check 1: headless stub factory output is detected as a stub.
  const headlessStub = headlessStubFactory(CapabilityFlag.StructuredOneShot);
  let headlessStubDetected: boolean;
  let markerReadDidNotThrow = true;
  try {
    headlessStubDetected = isStubPrimitive(headlessStub);
  } catch {
    headlessStubDetected = false;
    markerReadDidNotThrow = false;
  }

  // Check 2: pool stub factory output is detected as a stub.
  const poolStub = poolStubFactory(CapabilityFlag.StructuredOneShot);
  let poolStubDetected: boolean;
  try {
    poolStubDetected = isStubPrimitive(poolStub);
  } catch {
    poolStubDetected = false;
    markerReadDidNotThrow = false;
  }

  // Check 2b: openai-codex stub factory output is detected as a stub.
  // Per Rule 3.2, every adapter that emits stub primitives for parity
  // tests must use the canonical STUB_MARKER so isStubPrimitive sees it.
  // A new adapter forgetting the marker silently re-grants it the ability
  // to lie about capabilities — this check guards against that regression.
  const codexStub = codexStubFactory(CapabilityFlag.StructuredOneShot);
  let codexStubDetected: boolean;
  try {
    codexStubDetected = isStubPrimitive(codexStub);
  } catch {
    codexStubDetected = false;
    markerReadDidNotThrow = false;
  }

  // Check 3: a real primitive shape (plain object with capability)
  // is NOT detected as a stub.
  const fakeReal = {
    capability: CapabilityFlag.OneShotCompletion,
    evaluate: () => Promise.resolve({ text: '', usage: null }),
  };
  const realPrimitiveCorrectlyNotDetected = !isStubPrimitive(fakeReal);

  // Check 4: the marker Symbol identity is canonical (catches
  // re-export confusion where two different modules might create
  // different Symbol.for objects with the same key).
  const canonicalMarkerOnHeadless =
    (headlessStub as Record<symbol, unknown>)[STUB_MARKER] === true;
  const canonicalMarkerOnPool =
    (poolStub as Record<symbol, unknown>)[STUB_MARKER] === true;
  const canonicalMarkerOnCodex =
    (codexStub as Record<symbol, unknown>)[STUB_MARKER] === true;

  const allChecksPass =
    headlessStubDetected
    && poolStubDetected
    && codexStubDetected
    && realPrimitiveCorrectlyNotDetected
    && markerReadDidNotThrow
    && canonicalMarkerOnHeadless
    && canonicalMarkerOnPool
    && canonicalMarkerOnCodex;

  if (allChecksPass) {
    return {
      status: 'pass',
      message: 'capability-honesty canary: stub markers intact across all 3 adapter factories',
      details: {
        headlessStubDetected: true,
        poolStubDetected: true,
        codexStubDetected: true,
        realPrimitiveCorrectlyNotDetected: true,
        markerReadDidNotThrow: true,
      },
    };
  }

  const failures: string[] = [];
  if (!headlessStubDetected) failures.push('headless stub not detected');
  if (!poolStubDetected) failures.push('pool stub not detected');
  if (!codexStubDetected) failures.push('codex stub not detected');
  if (!realPrimitiveCorrectlyNotDetected) failures.push('real primitive incorrectly flagged as stub');
  if (!markerReadDidNotThrow) failures.push('reading the marker threw (proxy trap regression)');
  if (!canonicalMarkerOnHeadless) failures.push('canonical marker missing on headless stub');
  if (!canonicalMarkerOnPool) failures.push('canonical marker missing on pool stub');
  if (!canonicalMarkerOnCodex) failures.push('canonical marker missing on codex stub');

  return {
    status: 'fail',
    message: `capability-honesty canary: ${failures.join('; ')}`,
    details: {
      headlessStubDetected,
      poolStubDetected,
      codexStubDetected,
      realPrimitiveCorrectlyNotDetected,
      markerReadDidNotThrow,
    },
  };
}
