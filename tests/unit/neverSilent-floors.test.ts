import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCodexProjectTrusted, hasCodexProjectEntry } from '../../src/core/ensureCodexProjectTrusted.js';
import { ClaudeAuthStatusReader, parseClaudeAuthStatus } from '../../src/core/ClaudeAuthStatus.js';
import { categoryForProducer, CONVERSATION_CATEGORIES } from '../../src/messaging/notificationCategories.js';

describe('Codex folder trust is recorded before launch (§1.5)', () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  it('adds a trusted entry for the launch folder, once', () => {
    const h = home();
    expect(ensureCodexProjectTrusted(h, '/agents/inspec')).toEqual({ patched: true, reason: 'added' });
    expect(ensureCodexProjectTrusted(h, '/agents/inspec')).toEqual({ patched: false, reason: 'already-recorded' });
    const toml = fs.readFileSync(path.join(h, 'config.toml'), 'utf8');
    expect(toml).toContain('[projects."/agents/inspec"]\ntrust_level = "trusted"');
    expect((toml.match(/\[projects\./g) ?? []).length).toBe(1);
  });
  it('keeps existing settings and never overrides an explicit choice', () => {
    const h = home();
    fs.writeFileSync(path.join(h, 'config.toml'), 'model = "gpt"\n\n[projects."/agents/x"]\ntrust_level = "untrusted"\n');
    expect(ensureCodexProjectTrusted(h, '/agents/x').reason).toBe('already-recorded');
    expect(ensureCodexProjectTrusted(h, '/agents/y').patched).toBe(true);
    const toml = fs.readFileSync(path.join(h, 'config.toml'), 'utf8');
    expect(toml.startsWith('model = "gpt"')).toBe(true);
    expect(toml).toContain('trust_level = "untrusted"');
    expect(hasCodexProjectEntry(toml, '/agents/y')).toBe(true);
  });
  it('a folder already recorded in another form is left alone (never a duplicate key)', () => {
    const h = home();
    fs.writeFileSync(path.join(h, 'config.toml'), "[projects]\n\"/agents/z\" = { trust_level = \"trusted\" }\n[projects.'/agents/q']\ntrust_level = \"trusted\"\n");
    expect(ensureCodexProjectTrusted(h, '/agents/z').reason).toBe('already-recorded');
    expect(ensureCodexProjectTrusted(h, '/agents/q').reason).toBe('already-recorded');
  });
  it('refuses a missing home or a relative path', () => {
    expect(ensureCodexProjectTrusted(null, '/a').reason).toBe('no-home');
    expect(ensureCodexProjectTrusted(home(), 'rel/path').reason).toBe('not-absolute');
  });
});

describe("Claude Code's own login answer (§3.6, asymmetric)", () => {
  const out = (loggedIn: boolean | null) => JSON.stringify({ loggedIn, authMethod: loggedIn ? 'oauth' : 'none', loginExpiresAt: null });
  it('parses the JSON and treats garbage as unknown', () => {
    expect(parseClaudeAuthStatus(out(false)).loggedIn).toBe(false);
    expect(parseClaudeAuthStatus('nope').loggedIn).toBeNull();
    expect(parseClaudeAuthStatus(null).loggedIn).toBeNull();
  });
  it('a signed-out answer is trusted only after the empty-home canary says no', async () => {
    const proven = new ClaudeAuthStatusReader(async () => out(false));
    expect(await proven.trustedSignedOut('/h/a')).toBe(true);
    // A CLI that says "signed in" even for an empty home cannot be trusted to say no.
    let n = 0;
    const lying = new ClaudeAuthStatusReader(async () => (n++ === 0 ? out(false) : out(true)));
    expect(await lying.trustedSignedOut('/h/a')).toBeNull();
  });
  it('a YES never counts as proof and unreadable changes nothing', async () => {
    expect(await new ClaudeAuthStatusReader(async () => out(true)).trustedSignedOut('/h/a')).toBe(false);
    expect(await new ClaudeAuthStatusReader(async () => null).trustedSignedOut('/h/a')).toBeNull();
  });
});

describe('the never-silent notice is a conversation category from an internal producer', () => {
  it('maps the producer and is conversation-serving', () => {
    expect(categoryForProducer('never-silent')).toBe('never-silent-notice');
    expect(CONVERSATION_CATEGORIES.has('never-silent-notice')).toBe(true);
  });
});
