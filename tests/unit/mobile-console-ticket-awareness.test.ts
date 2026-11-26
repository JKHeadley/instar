/**
 * Agent awareness + migration parity for console sign-in from an owner phone
 * (docs/specs/mobile-console-device-signin.md §3.7): new installs and migrated agents carry the
 * same, true opening line; the stale "never receives the API token" line is replaced once.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, MOBILE_PAIRING_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OLD_OPENING = 'The operator can add this agent to the Instar iPhone app with a one-time link instead of typing an address and PIN. The link opens the app (a universal link on instar.sh); the phone registers its own Secure Enclave key, and I send the owner a confirmation code (like `KITE-4172`, or six digits) **privately** in Telegram, which the owner types into the app. Only then is the phone active. The phone never receives the API token and never gets an operator session; it can only make a fixed list of read requests (health, attention, sessions, topics, its own status) plus confirm and revoke itself. Development-agent gated (`mobilePairing.enabled`; 503 when off).';

const migrate = (dir: string) => {
  const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4321, hasTelegram: false, projectName: 'x' } as never);
  const r = { upgraded: [] as string[], errors: [] as string[], skipped: [] as string[] };
  (m as unknown as { migrateClaudeMd(r: unknown): void }).migrateClaudeMd(r);
  return r;
};

describe('console sign-in awareness', () => {
  const fresh = MOBILE_PAIRING_CLAUDEMD_SECTION(4321);
  const freshOpening = fresh.split('\n').find((l) => l.startsWith('The operator can add this agent to the Instar iPhone app'))!;

  it('the template describes the console sign-in and no longer claims the phone never receives the token', () => {
    expect(fresh).not.toContain('never receives the API token');
    expect(freshOpening).toContain('POST /mobile/console-ticket');
    expect(freshOpening).toContain('stores no API token');
    expect(freshOpening).toContain('PIN-confirmed actions still ask for the PIN');
    expect(freshOpening).toContain('mobilePairing.consoleTicket.enabled: false');
  });

  it('an existing agent\'s stale opening line becomes the template line exactly once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mct-aware-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const old = fresh.replace(freshOpening, OLD_OPENING);
      expect(old).toContain('never receives the API token');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Agent\n\nMine.\n${old}`);
      expect(migrate(dir).upgraded).toContain('CLAUDE.md: Mobile pairing link section describes console sign-in from an owner phone');
      const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
      expect(after).toContain('Mine.');
      expect(after).not.toContain('never receives the API token');
      // Migrated text is byte-identical to a new install's section.
      expect(after).toContain(fresh.trim());
      expect(migrate(dir).upgraded.filter((u) => u.includes('console sign-in'))).toHaveLength(0);
      expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(after);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-console-ticket-awareness.test.ts' });
    }
  });
});
