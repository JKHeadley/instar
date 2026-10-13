/**
 * Migration parity for the lifeline ingress secret
 * (docs/specs/telegram-internal-route-lifeline-secret.md): the CLAUDE.md
 * awareness section reaches existing agents (sniff key `Telegram internal
 * routes need the lifeline secret`), idempotently, with the same wording the
 * template gives new agents — including the observe exit rule and the honest
 * cooperative-boundary limit. The secret file is gitignored for existing
 * agents through the shared key-material list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  KEY_MATERIAL_GITIGNORE_STATE,
  KEY_MATERIAL_GITIGNORE_PROJECT,
  KEY_MATERIAL_NEVER_SERVED_PREFIXES,
  KEY_MATERIAL_BACKUP_PREFIXES,
  KEY_MATERIAL_SECRET_PATTERNS,
} from '../../src/core/keyMaterialPaths.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const HEADING = '### Telegram internal routes need the lifeline secret';
const UPGRADED = 'CLAUDE.md: added Telegram internal routes need the lifeline secret section';

describe('PostUpdateMigrator — lifeline ingress secret', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lifeline-secret-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-lifelineIngressSecret.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };
  const section = (s: string) => {
    const i = s.indexOf(HEADING);
    const end = s.indexOf('\n### ', i + 5);
    return s.slice(i, end === -1 ? undefined : end).trim();
  };

  it('adds the section once and is idempotent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    expect(run().upgraded).toContain(UPGRADED);
    expect(run().upgraded).not.toContain(UPGRADED);
    expect(fs.readFileSync(claudeMdPath, 'utf-8').split(HEADING).length - 1).toBe(1);
  });

  it('the template carries the same wording as the migration', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain(HEADING);
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    run();
    expect(section(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(section(md));
  });

  it('the section states the modes, the exit rule, the rollback, the trigger and the honest limit', () => {
    const s = section(generateClaudeMd('test', 'Test', 4040, false));
    expect(s).toContain('`X-Instar-Lifeline-Secret`');
    expect(s).toContain("`{ error: 'lifeline-secret-required', refused: true }`");
    expect(s).toContain('never placed in any process environment');
    expect(s).toContain('`POST /internal/lifeline-proof`');
    expect(s).toContain('No message is refused until the guard is armed');
    expect(s).toContain('(`refusing`) and taps (`refusingTaps`)');
    expect(s).toContain('later than `armedAt`');
    expect(s).toContain('a button tap without the secret is always refused');
    expect(s).toContain('binds no operator and carries no command authority');
    expect(s).toContain('after 24 hours with zero would-refuse and at least 10 verified Telegram requests from the lifeline, or 7 days after the guard armed, whichever comes first');
    expect(s).toContain('survive a restart');
    expect(s).toContain('`telegramIngress.lifelineSecret.enforce: false` holds observe');
    expect(s).toContain('`telegramIngress.lifelineSecret.bypass: true` is the full rollback');
    expect(s).toContain('cooperative boundary');
    expect(s).toContain('does not stop a session that deliberately reads the file');
    expect(s).toContain('**When to use** (PROACTIVE)');
  });

  it('the secret file is covered by every key-material consumer existing agents get on update', () => {
    expect(KEY_MATERIAL_GITIGNORE_STATE).toContain('state/lifeline-ingress-secret*');
    expect(KEY_MATERIAL_GITIGNORE_PROJECT).toContain('.instar/state/lifeline-ingress-secret*');
    expect(KEY_MATERIAL_NEVER_SERVED_PREFIXES).toContain('.instar/state/lifeline-ingress-secret');
    expect(KEY_MATERIAL_BACKUP_PREFIXES).toContain('state/lifeline-ingress-secret');
    expect(KEY_MATERIAL_SECRET_PATTERNS).toContain('.instar/state/lifeline-ingress-secret*');
  });
});
