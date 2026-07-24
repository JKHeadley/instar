/**
 * WriteDomainRegistry — I9 (no machine-local without a convergence story, on
 * BOTH axes), exact-key kv classification (§9.12), I8 defaults, and the
 * registry↔wiring identity (the map the tests read IS the map the server
 * wires — the PR-#334 dead-code lesson).
 *
 * Spec: docs/specs/standby-write-reconciliation.md §3.1/§3.5/§8.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  WriteDomainRegistry,
  buildWriteDomainRegistry,
  jailMachineIdForKey,
  sessionBuildContextKeyFor,
  WRITE_SURFACE_INVENTORY_COMPLETE,
} from '../../src/core/WriteDomainRegistry.js';

describe('I9 — no machine-local without a convergence story (both axes)', () => {
  it('a machine-local entry with NO story is REFUSED the classification and stays cluster-shared', () => {
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'kv', key: 'storyless-store', domain: 'machine-local' });
    expect(reg.domainForOp('set', 'storyless-store').domain).toBe('cluster-shared');
    expect(reg.refusedClassifications.length).toBe(1);
    expect(reg.refusedClassifications[0].reason).toContain('no convergence story');
  });

  it('a shared-git-synced-path entry with a LOGICAL story but no file-level arm is refused (the two-axis rule, round-2 S1)', () => {
    const reg = new WriteDomainRegistry();
    reg.add({
      kind: 'kv',
      key: 'shared-path-store',
      domain: 'machine-local',
      story: { logical: 'ws2x-replicated', onSharedGitSyncedPath: true }, // fileLevel MISSING
    });
    expect(reg.domainForOp('set', 'shared-path-store').domain).toBe('cluster-shared');
    expect(reg.refusedClassifications[0].reason).toContain('file-level arm');
  });

  it('a two-axis-complete story IS accepted machine-local', () => {
    const reg = new WriteDomainRegistry();
    reg.add({
      kind: 'kv',
      key: 'good-store',
      domain: 'machine-local',
      story: { logical: 'pool-scope-read-merge', onSharedGitSyncedPath: true, fileLevel: 'git-sync-excluded' },
    });
    expect(reg.domainForOp('set', 'good-store').domain).toBe('machine-local');
    expect(reg.refusedClassifications.length).toBe(0);
  });

  it('a non-shared-path entry needs only the logical axis', () => {
    const reg = new WriteDomainRegistry();
    reg.add({
      kind: 'kv',
      key: 'ephemeral-store',
      domain: 'machine-local',
      story: { logical: 'ephemeral-rebuildable', onSharedGitSyncedPath: false },
    });
    expect(reg.domainForOp('set', 'ephemeral-store').domain).toBe('machine-local');
  });

  it('a topic-scoped absent-window opt-in is audited under the SAME schema — an invalid story is stripped', () => {
    const reg = new WriteDomainRegistry();
    reg.add({
      kind: 'kv',
      key: 'topic-store',
      domain: 'topic-scoped',
      absentWindowStory: { logical: 'ws2x-replicated', onSharedGitSyncedPath: true }, // no fileLevel — invalid
    });
    const { entry } = reg.domainForOp('set', 'topic-store');
    expect(entry?.kind).toBe('kv');
    expect((entry as { absentWindowStory?: unknown }).absentWindowStory).toBeUndefined();
    expect(reg.refusedClassifications[0].reason).toContain('absent-window');
  });
});

describe('exact-key kv classification (§9.12 — no prefix matching in wave 1)', () => {
  const reg = buildWriteDomainRegistry({ machineId: 'm_self' });

  it('the per-machine build-context key is machine-local; the LEGACY shared key stays cluster-shared', () => {
    expect(reg.domainForOp('set', sessionBuildContextKeyFor('m_self')).domain).toBe('machine-local');
    expect(reg.domainForOp('set', 'session-build-context').domain).toBe('cluster-shared');
  });

  it('a PREFIX of a classified key is NOT classified (exact-key, never prefix)', () => {
    expect(reg.domainForOp('set', 'session-build-context-').domain).toBe('cluster-shared');
    expect(reg.domainForOp('set', `${sessionBuildContextKeyFor('m_self')}-extra`).domain).toBe('cluster-shared');
  });

  it('I8: unclassified ops and keys default cluster-shared — today’s exact guard', () => {
    expect(reg.domainForOp('set', 'anything-else').domain).toBe('cluster-shared');
    expect(reg.domainForOp('delete', 'anything-else').domain).toBe('cluster-shared');
    expect(reg.domainForOp('unknownOp').domain).toBe('cluster-shared');
  });

  it('the wave-1 op classifications match §3.1: session writes scoped, jobs/events cluster-shared', () => {
    expect(reg.domainForOp('saveSession').domain).toBe('session-scoped');
    expect(reg.domainForOp('removeSession').domain).toBe('session-scoped');
    expect(reg.domainForOp('saveJobState').domain).toBe('cluster-shared');
    expect(reg.domainForOp('appendEvent').domain).toBe('cluster-shared');
  });
});

describe('machine-id key jail (§3.3 round-2 L3)', () => {
  it('jails every char outside [A-Za-z0-9_-] so StateManager.validateKey always passes', () => {
    expect(jailMachineIdForKey('m.self/../etc')).toBe('m_self____etc');
    expect(/^[a-zA-Z0-9_-]+$/.test(sessionBuildContextKeyFor('we.ird id!'))).toBe(true);
  });

  it('identity-less installs embed the literal "local" — never "null"/"undefined"', () => {
    expect(sessionBuildContextKeyFor(null)).toBe('session-build-context-local');
    expect(sessionBuildContextKeyFor(undefined)).toBe('session-build-context-local');
    expect(sessionBuildContextKeyFor('  ')).toBe('session-build-context-local');
  });
});

describe('wave-1 route entries (§3.5)', () => {
  const reg = buildWriteDomainRegistry({ machineId: 'm_self' });

  it('the P2-6 families are machine-local with two-axis stories', () => {
    for (const [method, p] of [
      ['POST', '/evolution/actions'],
      ['PATCH', '/evolution/actions/ACT-1'],
      ['POST', '/evolution/gaps'],
      ['PATCH', '/evolution/proposals/x'],
      ['POST', '/attention'],
      ['PATCH', '/attention/att-1'],
    ] as const) {
      const e = reg.entryForRoute(method, p);
      expect(e, `${method} ${p}`).not.toBeNull();
      expect(e!.domain).toBe('machine-local');
      expect(e!.story?.fileLevel).toBe('git-sync-excluded');
      expect(e!.story?.onSharedGitSyncedPath).toBe(true);
    }
    expect(reg.refusedClassifications.length).toBe(0);
  });

  it('non-mutating / unrelated routes resolve null (unwired — I8)', () => {
    expect(reg.entryForRoute('POST', '/sessions/spawn')).toBeNull();
    expect(reg.entryForRoute('DELETE', '/attention/att-1')).toBeNull();
  });

  it('classifies apprenticeship instance mutations as cluster-shared', () => {
    const entry = reg.entryForRoute('POST', '/apprenticeship/instances/example/rung-transition');
    expect(entry?.domain).toBe('cluster-shared');
  });

  it('the physical Playwright seat lease is machine-local outside git sync', () => {
    for (const path of ['/playwright-profiles/seat/acquire', '/playwright-profiles/seat/release']) {
      const entry = reg.entryForRoute('POST', path);
      expect(entry?.domain).toBe('machine-local');
      expect(entry?.story?.logical).toBe('per-machine-path');
      expect(entry?.story?.onSharedGitSyncedPath).toBe(false);
    }
  });

  it('Codex continuation mutations stay with the local owning session', () => {
    for (const path of [
      '/continuation/start',
      '/continuation/123/complete',
      '/continuation/123/stop',
      '/continuation/stop-all',
      '/continuation/decide',
    ]) {
      const entry = reg.entryForRoute('POST', path);
      expect(entry?.domain, path).toBe('machine-local');
      expect(entry?.story?.logical, path).toBe('git-sync-excluded');
      expect(entry?.story?.onSharedGitSyncedPath, path).toBe(true);
      expect(entry?.story?.fileLevel, path).toBe('git-sync-excluded');
    }
  });
});

describe('registry↔wiring identity (the PR-#334 dead-code lesson)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');

  it('the server wires THE SAME builder the tests read (server.ts imports buildWriteDomainRegistry)', () => {
    const serverSrc = fs.readFileSync(path.join(repoRoot, 'src', 'commands', 'server.ts'), 'utf-8');
    expect(serverSrc).toContain('buildWriteDomainRegistry({ machineId: waMachineId })');
    expect(serverSrc).toContain("state.attachWriteAdmission(writeAdmission)");
  });

  it('every wave-1 route family in the registry has a live refuseInadmissibleWrite callsite in routes.ts', () => {
    const routesSrc = fs.readFileSync(path.join(repoRoot, 'src', 'server', 'routes.ts'), 'utf-8');
    // The helper exists and consults ctx.writeAdmission.guardRouteWrite.
    expect(routesSrc).toContain('wa.guardRouteWrite(req.method, req.path');
    // Wave-1 wiring: at least the two P2-6 anchor routes call the seam.
    const postActions = routesSrc.indexOf("router.post('/evolution/actions'");
    const postAttention = routesSrc.indexOf("router.post('/attention'");
    expect(postActions).toBeGreaterThan(-1);
    expect(postAttention).toBeGreaterThan(-1);
    for (const idx of [postActions, postAttention]) {
      const handler = routesSrc.slice(idx, idx + 3000);
      expect(handler).toContain('refuseInadmissibleWrite(req, res)');
    }
  });

  it('the wave-2 inventory latch ships FALSE in wave 1 (§9.14 — dryRun:false cannot grant authority yet)', () => {
    expect(WRITE_SURFACE_INVENTORY_COMPLETE).toBe(false);
  });
});
