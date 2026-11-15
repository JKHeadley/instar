/**
 * docs/specs/mobile-pairing-outcome-notice.md §3.6 — Agent Awareness + Migration Parity: the
 * outcome bullet and the topicId Mint splice reach new agents (template) and existing agents
 * (migrateClaudeMd), each by its own idempotent patch.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PostUpdateMigrator, MOBILE_PAIRING_CLAUDEMD_SECTION, PAIRING_OUTCOME_BULLET, PAIRING_MINT_BODY_OLD, PAIRING_MINT_BODY_NEW,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-pairingOutcomeBullet.test.ts' }); });

function migrate(dir: string) {
  const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4321, hasTelegram: true, projectName: 'x' } as never);
  const r = { upgraded: [] as string[], errors: [] as string[], skipped: [] as string[] };
  (m as unknown as { migrateClaudeMd(r: unknown): void }).migrateClaudeMd(r);
  return r;
}

function agentWith(section: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-outcome-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Agent\n\nMy own notes stay.\n${section}`);
  return dir;
}

/** The section as shipped before this change: today's template minus the two new pieces. */
function previousSection(port = 4321): string {
  return MOBILE_PAIRING_CLAUDEMD_SECTION(port).replace(`${PAIRING_OUTCOME_BULLET}\n`, '').replace(PAIRING_MINT_BODY_NEW, PAIRING_MINT_BODY_OLD);
}

describe('pairing outcome awareness', () => {
  it('the template carries the bullet once and the spliced Mint body', () => {
    const s = MOBILE_PAIRING_CLAUDEMD_SECTION(4321);
    expect(s.split(PAIRING_OUTCOME_BULLET).length - 1).toBe(1);
    expect(s).toContain(PAIRING_MINT_BODY_NEW);
    expect(s).not.toContain(PAIRING_MINT_BODY_OLD);
    expect(PAIRING_OUTCOME_BULLET).toContain('GET /mobile/devices?scope=pool');
    expect(PAIRING_OUTCOME_BULLET).toContain('is not a failed pairing');
  });

  it('the spliced curl body expands INSTAR_TOPIC_ID in a shell, and is empty when unset', () => {
    const body = PAIRING_MINT_BODY_NEW.replace(/^-d /, '');
    const out = (env: Record<string, string>) => execFileSync('/bin/sh', ['-c', `printf %s ${body}`], { env: { PATH: process.env.PATH ?? '', ...env } }).toString();
    expect(JSON.parse(out({ INSTAR_TOPIC_ID: '143125' }))).toEqual({ label: 'Justin iPhone', topicId: '143125' });
    expect(JSON.parse(out({}))).toEqual({ label: 'Justin iPhone', topicId: '' });
  });

  it('an existing agent gets both pieces once, and its own notes are kept', () => {
    const dir = agentWith(previousSection());
    const first = migrate(dir);
    expect(first.upgraded).toContain('CLAUDE.md: Mobile pairing link section says the pairing outcome is the device list');
    expect(first.upgraded).toContain('CLAUDE.md: Mobile pairing link Mint example passes the conversation topicId');
    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain('My own notes stay.');
    expect(after.split(PAIRING_OUTCOME_BULLET).length - 1).toBe(1);
    expect(after.indexOf(PAIRING_OUTCOME_BULLET)).toBeLessThan(after.indexOf('\n- Revoke one phone'));
    expect(after).toContain(PAIRING_MINT_BODY_NEW);
    const second = migrate(dir);
    expect(second.upgraded.filter((u) => u.includes('outcome') || u.includes('topicId'))).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(after);
  });

  it('the Mint patch is port-independent and applies without the bullet patch', () => {
    const dir = agentWith(previousSection(9999).replace('\n- Revoke one phone', '\n- Revoke (hand-edited)'));
    const r = migrate(dir);
    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain(PAIRING_MINT_BODY_NEW);
    expect(after).toContain('http://localhost:9999/mobile/pairing-codes');
    // A hand-edited section without the neighbour line is left without the bullet.
    expect(after).not.toContain(PAIRING_OUTCOME_BULLET);
    expect(r.upgraded).not.toContain('CLAUDE.md: Mobile pairing link section says the pairing outcome is the device list');
  });

  it('a reworded bullet (same marker) is not inserted twice', () => {
    const dir = agentWith(previousSection().replace('\n- Revoke one phone', '\n- **The pairing outcome is the device list.** An older wording.\n- Revoke one phone'));
    migrate(dir);
    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(after.split('**The pairing outcome is the device list').length - 1).toBe(1);
  });

  it('a hand-edited Mint body is left alone', () => {
    const dir = agentWith(previousSection().replace(PAIRING_MINT_BODY_OLD, `-d '{"label":"My phone"}'`));
    migrate(dir);
    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain(`-d '{"label":"My phone"}'`);
    expect(after).not.toContain(PAIRING_MINT_BODY_NEW);
  });
});
