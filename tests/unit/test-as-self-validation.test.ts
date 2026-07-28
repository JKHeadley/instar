import { describe, it, expect } from 'vitest';
import { isRawToken, validateTarget, validateBotTokenArg } from '../../src/commands/testAsSelfValidation.js';

const CANONICAL = '/Users/justin/.instar/agents/echo';

describe('test-as-self validation guards (Track F)', () => {
  describe('isRawToken', () => {
    it('flags a raw Telegram bot token', () => {
      expect(isRawToken('123456789:AAH8sQ3l2kZ_xQ9pZ0mNvW1rT5uY7iO3pLk')).toBe(true);
    });
    it('flags raw GitHub / Slack / OpenAI tokens', () => {
      expect(isRawToken('gho_EXAMPLEEXAMPLEEXAMPLEEXAMPLE00000000')).toBe(true);
      expect(isRawToken('xoxb-1234567890-abcdefghij')).toBe(true);
      expect(isRawToken('sk-ABCDEFGHIJKLMNOPQRSTUV')).toBe(true);
    });
    it('does NOT flag a Secret Drop ID (uuid-ish)', () => {
      expect(isRawToken('a3ac079e-21bc-4f74-9d81-287f0b3571c2')).toBe(false);
    });
    it('does NOT flag a short label', () => {
      expect(isRawToken('mmtest2-bot')).toBe(false);
    });
  });

  describe('validateTarget', () => {
    const opts = { canonicalHome: CANONICAL, protectedNames: ['bob'] };

    it('rejects an empty target', () => {
      expect(validateTarget(undefined, opts).code).toBe('empty-target');
      expect(validateTarget('   ', opts).code).toBe('empty-target');
    });
    it('rejects the canonical agent home (even with trailing slash)', () => {
      expect(validateTarget(CANONICAL, opts).code).toBe('target-is-canonical');
      expect(validateTarget(CANONICAL + '/', opts).code).toBe('target-is-canonical');
    });
    it('rejects a home whose name is protected (bob), case-insensitive', () => {
      expect(validateTarget('/Users/justin_instar_1/.instar/agents/bob', opts).code).toBe('target-is-protected');
      expect(validateTarget('/somewhere/Bob', opts).code).toBe('target-is-protected');
    });
    it('rejects an explicitly protected home path', () => {
      const r = validateTarget('/mini/home/x', { ...opts, protectedHomes: ['/mini/home/x'] });
      expect(r.code).toBe('target-is-protected');
    });
    it('accepts a clean throwaway target', () => {
      const r = validateTarget('/Users/justin/.instar/test-deploys/mmtest2', opts);
      expect(r.ok).toBe(true);
      expect(r.code).toBe('ok');
    });
  });

  describe('validateBotTokenArg', () => {
    it('accepts an absent arg (harness opens Secret Drop)', () => {
      expect(validateBotTokenArg(undefined).ok).toBe(true);
    });
    it('accepts a Secret Drop ID', () => {
      expect(validateBotTokenArg('a3ac079e-21bc-4f74-9d81-287f0b3571c2').ok).toBe(true);
    });
    it('REFUSES a raw Telegram token on the CLI', () => {
      const r = validateBotTokenArg('123456789:AAH8sQ3l2kZ_xQ9pZ0mNvW1rT5uY7iO3pLk');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('raw-token-on-cli');
    });
  });
});
