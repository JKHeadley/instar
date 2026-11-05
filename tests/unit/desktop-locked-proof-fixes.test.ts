/**
 * Fixes from the 2026-11-04 locked-Mac proof on the Mac Mini: a failed helper
 * state-op names its reason, every agent gets a dashboard PIN with or without
 * Telegram, and the viewer names why a password box cannot work.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MacDesktopHost, stateOpRefusal } from '../../src/core/MacDesktopHost.js';
import os from 'node:os';
import { ensureDashboardPin, persistDashboardPin } from '../../src/core/dashboardPin.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('stateOpRefusal', () => {
  it('keeps the exit code and the helper\'s one fixed word', () => {
    expect(stateOpRefusal(69, 'state-op: store-root-uncreatable\n')).toBe('mac-desktop-host-state-op-failed-exit-69-store-root-uncreatable');
    expect(stateOpRefusal(69, '')).toBe('mac-desktop-host-state-op-failed-exit-69');
    expect(stateOpRefusal(null, '')).toBe('mac-desktop-host-state-op-failed-signal');
  });

  it('drops anything that is not the fixed word: paths, values, free text', () => {
    expect(stateOpRefusal(1, '/Users/x/.instar/desktop-helper: Permission denied\nhunter2')).toBe('mac-desktop-host-state-op-failed-exit-1');
    expect(stateOpRefusal(69, 'state-op: Store/Root uncreatable')).toBe('mac-desktop-host-state-op-failed-exit-69');
    expect(stateOpRefusal(69, `state-op: ${'a'.repeat(80)}`)).toBe('mac-desktop-host-state-op-failed-exit-69');
    // Well-formed but not a word the helper writes: dropped too.
    expect(stateOpRefusal(69, 'state-op: users-justin-documents')).toBe('mac-desktop-host-state-op-failed-exit-69');
    // The status route's code pattern accepts what this produces.
    expect(/^mac-desktop-host-[a-z0-9-]+$/.test(stateOpRefusal(69, 'state-op: store-unwritable'))).toBe(true);
  });
});

// The trusted binary path is dist/native, so the stand-in helper lives there.
const helpers: string[] = [];
function standIn(body: string): MacDesktopHost {
  const filename = path.resolve('dist/native', `instar-desktop-stateop-test-${process.pid}-${helpers.length}`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  helpers.push(filename);
  const host = new MacDesktopHost(filename);
  host.setLockedRoot('/nonexistent/desktop-helper/locked');
  return host;
}

describe.skipIf(process.platform !== 'darwin')('MacDesktopHost.lockedOp failure', () => {
  afterEach(() => {
    // The stand-ins must live beside the trusted helper during the test. Move
    // only files this test created into an isolated temp dir before safe cleanup;
    // SafeFsExecutor correctly refuses deletion inside the instar source tree.
    const cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-desktop-stateop-cleanup-'));
    try {
      for (const filename of helpers.splice(0)) {
        fs.renameSync(filename, path.join(cleanupDir, path.basename(filename)));
      }
    } finally {
      SafeFsExecutor.safeRmSync(cleanupDir, { recursive: true, force: true, operation: 'tests/unit/desktop-locked-proof-fixes.test.ts:cleanup' });
    }
  });

  it('names the reason instead of a bare unavailable', async () => {
    const host = standIn(`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('state-op: store-root-uncreatable\\n');process.exit(69);});`);
    await expect(host.lockedOp({ op: 'set-disabled', disabled: false }))
      .rejects.toThrow('mac-desktop-host-state-op-failed-exit-69-store-root-uncreatable');
  });

  it('bounds what it reads from stderr and keeps none of the free text', async () => {
    const host = standIn(`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('x'.repeat(100000)+'\\nstate-op: late-word\\n');process.exit(3);});`);
    const error = await host.lockedOp({ op: 'read' }).catch((e: Error) => e);
    expect((error as Error).message).toBe('mac-desktop-host-state-op-failed-exit-3');
  });
});

describe('ensureDashboardPin', () => {
  it('mints a 6-digit PIN when the agent has none, whatever messaging it runs', () => {
    const config: { dashboardPin?: unknown } = {};
    const saved: string[] = [];
    expect(ensureDashboardPin(config, pin => saved.push(pin))).toEqual({ generated: true });
    expect(config.dashboardPin).toMatch(/^[0-9]{6}$/);
    expect(saved).toEqual([config.dashboardPin]);
    expect(ensureDashboardPin({ dashboardPin: '' }, () => {}, () => 123456)).toEqual({ generated: true });
  });

  it('never replaces a PIN that exists, including an unresolved vault reference', () => {
    const saved: string[] = [];
    const existing = { dashboardPin: '424242' };
    expect(ensureDashboardPin(existing, pin => saved.push(pin))).toEqual({ generated: false });
    expect(existing.dashboardPin).toBe('424242');
    const unresolved = { dashboardPin: { secret: true } as unknown };
    expect(ensureDashboardPin(unresolved, pin => saved.push(pin))).toEqual({ generated: false });
    expect(unresolved.dashboardPin).toEqual({ secret: true });
    expect(saved).toEqual([]);
  });

  it('runs outside the Telegram branch of server boot', () => {
    const source = fs.readFileSync(path.resolve('src/commands/server.ts'), 'utf8');
    const call = source.indexOf('ensureDashboardPin(config');
    const telegramBranch = source.indexOf('// ── Dashboard Topic: always-available link');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(telegramBranch);
    expect(source).not.toContain('Auto-generated dashboard PIN: ${pin}');
  });
});

describe('viewer names why the password box cannot work', () => {
  const viewer = fs.readFileSync(path.resolve('dashboard/desktop.js'), 'utf8');
  const html = fs.readFileSync(path.resolve('dashboard/desktop.html'), 'utf8');

  it('reads boxRefusal from the state record and shows the reason while locked', () => {
    expect(viewer).toContain("lockedBoxRefusal = typeof value.boxRefusal === 'string' ? value.boxRefusal : ''");
    expect(viewer).toContain('lockedBoxAllowed && !lockedBoxRefusal && locked');
    expect(html).toContain('id="lockedPasswordReason"');
  });

  it('has words for every reason the target can name', () => {
    for (const reason of ['tunnel-not-active', 'tunnel-not-first-tier', 'browser-box-off', 'retained-helper-required',
      'own-input-grant-required', 'unsupported-macos', 'helper-unprobed']) {
      expect(viewer).toContain(`'${reason}':`);
    }
  });
});

describe('persistDashboardPin', () => {
  const dirs: string[] = [];
  const stateDir = (vault: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-persist-'));
    dirs.push(dir);
    if (vault) {
      fs.mkdirSync(path.join(dir, 'secrets'));
      fs.writeFileSync(path.join(dir, 'secrets', 'config.secrets.enc'), 'x');
    }
    return dir;
  };
  afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); });

  it('keeps the PIN in the vault, and only a reference in config, when the agent has a vault', () => {
    const written: Array<[string, unknown]> = [];
    let config: unknown;
    expect(persistDashboardPin(stateDir(true), '123456', value => { config = value; },
      () => ({ set: (key: string, value: unknown) => { written.push([key, value]); } }))).toBe('vault');
    expect(written).toEqual([['dashboardPin', '123456']]);
    expect(config).toEqual({ secret: true });
  });

  it('falls back to config when the vault write fails, and uses config when there is no vault', () => {
    let config: unknown;
    expect(persistDashboardPin(stateDir(true), '123456', value => { config = value; },
      () => ({ set: () => { throw new Error('keychain locked'); } }))).toBe('config');
    expect(config).toBe('123456');
    let plain: unknown;
    let opened = false;
    expect(persistDashboardPin(stateDir(false), '654321', value => { plain = value; },
      () => { opened = true; return { set: () => {} }; })).toBe('config');
    expect(plain).toBe('654321');
    expect(opened).toBe(false);
  });
});

describe('secure-input owner registry path', () => {
  const swift = fs.readFileSync(path.resolve('src/native/remote-desktop/macos/InstarDesktopHost.swift'), 'utf8');

  it('opens the IOResources entry and reads IOConsoleUsers as its property', () => {
    // IOConsoleUsers is a property, not an entry: the old path returned no entry,
    // read as "unreadable", and refused every password with shield-not-confirmed.
    expect(swift).toContain('static let secureInputRegistryPath = "IOService:/IOResources"');
    expect(swift).not.toContain('"IOService:/IOResources/IOConsoleUsers"');
    expect(swift).toMatch(/IORegistryEntryFromPath\(kIOMainPortDefault, secureInputRegistryPath\)/);
    expect(swift).toMatch(/IORegistryEntryCreateCFProperty\(root, "IOConsoleUsers" as CFString/);
  });

  it('reads secure input from the session on the console, not any background account', () => {
    const start = swift.indexOf('static func secureInputOwner()');
    const body = swift.slice(start, swift.indexOf('\n    }\n', start));
    expect(body).toContain('$0["kCGSSessionOnConsoleKey"] as? Bool == true');
    expect(body).toContain('(onConsole.isEmpty ? users : onConsole)');
    expect(body).not.toContain('users.compactMap');
  });

  it('types only while this helper\'s own session is the one on screen', () => {
    const start = swift.indexOf('static func secureTargetHolds()');
    const body = swift.slice(start, swift.indexOf('\n    }\n', start));
    expect(body).toContain('state?[kCGSessionOnConsoleKey as String] as? Bool == true');
    expect(body).toContain('state?["CGSSessionScreenIsLocked"] as? Bool == true');
    expect(body).toContain('secureInputOwner() == "loginwindow"');
  });
});

describe('viewer has words for every password refusal', () => {
  it('covers each word the helper and the target can send', () => {
    const viewer = fs.readFileSync(path.resolve('dashboard/desktop.js'), 'utf8');
    const swift = fs.readFileSync(path.resolve('src/native/remote-desktop/macos/InstarDesktopHost.swift'), 'utf8');
    const start = swift.indexOf('static func reserve(');
    const reserve = swift.slice(start, swift.indexOf('\n    }\n', start));
    const words = new Set<string>([
      ...[...swift.matchAll(/HostError\.refused\("([a-z-]+)"\)/g)].map(m => m[1]),
      ...[...reserve.matchAll(/return "([a-z-]+)"/g)].map(m => m[1]),
      // Target-side words (DirectDesktopAccess / DesktopLockedController).
      'grant-ended', 'busy', 'state-unknown', 'relock-pending', 'relock-pending-unconfirmed', 'relock-failed',
      'relock-failed-producer-alive', 'not-locked',
    ]);
    expect(words.has('shield-not-confirmed')).toBe(true);
    expect(words.size).toBeGreaterThan(15);
    const missing = [...words].filter(word => !viewer.includes(`'${word}':`) && !viewer.includes(`\n    ${word}:`) && !viewer.includes(` ${word}:`));
    expect(missing).toEqual([]);
  });
});
