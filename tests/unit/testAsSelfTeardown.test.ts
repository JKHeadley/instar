/**
 * ACT-064 — test-as-self harness: cwd-independent verifier resolution and a
 * teardown that reaps everything the throwaway started (tunnel, sessions).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveVerifierPath,
  selectTargetPids,
  selectTargetTmuxSessions,
} from '../../src/commands/test-as-self.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REL = path.join('.claude', 'skills', 'test-as-self', 'scripts', 'verify.mjs');

describe('resolveVerifierPath (step 6 is cwd-independent)', () => {
  it('resolves from the module location (dist/commands → package root), not from cwd', () => {
    const moduleDir = path.join(REPO, 'dist', 'commands');
    const got = resolveVerifierPath(moduleDir, '/nonexistent-canonical-home');
    expect(got).toBe(path.join(REPO, REL));
    expect(fs.existsSync(got)).toBe(true);
  });

  it('falls back to the canonical home when the package does not carry the skill', () => {
    const canonical = '/agents/canon';
    const got = resolveVerifierPath('/pkg/dist/commands', canonical, (p) => p === path.join(canonical, REL));
    expect(got).toBe(path.join(canonical, REL));
  });

  it('throws a named error when neither location has the verifier', () => {
    expect(() => resolveVerifierPath('/pkg/dist/commands', '/canon', () => false)).toThrow(/verify\.mjs not found/);
  });
});

describe('selectTargetPids (tunnel + leftovers naming the throwaway home)', () => {
  const target = '/Users/u/.instar/test-deploys/2026-10-09T13-00-00-000Z';
  // pid ppid command
  const ps = [
    `  101   1 /Users/u/.instar/test-deploys/2026-10-09T13-00-00-000Z/.instar/shadow-install/node_modules/cloudflared/bin/cloudflared tunnel --url http://127.0.0.1:4041 --config ${target}/.instar/cloudflared-quick.yml`,
    `  102 105 /usr/local/bin/node /x/dist/cli.js server start --foreground --dir ${target}`,
    `  103   1 /usr/local/bin/node /x/dist/cli.js server start --foreground --dir ${target}-other`,
    `  104   1 /Users/u/.instar/agents/echo/.instar/shadow-install/node_modules/cloudflared/bin/cloudflared tunnel run --token abc`,
    `  105 106 node /x/dist/cli.js test-as-self --target ${target}`,
    `  106 107 /bin/zsh -c instar test-as-self --target ${target}`,
    `  107   1 python3 run-detached.py node cli.js test-as-self --target ${target}`,
    `    1   0 /sbin/launchd`,
  ].join('\n');

  it('selects the throwaway quick tunnel and server, never a sibling path or another agent', () => {
    expect(selectTargetPids(ps, target, 105)).toEqual([101, 102]);
  });

  it('never selects the harness or any of its ancestors (the launching shell names the target too)', () => {
    const got = selectTargetPids(ps, target, 105);
    for (const pid of [105, 106, 107]) expect(got).not.toContain(pid);
  });

  it('an unrelated process naming the target IS selected when it is not an ancestor', () => {
    expect(selectTargetPids(ps, target, 999)).toEqual([101, 102, 105, 106, 107]);
  });
});

describe('selectTargetTmuxSessions (dispatch/job sessions)', () => {
  it('selects only sessions prefixed by the throwaway basename', () => {
    const target = '/Users/u/.instar/test-deploys/2026-10-09T13-00-00-000Z';
    const sessions = [
      '2026-10-09T13-00-00-000Z-dispatch-abc',
      '2026-10-09T13-00-00-000Z-server',
      'echo-server',
      '2026-10-09T13-00-00-000Zz-other',
    ];
    expect(selectTargetTmuxSessions(sessions, target)).toEqual([
      '2026-10-09T13-00-00-000Z-dispatch-abc',
      '2026-10-09T13-00-00-000Z-server',
    ]);
  });
});
