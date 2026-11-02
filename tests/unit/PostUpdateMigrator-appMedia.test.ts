/**
 * Migration parity for media in app conversations (docs/specs/mobile-native-chat-media.md):
 * the `### App conversation media` section is added to an existing CLAUDE.md by its exact heading
 * (not the app-conversation section's sniff), once; the reply relay with --file and the
 * app-media-path helper are installed, and the previously shipped app-reply.sh is listed as replaceable.
 * Also the replay guard's reserve for send routes (§4.10).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, APP_MEDIA_CLAUDEMD_MARKER, APP_MEDIA_CLAUDEMD_SECTION, APP_CONVERSATIONS_CLAUDEMD_SECTION, APP_MEDIA_STALE_COPY_LINE, APP_MEDIA_CURRENT_COPY_LINE, APP_MEDIA_STALE_VOICE_LINE, APP_MEDIA_CURRENT_VOICE_LINE } from '../../src/core/PostUpdateMigrator.js';
import { ensureAppReplyRelay, packagedAppReplyRelayTemplate, PRIOR_SHIPPED_APP_RELAY_SHA256 } from '../../src/core/AppReplyRelayInstaller.js';
import { ReplayGuard, MAX_REPLAY_PER_DEVICE, REPLAY_SEND_RESERVE } from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const ADDED = 'CLAUDE.md: added App conversation media section';

describe('PostUpdateMigrator — app conversation media', () => {
  let projectDir: string;
  let stateDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-app-media-mig-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-appMedia.test.ts' }));

  const migrator = () => new PostUpdateMigrator({ projectDir, stateDir, port: 4321, hasTelegram: false, projectName: 'test' });

  it('new agents get the section from the template', () => {
    expect(generateClaudeMd('test', 'Test', 4040, false)).toContain(APP_MEDIA_CLAUDEMD_MARKER);
  });

  it('adds the section to an agent that already has the app conversation section, once', () => {
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, `# CLAUDE.md\n${APP_CONVERSATIONS_CLAUDEMD_SECTION(4321)}`);
    const run = () => { const r: MigrationResult = { upgraded: [], skipped: [], errors: [] }; (migrator() as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r); return r; };
    expect(run().upgraded).toContain(ADDED);
    const after = fs.readFileSync(file, 'utf-8');
    expect(after.split(APP_MEDIA_CLAUDEMD_MARKER).length - 1).toBe(1);
    expect(after).toContain('app-reply.sh --file');
    expect(run().upgraded).not.toContain(ADDED);
    expect(APP_MEDIA_CLAUDEMD_SECTION()).toContain('app-media-path');
  });

  it('the section describes copies between machines, and an installed section with the old line is refreshed once', () => {
    expect(APP_MEDIA_CLAUDEMD_SECTION()).toContain(APP_MEDIA_CURRENT_COPY_LINE);
    expect(APP_MEDIA_CLAUDEMD_SECTION()).not.toContain(APP_MEDIA_STALE_COPY_LINE);
    const file = path.join(projectDir, 'CLAUDE.md');
    const installed = APP_MEDIA_CLAUDEMD_SECTION().replace(APP_MEDIA_CURRENT_COPY_LINE, APP_MEDIA_STALE_COPY_LINE);
    fs.writeFileSync(file, `# CLAUDE.md\n${APP_CONVERSATIONS_CLAUDEMD_SECTION(4321)}${installed}`);
    const run = () => { const r: MigrationResult = { upgraded: [], skipped: [], errors: [] }; (migrator() as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r); return r; };
    expect(run().upgraded).toContain('CLAUDE.md: updated the App conversation media copy line');
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toContain(APP_MEDIA_CURRENT_COPY_LINE);
    expect(after).not.toContain(APP_MEDIA_STALE_COPY_LINE);
    expect(run().upgraded).not.toContain('CLAUDE.md: updated the App conversation media copy line');
  });

  it('the section describes server voice transcription, and an installed section with the old voice form is refreshed once', () => {
    const section = APP_MEDIA_CLAUDEMD_SECTION();
    expect(section).toContain(APP_MEDIA_CURRENT_VOICE_LINE);
    expect(section).toContain('transcription unavailable');
    const stale = section.replace(APP_MEDIA_CURRENT_VOICE_LINE, APP_MEDIA_STALE_VOICE_LINE);
    expect(stale).not.toContain('transcription unavailable');
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, `# CLAUDE.md\n${APP_CONVERSATIONS_CLAUDEMD_SECTION(4321)}${stale}`);
    const UPDATED = 'CLAUDE.md: updated the App conversation media voice line';
    const run = () => { const r: MigrationResult = { upgraded: [], skipped: [], errors: [] }; (migrator() as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r); return r; };
    expect(run().upgraded).toContain(UPDATED);
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toContain(APP_MEDIA_CURRENT_VOICE_LINE);
    expect(after.split(APP_MEDIA_CLAUDEMD_MARKER).length - 1).toBe(1);
    expect(run().upgraded).not.toContain(UPDATED);
  });

  it('installs the helper beside the relay, and the previously shipped relay is on the replaceable list', () => {
    const template = packagedAppReplyRelayTemplate()!;
    expect(template).toContain('--file');
    const priorPath = path.join(stateDir, 'scripts', 'app-reply.sh');
    // The increment-1 relay's hash: an installed copy with these bytes is replaced on update.
    const prior = [...PRIOR_SHIPPED_APP_RELAY_SHA256][0]!;
    expect(prior).toBe('a2070b6941b1eb59111fa44345c5dbaf25ed08bbeaae4f79a22543c9fa8241a0');
    const r = ensureAppReplyRelay({ projectDir, stateDir, template, claudeCompatibility: true });
    expect(r.errors).toEqual([]);
    for (const p of [path.join(stateDir, 'scripts', 'app-media-path'), path.join(projectDir, '.claude', 'scripts', 'app-media-path')]) {
      expect(fs.statSync(p).mode & 0o111).not.toBe(0);
    }
    expect(crypto.createHash('sha256').update(fs.readFileSync(priorPath)).digest('hex')).not.toBe(prior);
  });
});

describe('replay guard reserve', () => {
  it('refuses a non-send request at 1,900 entries while a send is still admitted, and the bound holds', () => {
    const g = new ReplayGuard(() => 1_000);
    for (let i = 0; i < MAX_REPLAY_PER_DEVICE - REPLAY_SEND_RESERVE; i++) expect(g.admit('d', `r${i}`)).toBe('ok');
    expect(g.admit('d', 'read')).toBe('full');
    for (let i = 0; i < REPLAY_SEND_RESERVE; i++) expect(g.admit('d', `s${i}`, true)).toBe('ok');
    expect(g.admit('d', 'send-over', true)).toBe('full');
  });
});
