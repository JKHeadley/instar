/**
 * Regression: the dashboard broadcast leaked the internal placeholder string
 * "(check your config)" to the user as their PIN.
 *
 * Live incident (2026-06-06, topic 5): the broadcast sent
 *   `PIN: (check your config)`
 * because `config.dashboardPin` was the unresolved `{secret:true}` ref (a
 * transient vault/keychain read failure at boot under host pressure left the
 * loadConfig secret-merge incomplete), and the old code fell back to a literal
 * placeholder via `this.config.dashboardPin || '(check your config)'`. That
 * value is useless to the end-user (they cannot log in) and reads like an
 * instruction they can't act on — the exact user-facing-clarity failure.
 *
 * The fix: resolve the PIN (in-memory first, then a fresh vault read) and, when
 * unresolvable, OMIT the PIN line with an honest, actionable note — the
 * placeholder must NEVER reach a user. Mirrors the constructor's existing
 * `{secret:true}` normalization for `config.token`.
 *
 * Vaults are written with forceFileKey so tests never touch the real keychain;
 * the adapter's production-path read reaches them via the dual-key file
 * candidate (CMT-1038).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DASHBOARD_PIN_PLACEHOLDER, DASHBOARD_PIN_VAULT_KEY } from '../../src/core/dashboardPin.js';

const dirs: string[] = [];

function makeAdapter(dashboardPin: unknown, vaultPin?: string): TelegramAdapter {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-dashpin-'));
  dirs.push(tmpDir);
  if (vaultPin !== undefined) {
    const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
    store.set(DASHBOARD_PIN_VAULT_KEY, vaultPin);
  }
  return new TelegramAdapter(
    {
      token: '',
      chatId: '-100123456',
      dashboardTopicId: 5,
      // Pass through whatever the test supplies (string, the {secret:true}
      // object, undefined) to mirror untyped/unresolved config JSON.
      dashboardPin: dashboardPin as string | undefined,
    },
    tmpDir,
  );
}

// Access the two private members under test.
function format(adapter: TelegramAdapter, pin: string | null, isNamed: boolean): string {
  return (adapter as unknown as { formatDashboardMessage: (u: string, p: string | null, n: boolean) => string })
    .formatDashboardMessage('https://echo.example.dev', pin, isNamed);
}
function resolve(adapter: TelegramAdapter): string | null {
  return (adapter as unknown as { resolvedDashboardPin: () => string | null }).resolvedDashboardPin();
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/telegram-dashboard-pin-leak.test.ts' });
  }
});

describe('formatDashboardMessage — never leaks the placeholder', () => {
  it('renders a real PIN (named link)', () => {
    const msg = format(makeAdapter('481516'), '481516', true);
    expect(msg).toContain('PIN: `481516`');
    expect(msg).not.toContain(DASHBOARD_PIN_PLACEHOLDER);
  });

  it('renders a real PIN (quick link)', () => {
    const msg = format(makeAdapter('234812'), '234812', false);
    expect(msg).toContain('PIN: `234812`');
    expect(msg).not.toContain(DASHBOARD_PIN_PLACEHOLDER);
  });

  it('a null PIN omits the PIN line and NEVER emits the placeholder (named)', () => {
    const msg = format(makeAdapter(undefined), null, true);
    expect(msg).not.toContain(DASHBOARD_PIN_PLACEHOLDER);
    expect(msg).not.toContain('PIN: `'); // no fake code-span PIN
    expect(msg.toLowerCase()).toContain('ask me for your dashboard pin'); // honest, actionable
    // The dashboard link itself is still present and useful.
    expect(msg).toContain('https://echo.example.dev/dashboard');
  });

  it('a null PIN omits the PIN line and NEVER emits the placeholder (quick)', () => {
    const msg = format(makeAdapter(undefined), null, false);
    expect(msg).not.toContain(DASHBOARD_PIN_PLACEHOLDER);
    expect(msg.toLowerCase()).toContain('ask me for your dashboard pin');
  });
});

describe('resolvedDashboardPin — wiring (in-memory first, vault fallback)', () => {
  it('uses a usable in-memory config PIN', () => {
    expect(resolve(makeAdapter('135790'))).toBe('135790');
  });

  it('recovers the real PIN from the vault when config holds the unresolved {secret:true} object', () => {
    // The exact runtime shape that caused the leak.
    expect(resolve(makeAdapter({ secret: true }, '864209'))).toBe('864209');
  });

  it('recovers the real PIN from the vault when config holds the literal placeholder', () => {
    expect(resolve(makeAdapter(DASHBOARD_PIN_PLACEHOLDER, '112358'))).toBe('112358');
  });

  it('returns null when neither config nor vault yields a real PIN', () => {
    expect(resolve(makeAdapter(undefined))).toBeNull();
    expect(resolve(makeAdapter({ secret: true }))).toBeNull();
  });

  it('end-to-end: an unresolved {secret:true} config + a vault PIN produces a message with the REAL PIN, never [object Object] or the placeholder', () => {
    const adapter = makeAdapter({ secret: true }, '707070');
    const pin = resolve(adapter);
    const msg = format(adapter, pin, true);
    expect(msg).toContain('PIN: `707070`');
    expect(msg).not.toContain(DASHBOARD_PIN_PLACEHOLDER);
    expect(msg).not.toContain('[object Object]');
  });
});
