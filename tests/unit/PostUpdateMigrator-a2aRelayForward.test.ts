/**
 * Migration parity for the A2A cross-machine route
 * (docs/specs/a2a-cross-machine-route.md): the CLAUDE.md awareness section
 * reaches existing agents (sniff key `A2A relay forward`), idempotently; the
 * template carries the same section for new agents; ConfigDefaults adds
 * nothing (enabled omitted on purpose) and the dev gate decides via a
 * DEV_GATED_FEATURES entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { resolveRelayForwardEnabled } from '../../src/threadline/relayForward.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — A2A relay forward', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-forward-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-a2aRelayForward.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the section once and is idempotent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added A2A relay forward section');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('### A2A relay forward');
    expect(after).toContain("`deliveryPath: 'forwarded'` and `forwardedTo` say so");
    expect(after).toContain('`unconfirmed` means unknown: I do not resend');
    const r2 = run();
    expect(r2.upgraded).not.toContain('CLAUDE.md: added A2A relay forward section');
    expect(fs.readFileSync(claudeMdPath, 'utf-8').split('### A2A relay forward').length - 1).toBe(1);
  });

  it('the template carries the same section for new agents, with the proactive trigger', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('### A2A relay forward');
    expect(md).toContain('my sends go out through that machine');
    expect(md).toContain('**When to use** (PROACTIVE): a user asks which machine carried a message, or where a reply went');
    expect(md).toContain('`forwardedTo`, `replyArrivesIn` and `GET /threadline/peers/health?scope=pool`');
  });

  it('the migrated text equals the template text (one source of wording)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    run();
    const section = (s: string) => {
      const i = s.indexOf('### A2A relay forward');
      const end = s.indexOf('\n### ', i + 5);
      return s.slice(i, end === -1 ? undefined : end).trim();
    };
    expect(section(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(section(generateClaudeMd('test', 'Test', 4040, false)));
  });

  it('no config default is added; the dev gate decides (live on dev, dark on fleet)', () => {
    const d = getMigrationDefaults('standalone') as { threadline?: Record<string, unknown> };
    expect(d.threadline?.relayForward).toBeUndefined();
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'threadline.relayForward.enabled')).toHaveLength(1);
    const dev: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const fleet: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    expect(resolveRelayForwardEnabled(undefined, dev as never)).toBe(true);
    expect(resolveRelayForwardEnabled(undefined, fleet as never)).toBe(false);
  });
});
