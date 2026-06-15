import { describe, it, expect } from 'vitest';
import { slugifyChannelName, validateChannelName } from '../../src/messaging/slack/sanitize.js';

// Regression: the Slack Updates/Attention channel callers passed an un-slugified
// workspace-derived name (e.g. "SageMind Live Test-sys-updates") straight into
// ChannelManager.createChannel, which validate-and-throws on names that aren't
// lowercase [a-z0-9-_]. The fix slugifies caller-side, mirroring the session-channel
// slug. These tests assert the slug is always a valid Slack channel name.

describe('slugifyChannelName', () => {
  describe('produces a valid Slack channel name', () => {
    it('slugifies the exact failing Updates-channel name', () => {
      // The live failure: "SageMind Live Test-sys-updates"
      const slug = slugifyChannelName('SageMind Live Test-sys-updates');
      expect(slug).toBe('sagemind-live-test-sys-updates');
      // ...and crucially, createChannel would NOT throw on it:
      expect(validateChannelName(slug)).toBe(true);
    });

    it('slugifies the Attention-channel variant', () => {
      const slug = slugifyChannelName('SageMind Live Test-sys-attention');
      expect(slug).toBe('sagemind-live-test-sys-attention');
      expect(validateChannelName(slug)).toBe(true);
    });

    it('lowercases uppercase', () => {
      expect(slugifyChannelName('AGENT-sys-updates')).toBe('agent-sys-updates');
    });

    it('collapses spaces to single hyphens', () => {
      const slug = slugifyChannelName('my   agent   name');
      expect(slug).toBe('my-agent-name');
      expect(validateChannelName(slug)).toBe(true);
    });

    it('strips disallowed punctuation', () => {
      const slug = slugifyChannelName("Justin's Agent! (prod)");
      expect(validateChannelName(slug)).toBe(true);
      expect(slug).toBe('justin-s-agent-prod');
    });

    it('trims leading/trailing hyphens', () => {
      expect(slugifyChannelName('  spaced  ')).toBe('spaced');
      expect(slugifyChannelName('!!!edge!!!')).toBe('edge');
    });

    it('preserves an already-valid name unchanged', () => {
      const valid = 'agent-sys-updates';
      expect(slugifyChannelName(valid)).toBe(valid);
      expect(validateChannelName(valid)).toBe(true);
    });

    it('clamps to Slack 80-char limit', () => {
      const long = 'a'.repeat(200);
      const slug = slugifyChannelName(long);
      expect(slug.length).toBeLessThanOrEqual(80);
      expect(validateChannelName(slug)).toBe(true);
    });
  });

  describe('demonstrates the bug it fixes', () => {
    it('the raw un-slugified name is rejected by validateChannelName', () => {
      // This is what the caller used to pass — it fails validation, which is
      // why createChannel threw "Invalid channel name".
      expect(validateChannelName('SageMind Live Test-sys-updates')).toBe(false);
      // After slugifying, it passes.
      expect(validateChannelName(slugifyChannelName('SageMind Live Test-sys-updates'))).toBe(true);
    });
  });
});
