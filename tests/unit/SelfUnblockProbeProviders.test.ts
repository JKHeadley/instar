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
  it('returns a REAL provider for EVERY one of the 9 sources', () => {
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
