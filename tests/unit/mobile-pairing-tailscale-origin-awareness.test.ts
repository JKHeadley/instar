/**
 * mobile-pairing-tailscale-origin §3.4 — Agent Awareness + Migration Parity: the pairing section
 * says 30 minutes, explains originKind and the Tailscale fallback, and an EXISTING agent's stale
 * two lines are rewritten in place exactly once.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, MOBILE_PAIRING_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { PairingCodeStore, codeTtlMs } from '../../src/core/MobilePairing.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-pairing-tailscale-origin-awareness.test.ts' }); });

const OLD_SECTION = `\n### Mobile pairing link — add this agent to the Instar iPhone app (\`POST /mobile/pairing-codes\`)

The operator can add this agent to the Instar iPhone app with a one-time link.
- Mint: \`curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' http://localhost:4321/mobile/pairing-codes -d '{"label":"Justin iPhone"}'\` → \`{ code, expiresAt, link }\`. Single use, 10 minutes.
- **Send only the \`link\`**.
- \`409 stable-address-required\`: the phone needs a permanent address (a named tunnel with a hostname, running on this machine); offer to set it up. \`409 approval-unavailable\` at redeem: I could not DM the owner; ask them to send the bot any private message first. \`429 pairing-paused\`: ten wrong codes in 24 hours; an attention item explains it.
- **When to use** (PROACTIVE): pair.
`;

function migrate(dir: string) {
  const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4321, hasTelegram: false, projectName: 'x' } as never);
  const r = { upgraded: [] as string[], errors: [] as string[], skipped: [] as string[] };
  (m as unknown as { migrateClaudeMd(r: unknown): void }).migrateClaudeMd(r);
  return r;
}

describe('pairing awareness for Tailscale origin and 30-minute links', () => {
  it('the template section states 30 minutes, originKind and the Tailscale fallback', () => {
    const s = MOBILE_PAIRING_CLAUDEMD_SECTION(4321);
    expect(s).toContain('Single use, 30 minutes');
    expect(s).toContain('originKind');
    expect(s).toContain('Tailscale HTTPS name served by');
    expect(s).not.toContain('Single use, 10 minutes.');
  });

  it('an existing agent gets its two stale lines rewritten once, and the rest of its file kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-aware-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Agent\n\nMy own notes stay.\n${OLD_SECTION}`);
    const first = migrate(dir);
    expect(first.upgraded).toContain('CLAUDE.md: Mobile pairing link section updated for Tailscale origin and 30-minute links');
    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain('My own notes stay.');
    expect(after).toContain('Single use, 30 minutes');
    expect(after).not.toContain('Single use, 10 minutes.');
    expect(after).not.toContain('the phone needs a permanent address (a named tunnel');
    expect(after.split('### Mobile pairing link').length - 1).toBe(1);
    const second = migrate(dir);
    expect(second.upgraded.filter((u) => u.includes('Mobile pairing link'))).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(after);
  });

  it('codes default to 30 minutes and carry the origin they were minted for', () => {
    expect(codeTtlMs(undefined)).toBe(30 * 60_000);
    const store = new PairingCodeStore();
    const m = store.mint(codeTtlMs(undefined), 'phone', 'tok', { host: 'a.ts.net', kind: 'tailscale' });
    expect(m.ok).toBe(true);
    const r = store.redeem(m.ok ? m.code : '', 'tok');
    expect(r).toEqual({ ok: true, label: 'phone', bound: { host: 'a.ts.net', kind: 'tailscale' }, person: null });
  });
});
