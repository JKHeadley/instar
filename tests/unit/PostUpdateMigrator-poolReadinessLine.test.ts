import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, POOL_MOVE_NUDGE_CLAUDE_MD_LINE, POOL_READINESS_CLAUDE_MD_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type R = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — pool readiness line', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-poolReadinessLine.test.ts' }); });
  const run = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-readiness-line-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const p = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(p, body);
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'x' } as never);
    const once = (): void => (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    once(); once();
    return fs.readFileSync(p, 'utf8');
  };

  it('adds the line once to an agent with the pool section', () => {
    const out = run('# Agent\n\n**Multi-Machine Session Pool (active-active — spread conversations)**\n');
    expect(out.split('**Pool readiness:**').length).toBe(2);
    expect(out).toContain(POOL_READINESS_CLAUDE_MD_LINE);
  });

  it('an older copy of the line gets the current text, once', () => {
    const out = run('# Agent\n\n- **Pool readiness:** an older sentence.\nNext line\n');
    expect(out.split('**Pool readiness:**').length).toBe(2);
    expect(out).toContain(POOL_READINESS_CLAUDE_MD_LINE);
    expect(out).toContain('Next line');
  });

  it('adds the move nudge line once', () => {
    const out = run('# Agent\n\n**Multi-Machine Session Pool (active-active — spread conversations)**\n');
    expect(out.split('**Why a message waited after a move:**').length).toBe(2);
  });

  it('the template carries the same line, so new and updated agents agree', () => {
    const md = generateClaudeMd('p', 'a', 4042, false);
    expect(md).toContain(POOL_READINESS_CLAUDE_MD_LINE);
    expect(md).toContain(POOL_MOVE_NUDGE_CLAUDE_MD_LINE);
  });
});
