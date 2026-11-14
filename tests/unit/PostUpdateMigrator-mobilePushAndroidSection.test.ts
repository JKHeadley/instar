/** Agent Awareness + Migration Parity for Android push (docs/specs/mobile-android-app.md §2.5, §7 Migration). */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, MOBILE_PUSH_CLAUDEMD_SECTION, MOBILE_PUSH_CLAUDEMD_SECTION_V1 } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = 'Mobile push notifications';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-mobilePushAndroidSection.test.ts' }); });

function migrate(initial: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-android-mig-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), initial);
  const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4040, hasTelegram: false, projectName: 'p' } as never);
  const results: Array<{ upgraded: string[]; skipped: string[]; errors: string[] }> = [];
  const run = () => { const r = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: unknown): void }).migrateClaudeMd(r); results.push(r); };
  run(); run();
  return { text: fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8'), results };
}

describe('mobile push section names both providers', () => {
  it('the template carries the two-provider section', () => {
    const s = MOBILE_PUSH_CLAUDEMD_SECTION(4040);
    expect(s).toContain(MARKER);
    for (const w of ['Android', 'fcm_service_account_json', 'fcmConfigured', 'pausedReasons', '/mobile/push/recheck']) expect(s).toContain(w);
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('/mobile/push/recheck');
  });

  it('a marker-less CLAUDE.md with the exact old section gets the new one; running twice leaves exactly one section', () => {
    const { text } = migrate(`# Agent\n${MOBILE_PUSH_CLAUDEMD_SECTION_V1(4040)}`);
    expect(text.split(MARKER).length - 1).toBe(1);
    expect(text).toContain(MOBILE_PUSH_CLAUDEMD_SECTION(4040));
    expect(text).not.toContain('the Instar iPhone app buzzes');
  });

  it('an edited old section is left alone with a REVIEW line', () => {
    const edited = MOBILE_PUSH_CLAUDEMD_SECTION_V1(4040).replace('nothing is dropped', 'nothing is ever dropped (my note)');
    const { text, results } = migrate(`# Agent\n${edited}`);
    expect(text).toContain('nothing is ever dropped (my note)');
    expect(text.split(MARKER).length - 1).toBe(1);
    expect(results[0]!.upgraded.some((u) => u.startsWith('REVIEW:') && u.includes('Mobile push notifications'))).toBe(true);
  });

  it('a file with no section gets the new one once', () => {
    const { text } = migrate('# Agent\n');
    expect(text.split(MARKER).length - 1).toBe(1);
    expect(text).toContain('fcm_service_account_json');
  });
});
