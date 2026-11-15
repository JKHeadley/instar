/**
 * Agent awareness for voice transcription (docs/specs/backup-on-machine-voice.md): the CLAUDE.md
 * section is in the template, reaches an existing agent once on update, lands in the messaging
 * reference file, and the App conversation media voice line is refreshed from its previous form.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PostUpdateMigrator, VOICE_TRANSCRIPTION_CLAUDEMD_SECTION, APP_MEDIA_CLAUDEMD_SECTION, APP_MEDIA_CURRENT_VOICE_LINE, APP_MEDIA_V2_VOICE_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { splitAwareness } from '../../src/scaffold/claudeMdLayout.js';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';

const MARKER = 'Voice messages and transcription (';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/voice-transcription-awareness.test.ts' }); });

function migrate(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-mig-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content);
  const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4040, hasTelegram: false, projectName: 'p' } as never);
  const run = () => (m as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
  run(); run();
  return fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
}

describe('voice transcription awareness', () => {
  it('is in the template, short, and names the route, the install steps and the off switch', () => {
    const s = VOICE_TRANSCRIPTION_CLAUDEMD_SECTION(4040);
    expect(s).toContain(MARKER);
    expect(s).toContain('http://localhost:4040/voice-transcription');
    expect(s).toContain('brew install whisper-cpp ffmpeg');
    expect(s).toContain('60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe');
    expect(s).toContain('voiceTranscription.local: false');
    expect(s.length).toBeLessThan(2600);
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain(MARKER);
  });

  it('reaches an existing agent exactly once on update', () => {
    expect(migrate('# Agent\n').split(MARKER).length - 1).toBe(1);
  });

  it('lands in the messaging reference file', () => {
    const split = splitAwareness(`# CLAUDE.md — a\n\n## Something\n\ntext\n${VOICE_TRANSCRIPTION_CLAUDEMD_SECTION(4040)}`);
    const owner = [...split.referenceTitles.entries()].find(([, titles]) => titles.some((t) => t.includes('Voice messages and transcription')));
    expect(owner?.[0]).toBe('messaging.md');
  });

  it('refreshes the previous App conversation media voice line in place, once', () => {
    expect(APP_MEDIA_CLAUDEMD_SECTION()).toContain(APP_MEDIA_CURRENT_VOICE_LINE);
    expect(APP_MEDIA_CURRENT_VOICE_LINE).toContain('whisper.cpp on this machine');
    expect(APP_MEDIA_CURRENT_VOICE_LINE).not.toContain('`GROQ_API_KEY` or `OPENAI_API_KEY`');
    const prior = APP_MEDIA_CLAUDEMD_SECTION().replace(APP_MEDIA_CURRENT_VOICE_LINE, APP_MEDIA_V2_VOICE_LINE);
    expect(prior).toContain(APP_MEDIA_V2_VOICE_LINE);
    const after = migrate(`# Agent\n${prior}`);
    expect(after).toContain(APP_MEDIA_CURRENT_VOICE_LINE);
    expect(after).not.toContain(APP_MEDIA_V2_VOICE_LINE);
  });

  it('the catalog row is off gap: the backup is exercised by the e2e drill', () => {
    const row = RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'voice-transcription')!;
    expect(row.backupStatus).toBe('exercised');
    expect(row.drillTest).toBe('tests/e2e/local-voice-transcription-lifecycle.test.ts');
    expect(row.backup).toMatch(/whisper\.cpp/);
  });
});
