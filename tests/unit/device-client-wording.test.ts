/**
 * The words the server writes that name the sending device (dashboard-conversations-browser-device
 * §4.7). Phone wording stays byte for byte what it was; a `client: 'browser'` device gets 💻 and
 * "dashboard".
 */
import { describe, it, expect } from 'vitest';
import {
  deviceClientOf, deviceIcon, deviceNoun, mirrorPrefix, openItHint, requestDeviceClient, signedTag,
} from '../../src/core/deviceClientWording.js';
import { planTelegramMirror } from '../../src/server/mobileMediaSend.js';
import { mirrorMediaToSlack, type MobileSlackBridge, type SlackAppConversation } from '../../src/server/mobileSlackRoutes.js';
import { appInjectionTag } from '../../src/core/appInboundDispatch.js';
import type { AppAttachment } from '../../src/core/appMediaTypes.js';

const att = (over: Partial<AppAttachment> = {}): AppAttachment => ({
  attachmentId: 'a'.repeat(64), index: 0, sha256: 'b'.repeat(64), size: 1000, declaredKind: 'photo', kind: 'photo',
  mediaType: 'image/png', declaredType: 'image/png', filename: 'holiday.png', ...over,
});

describe('deviceClientWording', () => {
  it('a record is a browser only when client is exactly "browser"', () => {
    expect(deviceClientOf({ client: 'browser' })).toBe('browser');
    for (const d of [{}, { client: 'phone' }, { client: 'Browser' }, { client: 1 }, null, undefined]) expect(deviceClientOf(d as never)).toBe('phone');
  });
  it('phone wording is unchanged; browser wording uses 💻 and the dashboard', () => {
    expect(mirrorPrefix('phone', 'Justin')).toBe('📱 Justin (from the app)');
    expect(mirrorPrefix('browser', 'Justin')).toBe('💻 Justin (from the dashboard)');
    expect(openItHint('phone')).toBe('open it in the app');
    expect(openItHint('browser')).toBe('open it in the dashboard');
    expect(signedTag('phone')).toBe('(📱 signed)');
    expect(signedTag('browser')).toBe('(💻 signed)');
    expect(deviceNoun('phone')).toBe('phone');
    expect(deviceNoun('browser')).toBe('browser');
    expect(deviceIcon('browser')).toBe('💻');
  });
  it('requestDeviceClient reads only the authenticator-set marker; absent is a phone', () => {
    expect(requestDeviceClient({ instarDeviceClient: 'browser' })).toBe('browser');
    expect(requestDeviceClient({})).toBe('phone');
    expect(requestDeviceClient({ instarDeviceClient: 'browserx' })).toBe('phone');
    expect(requestDeviceClient(undefined)).toBe('phone');
  });
});

describe('§4.7 wording sites', () => {
  const here = () => '/blobs/x';
  it('Telegram media mirror: phone byte-identical (default), browser 💻 dashboard', () => {
    const phone = planTelegramMirror('Justin', [att({ size: 51_000_000, filename: 'v.mov' })], 'hi', here);
    expect(phone.textLines).toEqual(['📱 Justin (from the app): hi', '📱 Justin sent v.mov (too large for Telegram; open it in the app)']);
    const browser = planTelegramMirror('Justin', [att({ size: 51_000_000, filename: 'v.mov' })], 'hi', here, 'browser');
    expect(browser.textLines).toEqual(['💻 Justin (from the dashboard): hi', '💻 Justin sent v.mov (too large for Telegram; open it in the dashboard)']);
    expect(planTelegramMirror('Justin', [att()], '', here, 'browser').caption).toBe('💻 Justin (from the dashboard)');
  });
  it('Slack media mirror: browser 💻 lines, including a file with no blob here', async () => {
    const uploads: Array<{ initialComment?: string }> = [];
    const posts: string[] = [];
    const bridge = {
      uploadFile: async (_c: SlackAppConversation, _p: string, o: { filename: string; initialComment?: string }) => { uploads.push(o); },
      post: async (_c: SlackAppConversation, t: string) => { posts.push(t); },
    } as unknown as MobileSlackBridge;
    const conv = { id: -1, key: 'slack:_:C1', channelId: 'C1', threadTs: null, label: null, mintedAt: null };
    await mirrorMediaToSlack(bridge, conv, 'Justin', [att(), att({ index: 1, sha256: 'c'.repeat(64), filename: 'gone.pdf' })], 'see',
      (sha) => (sha === 'b'.repeat(64) ? '/blob' : null), 'browser');
    expect(uploads[0]!.initialComment).toBe('💻 Justin (from the dashboard): see');
    expect(posts).toEqual(['💻 Justin sent gone.pdf (open it in the dashboard)']);
  });
  it('session tag: phone unchanged, browser 💻 signed, only when verified', () => {
    expect(appInjectionTag(-9, 'T', 'Justin', 'verified')).toBe('[app:-9 "T" from Justin (📱 signed)]');
    expect(appInjectionTag(-9, 'T', 'Justin', 'verified', 'browser')).toBe('[app:-9 "T" from Justin (💻 signed)]');
    expect(appInjectionTag(-9, 'T', 'Justin', 'unknown', 'browser')).toBe('[app:-9 "T" from Justin]');
  });
});

// ── Agent awareness + migration parity (§4.7: CapabilityIndex / PostUpdateMigrator) ─────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Agent Awareness + Migration Parity: the dashboard conversations (browser device) line', () => {
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const run = async (projectDir: string) => {
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(result);
    return result;
  };
  it('new agents get it once, right after the native session screen line, and it explains 💻', async () => {
    const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
    const { APP_CONVERSATIONS_NATIVE_SESSION_LINE, DASHBOARD_CONVERSATIONS_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md.split(DASHBOARD_CONVERSATIONS_LINE).length - 1).toBe(1);
    const lines = md.split('\n');
    expect(lines[lines.indexOf(APP_CONVERSATIONS_NATIVE_SESSION_LINE) + 1]).toBe(DASHBOARD_CONVERSATIONS_LINE);
    expect(DASHBOARD_CONVERSATIONS_LINE).toContain('💻');
    expect(DASHBOARD_CONVERSATIONS_LINE).toContain('approved browser key of the owner signed it in the dashboard');
  });
  it('existing agents get it in place, once (idempotent)', async () => {
    const { APP_CONVERSATIONS_CLAUDEMD_SECTION, APP_CONVERSATIONS_NATIVE_SESSION_LINE, DASHBOARD_CONVERSATIONS_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dash-conv-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const md = path.join(dir, 'CLAUDE.md');
      const old = APP_CONVERSATIONS_CLAUDEMD_SECTION(4321).replace(`${DASHBOARD_CONVERSATIONS_LINE}\n`, '');
      expect(old).not.toContain(DASHBOARD_CONVERSATIONS_LINE);
      fs.writeFileSync(md, `# CLAUDE.md\n${old}`);
      expect((await run(dir)).upgraded).toContain('CLAUDE.md: added the dashboard conversations (browser device) line');
      const lines = fs.readFileSync(md, 'utf-8').split('\n');
      expect(lines[lines.indexOf(APP_CONVERSATIONS_NATIVE_SESSION_LINE) + 1]).toBe(DASHBOARD_CONVERSATIONS_LINE);
      expect((await run(dir)).upgraded).not.toContain('CLAUDE.md: added the dashboard conversations (browser device) line');
      expect(fs.readFileSync(md, 'utf-8').split(DASHBOARD_CONVERSATIONS_LINE).length - 1).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/device-client-wording.test.ts' });
    }
  });
  it('the capability index names the browser routes and 💻', async () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/CapabilityIndex.ts'), 'utf8');
    expect(src).toContain('POST /mobile/browser-devices');
    expect(src).toContain('GET /mobile/browser-devices/status');
    expect(src).toContain('💻 marks a message an approved browser key of the owner signed in the dashboard');
  });
});
