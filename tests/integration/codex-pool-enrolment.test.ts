/**
 * Codex accounts can be enrolled in the subscription pool — end to end.
 *
 * This is the tier that would have caught the real defect. Unit tests of the
 * identity reader pass whether or not it is WIRED; what mattered operationally is
 * that `SubscriptionAccountEmailRegistrar.register()` — the pool's verified-add
 * path, the one the enrol route actually uses — rejected every Codex home with
 * `subscription-account-email-unresolved`, because the only oracle asks Anthropic.
 *
 * So these drive the real registrar against a real pool on a real temp state dir,
 * with only the credential FILE faked. If the composite oracle is ever unwired,
 * the first test fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SubscriptionPool,
  SubscriptionAccountEmailRegistrar,
  SubscriptionIdentityError,
} from '../../src/core/SubscriptionPool.js';
import {
  CompositeCredentialIdentityOracle,
  IDENTITY_VERIFIABLE_SLOTS,
  isIdentityVerifiableSlot,
} from '../../src/core/CompositeCredentialIdentityOracle.js';
import type { IdentityOracle, IdentityOracleResult } from '../../src/core/CredentialLocationLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Stands in for the Anthropic OAuth oracle: it cannot speak for a Codex slot. */
const anthropicOnly: IdentityOracle = {
  async resolveSlotTenant(): Promise<IdentityOracleResult> {
    return { unavailable: true, reason: 'oauth-profile-unreachable-for-this-slot' };
  },
};

function writeCodexHome(root: string, name: string, email: string, accountId: string): string {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  const payload = Buffer.from(
    JSON.stringify({
      email,
      'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: accountId },
    }),
    'utf-8',
  ).toString('base64url');
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: `hdr.${payload}.sig`, account_id: accountId },
    }),
  );
  return home;
}

describe('subscription pool — Codex enrolment (integration)', () => {
  let stateDir: string;
  let pool: SubscriptionPool;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-enrol-'));
    pool = new SubscriptionPool({ stateDir });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/codex-pool-enrolment.test.ts:cleanup',
    });
  });

  it('THE DEFECT: with the Anthropic-only oracle a Codex account cannot be enrolled', async () => {
    // The state of the world before this change — kept as a test so the fix has
    // something to be a fix OF, and so a regression is legible rather than silent.
    const home = writeCodexHome(stateDir, 'codex-a', 'a@example.com', 'acct-a');
    const registrar = new SubscriptionAccountEmailRegistrar(pool, anthropicOnly);

    await expect(
      registrar.register({
        id: 'codex-a',
        nickname: 'Codex A',
        provider: 'openai',
        framework: 'codex-cli',
        configHome: home,
      }),
    ).rejects.toBeInstanceOf(SubscriptionIdentityError);
    expect(pool.list()).toHaveLength(0);
  });

  it('THE FIX: with the composite oracle the same account enrols', async () => {
    const home = writeCodexHome(stateDir, 'codex-a', 'a@example.com', 'acct-a');
    const registrar = new SubscriptionAccountEmailRegistrar(
      pool,
      new CompositeCredentialIdentityOracle({ anthropic: anthropicOnly }),
    );

    const acct = await registrar.register({
      id: 'codex-a',
      nickname: 'Codex A',
      provider: 'openai',
      framework: 'codex-cli',
      configHome: home,
    });

    expect(acct.id).toBe('codex-a');
    expect(acct.framework).toBe('codex-cli');
    expect(acct.provider).toBe('openai');
    // The email came from the SLOT, not from the caller — the caller never sent one.
    expect(acct.email).toBe('a@example.com');
    expect(pool.list()).toHaveLength(1);
  });

  it('TWO Codex accounts coexist as distinct pool rows', async () => {
    // The whole point: codex-to-codex swap is impossible with fewer than two.
    const registrar = new SubscriptionAccountEmailRegistrar(
      pool,
      new CompositeCredentialIdentityOracle({ anthropic: anthropicOnly }),
    );
    const a = writeCodexHome(stateDir, 'codex-a', 'a@example.com', 'acct-a');
    const b = writeCodexHome(stateDir, 'codex-b', 'b@example.com', 'acct-b');

    await registrar.register({ id: 'codex-a', nickname: 'A', provider: 'openai', framework: 'codex-cli', configHome: a });
    await registrar.register({ id: 'codex-b', nickname: 'B', provider: 'openai', framework: 'codex-cli', configHome: b });

    const rows = pool.list();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.email)).size).toBe(2);
    expect(new Set(rows.map((r) => r.configHome)).size).toBe(2);
  });

  it('a caller-supplied email that contradicts the slot is REFUSED', async () => {
    // The identity guard must still bite: the slot is authoritative, not the caller.
    const home = writeCodexHome(stateDir, 'codex-a', 'real@example.com', 'acct-a');
    const registrar = new SubscriptionAccountEmailRegistrar(
      pool,
      new CompositeCredentialIdentityOracle({ anthropic: anthropicOnly }),
    );

    await expect(
      registrar.register({
        id: 'codex-a',
        nickname: 'A',
        provider: 'openai',
        framework: 'codex-cli',
        configHome: home,
        email: 'claimed@example.com',
      }),
    ).rejects.toBeInstanceOf(SubscriptionIdentityError);
    expect(pool.list()).toHaveLength(0);
  });

  it('CONTROL: a slot with no credential still refuses, so the guard is not simply off', async () => {
    const empty = path.join(stateDir, 'empty-home');
    fs.mkdirSync(empty, { recursive: true });
    const registrar = new SubscriptionAccountEmailRegistrar(
      pool,
      new CompositeCredentialIdentityOracle({ anthropic: anthropicOnly }),
    );

    await expect(
      registrar.register({ id: 'x', nickname: 'X', provider: 'openai', framework: 'codex-cli', configHome: empty }),
    ).rejects.toBeInstanceOf(SubscriptionIdentityError);
    expect(pool.list()).toHaveLength(0);
  });
});

/**
 * The layer the tests above did NOT cover, and the defect that hid there.
 *
 * Everything above drives the REGISTRAR. The enrol route sits one layer higher and
 * carried its own gate — `provider !== 'anthropic' || framework !== 'claude-code'` —
 * so it refused Codex BEFORE the oracle was ever asked. Every registrar test passed
 * while enrolling a real Codex account through the real route still returned
 * `subscription-account-identity-provider-unsupported`. Found by attempting the
 * actual enrolment on a live server, not by reading.
 */
describe('enrolment gate — the route must not disagree with the identity layer', () => {
  it('the gate admits every pair the identity layer covers', () => {
    expect(isIdentityVerifiableSlot('anthropic', 'claude-code')).toBe(true);
    expect(isIdentityVerifiableSlot('openai', 'codex-cli')).toBe(true);
  });

  it('CONTROL: it still refuses a pair no oracle can answer for', () => {
    // Without this the gate could pass by admitting everything, which would push an
    // unanswerable slot down to the oracle and fail with a confusing reason.
    expect(isIdentityVerifiableSlot('google', 'gemini-cli')).toBe(false);
    expect(isIdentityVerifiableSlot('openai', 'claude-code')).toBe(false); // provider/framework must AGREE
    expect(isIdentityVerifiableSlot(undefined, undefined)).toBe(false);
  });

  it('THE REGRESSION: every advertised pair is genuinely answerable by the oracle', async () => {
    // This is what keeps the list honest in the other direction. Adding a pair here
    // without an oracle behind it would let the route accept an enrolment it cannot
    // verify — trading a false refusal for a false acceptance, which is worse.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-consist-'));
    try {
      const codexHome = writeCodexHome(root, 'codex', 'someone@example.com', 'acct-consistency');
      const anthropicHome = path.join(root, 'anthropic');
      fs.mkdirSync(anthropicHome, { recursive: true });

      let anthropicAsked = false;
      const oracle = new CompositeCredentialIdentityOracle({
        anthropic: {
          async resolveSlotTenant(): Promise<IdentityOracleResult> {
            anthropicAsked = true;
            return { email: 'anthropic@example.com' };
          },
        },
      });

      for (const pair of IDENTITY_VERIFIABLE_SLOTS) {
        const slot = pair.framework === 'codex-cli' ? codexHome : anthropicHome;
        const res = await oracle.resolveSlotTenant(slot);
        expect(res.unavailable, `${pair.provider}/${pair.framework} is advertised but unanswerable`).toBeFalsy();
        expect(res.email).toBeTruthy();
      }
      expect(anthropicAsked, 'the anthropic pair should still route to the anthropic oracle').toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(root, {
        recursive: true,
        force: true,
        operation: 'tests/integration/codex-pool-enrolment.test.ts:gate-consistency',
      });
    }
  });

  it('the route asks the identity layer instead of restating it', () => {
    // The inline pair is exactly what went stale. If it comes back, so does the bug.
    const routes = fs.readFileSync('src/server/routes.ts', 'utf8');
    expect(routes).toContain('isIdentityVerifiableSlot(provider, framework)');
    expect(routes).not.toContain("provider !== 'anthropic' || framework !== 'claude-code'");
  });
});
