/**
 * Skill usage telemetry hook — docs/specs/skill-learning-sentinel.md §2 +
 * frontloaded decisions 18 and 29. The generated bash hook is RUN with a fake
 * PostToolUse payload on stdin and the per-machine JSONL row is read back.
 *
 * Covers: exactly {ts, skill, session_id, session_name, topic_id, machine_id,
 * content_hash}; content_hash = the x-instar-stamp of the rendered SKILL.md;
 * hostile `args`/`tool_output` never reach the file; an invalid skill name →
 * content_hash "unknown" and the hostile name absent; a bad machine id →
 * "unknown"; non-Skill tools write nothing; malformed stdin exits 0; the file
 * is .instar/skill-telemetry/<machine_id>.jsonl, never the legacy flat file.
 */

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const STAMP = 'c0ffee'.repeat(10) + 'abcd';

interface Row {
  ts: string; skill: string; session_id: string; session_name: string; topic_id: string; machine_id: string; content_hash: string;
}

function hookSource(): string {
  const m = new PostUpdateMigrator({ projectDir: '/nonexistent', stateDir: '/nonexistent/.instar', port: 4042, hasTelegram: false, projectName: 't' });
  return m.getHookContent('skill-usage-telemetry');
}

describe('skill-usage-telemetry hook (run for real)', () => {
  let home: string;
  let hookPath: string;

  function run(payload: unknown, env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync('bash', [hookPath], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_PROJECT_DIR: home, ...env },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function rows(machine: string): Row[] {
    const p = path.join(home, '.instar', 'skill-telemetry', `${machine}.jsonl`);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-skill-hook-'));
    hookPath = path.join(home, 'skill-usage-telemetry.sh');
    fs.writeFileSync(hookPath, hookSource(), { mode: 0o755 });
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), `---\nname: alpha\ndescription: a\nx-instar-stamp: ${STAMP}\n---\n# Alpha\n`);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/skill-usage-telemetry-hook.test.ts' });
  });

  it('the hook source has no shell interpolation into JSON and no legacy flat file', () => {
    const src = hookSource();
    expect(src).not.toContain('skill-telemetry.jsonl"');
    expect(src).not.toContain('echo "{');
    expect(src).toContain('skill-telemetry');
    expect(src).not.toContain('"args"');
    expect(src.startsWith('#!/bin/bash')).toBe(true);
  });

  it('writes one row with exactly the seven keys, the stamp as content_hash, into the per-machine file', () => {
    const r = run(
      { tool_name: 'Skill', tool_input: { skill: 'alpha', args: 'ignored' }, tool_output: 'ignored' },
      { INSTAR_SESSION_ID: 'abc-123', INSTAR_SESSION_NAME: 'echo-topic-77', INSTAR_TOPIC_ID: '77', INSTAR_MACHINE_ID: 'mama-pc' },
    );
    expect(r.status).toBe(0);
    const got = rows('mama-pc');
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0])).toEqual(['ts', 'skill', 'session_id', 'session_name', 'topic_id', 'machine_id', 'content_hash']);
    expect(got[0]).toMatchObject({ skill: 'alpha', session_id: 'abc-123', session_name: 'echo-topic-77', topic_id: '77', machine_id: 'mama-pc', content_hash: STAMP });
    expect(got[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(fs.existsSync(path.join(home, '.instar', 'skill-telemetry.jsonl'))).toBe(false);
  });

  it('hostile args and tool_output never reach the file; every row stays parseable JSON', () => {
    const hostile = 'x"},{"injected":1} $(touch /tmp/pwned) `whoami` \n\u0000 \\" ';
    const r = run(
      { tool_name: 'Skill', tool_input: { skill: 'alpha', args: hostile }, tool_output: hostile },
      { INSTAR_MACHINE_ID: 'm1' },
    );
    expect(r.status).toBe(0);
    const raw = fs.readFileSync(path.join(home, '.instar', 'skill-telemetry', 'm1.jsonl'), 'utf-8');
    expect(raw).not.toContain('injected');
    expect(raw).not.toContain('whoami');
    expect(raw).not.toContain('args');
    const got = rows('m1');
    expect(got).toHaveLength(1);
    expect(got[0].skill).toBe('alpha');
    expect(got[0].topic_id).toBe(''); // unset → empty string
  });

  it('an invalid skill name is never written and yields content_hash "unknown"', () => {
    for (const bad of ['../etc', 'Alpha', 'a b', '/abs/path', 'x'.repeat(65), 'alpha\n']) {
      run({ tool_name: 'Skill', tool_input: { skill: bad } }, { INSTAR_MACHINE_ID: 'm2' });
    }
    const raw = fs.readFileSync(path.join(home, '.instar', 'skill-telemetry', 'm2.jsonl'), 'utf-8');
    expect(raw).not.toContain('etc');
    expect(raw).not.toContain('Alpha');
    expect(raw).not.toContain('abs');
    const got = rows('m2');
    expect(got).toHaveLength(6);
    for (const row of got) {
      expect(row.skill).toBe('unknown');
      expect(row.content_hash).toBe('unknown');
    }
  });

  it('a valid skill whose rendering carries no stamp (or does not exist) yields content_hash "unknown"', () => {
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nno stamp\n');
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, { INSTAR_MACHINE_ID: 'm3' });
    run({ tool_name: 'Skill', tool_input: { skill: 'missing-skill' } }, { INSTAR_MACHINE_ID: 'm3' });
    const got = rows('m3');
    expect(got.map(r => [r.skill, r.content_hash])).toEqual([['alpha', 'unknown'], ['missing-skill', 'unknown']]);
  });

  it('a bad or unset machine id with no identity file becomes "unknown" and the row lands in unknown.jsonl', () => {
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, { INSTAR_MACHINE_ID: '../escape' });
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, { INSTAR_MACHINE_ID: 'x'.repeat(65) });
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, { INSTAR_MACHINE_ID: 'mama-pc\n' }); // fullmatch: no trailing newline
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, {});
    const got = rows('unknown');
    expect(got).toHaveLength(4);
    for (const row of got) expect(row.machine_id).toBe('unknown');
    expect(fs.readdirSync(path.join(home, '.instar', 'skill-telemetry'))).toEqual(['unknown.jsonl']);
  });

  it('with the env var unset, machine_id comes from .instar/machine/identity.json; a bad file falls back to unknown', () => {
    const identity = path.join(home, '.instar', 'machine', 'identity.json');
    fs.mkdirSync(path.dirname(identity), { recursive: true });
    fs.writeFileSync(identity, JSON.stringify({ machineId: 'm_e8c9b243c449b1337713bc29d47a6f3a', name: 'Mama PC' }));
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, {});
    expect(rows('m_e8c9b243c449b1337713bc29d47a6f3a').map(r => r.machine_id)).toEqual(['m_e8c9b243c449b1337713bc29d47a6f3a']);
    // The env var, when valid, wins over the file.
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, { INSTAR_MACHINE_ID: 'studio' });
    expect(rows('studio')).toHaveLength(1);
    expect(rows('m_e8c9b243c449b1337713bc29d47a6f3a')).toHaveLength(1);
    // An invalid machineId in the file, or an unparseable file → unknown.
    fs.writeFileSync(identity, JSON.stringify({ machineId: '../escape' }));
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, {});
    fs.writeFileSync(identity, 'not json');
    run({ tool_name: 'Skill', tool_input: { skill: 'alpha' } }, {});
    expect(rows('unknown').map(r => r.machine_id)).toEqual(['unknown', 'unknown']);
  });

  it('exits 0 and writes nothing for a non-Skill tool or malformed stdin', () => {
    expect(run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { INSTAR_MACHINE_ID: 'm4' }).status).toBe(0);
    expect(run('this is not json', { INSTAR_MACHINE_ID: 'm4' }).status).toBe(0);
    expect(run('', { INSTAR_MACHINE_ID: 'm4' }).status).toBe(0);
    expect(fs.existsSync(path.join(home, '.instar', 'skill-telemetry'))).toBe(false);
  });
});
