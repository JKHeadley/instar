/**
 * Migration parity for Threadline MCP over local HTTP
 * (docs/specs/threadline-mcp-local-http.md D6): the CLAUDE.md awareness card
 * reaches existing agents (sniff key `Threadline MCP over local HTTP`),
 * idempotently, with the template's wording; the local secret file is covered
 * by every key-material consumer existing agents get on update; the card is
 * mirrored to the Codex/Gemini shadow. (Adapted from the lifeline-secret test:)
 *
 * Original header — Migration parity for the lifeline ingress secret
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
const HEADING = '### Threadline MCP over local HTTP';
const UPGRADED = 'CLAUDE.md: added Threadline MCP over local HTTP section';

describe('PostUpdateMigrator — Threadline MCP over local HTTP', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    const base = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
    projectDir = fs.mkdtempSync(path.join(base, 'instar-tlmcp-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-threadlineMcpHttp.test.ts' }));

  const migrator = () => new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
  const run = () => {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator() as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };
  const section = (s: string) => {
    const i = s.indexOf(HEADING);
    const end = s.indexOf('\n### ', i + 5);
    return s.slice(i, end === -1 ? undefined : end).trim();
  };

  it('adds the card once and is idempotent', () => {
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

  it('the card names the flag, the route, the health field, the Codex name, fallback and outcome-unknown', () => {
    const s = section(generateClaudeMd('test', 'Test', 4040, false));
    for (const needle of ['`threadline.mcpHttp.enabled: true`', '`POST /mcp/threadline`', '`threadline.mcpHttp`', '`threadline_local`',
      '`sessionsOnHttpNeverCalled`', '`fallbacks`', '`stuckOperations`', 'outcome unknown', 'falls back to the helper', '**When to use** (PROACTIVE)']) {
      expect(s).toContain(needle);
    }
  });

  it('the secret file is covered by every key-material consumer existing agents get on update', () => {
    expect(KEY_MATERIAL_GITIGNORE_STATE).toContain('state/local-mcp-secret*');
    expect(KEY_MATERIAL_GITIGNORE_PROJECT).toContain('.instar/state/local-mcp-secret*');
    expect(KEY_MATERIAL_NEVER_SERVED_PREFIXES).toContain('.instar/state/local-mcp-secret');
    expect(KEY_MATERIAL_BACKUP_PREFIXES).toContain('state/local-mcp-secret');
    expect(KEY_MATERIAL_SECRET_PATTERNS).toContain('.instar/state/local-mcp-secret*');
  });

  it('the card is mirrored to a Codex shadow (AGENTS.md)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    run();
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# AGENTS.md\n');
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator() as unknown as { migrateFrameworkShadowCapabilities(r: MigrationResult): void }).migrateFrameworkShadowCapabilities(result);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8')).toContain(HEADING);
  });
});
