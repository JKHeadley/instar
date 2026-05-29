/**
 * Unit tests for MeshUrlAdvertiser — the fix for the "lastKnownUrl is never
 * populated" gap that made the Multi-Machine Session Pool inert across real
 * machines (cross-machine routing filters peers by lastKnownUrl, which nothing
 * ever wrote). Found via real-hardware dogfooding 2026-05-29.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveAdvertisedMeshUrl, advertiseSelfMeshUrl } from '../../src/core/MeshUrlAdvertiser.js';

describe('resolveAdvertisedMeshUrl', () => {
  it('prefers a concretely-resolved quick-tunnel URL (only known at runtime)', () => {
    expect(resolveAdvertisedMeshUrl({ enabled: true, type: 'quick' }, 'https://abc-def.trycloudflare.com'))
      .toBe('https://abc-def.trycloudflare.com');
  });

  it('strips a trailing slash from the resolved URL', () => {
    expect(resolveAdvertisedMeshUrl({ type: 'quick' }, 'https://x.trycloudflare.com/'))
      .toBe('https://x.trycloudflare.com');
  });

  it('derives https://<hostname> for a named tunnel when no resolved URL is given', () => {
    expect(resolveAdvertisedMeshUrl({ enabled: true, type: 'named', hostname: 'echo.dawn-tunnel.dev' }))
      .toBe('https://echo.dawn-tunnel.dev');
  });

  it('normalizes a hostname that already includes a scheme', () => {
    expect(resolveAdvertisedMeshUrl({ type: 'named', hostname: 'https://echo.dawn-tunnel.dev/' }))
      .toBe('https://echo.dawn-tunnel.dev');
  });

  it('returns null when the tunnel is disabled (machine is not reachable cross-machine)', () => {
    expect(resolveAdvertisedMeshUrl({ enabled: false, hostname: 'echo.dawn-tunnel.dev' })).toBeNull();
  });

  it('returns null when there is no tunnel config and no resolved URL', () => {
    expect(resolveAdvertisedMeshUrl(undefined)).toBeNull();
    expect(resolveAdvertisedMeshUrl({})).toBeNull();
  });

  it('ignores a non-http resolved URL and falls through to the named hostname', () => {
    expect(resolveAdvertisedMeshUrl({ type: 'named', hostname: 'echo.dawn-tunnel.dev' }, 'not-a-url'))
      .toBe('https://echo.dawn-tunnel.dev');
  });
});

describe('advertiseSelfMeshUrl (against a real MachineIdentityManager)', () => {
  let dir: string;
  let mgr: MachineIdentityManager;
  let selfId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-url-'));
    mgr = new MachineIdentityManager(dir);
    const identity = await mgr.generateIdentity({ name: 'self' });
    selfId = identity.machineId;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mesh-url-advertiser.test.ts:afterEach' });
  });

  it('writes lastKnownUrl onto the self registry entry (the bug: this never happened)', () => {
    // Precondition: a freshly-registered machine has NO url — this is exactly
    // the null that filtered every peer out of cross-machine routing.
    expect(mgr.getMachineUrl(selfId)).toBeNull();

    const wrote = advertiseSelfMeshUrl(mgr, selfId, 'https://echo.dawn-tunnel.dev');
    expect(wrote).toBe(true);
    expect(mgr.getMachineUrl(selfId)).toBe('https://echo.dawn-tunnel.dev');
  });

  it('is idempotent — no rewrite when the URL is unchanged', () => {
    advertiseSelfMeshUrl(mgr, selfId, 'https://echo.dawn-tunnel.dev');
    expect(advertiseSelfMeshUrl(mgr, selfId, 'https://echo.dawn-tunnel.dev')).toBe(false);
    expect(mgr.getMachineUrl(selfId)).toBe('https://echo.dawn-tunnel.dev');
  });

  it('updates when the URL changes (quick tunnel gets a new URL after sleep/wake)', () => {
    advertiseSelfMeshUrl(mgr, selfId, 'https://old.trycloudflare.com');
    expect(advertiseSelfMeshUrl(mgr, selfId, 'https://new.trycloudflare.com')).toBe(true);
    expect(mgr.getMachineUrl(selfId)).toBe('https://new.trycloudflare.com');
  });

  it('no-ops on a null URL (tunnel disabled) rather than throwing', () => {
    expect(advertiseSelfMeshUrl(mgr, selfId, null)).toBe(false);
    expect(mgr.getMachineUrl(selfId)).toBeNull();
  });

  it('is tolerant when the self entry is absent (boot ordering race)', () => {
    expect(advertiseSelfMeshUrl(mgr, 'm_does_not_exist', 'https://x.dev')).toBe(false);
  });
});
