/**
 * Remote Desktop with Face ID and the PIN page (docs/specs/mobile-owner-presence-pin.md): the pure parts.
 * The desktop session store (expiry, two per phone, phone re-check, PIN-change clear), the purpose-bound
 * message bytes, the PIN value rule (never a placeholder or an object), and the switch.
 */
import { describe, it, expect } from 'vitest';
import { PhoneDesktopSessionStore } from '../../src/server/PhoneDesktopSessionStore.js';
import { ownerPresenceMessage, revealablePin, isOwnerPresenceEnabled, DESKTOP_UNLOCK_VERSION, PIN_REVEAL_VERSION } from '../../src/server/mobileOwnerPresenceRoutes.js';
import { presenceMessage, PRESENCE_MESSAGE_VERSION } from '../../src/server/mobileConsoleTicket.js';
import { DASHBOARD_PIN_PLACEHOLDER } from '../../src/core/dashboardPin.js';

describe('PhoneDesktopSessionStore', () => {
  const yes = () => true;

  it('a live session names its phone; an expired one names none', () => {
    let t = 1_000;
    const s = new PhoneDesktopSessionStore(() => t);
    const a = s.issue('dev-a');
    expect(s.verify(a.token, yes)).toBe('dev-a');
    t += 15 * 60_000;
    expect(s.verify(a.token, yes)).toBeNull();
  });

  it('a phone that no longer qualifies ends its session at its next check, and it stays ended', () => {
    const s = new PhoneDesktopSessionStore();
    const a = s.issue('dev-a');
    expect(s.verify(a.token, () => false)).toBeNull();
    expect(s.verify(a.token, yes)).toBeNull();
  });

  it('keeps two sessions per phone, so a re-unlock never ends a running desktop; a third drops the oldest', () => {
    const s = new PhoneDesktopSessionStore();
    const a = s.issue('dev-a'), b = s.issue('dev-a');
    expect([s.verify(a.token, yes), s.verify(b.token, yes)]).toEqual(['dev-a', 'dev-a']);
    const c = s.issue('dev-a');
    expect(s.verify(a.token, yes)).toBeNull();
    expect([s.verify(b.token, yes), s.verify(c.token, yes)]).toEqual(['dev-a', 'dev-a']);
    expect(s.verify(s.issue('dev-b').token, yes)).toBe('dev-b');
  });

  it('the owner check is reused for a second, so a streamed frame never reads the registry each time', () => {
    let t = 1_000;
    let reads = 0;
    let ok = true;
    const s = new PhoneDesktopSessionStore(() => t);
    const a = s.issue('dev-a');
    const check = () => { reads++; return ok; };
    for (let i = 0; i < 30; i++) expect(s.verify(a.token, check)).toBe('dev-a');
    expect(reads).toBe(1);
    ok = false;
    t += 999;
    expect(s.verify(a.token, check)).toBe('dev-a');
    t += 1;
    expect(s.verify(a.token, check)).toBeNull();
  });

  it('a PIN change clears every session', () => {
    const s = new PhoneDesktopSessionStore();
    const a = s.issue('dev-a');
    s.clear();
    expect(s.verify(a.token, yes)).toBeNull();
    expect(s.deviceOf(a.token)).toBeNull();
  });

  it('refuses junk tokens', () => {
    const s = new PhoneDesktopSessionStore();
    s.issue('dev-a');
    for (const t of [undefined, '', 'x'.repeat(300), 42, 'not-a-session']) expect(s.verify(t, yes)).toBeNull();
    expect(s.belongsTo(s.issue('dev-b').token, 'dev-a', yes)).toBe(false);
  });
});

describe('purpose-bound messages', () => {
  it('each purpose signs different bytes, and neither matches the console ticket', () => {
    const d = ownerPresenceMessage(DESKTOP_UNLOCK_VERSION, 'dev', 'Echo.Example.dev', 'c');
    const p = ownerPresenceMessage(PIN_REVEAL_VERSION, 'dev', 'echo.example.dev', 'c');
    expect(d).toBe('instar-desktop-unlock-v1\ndev\necho.example.dev\nc');
    expect(p).toBe('instar-pin-reveal-v1\ndev\necho.example.dev\nc');
    expect(new Set([d, p, presenceMessage('dev', 'echo.example.dev', 'c')]).size).toBe(3);
    expect([DESKTOP_UNLOCK_VERSION, PIN_REVEAL_VERSION]).not.toContain(PRESENCE_MESSAGE_VERSION);
  });
});

describe('revealablePin', () => {
  it('returns exactly the value unlock compares against', () => {
    expect(revealablePin('424242')).toBe('424242');
    expect(revealablePin(' 4242 ')).toBe(' 4242 ');
  });
  it('never a placeholder, an empty value or an unresolved vault reference', () => {
    for (const v of [undefined, null, '', '   ', DASHBOARD_PIN_PLACEHOLDER, ` ${DASHBOARD_PIN_PLACEHOLDER} `, { secret: true }, 424242]) expect(revealablePin(v)).toBeNull();
  });
});

describe('the switch', () => {
  it('omitted: live on a development agent, dark on the fleet; explicit wins', () => {
    expect(isOwnerPresenceEnabled({ developmentAgent: true } as never)).toBe(true);
    expect(isOwnerPresenceEnabled({} as never)).toBe(false);
    expect(isOwnerPresenceEnabled({ developmentAgent: true, mobilePairing: { ownerPresence: { enabled: false } } } as never)).toBe(false);
    expect(isOwnerPresenceEnabled({ mobilePairing: { ownerPresence: { enabled: true } } } as never)).toBe(true);
  });
});

describe('agent awareness (spec §2.7)', () => {
  it('new installs carry the bullet; an existing agent gets it once, before its fixed neighbour', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { PostUpdateMigrator, MOBILE_PAIRING_CLAUDEMD_SECTION, OWNER_PRESENCE_BULLET } = await import('../../src/core/PostUpdateMigrator.js');
    const { SafeFsExecutor } = await import('../../src/core/SafeFsExecutor.js');
    const fresh = MOBILE_PAIRING_CLAUDEMD_SECTION(4321);
    expect(fresh).toContain(OWNER_PRESENCE_BULLET);
    expect(OWNER_PRESENCE_BULLET).toContain('POST /mobile/desktop-unlock');
    expect(OWNER_PRESENCE_BULLET).toContain('mobilePairing.ownerPresence.enabled: false');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mop-aware-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Agent\n${fresh.replace(`${OWNER_PRESENCE_BULLET}\n`, '')}`);
      const run = () => {
        const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4321, hasTelegram: false, projectName: 'x' } as never);
        const r = { upgraded: [] as string[], errors: [] as string[], skipped: [] as string[] };
        (m as unknown as { migrateClaudeMd(r: unknown): void }).migrateClaudeMd(r);
        return fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
      };
      const once = run();
      expect(once.split(OWNER_PRESENCE_BULLET).length - 1).toBe(1);
      expect(once.indexOf(OWNER_PRESENCE_BULLET)).toBeLessThan(once.indexOf('- **Never ask the operator for the '));
      expect(run()).toBe(once);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-owner-presence.test.ts' });
    }
  });
});

describe('caller binding covers every place a phone session is accepted (spec §2.1)', () => {
  it('the desktop verifier is used only at the named sites, and every routes.ts use sits behind the /desktop binding', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../..');
    const routes = fs.readFileSync(path.join(root, 'src/server/routes.ts'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'src/server/AgentServer.ts'), 'utf8');
    // AgentServer: the DirectDesktopAccess validator, the mesh front, and the ctx handoff (plus its definition).
    expect(server.match(/this\.verifyDesktopOperatorSession\(/g)?.length).toBe(3);
    const binding = routes.indexOf('mountPhoneSessionBinding(router, ctx.phoneDesktopSessions)');
    expect(binding).toBeGreaterThan(-1);
    const uses = [...routes.matchAll(/verifyDesktopSession\(/g)].map((m) => m.index!);
    const definition = routes.indexOf('const verifyDesktopSession = ');
    // Setup's verifySession, targets, new request, cursor, displays: five uses, all after the binding.
    expect(uses.filter((i) => i !== definition + 'const '.length)).toHaveLength(5);
    for (const i of uses) expect(i).toBeGreaterThan(binding);
    // And every one of them is inside the desktop route block (before the next unrelated section).
    const blockEnd = routes.indexOf("router.post('/desktop/requests/:id/revoke'");
    for (const i of uses) expect(i).toBeLessThan(blockEnd);
    // No other module verifies a phone session.
    expect(routes.includes('ctx.verifyDesktopOperatorSession?.(')).toBe(false);
  });
});
