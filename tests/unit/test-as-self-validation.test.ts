import { describe, it, expect } from 'vitest';
import path from 'node:path';
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
    it('rejects a target that CONTAINS the canonical or any agent home (teardown sweep would reach it)', () => {
      expect(validateTarget(path.dirname(CANONICAL), opts).code).toBe('target-is-ancestor');
      expect(validateTarget('/', opts).code).toBe('target-is-ancestor');
      const r = validateTarget('/Users/x/.instar', { ...opts, agentHomes: ['/Users/x/.instar/agents/groky'] });
      expect(r.code).toBe('target-is-ancestor');
    });
    it('rejects a target whose basename matches the canonical or a live agent home', () => {
      expect(validateTarget('/tmp/x/' + path.basename(CANONICAL), opts).code).toBe('target-name-collides');
      const r = validateTarget('/tmp/x/Groky', { ...opts, agentHomes: ['/Users/x/.instar/agents/groky'] });
      expect(r.code).toBe('target-name-collides');
    });
    it('rejects a basename that overlaps an agent tmux prefix in either direction', () => {
      const o = { ...opts, agentHomes: ['/Users/x/.instar/agents/groky'] };
      // target sweep `groky-2-*` could hit groky's session `groky-2-...`
      expect(validateTarget('/tmp/x/groky-2', o).code).toBe('target-name-collides');
      // target sweep `ech-*`... and an agent `echo-desk` would be hit by target `echo`
      expect(validateTarget('/tmp/x/echo', { ...opts, canonicalHome: '/a/b/echo-desk' }).code).toBe('target-name-collides');
    });
    it('accepts a name that only shares letters, not a dash-prefix', () => {
      expect(validateTarget('/tmp/x/grokyy', { ...opts, agentHomes: ['/Users/x/.instar/agents/groky'] }).ok).toBe(true);
    });
    it('follows symlinks when checking for a contained agent home', () => {
      const os = require('node:os') as typeof import('node:os');
      const fs = require('node:fs') as typeof import('node:fs');
      const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-real-'));
      const home = path.join(real, 'agents', 'zed');
      fs.mkdirSync(home, { recursive: true });
      const link = path.join(os.tmpdir(), `tas-link-${process.pid}`);
      try { fs.unlinkSync(link); } catch { /* none */ }
      fs.symlinkSync(real, link);
      const homeLink = path.join(os.tmpdir(), `tas-homelink-${process.pid}`);
      try { fs.unlinkSync(homeLink); } catch { /* none */ }
      fs.symlinkSync(home, homeLink);
      try {
        expect(validateTarget(link, { ...opts, agentHomes: [home] }).code).toBe('target-is-ancestor');
        // a symlink TO the agent home itself
        expect(validateTarget(homeLink, { ...opts, agentHomes: [home] }).code).toBe('target-is-canonical');
      } finally {
        fs.unlinkSync(link);
        fs.unlinkSync(homeLink);
      }
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
