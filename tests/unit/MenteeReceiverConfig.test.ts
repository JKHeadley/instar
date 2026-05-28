/**
 * Tier-1 unit tests for the MenteeConfig type + DEFAULT_MENTEE_CONFIG.
 * Ships-dormant invariants: enabled defaults false, all required-when-enabled
 * fields default to safe empty/zero values so a partial config can never
 * accidentally wire up.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_MENTEE_CONFIG, type MenteeConfig } from '../../src/messaging/MenteeReceiverConfig.js';

describe('DEFAULT_MENTEE_CONFIG (ships dormant)', () => {
  it('defaults enabled:false (the master ships-dormant invariant)', () => {
    expect(DEFAULT_MENTEE_CONFIG.enabled).toBe(false);
  });

  it('defaults localAgentName to empty string so an accidental enabled:true cannot match any marker.to', () => {
    expect(DEFAULT_MENTEE_CONFIG.localAgentName).toBe('');
  });

  it('defaults knownMentors to {} so the allowlist refuses every inbound sender by construction', () => {
    expect(DEFAULT_MENTEE_CONFIG.knownMentors).toEqual({});
    expect(Object.keys(DEFAULT_MENTEE_CONFIG.knownMentors)).toHaveLength(0);
  });

  it('defaults replyChatId/replyTopicId to empty/0 so the reply-out path has no destination unless explicitly set', () => {
    expect(DEFAULT_MENTEE_CONFIG.replyChatId).toBe('');
    expect(DEFAULT_MENTEE_CONFIG.replyTopicId).toBe(0);
  });

  it('defaults sessionTimeoutMs to 5 min (mirror of Stage-A timeout shape)', () => {
    expect(DEFAULT_MENTEE_CONFIG.sessionTimeoutMs).toBe(5 * 60 * 1000);
  });

  it('all required-when-enabled fields fail the install gate at their defaults (defense-in-depth, even if enabled were toggled true alone)', () => {
    // The install method checks: enabled && localAgentName && knownMentors keys.length>0 && replyChatId && replyTopicId.
    // At defaults, FOUR of those five gates would fail even if enabled were forced true.
    const cfg: MenteeConfig = { ...DEFAULT_MENTEE_CONFIG, enabled: true };
    expect(cfg.localAgentName.length).toBe(0);
    expect(Object.keys(cfg.knownMentors).length).toBe(0);
    expect(cfg.replyChatId.length).toBe(0);
    expect(cfg.replyTopicId).toBe(0);
  });

  it('shape is forward-compatible — adding new optional fields must not change existing default values (regression guard)', () => {
    // Frozen baseline. Adding new MUST-HAVE fields to MenteeConfig is a breaking
    // change to deployed agents whose config.json was written before the new
    // field existed. The migrateConfig backfill is the only safe path.
    expect(DEFAULT_MENTEE_CONFIG).toEqual({
      enabled: false,
      localAgentName: '',
      knownMentors: {},
      replyChatId: '',
      replyTopicId: 0,
      sessionTimeoutMs: 300_000,
    });
  });
});
