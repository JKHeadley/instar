/**
 * Wiring integrity for skill-driven sign-in repair (spec skill-driven-signin-repair): the
 * production composition in server.ts must hand the REAL implementations to each seam — never
 * leave one null or a no-op. Behavior of each seam is covered by its own unit/integration test;
 * this pins that the composition root actually wires them, plus the template (new agents).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf8');

describe('skill-driven sign-in repair wiring (server.ts composition root)', () => {
  it('the quota poller gets the detailed live Codex read and the canary-proven CLI login check', () => {
    expect(serverSource).toContain('codexLiveUsageReaderDetailed: buildCodexLiveUsageReaderDetailed(config.subscriptionPool)');
    expect(serverSource).toContain('codexLoginStatus: (codexHome) => codexLoginStatusChecker.check(codexHome)');
    expect(serverSource).toContain('new CodexLoginStatusChecker()');
  });

  it('the re-login runtime gets the production helper-session ports, the phone-tap notice and the route context', () => {
    expect(serverSource).toContain('helperSession: buildReloginHelperSessionPorts({ sessionManager');
    expect(serverSource).toMatch(/onPhoneTap: notify \? \(episode, key\) => notify\(episode, key, 'phone-tap'\)/);
    expect(serverSource).toContain('subscriptionReloginRouteContext(subscriptionReloginRuntime)');
    expect(serverSource).toContain("episode.failureClass === 'no-healthy-seat'");
  });

  it('new agents learn about it from the CLAUDE.md template', () => {
    const md = generateClaudeMd('test-agent', 'Test Agent', 4042, false);
    expect(md).toContain('Skill-driven sign-in repair (macOS, dev-gated)');
    expect(md).toContain('POST /subscription-relogin/EPISODE/code');
    expect(md).toContain('loginCheck');
  });
});
