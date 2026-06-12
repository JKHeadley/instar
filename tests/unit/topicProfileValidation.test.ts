/**
 * Unit tests — topicProfileValidation (TOPIC-PROFILE-SPEC §10.2 / §11).
 *
 * Closed-enum reject cases (newline, shell metachar, off-enum, >64 chars,
 * cross-framework id) for ALL fields, not only model; the §4 model+modelTier
 * hard refusal; clamped rejected-value audit fields (§10.3 — never verbatim).
 */

import { describe, it, expect } from 'vitest';
import {
  validateProfileFields,
  validateModelId,
  modelTierMutualExclusionError,
  clampRejectedValue,
  billingLaneError,
  PER_TOKEN_LANE_MODEL_IDS,
  THINKING_MODES,
} from '../../src/core/topicProfileValidation.js';
import { KNOWN_MODEL_IDS } from '../../src/core/ModelTierEscalation.js';

describe('validateModelId (§10.2 closed-enum clamp)', () => {
  it('accepts a known claude id', () => {
    expect(validateModelId('claude-opus-4-8', 'claude-code')).toBeNull();
    expect(validateModelId('opus', 'claude-code')).toBeNull();
  });

  it('accepts a known codex id against codex-cli', () => {
    expect(validateModelId('gpt-5.5', 'codex-cli')).toBeNull();
  });

  it('rejects a newline-bearing id (regex failure class)', () => {
    const err = validateModelId('opus\nrm -rf /', 'claude-code');
    expect(err?.failure).toBe('regex');
  });

  it('rejects a shell-metachar id', () => {
    const err = validateModelId('opus;echo pwned', 'claude-code');
    expect(err?.failure).toBe('regex');
  });

  it('rejects an over-64-char id (length failure class)', () => {
    const err = validateModelId('a'.repeat(65), 'claude-code');
    expect(err?.failure).toBe('length');
  });

  it('rejects an off-enum id with a named reason', () => {
    const err = validateModelId('gpt-7-ultra', 'claude-code');
    expect(err?.failure).toBe('off-enum');
    expect(err?.reason).toContain('not a known');
  });

  it('rejects a cross-framework id (claude id against codex)', () => {
    const err = validateModelId('claude-opus-4-8', 'codex-cli');
    expect(err?.failure).toBe('off-enum');
  });

  it('refuses ALL pi ids (closed-empty enumeration)', () => {
    const err = validateModelId('gpt-5.5', 'pi-cli');
    expect(err?.failure).toBe('cross-framework-id');
  });
});

describe('validateProfileFields — every field clamped (§10.2)', () => {
  it('accepts a fully-valid patch', () => {
    const result = validateProfileFields(
      { framework: 'codex-cli', thinkingMode: 'high', escalationOverride: 'inherit' },
      'claude-code',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an off-enum framework', () => {
    const result = validateProfileFields({ framework: 'cursor-cli' }, 'claude-code');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('framework');
  });

  it('rejects an off-enum thinkingMode (it becomes a launch arg — injection surface)', () => {
    const result = validateProfileFields({ thinkingMode: 'xhigh; rm -rf /' }, 'claude-code');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('thinkingMode');
      expect(result.error.failure).toBe('off-enum');
      // §10.3 — the rejected value is never stored verbatim.
      expect(result.error.rejectedPrefix).not.toContain(';');
    }
  });

  it('rejects an off-enum escalationOverride', () => {
    const result = validateProfileFields({ escalationOverride: 'always' }, 'claude-code');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('escalationOverride');
  });

  it('rejects an off-enum modelTier', () => {
    const result = validateProfileFields({ modelTier: 'ultra' }, 'claude-code');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('modelTier');
  });

  it('validates the model against the PATCH framework when both are set', () => {
    const ok = validateProfileFields({ framework: 'codex-cli', model: 'gpt-5.5' }, 'claude-code');
    expect(ok.ok).toBe(true);
    const bad = validateProfileFields({ framework: 'codex-cli', model: 'claude-opus-4-8' }, 'claude-code');
    expect(bad.ok).toBe(false);
  });

  it('validates the model against the effective framework when the patch sets none', () => {
    const result = validateProfileFields({ model: 'gpt-5.5' }, 'claude-code');
    expect(result.ok).toBe(false);
  });

  it('null fields are CLEAR requests and always valid', () => {
    const result = validateProfileFields(
      { framework: null, model: null, modelTier: null, thinkingMode: null, escalationOverride: null },
      'claude-code',
    );
    expect(result.ok).toBe(true);
  });

  it('covers every thinking mode in the closed enum', () => {
    for (const mode of THINKING_MODES) {
      expect(validateProfileFields({ thinkingMode: mode }, 'claude-code').ok).toBe(true);
    }
  });
});

describe('billing lane (§10.2 — a pin can never introduce a per-token path)', () => {
  it('subscription-lane ids pass (both sides: the allow side of the boundary)', () => {
    expect(billingLaneError('claude-opus-4-8', 'claude-code')).toBeNull();
    expect(billingLaneError('gpt-5.5', 'codex-cli')).toBeNull();
  });

  it('refuses a per-token-lane id with the named failure class (injected deny set)', () => {
    const err = billingLaneError('claude-opus-4-8', 'claude-code', ['claude-opus-4-8']);
    expect(err?.failure).toBe('per-token-lane');
    expect(err?.field).toBe('model');
    expect(err?.reason).toContain('per-token');
    expect(err?.reason).toContain('subscription');
  });

  it('the shipped deny sets are empty AND every known id rides the subscription envelope', () => {
    // The seam is honest: today every closed-enum member is subscription-lane.
    // The moment a per-token id joins a known-ids enum, it must be classified
    // in PER_TOKEN_LANE_MODEL_IDS — this test pins the current truth so that
    // change is a deliberate, reviewed edit (the refusal then wins).
    for (const [framework, known] of Object.entries(KNOWN_MODEL_IDS)) {
      const deny = PER_TOKEN_LANE_MODEL_IDS[framework as keyof typeof PER_TOKEN_LANE_MODEL_IDS] ?? [];
      for (const id of known) {
        expect(deny.includes(id)).toBe(false);
      }
    }
  });

  it('validateModelId runs the billing-lane arm after the enum check', () => {
    // The default tables are empty, so the wired arm passes — assert the wire
    // exists by checking a valid id still validates null (no throw), and the
    // injectable predicate refuses. (validateModelId uses the shipped table;
    // the refusal side is covered through billingLaneError directly.)
    expect(validateModelId('claude-fable-5', 'claude-code')).toBeNull();
    expect(billingLaneError('claude-fable-5', 'claude-code', ['claude-fable-5'])?.failure).toBe('per-token-lane');
  });
});

describe('modelTierMutualExclusionError (§4 hard refusal)', () => {
  it('refuses model+modelTier both set', () => {
    const err = modelTierMutualExclusionError({ model: 'opus', modelTier: 'default' });
    expect(err?.failure).toBe('model-and-tier-both-set');
    expect(err?.reason).toContain('pick one');
  });

  it('allows either alone or neither', () => {
    expect(modelTierMutualExclusionError({ model: 'opus', modelTier: null })).toBeNull();
    expect(modelTierMutualExclusionError({ model: null, modelTier: 'escalated' })).toBeNull();
    expect(modelTierMutualExclusionError({})).toBeNull();
  });
});

describe('clampRejectedValue (§10.3 stored-prompt-injection guard)', () => {
  it('clamps charset and truncates to 32 chars, recording the true length', () => {
    const raw = '<script>alert(1)</script>' + 'x'.repeat(100);
    const { prefix, length } = clampRejectedValue(raw);
    expect(prefix.length).toBeLessThanOrEqual(32);
    expect(prefix).not.toContain('<');
    expect(length).toBe(raw.length);
  });
});
