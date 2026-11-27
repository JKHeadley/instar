/**
 * Migration Parity for fb-829a7161-942: existing agents' CLAUDE.md carried
 * token-less `curl http://localhost:<port>/threadline/peers/health` examples
 * from an earlier template. Those routes are bearer-gated now, so the migrator
 * rewrites the exact bare forms to carry the bearer — once, idempotently, and
 * without touching anything else.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'threadline-bearer-curls-test.cleanup' }); });

function project(md: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bearer-curls-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), md);
  return dir;
}
function migrate(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}
const BARE = '`curl http://localhost:4042/threadline/peers/health`';
const AUTHED = '`curl -H "Authorization: Bearer $AUTH" http://localhost:4042/threadline/peers/health`';
const OLD_SECTION = `### Is my channel to a peer alive? (A2A delivery health)

- All peers: ${BARE} → { peers: [] }
- One peer: \`curl http://localhost:4042/threadline/peers/<fingerprint>/health\`

### What \`relayStatus\` means (honest delivery)

Peer health (${BARE}) now counts failedCount.
`;

describe('migrateClaudeMd — threadline delivery-health curls carry the bearer', () => {
  it('rewrites every bare curl an older template emitted, and nothing else', () => {
    const dir = project('# Agent\n' + OLD_SECTION + '\nUnrelated: `curl http://localhost:4042/health`\n');
    const r = migrate(dir);
    const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(r.upgraded).toContain('CLAUDE.md: A2A delivery-health curls now carry the bearer (threadline routes are bearer-gated)');
    expect(md).not.toContain(BARE);
    expect(md).not.toContain('`curl http://localhost:4042/threadline/peers/');
    expect(md).toContain(AUTHED);
    expect(md).toContain('`curl -H "Authorization: Bearer $AUTH" http://localhost:4042/threadline/peers/<fingerprint>/health`');
    // The public /health curl is untouched: the rewrite is scoped to /threadline/peers/.
    expect(md).toContain('`curl http://localhost:4042/health`');
  });

  it('is idempotent: a second run changes nothing and reports nothing', () => {
    const dir = project('# Agent\n' + OLD_SECTION);
    migrate(dir);
    const once = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    const r2 = migrate(dir);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(once);
    expect(r2.upgraded.filter(u => u.includes('delivery-health curls'))).toEqual([]);
  });

  it('a fresh template already carries the bearer, so a new agent gets no rewrite', () => {
    const dir = project(generateClaudeMd('test', 'TestAgent', 4042, false));
    const r = migrate(dir);
    expect(r.upgraded.filter(u => u.includes('delivery-health curls'))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).not.toContain('`curl http://localhost:4042/threadline/peers/');
  });
});
