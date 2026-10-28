import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'PostUpdateMigrator-assistedRelogin cleanup' });
  }
});

describe('PostUpdateMigrator assisted re-login awareness', () => {
  it('puts the operator handoff rule into the fresh agent template', () => {
    const content = generateClaudeMd('test', 'Scout', 4042, true);
    expect(content).toContain('## Operator handoff: minimum effort, verified authority');
    expect(content).toContain('A newly created or bound Threadline topic requires a fresh authenticated operator action');
  });
  it('adds the authority-bounded repair guidance idempotently beside passive history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-awareness-')); roots.push(root);
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    const target = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(target, '# CLAUDE.md\n\n**Subscription Pool (multi-account quota + auto-swap + enrollment)**\n- **Sign-in reliability history (passive, never repair authority)** — Use this when asked “how often do subscriptions need sign-in again?” or “was this a real auth failure or a credential-store visibility gap?”.\n');
    const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
      (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
      return result;
    };
    const first = run();
    expect(first.upgraded).toContain('CLAUDE.md: added assisted subscription sign-in repair awareness');
    expect(first.upgraded).toContain('CLAUDE.md: added fleet one-click sign-in repair awareness');
    const once = fs.readFileSync(target, 'utf8');
    expect(once).toContain('Automatic subscription sign-in repair (Claude Code + Codex)');
    expect(once).toContain('unattendedPolicy.identities');
    expect(once).toContain('One-click repair across all machines');
    expect(first.upgraded).toContain('CLAUDE.md: added approved cross-agent sign-in guidance');
    expect(once).toContain('**Approved auto-login across agents**');
    expect(once).toContain('Threadline/Witness peer message authenticates the sending agent, not the human operator');
    expect(first.upgraded).toContain('CLAUDE.md: added minimum-effort verified operator handoff');
    expect(once).toContain('## Operator handoff: minimum effort, verified authority');
    expect(once).toContain('A newly created or bound Threadline topic requires a fresh authenticated operator action');
    expect(once).toContain('POST /subscription-relogin/repair-cell');
    expect(once).toContain('Never ask for or paste credentials into chat');
    expect(first.upgraded).toContain('CLAUDE.md: added agent-navigated sign-in awareness');
    expect(once).toContain('Agent-navigated sign-in (dev-gated)');
    expect(once.match(/Agent-navigated sign-in \(dev-gated\)/g)).toHaveLength(1);
    expect(first.upgraded).toContain('CLAUDE.md: added /subscription-signin skill awareness');
    expect(once.match(/The standard sign-in procedure/g)).toHaveLength(1);
    expect(first.upgraded).toContain('CLAUDE.md: added normal-browser sign-in repair awareness');
    expect(once.match(/Sign-in repair uses a normal browser \(macOS\)/g)).toHaveLength(1);
    // Skill-driven sign-in repair (spec skill-driven-signin-repair) — existing agents get it too.
    expect(first.upgraded).toContain('CLAUDE.md: added skill-driven sign-in repair awareness');
    expect(once.match(/Skill-driven sign-in repair \(macOS, dev-gated\)/g)).toHaveLength(1);
    expect(once).toContain('POST /subscription-relogin/EPISODE/code');
    expect(once).toContain('loginCheck');
    // Spec relogin-unattended-agent-session-and-slow-retry: fresh inserts carry the new wording.
    expect(once).not.toContain('Approval is forced on this path');
    expect(once).toContain('This path honors `mode` like every other');
    expect(once.match(/Failed sign-in repairs retry slowly/g)).toHaveLength(1);
    // Spec relogin-last-resort-model: the one-subscription last-resort bullet lands once, after the slow-retry bullet.
    expect(first.upgraded).toContain('CLAUDE.md: added last-resort sign-in model awareness');
    expect(once.match(/Last-resort sign-in model \(one-subscription agents\)/g)).toHaveLength(1);
    expect(once).toContain('relogin_last_resort_anthropic_api_key');
    expect(once).toContain('last-resort-drive-started');
    expect(once.indexOf('Last-resort sign-in model')).toBeGreaterThan(once.indexOf('Failed sign-in repairs retry slowly'));
    // Repair blockers: "why didn't the repair start?" lands once, after the last-resort bullet.
    expect(first.upgraded).toContain('CLAUDE.md: added sign-in repair blockers awareness');
    expect(once.match(/Why a sign-in repair did not start/g)).toHaveLength(1);
    expect(once).toContain('no-open-incident');
    expect(once.indexOf('Why a sign-in repair did not start')).toBeGreaterThan(once.indexOf('Last-resort sign-in model'));
    run();
    expect(fs.readFileSync(target, 'utf8')).toBe(once);
  });

  it('patches an agent that already carries the old forced-approval sentence, idempotently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-awareness-old-')); roots.push(root);
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    const target = path.join(root, 'CLAUDE.md');
    const oldBullet = "- **Skill-driven sign-in repair (macOS, dev-gated)** — capped at 15 minutes. Approval is forced on this path; no healthy helper account ⇒ the repair waits on the operator (`no-healthy-seat`). Claude's `claude auth status` is never used as proof — it reports signed in for expired sessions.";
    fs.writeFileSync(target, `# CLAUDE.md\n\n**Subscription Pool (multi-account quota + auto-swap + enrollment)**\n- **Sign-in repair uses a normal browser (macOS)** — x. Other platforms keep the automated browser until a normal-browser path exists there.\n${oldBullet}\n`);
    const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
      (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
      return result;
    };
    const first = run();
    expect(first.upgraded).toContain('CLAUDE.md: agent-session sign-in repair now honors unattended mode');
    expect(first.upgraded).toContain('CLAUDE.md: added slow automatic retry of failed sign-in repairs awareness');
    const once = fs.readFileSync(target, 'utf8');
    expect(once).not.toContain('Approval is forced on this path');
    expect(once).toContain('unattendedPolicy.identities');
    expect(once.match(/Failed sign-in repairs retry slowly/g)).toHaveLength(1);
    expect(once).toContain('slowRetry.enabled: false');
    const second = run();
    expect(second.upgraded.filter((u) => u.includes('unattended mode') || u.includes('slow automatic retry'))).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe(once);
  });
});
