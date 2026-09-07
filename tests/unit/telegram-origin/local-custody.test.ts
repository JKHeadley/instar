import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FileClassifier } from '../../../src/core/FileClassifier.js';
import { BackupManager } from '../../../src/core/BackupManager.js';
import { DEFAULT_GITIGNORE } from '../../../src/core/GitStateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { ORIGIN_LOCAL_GITIGNORE } from '../../../src/messaging/telegram-origin/OriginLocalPaths.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir,
  { recursive: true, force: true, operation: 'test:origin-local-custody:cleanup' }); });
const files = ['origin-sessions-host.json', 'origin-sessions-host.json.temporary.tmp', 'origin-notice.sock',
  'state/pending-relay.echo.sqlite', 'state/pending-relay.echo.sqlite-wal',
  'state/telegram-origin-spool/echo/evidence.sqlite', 'state/telegram-origin-archives/echo/retained.sqlite'];
describe('origin custody remains machine local', () => {
  it('excludes every custody file and SQLite companion from sync and fresh state tracking', () => {
    const classifier = new FileClassifier({ projectDir: '/fixture' });
    for (const file of files) expect(classifier.classify(`.instar/${file}`).strategy).toBe('exclude');
    for (const pattern of ORIGIN_LOCAL_GITIGNORE) expect(DEFAULT_GITIGNORE).toContain(pattern);
    expect(classifier.classify('src/feature.ts').strategy).toBe('llm');
  });
  it('does not copy queue authority or session verifiers via an enclosing backup directory', () => {
    const stateDir = temporaryState(); directories.push(stateDir);
    for (const file of [...files, 'state/ordinary.json']) {
      mkdirSync(path.dirname(path.join(stateDir, file)), { recursive: true });
      writeFileSync(path.join(stateDir, file), '{"fixture":true}');
    }
    const backup = new BackupManager(stateDir, { includeFiles: ['origin-sessions-host.json', 'origin-notice.sock', 'state/'] });
    const snapshot = backup.createSnapshot('manual');
    expect(JSON.stringify(snapshot.files)).toContain('ordinary.json');
    for (const file of files) expect(JSON.stringify(snapshot.files)).not.toContain(path.basename(file));
  });
});
