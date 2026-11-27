/**
 * Trust-journey stage 0 part C: the effect-kinds table, admission for governed kinds, and the
 * legacy import plan. Both sides of every rule.
 */
import { describe, it, expect } from 'vitest';
import { actionIdentityOf, deriveEffect, SYSTEM_SERVICES, verbRules } from '../../src/data/effect-kinds.js';
import { askSentence, decideAdmission, type AdmissionInputs } from '../../src/core/trustJourney/admission.js';
import { planLegacyImport } from '../../src/core/trustJourney/legacyImport.js';

describe('deriveEffect', () => {
  it('ignores non-MCP and malformed names', () => {
    expect(deriveEffect('Bash', {})).toBeNull();
    expect(deriveEffect('mcp__x', {})).toBeNull();
  });
  it('classifies by the server-held verb rules', () => {
    expect(deriveEffect('mcp__mail__send_email', { to: 'a@b.c' })!.kind).toBe('mail.write');
    expect(deriveEffect('mcp__mail__delete_thread', {})!.kind).toBe('mail.delete');
    expect(deriveEffect('mcp__mail__list_threads', {})!.operation).toBe('read');
    expect(deriveEffect('mcp__mail__get_and_delete', {})!.operation).toBe('modify'); // a mutating tail is never a read
    expect(verbRules('send_message').reversibility).toBe('irreversible');
  });
  it('has unknown audience without a table entry', () => {
    expect(deriveEffect('mcp__mail__send_email', { to: 'a@b.c' })!.audience).toBe('unknown');
  });
  it('typing into a password field on the browser is a sign-in, always self', () => {
    const e = deriveEffect('mcp__playwright__browser_type', { element: 'Password input', ref: 'e5', text: 'x' })!;
    expect(e.operation).toBe('sign-in');
    expect(e.kind).toBe('playwright.sign-in');
    expect(e.audience).toBe('self');
    const f = deriveEffect('mcp__playwright__browser_fill_form', { fields: [{ name: 'Email', type: 'textbox' }, { name: 'One-time code', type: 'textbox' }] })!;
    expect(f.operation).toBe('sign-in');
    expect(deriveEffect('mcp__playwright__browser_type', { element: 'Search box', text: 'x' })!.operation).not.toBe('sign-in');
  });
  it('classifies real GitHub pull request tools and validates the repository audience', () => {
    for (const name of ['github__create_pull_request', 'github_create_pull_request']) {
      const tool = 'mcp__codex_apps__' + name;
      expect(deriveEffect(tool, { repository_full_name: 'Owner/Repo' })).toMatchObject({
        kind: 'codex_apps.write', audience: ['owner/repo'], matched: true,
      });
      for (const repository_full_name of [undefined, 'owner', 'owner/repo,other/repo', 'owner/repo\n', ['owner/repo']]) {
        expect(deriveEffect(tool, { repository_full_name })?.audience).toBe('unknown');
      }
    }
    expect(deriveEffect('mcp__codex_apps__github__update_pull_request', { repository_full_name: 'owner/repo' })).toMatchObject({
      kind: 'codex_apps.modify', audience: ['owner/repo'],
    });
    expect(deriveEffect('mcp__codex_apps__github__merge_pull_request', { repository_full_name: 'owner/repo' })?.floor)
      .toContain('irreversible-outside-role');
    expect(verbRules('github__delete_file').operation).toBe('delete');
    expect(verbRules('github_post_comment').reversibility).toBe('irreversible');
    expect(verbRules('other_create_object').operation).toBe('modify');
  });
  it('the action identity binds the exact input, in any key order', () => {
    expect(actionIdentityOf('t', { a: 1, b: [2] })).toBe(actionIdentityOf('t', { b: [2], a: 1 }));
    expect(actionIdentityOf('t', { a: 1 })).not.toBe(actionIdentityOf('t', { a: 2 }));
  });
});

const base = (over: Partial<AdmissionInputs> = {}): AdmissionInputs => ({
  effect: deriveEffect('mcp__mail__send_email', { to: 'x@y.z' }),
  unchangedLegacy: () => false,
  provenLevel: () => null,
  unreadableHistory: () => false,
  unusedApproval: () => null,
  ...over,
});

describe('decideAdmission', () => {
  it('reads are not gated; system services and unchanged legacy kinds keep today\'s gate', () => {
    expect(decideAdmission(base({ effect: deriveEffect('mcp__mail__list_threads', {}) })).verdict).toBe('not-gated');
    expect(decideAdmission(base({ effect: deriveEffect(`mcp__${SYSTEM_SERVICES[0]}__set_mode`, {}) })).verdict).toBe('legacy');
    expect(decideAdmission(base({ unchangedLegacy: () => true })).verdict).toBe('legacy');
  });
  it('a governed kind with no grant asks (decision 10)', () => {
    expect(decideAdmission(base())).toEqual({ verdict: 'ask', why: 'no-grant' });
  });
  it('a grant that asks, asks; a proven log/autonomous grant still asks when the scope is unknown', () => {
    expect(decideAdmission(base({ provenLevel: () => 'approve-always' }))).toEqual({ verdict: 'ask', why: 'grant-asks' });
    expect(decideAdmission(base({ provenLevel: () => 'autonomous' }))).toEqual({ verdict: 'ask', why: 'unknown-scope' });
  });
  it('a proven grant on a self-scoped action proceeds', () => {
    const e = { ...deriveEffect('mcp__mail__archive_thread', {})!, audience: 'self' as const };
    expect(decideAdmission(base({ effect: e, provenLevel: () => 'log' }))).toEqual({ verdict: 'proceed', why: 'grant', level: 'log' });
  });
  it('an always-ask item asks even under a grant', () => {
    const e = { ...deriveEffect('mcp__social__post_update', {})!, audience: 'self' as const, floor: ['speaks-publicly' as const] };
    expect(decideAdmission(base({ effect: e, provenLevel: () => 'autonomous' })).why).toBe('always-ask-item');
  });
  it('sign-in ignores legacy and write grants, and asks', () => {
    const e = deriveEffect('mcp__playwright__browser_type', { element: 'Password', text: 'x' });
    expect(decideAdmission(base({ effect: e, unchangedLegacy: () => true, provenLevel: () => 'autonomous' }))).toEqual({ verdict: 'ask', why: 'sign-in' });
  });
  it('an approval for this exact action admits it once', () => {
    expect(decideAdmission(base({ unusedApproval: () => ({ approvalId: 'a1' }) }))).toEqual({ verdict: 'proceed-once', why: 'approved-once', approvalId: 'a1' });
  });
  it('unreadable history asks', () => {
    expect(decideAdmission(base({ unreadableHistory: () => true, provenLevel: () => 'autonomous' })).why).toBe('unreadable-history');
  });
  it('the refusal sentence says where the card is and to continue other work', () => {
    expect(askSentence('no-grant', 'sent')).toMatch(/card asking for approval is in their direct chat/);
    expect(askSentence('holder-unreachable', 'other')).toMatch(/serving lease/);
  });
});

describe('planLegacyImport', () => {
  const p = { gateEnabled: true, gateServices: ['gmail'], readOnlyServices: ['calendar'], logServices: ['slack'], mcpServers: ['playwright', '*', 'parity-sentinel'], existingKeys: [] as string[] };
  it('imports every concrete kind as write/modify/delete, never wildcards or system services', () => {
    const keys = planLegacyImport(p).grants.map((g) => g.key);
    expect(keys).toContain('gmail.write');
    expect(keys).toContain('calendar.delete');
    expect(keys).toContain('slack.modify');
    expect(keys).toContain('playwright.write');
    expect(keys.some((k) => k.startsWith('*') || k.startsWith('parity-sentinel'))).toBe(false);
    expect(keys.some((k) => k.endsWith('.sign-in') || k.endsWith('.read'))).toBe(false);
  });
  it('with the gate off, today\'s behaviour is blocked', () => {
    expect(planLegacyImport({ ...p, gateEnabled: false }).grants.every((g) => g.behaviour === 'blocked')).toBe(true);
  });
  it('a machine joining after every legacy kind was changed imports nothing', () => {
    expect(planLegacyImport({ ...p, existingKeys: [], othersImported: true }).grants).toEqual([]);
  });
  it('a machine joining later imports only kinds already legacy somewhere', () => {
    expect(planLegacyImport({ ...p, existingKeys: ['gmail.write'] }).grants.map((g) => g.key)).toEqual(['gmail.write']);
  });
});

describe('security review fixes (stage 0 part C)', () => {
  it('a current "Don\'t do this" wins over an earlier one-time approval, and is refused without a card', () => {
    expect(decideAdmission(base({ unusedApproval: () => ({ approvalId: 'a1' }), currentLevel: () => 'blocked' }))).toEqual({ verdict: 'refused', why: 'blocked' });
  });
  it('unreadable history wins over an earlier one-time approval', () => {
    expect(decideAdmission(base({ unusedApproval: () => ({ approvalId: 'a1' }), unreadableHistory: () => true })).why).toBe('unreadable-history');
  });
});
