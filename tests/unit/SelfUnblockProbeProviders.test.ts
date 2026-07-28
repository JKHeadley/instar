/**
 * Unit tests — SelfUnblockProbeProviders (the PRODUCER half of "Self-Unblock
 * Before Escalating"). Every provider must be:
 *   - fail-closed: no operator-declared tags ⇒ EMPTY advertisedScopeTags ⇒ the
 *     runner's relevance match never fires ⇒ holdsRelevantCred:false ⇒ runs exhaust;
 *   - bounded: at most ONE injected exec/fetch per provider, with an explicit
 *     timeout (never a recursive scan);
 *   - secret-safe: a provider NEVER returns or includes a secret VALUE — only
 *     non-secret `{ reachable, advertisedScopeTags, detail }`.
 * All external access is injected, so these tests NEVER shell out or hit a network.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildProductionProbeProviders,
  type SelfUnblockProbeDeps,
  type ExecFileBounded,
  type BoundedExecResult,
} from '../../src/monitoring/SelfUnblockProbeProviders.js';
import {
  SelfUnblockChecklist,
  SelfUnblockRunStore,
  SELF_UNBLOCK_PROBE_SOURCES,
} from '../../src/monitoring/SelfUnblockChecklist.js';
import { DurableVaultSession } from '../../src/monitoring/DurableVaultSession.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TARGET = 'cloudflare:feedback.dawn-tunnel.dev';

/** A bounded-exec spy that records every call and returns a scripted result. */
function execSpy(
  result: BoundedExecResult = { code: 0, stdout: '', stderr: '', timedOut: false },
): { fn: ExecFileBounded; calls: Array<{ file: string; args: string[]; opts: { timeoutMs: number; env?: NodeJS.ProcessEnv } }> } {
  const calls: Array<{ file: string; args: string[]; opts: { timeoutMs: number; env?: NodeJS.ProcessEnv } }> = [];
  const fn: ExecFileBounded = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return result;
  };
  return { fn, calls };
}

function okFetch(zones: string[] = []): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ result: zones.map((name) => ({ name })) }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('buildProductionProbeProviders — coverage', () => {
  it('returns a REAL provider for EVERY one of the 10 sources', () => {
    const providers = buildProductionProbeProviders({});
    for (const source of SELF_UNBLOCK_PROBE_SOURCES) {
      expect(typeof providers[source]).toBe('function');
    }
    expect(Object.keys(providers).sort()).toEqual([...SELF_UNBLOCK_PROBE_SOURCES].sort());
  });
});

describe('fail-closed: no declared tags ⇒ empty advertisedScopeTags', () => {
  it('every provider advertises NO tags when nothing is declared (so none is surfaced)', async () => {
    // Make every source "reachable" so the ONLY thing that could surface a cred is
    // a declared tag — and none is declared.
    const exec = execSpy({ code: 0, stdout: '{}', stderr: '', timedOut: false }).fn;
    const deps: SelfUnblockProbeDeps = {
      execFileBounded: exec,
      fetchImpl: okFetch([]),
      getVaultKeys: () => ['telegram-token', 'auth-token'],
      getCloudflareToken: () => 'cf-token-value',
      durableVaultSession: new DurableVaultSession({ deriveSession: () => 'sess-1' }),
      // credentialScopeTags intentionally OMITTED
    };
    const providers = buildProductionProbeProviders(deps);
    for (const source of SELF_UNBLOCK_PROBE_SOURCES) {
      const r = await providers[source]!(TARGET);
      expect(r.advertisedScopeTags ?? []).toEqual([]);
    }
  });

  it('a full checklist run EXHAUSTS when nothing is declared (behaves like today)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-providers-'));
    try {
      const store = new SelfUnblockRunStore({ stateDir: tmpDir });
      const providers = buildProductionProbeProviders({
        execFileBounded: execSpy({ code: 0, stdout: '{}', stderr: '', timedOut: false }).fn,
        fetchImpl: okFetch(['other.dev']), // a zone, but NOT the target's
        getVaultKeys: () => ['telegram-token'],
        getCloudflareToken: () => 'cf-token-value',
        durableVaultSession: new DurableVaultSession({ deriveSession: () => 'sess-1' }),
      });
      const checklist = new SelfUnblockChecklist({ providers, store });
      const run = await checklist.run({ target: TARGET, requiredAttemptType: 'self-fetch' });
      expect(run.exhausted).toBe(true);
      expect(run.probes.every((p) => p.holdsRelevantCred === false)).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/SelfUnblockProbeProviders.test.ts:exhaust',
      });
    }
  });

  it('a DECLARED matching tag surfaces the credential (operator opt-in works)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-providers-'));
    try {
      const store = new SelfUnblockRunStore({ stateDir: tmpDir });
      const providers = buildProductionProbeProviders({
        execFileBounded: execSpy({ code: 0, stdout: '{}', stderr: '', timedOut: false }).fn,
        fetchImpl: okFetch([]),
        getVaultKeys: () => ['namecheap-key'],
        getCloudflareToken: () => null,
        // Operator declares own-vault holds a parent-zone cred → relevant to the target.
        credentialScopeTags: { 'own-vault': ['cloudflare:dawn-tunnel.dev'] },
      });
      const checklist = new SelfUnblockChecklist({ providers, store });
      const run = await checklist.run({ target: TARGET, requiredAttemptType: 'self-fetch' });
      expect(run.exhausted).toBe(false);
      // Short-circuits on own-vault (the first source).
      const ownVault = run.probes.find((p) => p.source === 'own-vault');
      expect(ownVault?.holdsRelevantCred).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/SelfUnblockProbeProviders.test.ts:declared',
      });
    }
  });
});

describe('boundedness: at most ONE injected call per provider, with a timeout', () => {
  it('cloud-vercel / cloud-github each do exactly ONE bounded exec with a timeout', async () => {
    const vercelSpy = execSpy();
    const providersV = buildProductionProbeProviders({ execFileBounded: vercelSpy.fn });
    await providersV['cloud-vercel']!(TARGET);
    expect(vercelSpy.calls).toHaveLength(1);
    expect(vercelSpy.calls[0].file).toBe('vercel');
    expect(vercelSpy.calls[0].opts.timeoutMs).toBeGreaterThan(0);

    const ghSpy = execSpy();
    const providersG = buildProductionProbeProviders({ execFileBounded: ghSpy.fn });
    await providersG['cloud-github']!(TARGET);
    expect(ghSpy.calls).toHaveLength(1);
    expect(ghSpy.calls[0].file).toBe('gh');
    expect(ghSpy.calls[0].opts.timeoutMs).toBeGreaterThan(0);
  });

  it('org-bitwarden does ONE bounded exec and NEVER puts the session in argv', async () => {
    const spy = execSpy();
    const dvs = new DurableVaultSession({ deriveSession: () => 'SECRET-SESSION-TOKEN' });
    const providers = buildProductionProbeProviders({ execFileBounded: spy.fn, durableVaultSession: dvs });
    await providers['org-bitwarden']!(TARGET);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].file).toBe('bw');
    // The session NEVER appears in argv (visible in `ps`) — only in BW_SESSION env.
    expect(spy.calls[0].args.join(' ')).not.toContain('SECRET-SESSION-TOKEN');
    expect(spy.calls[0].opts.env?.BW_SESSION).toBe('SECRET-SESSION-TOKEN');
  });

  it('declared-presence providers (launchd/mcp/playwright/controlled) do NO exec/fetch', async () => {
    const spy = execSpy();
    let fetchCalls = 0;
    const providers = buildProductionProbeProviders({
      execFileBounded: spy.fn,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    for (const source of ['cloud-launchd', 'mcp-tools', 'browser-playwright', 'controlled-resource'] as const) {
      await providers[source]!(TARGET);
    }
    expect(spy.calls).toHaveLength(0);
    expect(fetchCalls).toBe(0);
  });
});

describe('unreachable + secret-safety honesty', () => {
  it('own-vault is unreachable (NOT a throw) when key listing is not wired', async () => {
    const providers = buildProductionProbeProviders({});
    const r = await providers['own-vault']!(TARGET);
    expect(r.reachable).toBe(false);
    expect(r.advertisedScopeTags ?? []).toEqual([]);
  });

  it('org-bitwarden is unreachable with a clear detail when no durable session is wired', async () => {
    const providers = buildProductionProbeProviders({});
    const r = await providers['org-bitwarden']!(TARGET);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain('durable vault session not wired');
  });

  it('cloud-cloudflare is unreachable when no token is configured (no fetch attempted)', async () => {
    let fetchCalls = 0;
    const providers = buildProductionProbeProviders({
      getCloudflareToken: () => null,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const r = await providers['cloud-cloudflare']!(TARGET);
    expect(r.reachable).toBe(false);
    expect(fetchCalls).toBe(0);
  });

  it('NO provider result ever contains a secret VALUE (token / session / vault key value)', async () => {
    const SECRETS = ['CF-TOKEN-abc123', 'SECRET-SESSION-TOKEN', 'master-pw-xyz'];
    const dvs = new DurableVaultSession({ deriveSession: () => 'SECRET-SESSION-TOKEN' });
    const providers = buildProductionProbeProviders({
      execFileBounded: execSpy({ code: 0, stdout: 'SECRET-SESSION-TOKEN in output', stderr: '', timedOut: false }).fn,
      fetchImpl: okFetch(['dawn-tunnel.dev']),
      getVaultKeys: () => ['telegram-token'],
      getCloudflareToken: () => 'CF-TOKEN-abc123',
      durableVaultSession: dvs,
      credentialScopeTags: { 'cloud-cloudflare': ['cloudflare:dawn-tunnel.dev'] },
    });
    for (const source of SELF_UNBLOCK_PROBE_SOURCES) {
      const r = await providers[source]!(TARGET);
      const serialized = JSON.stringify(r);
      for (const secret of SECRETS) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});

// ─── owned-identities (correction-derived-hardening) ────────────────────────────

describe('owned-identities probe — registry-declared, liveness-gated, fail-closed, secret-safe', () => {
  const REGISTRY = JSON.stringify([
    {
      identity: 'owner-test@sagemindai.io',
      service: 'slack-workspace',
      roles: ['owner'],
      scopeTags: ['slack:T0TESTTEAM', 'google:sagemindai.io'],
      credentialRef: 'file:.instar/slack-live-test/test-users.json#owner-test',
      note: 'test workspace owner',
    },
    {
      identity: 'admin-test@sagemindai.io',
      service: 'slack-workspace',
      scopeTags: ['slack:T0ADMINONLY'],
      credentialRef: 'vault:admin-test-password',
      // A STRAY secret-shaped field someone mistakenly stored — must never leak.
      password: 'SUPER-SECRET-PW-999',
    },
    {
      identity: 'stale-test@sagemindai.io',
      service: 'slack-workspace',
      scopeTags: ['slack:T0STALETEAM'],
      // No credentialRef — unverifiable → must contribute NOTHING.
    },
  ]);

  function depsWithRegistry(
    raw: string | Error,
    opts: { fileRefLive?: boolean; vaultKeys?: string[] } = {},
  ): SelfUnblockProbeDeps {
    return {
      ownedIdentitiesPath: '/fake/home/.instar/owned-identities.json',
      readFileUtf8: () => {
        if (raw instanceof Error) throw raw;
        return raw;
      },
      fileExists: () => opts.fileRefLive ?? true,
      getVaultKeys: () => opts.vaultKeys ?? [],
    };
  }

  it('advertises tags ONLY from entries whose credentialRef resolves (file stat + vault-key presence)', async () => {
    const providers = buildProductionProbeProviders(
      depsWithRegistry(REGISTRY, { fileRefLive: true, vaultKeys: ['admin-test-password'] }),
    );
    const r = await providers['owned-identities']!('slack:T0TESTTEAM');
    expect(r.reachable).toBe(true);
    expect([...(r.advertisedScopeTags ?? [])].sort()).toEqual([
      'google:sagemindai.io',
      'slack:T0ADMINONLY',
      'slack:T0TESTTEAM',
    ]);
    // The no-credentialRef entry contributed nothing and is reported as skipped.
    expect(r.advertisedScopeTags).not.toContain('slack:T0STALETEAM');
    expect(r.detail).toContain('2 live identities');
    expect(r.detail).toContain('1 skipped');
  });

  it('LIVENESS GATE: a stale entry (dangling file ref, absent vault key) advertises NOTHING — the stranding path is closed', async () => {
    // Every ref fails liveness → the probe is unreachable, tags empty → a
    // checklist run over this registry EXHAUSTS (the agent can still escalate).
    const providers = buildProductionProbeProviders(
      depsWithRegistry(REGISTRY, { fileRefLive: false, vaultKeys: [] }),
    );
    const r = await providers['owned-identities']!('slack:T0TESTTEAM');
    expect(r.reachable).toBe(false);
    expect(r.advertisedScopeTags ?? []).toEqual([]);
    expect(r.detail).toContain('no live entries');
  });

  it('path not wired → unreachable (fail-closed)', async () => {
    const providers = buildProductionProbeProviders({});
    const r = await providers['owned-identities']!('slack:T0TESTTEAM');
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain('not wired');
  });

  it('missing/unreadable registry → unreachable, never a throw', async () => {
    const providers = buildProductionProbeProviders(depsWithRegistry(new Error('ENOENT')));
    const r = await providers['owned-identities']!('slack:T0TESTTEAM');
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain('absent or unreadable');
  });

  it('malformed JSON and non-array roots → unreachable (fail-closed)', async () => {
    const bad = buildProductionProbeProviders(depsWithRegistry('{not json'));
    expect((await bad['owned-identities']!('t')).reachable).toBe(false);
    const nonArray = buildProductionProbeProviders(depsWithRegistry('{"identity":"x"}'));
    expect((await nonArray['owned-identities']!('t')).reachable).toBe(false);
  });

  it('a stray password-shaped field in an entry NEVER appears in any output field', async () => {
    const providers = buildProductionProbeProviders(
      depsWithRegistry(REGISTRY, { fileRefLive: true, vaultKeys: ['admin-test-password'] }),
    );
    const r = await providers['owned-identities']!('slack:T0TESTTEAM');
    expect(JSON.stringify(r)).not.toContain('SUPER-SECRET-PW-999');
    // The credential POINTER is also not surfaced (names + tags only).
    expect(JSON.stringify(r)).not.toContain('test-users.json');
  });

  it('a LIVE registry scopeTag matching the target short-circuits a checklist run as a self-unblock hit', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-owned-'));
    try {
      const store = new SelfUnblockRunStore({ stateDir: tmpDir });
      const providers = buildProductionProbeProviders({
        ...depsWithRegistry(REGISTRY, { fileRefLive: true }),
        getCloudflareToken: () => null,
      });
      const checklist = new SelfUnblockChecklist({ providers, store });
      const run = await checklist.run({ target: 'slack:T0TESTTEAM', requiredAttemptType: 'self-fetch' });
      expect(run.exhausted).toBe(false);
      const owned = run.probes.find((p) => p.source === 'owned-identities');
      expect(owned?.holdsRelevantCred).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/SelfUnblockProbeProviders.test.ts:owned-identities',
      });
    }
  });

  it('JAIL: a file ref outside the agent home never resolves — even when the file exists', async () => {
    const registry = JSON.stringify([
      { identity: 'esc-1', scopeTags: ['slack:T0X'], credentialRef: 'file:/etc/hosts' },
      { identity: 'esc-2', scopeTags: ['slack:T0Y'], credentialRef: 'file:../../outside/secret.json' },
    ]);
    const statted: string[] = [];
    const providers = buildProductionProbeProviders({
      ownedIdentitiesPath: '/fake/home/.instar/owned-identities.json',
      readFileUtf8: () => registry,
      fileExists: (p2: string) => {
        statted.push(p2);
        return true; // every stat says "exists" — the jail must refuse BEFORE the stat
      },
    });
    const r = await providers['owned-identities']!('slack:T0X');
    expect(r.reachable).toBe(false);
    expect(r.advertisedScopeTags ?? []).toEqual([]);
    // Neither out-of-jail path was ever statted.
    expect(statted).toEqual([]);
  });

  it('CLAMP: an oversized/control-char identity name is clamped before it rides the result', async () => {
    const registry = JSON.stringify([
      {
        identity: 'x'.repeat(5000) + '\u0007\n<script>',
        scopeTags: ['slack:T0X'],
        credentialRef: 'file:.instar/x.json',
      },
    ]);
    const providers = buildProductionProbeProviders({
      ownedIdentitiesPath: '/fake/home/.instar/owned-identities.json',
      readFileUtf8: () => registry,
      fileExists: () => true,
    });
    const r = await providers['owned-identities']!('slack:T0X');
    expect(r.reachable).toBe(true);
    const serialized = JSON.stringify(r);
    expect(serialized.length).toBeLessThan(1000);
    expect(serialized).not.toContain('\u0007');
  });

  it('a STALE registry never suppresses exhaustion — a full checklist run over dangling refs EXHAUSTS', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-owned-stale-'));
    try {
      const store = new SelfUnblockRunStore({ stateDir: tmpDir });
      const providers = buildProductionProbeProviders({
        ...depsWithRegistry(REGISTRY, { fileRefLive: false, vaultKeys: [] }),
        getCloudflareToken: () => null,
      });
      const checklist = new SelfUnblockChecklist({ providers, store });
      const run = await checklist.run({ target: 'slack:T0TESTTEAM', requiredAttemptType: 'self-fetch' });
      expect(run.exhausted).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/SelfUnblockProbeProviders.test.ts:owned-stale',
      });
    }
  });
});

// ─── wiring integrity (Testing Integrity Standard; parent-feature regression class) ──

describe('owned-identities production wiring', () => {
  it('AgentServer wires ownedIdentitiesPath into buildProductionProbeProviders (the provider-exists-but-never-wired regression class)', () => {
    // The parent feature\'s founding gap was a provider that existed but was never
    // instantiated in production. This ratchet reads the single production
    // callsite and asserts the dep is threaded — a removal breaks this test
    // before it silently ships an unwired probe.
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/server/AgentServer.ts'),
      'utf8',
    );
    const callsite = src.slice(src.indexOf('buildProductionProbeProviders({'));
    const block = callsite.slice(0, callsite.indexOf('});') + 3);
    expect(block).toContain("ownedIdentitiesPath: path.join(stateDir, 'owned-identities.json')");
  });
});
