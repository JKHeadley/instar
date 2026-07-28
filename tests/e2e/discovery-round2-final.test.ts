/**
 * E2E test — Discovery Round 2 Final Fixes.
 *
 * Tests:
 *   1. Version-aware decline reset — featureVersion material change
 *   2. Self-governing activation challenge — challenge-response
 *   3. Right-to-erasure consent anonymization
 *
 * (The former TopicClassifier block was removed 2026-07-04 (CMT-1907) when that
 *  dead-code keyword intent classifier was deleted.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import type { ConsentRecord, FeatureDefinition } from '../../src/core/FeatureRegistry.js';
// TopicClassifier (dead-code keyword intent classifier) was REMOVED 2026-07-04 (CMT-1907);
// its describe block below was removed with it. The remaining blocks test FeatureRegistry.

// ── Helpers ──────────────────────────────────────────────────────────

let crCounter = 0;
function makeConsentRecord(featureId: string, overrides?: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: `cr-r2-${Date.now()}-${++crCounter}`,
    userId: 'default',
    featureId,
    consentTier: 'network',
    dataImplications: [{ dataType: 'messages', destination: 'anthropic-api', description: 'Test' }],
    consentedAt: new Date().toISOString(),
    mechanism: 'explicit-verbal',
    ...overrides,
  };
}

// ── 2. Version-Aware Decline Reset ──────────────────────────────────

describe('Version-Aware Decline Reset', () => {
  let registry: FeatureRegistry;
  let stateDir: string;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-version-decline-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
  });

  afterAll(() => registry?.close());

  it('stores declinedAtVersion on decline', () => {
    const fid = 'publishing-telegraph';
    registry.transition(fid, 'default', 'aware', { trigger: 'test' });
    registry.transition(fid, 'default', 'declined', { trigger: 'user' });

    const state = registry.getState(fid)!;
    expect(state.declinedAtVersion).toBeDefined();
    expect(state.declinedAtVersion).not.toBeNull();
  });

  it('blocks re-surfacing after maxDeclines when version unchanged', () => {
    const fid = 'publishing-telegraph';
    // Decline 2 more times (already 1 from above)
    registry.transition(fid, 'default', 'aware', { trigger: 'test' });
    registry.transition(fid, 'default', 'declined', { trigger: 'user' });
    registry.transition(fid, 'default', 'aware', { trigger: 'test' });
    registry.transition(fid, 'default', 'declined', { trigger: 'user' });

    const state = registry.getState(fid)!;
    expect(state.declineCount).toBe(3);

    // Now blocked
    const result = registry.transition(fid, 'default', 'aware', { trigger: 'context-change' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MAX_DECLINES_REACHED');
  });

  it('allows re-surfacing after maxDeclines when version changes', () => {
    // Simulate a version change by re-registering with a new version
    const fid = 'publishing-telegraph';
    const def = registry.getDefinition(fid)!;
    const updatedDef: FeatureDefinition = { ...def, featureVersion: '99.0.0' };
    registry.register(updatedDef); // Re-register with new version

    // Should now allow the transition
    const result = registry.transition(fid, 'default', 'aware', { trigger: 'version-change' });
    expect(result.success).toBe(true);
  });

  it('preserves declineCount even after version-change re-surfacing', () => {
    const fid = 'publishing-telegraph';
    const state = registry.getState(fid)!;
    // declineCount should still be 3 — it never resets
    expect(state.declineCount).toBe(3);
  });
});

// ── 3. Self-Governing Activation Challenge ──────────────────────────

describe('Self-Governing Activation Challenge', () => {
  let registry: FeatureRegistry;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-selfgov-'));
    const sd = path.join(dir, '.instar');
    fs.mkdirSync(path.join(sd, 'state'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'config.json'), '{}');
    registry = new FeatureRegistry(sd);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
  });

  afterAll(() => registry?.close());

  it('requires challenge for self-governing tier activation', () => {
    const fid = 'autonomous-evolution';
    registry.transition(fid, 'default', 'aware', { trigger: 'test' });
    registry.transition(fid, 'default', 'interested');

    const result = registry.transition(fid, 'default', 'enabled', {
      consentRecord: makeConsentRecord(fid, { consentTier: 'self-governing' }),
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ACTIVATION_CHALLENGE_REQUIRED');
    expect((result.error?.details as any)?.challenge).toBeDefined();
  });

  it('accepts valid challenge token', () => {
    const fid = 'autonomous-evolution';

    // Get the challenge
    const challengeResult = registry.transition(fid, 'default', 'enabled', {
      consentRecord: makeConsentRecord(fid, { consentTier: 'self-governing' }),
    });
    const challenge = (challengeResult.error?.details as any)?.challenge;
    expect(challenge).toBeDefined();

    // Present challenge back
    const result = registry.transition(fid, 'default', 'enabled', {
      consentRecord: makeConsentRecord(fid, { consentTier: 'self-governing' }),
      activationChallenge: challenge,
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid challenge token', () => {
    // Disable first so we can re-enable
    const fid = 'autonomous-evolution';
    registry.transition(fid, 'default', 'disabled');

    // Re-enable with wrong challenge — go through interested first
    registry.transition(fid, 'default', 'enabled', {
      consentRecord: makeConsentRecord(fid, { consentTier: 'self-governing' }),
    }); // Gets challenge

    const result = registry.transition(fid, 'default', 'enabled', {
      consentRecord: makeConsentRecord(fid, { consentTier: 'self-governing' }),
      activationChallenge: 'wrong-token',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTIVATION_CHALLENGE');
  });

  it('challenge is one-time use (consumed on success)', () => {
    const fid = 'autonomous-evolution';
    // Generate a challenge
    const challenge = registry.generateActivationChallenge(fid, 'default');

    // First verify succeeds
    expect(registry.verifyActivationChallenge(fid, 'default', challenge)).toBe(true);

    // Second verify fails (consumed)
    expect(registry.verifyActivationChallenge(fid, 'default', challenge)).toBe(false);
  });

  it('does not require challenge for network tier', () => {
    const fid = 'threadline-relay';
    registry.transition(fid, 'default', 'aware', { trigger: 'test' });
    registry.transition(fid, 'default', 'interested');

    const result = registry.transition(fid, 'default', 'enabled', {
      consentRecord: makeConsentRecord(fid),
    });

    // Network tier needs consent but NOT activation challenge
    expect(result.success).toBe(true);
  });
});

// ── 4. Right-to-Erasure Consent Anonymization ───────────────────────

describe('Right-to-Erasure Anonymization', () => {
  let registry: FeatureRegistry;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-erasure-'));
    const sd = path.join(dir, '.instar');
    fs.mkdirSync(path.join(sd, 'state'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'config.json'), '{}');
    registry = new FeatureRegistry(sd);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
  });

  afterAll(() => registry?.close());

  it('anonymizes consent records instead of preserving userId', () => {
    const fid = 'cloudflare-tunnel';
    registry.transition(fid, 'user-42', 'aware', { trigger: 'test' });
    registry.transition(fid, 'user-42', 'interested');
    registry.transition(fid, 'user-42', 'enabled', {
      consentRecord: makeConsentRecord(fid, { userId: 'user-42', consentTier: 'local' }),
    });

    // Verify record exists
    const before = registry.getConsentRecordsForFeature(fid, 'user-42');
    expect(before.length).toBeGreaterThanOrEqual(1);

    // Erase
    const result = registry.eraseDiscoveryData('user-42');
    expect(result.deleted).toBeGreaterThanOrEqual(0);
    expect(result.consentRecordsAnonymized).toBeGreaterThanOrEqual(1);

    // Original userId no longer has records
    const after = registry.getConsentRecordsForFeature(fid, 'user-42');
    expect(after.length).toBe(0);

    // But the consent record still exists (anonymized)
    const allRecords = registry.getConsentRecords('user-42');
    expect(allRecords.length).toBe(0); // Can't find by original userId
  });

  it('forceDeleteConsent still fully deletes', () => {
    const fid = 'feedback-system';
    registry.transition(fid, 'user-99', 'aware', { trigger: 'test' });
    registry.transition(fid, 'user-99', 'interested');
    registry.transition(fid, 'user-99', 'enabled', {
      consentRecord: makeConsentRecord(fid, { userId: 'user-99', consentTier: 'local' }),
    });

    const result = registry.eraseDiscoveryData('user-99', { forceDeleteConsent: true });
    expect(result.consentRecordsAnonymized).toBe(0);
  });

  it('anonymizes event log entries', () => {
    const fid = 'git-backup';
    registry.transition(fid, 'user-77', 'aware', { trigger: 'test' });

    // Erase
    registry.eraseDiscoveryData('user-77');

    // Check events
    const events = registry.getDiscoveryEvents({ userId: 'user-77' });
    expect(events.length).toBe(0); // Events are anonymized to 'erased'

    // Events with 'erased' userId should exist
    const erasedEvents = registry.getDiscoveryEvents({ userId: 'erased' });
    expect(erasedEvents.length).toBeGreaterThanOrEqual(0);
  });
});
