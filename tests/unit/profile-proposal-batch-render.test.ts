import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { ProfileProposalRequests } from '../../src/core/ProfileProposalRequests.js';
import { ProfileProposalOwnerTurns } from '../../src/core/ProfileProposalOwnerTurns.js';
import { renderProfileBatchProposal, escapeProfileProposalName, profileProposalFitsTelegram, telegramProfileTopicLink } from '../../src/core/profileProposalBatch.js';
import { formatForTelegram } from '../../src/messaging/TelegramMarkdownFormatter.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { ISSUES_TOPIC_OFFSET } from '../../src/messaging/telegramTopicSpace.js';
let tmp: string;
let surface: TopicProfileWriteSurface;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-batch-render-'));
  const store = new TopicProfileStore({ stateFilePath: path.join(tmp, 'profiles.json') });
  await store.ready();
  const resolver = new TopicProfileResolver({ store, defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}), frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined, localModelBinding: () => null, frameworkBinaryPath: () => null });
  surface = new TopicProfileWriteSurface({ store, resolver,
    regime: () => ({ enabled: true, dryRun: false }), boundOperator: () => ({ platform: 'telegram', uid: '7' }),
    localModelBinding: () => null, legacyFrameworkRespawn: async () => ({ respawned: false }),
    disclose: async () => {}, audit: () => {},
  });
});
afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true,
  operation: 'tests/unit/profile-proposal-batch-render.test.ts:cleanup' }));
const chat = '-1001234567';
const link = (target: string) => telegramProfileTopicLink(chat, target);
const options = () => ({ source: '1', targets: [{ target: '10', patch: { framework: 'codex-cli' } }, { target: '20', patch: { framework: 'claude-code' } }], surface, name: () => 'Same title', link, placement: () => 'owner-epoch' });
describe('batch proposal disclosure and actual Telegram formatting', () => {
  it('keeps the exact real per-item echo/baseline and distinguishes colliding titles beside their own effect', () => {
    const result = renderProfileBatchProposal(options()); if (!result.ok) throw Error(result.message);
    expect(result.items.map(i => i.target)).toEqual(['10', '20']);
    for (const item of result.items) {
      const rendered = surface.renderProposalEcho(item.target, item.patch, escapeProfileProposalName('Same title'));
      if (!rendered.ok) throw Error(rendered.reply);
      expect(item.core).toBe(rendered.echo); expect(item.baselineStamp).toBe(rendered.baselineStamp);
      expect(result.core).toContain(`[Open this conversation](${link(item.target)})\n${item.core}`);
    }
    const actual = formatForTelegram(result.core);
    expect(actual.text).toContain('href="https://t.me/c/1234567/10"');
    expect(actual.text).toContain('href="https://t.me/c/1234567/20"');
    expect(profileProposalFitsTelegram(result.core)).toBe(true);
  });
  it('rejects swapped or unsafe duplicate-title links instead of attaching another target identity', () => {
    expect(renderProfileBatchProposal({ ...options(), link: target => link(target === '10' ? '20' : '10') })).toMatchObject({ ok: false, reason: 'target-link-unavailable' });
    expect(renderProfileBatchProposal({ ...options(), link: target => `${link(target === '10' ? '20' : '10')}?post=${target}` })).toMatchObject({ ok: false, reason: 'target-link-unavailable' });
    expect(renderProfileBatchProposal({ ...options(), link: () => 'javascript:alert(1)' })).toMatchObject({ ok: false, reason: 'target-link-unavailable' });
    expect(renderProfileBatchProposal({ ...options(), link: target => `tg://privatepost?channel=1234567&post=${target}` })).toMatchObject({ ok: false, reason: 'target-link-unavailable' });
    expect(renderProfileBatchProposal({ ...options(), link: () => null })).toMatchObject({ ok: false, reason: 'target-link-unavailable' });
  });
  it('binds internal issues identifiers to actual adapter wire threads and refuses swapped destinations', async () => {
    const adapter = new TelegramAdapter({ token: 'fixture', chatId: chat, issuesChatId: '-1007654321' }, tmp, { suppressLifelineAutoCreate: true });
    try {
      const native = (target: string) => {
        const destination = adapter.getNativeTopicDestination(Number(target));
        return destination ? telegramProfileTopicLink(destination.chatId, String(destination.threadId)) : null;
      };
      const targets = [{ target: String(ISSUES_TOPIC_OFFSET + 10), patch: { framework: 'codex-cli' } },
        { target: String(ISSUES_TOPIC_OFFSET + 20), patch: { framework: 'claude-code' } }];
      const result = renderProfileBatchProposal({ ...options(), targets, link: native });
      if (!result.ok) throw Error(result.message);
      expect(formatForTelegram(result.core).text).toContain('href="https://t.me/c/7654321/10"');
      expect(formatForTelegram(result.core).text).toContain('href="https://t.me/c/7654321/20"');
      expect(result.items.map(item => item.target)).toEqual(targets.map(item => item.target));
      expect(renderProfileBatchProposal({ ...options(), targets, link: target => native(target === targets[0].target ? targets[1].target : targets[0].target) }))
        .toMatchObject({ ok: false, reason: 'target-link-unavailable' });
      // An internal identifier is never a wire thread in the native group URL.
      expect(renderProfileBatchProposal({ ...options(), targets, link: target => telegramProfileTopicLink('-1007654321', target) }))
        .toMatchObject({ ok: false, reason: 'target-link-unavailable' });
    } finally { await adapter.stop(); }
  });
  it('retains distinct native groups for equal main and issues wire thread numbers', async () => {
    const adapter = new TelegramAdapter({ token: 'fixture', chatId: chat, issuesChatId: '-1007654321' }, tmp, { suppressLifelineAutoCreate: true });
    try {
      const targets = [{ target: '10', patch: { framework: 'codex-cli' } }, { target: String(ISSUES_TOPIC_OFFSET + 10), patch: { framework: 'claude-code' } }];
      const result = renderProfileBatchProposal({ ...options(), targets, link: target => {
        const dest = adapter.getNativeTopicDestination(Number(target)); return dest ? telegramProfileTopicLink(dest.chatId, String(dest.threadId)) : null;
      } });
      if (!result.ok) throw Error(result.message);
      expect(result.core).toContain('https://t.me/c/1234567/10'); expect(result.core).toContain('https://t.me/c/7654321/10');
    } finally { await adapter.stop(); }
  });
  it('renders untrusted name punctuation as literal text, not a new link, heading or command', () => {
    const name = '[Approve](https://evil.test/10) **yes** <b>owner</b> `x`\n# yes';
    const result = renderProfileBatchProposal({ ...options(), name: target => `${name}${target}` }); if (!result.ok) throw Error(result.message);
    const actual = formatForTelegram(result.core).text;
    expect(actual).not.toContain('href="https://evil.test/10"'); expect(actual).not.toContain('<b>owner</b>');
    expect(actual).toContain('[Approve](https://evil.test/10) **yes** &lt;b&gt;owner&lt;/b&gt;');
    expect(result.core).not.toContain('\n# yes');
  });
  it('uses the real entity-decoded payload budget rather than raw HTML/URL length', () => {
    expect(profileProposalFitsTelegram('&'.repeat(4096))).toBe(true);
    expect(profileProposalFitsTelegram('&'.repeat(4097))).toBe(false);
    expect(profileProposalFitsTelegram('[short](https://example.com/' + 'x'.repeat(1000) + ')')).toBe(true);
    expect(profileProposalFitsTelegram('<b>' + 'x'.repeat(4096) + '</b>', 'html')).toBe(true);
    expect(profileProposalFitsTelegram('<b>' + 'x'.repeat(4097) + '</b>', 'html')).toBe(false);
  });
  it('counts duplicate-name disambiguators and the full final question before spending a handle', () => {
    const result = renderProfileBatchProposal(options()); if (!result.ok) throw Error(result.message);
    const withoutLinks = result.core.replace(/Conversation \d+: \[Open this conversation\]\([^\n]+\)\n/g, '');
    const pad = 'x'.repeat(4096 - formatForTelegram(withoutLinks).text.replace(/<[^>]*>/g, '').length);
    expect(profileProposalFitsTelegram(withoutLinks + pad)).toBe(true);
    expect(profileProposalFitsTelegram(result.core + pad)).toBe(false);
    const registry = new ProfileProposalOwnerTurns(); const binding = { source: '1', principal: 'telegram:7', inboundId: '99' };
    const handle = registry.issue(binding); const manager = new ProfileProposalRequests({ maxSends: 0, validateFormat: profileProposalFitsTelegram });
    const opts = { ownerTurn: { registry, handle, principal: binding.principal, inboundId: binding.inboundId } };
    expect(manager.beginBatch('1', result.items, result.core + pad, opts)).toEqual({ ok: false, reason: 'invalid-format' });
    expect(registry.canDispatch(handle, binding)).toBe(true);
    expect(manager.beginBatch('1', result.items, result.core, opts).ok).toBe(true);
  });
  it('builds links only from a configured forum group and a canonical native target', () => {
    expect(link('10')).toBe('https://t.me/c/1234567/10');
    expect(telegramProfileTopicLink('123', '10')).toBeNull();
    expect(link('01')).toBeNull(); expect(link('10/20')).toBeNull();
  });
});
