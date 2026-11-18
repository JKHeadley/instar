/**
 * Wiring integrity for custom project apps (docs/specs/project-apps-sandbox.md). A part whose wiring
 * is silently dropped passes its own unit tests but fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { PROJECT_APP_BLOB_KIND_REGISTRATION, PROJECT_APP_BLOB_STORE_KEY } from '../../src/core/ProjectAppBlobStore.js';
import { RECONCILER_ALLOWLIST } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('custom project apps wiring', () => {
  it('the blob kind is in the journal with never-delete retention and its own state-sync flag', () => {
    expect(JOURNAL_KINDS).toContain('project-app-blob');
    expect(DEFAULT_RETENTION['project-app-blob' as keyof typeof DEFAULT_RETENTION]).toMatchObject({ rotateKeep: 0 });
    expect(read('src/core/JournalSyncApplier.ts')).toContain("'project-app-blob': 'multiMachine.stateSync.projectAppBlobs'");
    expect(PROJECT_APP_BLOB_STORE_KEY).toBe('projectAppBlobs');
    expect(RECONCILER_ALLOWLIST.projectAppBlobs).toMatch(/ProjectAppBlobStore/);
    const reg = new ReplicatedKindRegistry();
    reg.register(PROJECT_APP_BLOB_KIND_REGISTRATION);
  });

  it('server.ts registers the kind, forces its store on with custom apps, builds the real source and the sandbox, and invalidates and settles on commits', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain('replicatedKindRegistry.register(PROJECT_APP_BLOB_KIND_REGISTRATION)');
    expect(src).toContain('if (_projectAppsCustomOn) s = { ...s, projectAppBlobs: { enabled: true } };');
    expect(src).toContain('_projectAppCustom = new ProjectAppCustomSource({');
    expect(src).toContain('_projectAppSandbox = new ProjectAppSandbox({ source: paCustom, hmacSecret: () => paCustom.hmacSecret() });');
    expect(src).toContain('workBoardUnion: () => _workBoardRuntime?.svc.entries() ?? []');
    expect(src).toContain('projectAppSandbox: () => _projectAppSandbox, projectAppCustom: () => _projectAppCustom');
    // Both commit observers (own and peer) refold and then finish any version card the phone approved.
    expect((src.match(/kind === 'project-app-blob' \|\| kind === 'work-card-record'\) \{ _projectAppCustom\?\.invalidate\(\); _projectAppCustom\?\.scheduleSettle\(\); \}/g) ?? []).length).toBe(2);
    // And once at boot (an approve that landed while this machine was down or not the holder).
    expect(src).toContain('paCustom.scheduleSettle();');
    // The row carries whether the app runs, and folds counts past three instead of cutting them (§3.3).
    expect(src).toContain('customApp: (appRef) => (_projectAppCustom ? customAppRow(_projectAppCustom, appRef) : null),');
    expect(src).not.toMatch(/sum\.counts[^\n]*\.slice\(0, 3\)/);
    const rt = read('src/server/ProjectAppsRuntime.ts');
    expect(rt).toContain('runState: customAppRunState(src.servedVersion(a.appId).state)');
    expect(rt).toContain('...foldRowCounts(sum.counts)');
    // A stopped app's serve card reads as settled on the Work Board (read lazily: the source is wired later).
    expect(src).toContain('wbRuntime.svc.setStoppedAppCardCheck((cardId) => _projectAppCustom?.stoppedServeCard(cardId) === true);');
  });

  it('routes.ts mounts the custom routes and makes version cards phone-only on the Work Board', () => {
    const src = read('src/server/routes.ts');
    expect(src).toContain('mountProjectAppCustomRoutes(router, {');
    expect(src).toContain('phoneOnlyCard: (cardId) =>');
    expect(src).toContain('return isPhoneOnlyCard(src, cardId);'); // fails closed (L2)
    expect(read('src/server/AgentServer.ts')).toContain('projectAppCustom: options.projectAppCustom,');
  });

  it('the write domain names the custom-app routes', () => {
    const reg = buildWriteDomainRegistry({ machineId: 'm_self' });
    expect(reg.entryForRoute('POST', '/project-apps')).not.toBeNull();
    expect(reg.entryForRoute('PUT', '/project-apps/pa_0123456789abcdef/source')).not.toBeNull();
  });

  it('the key file is on the backup blocklist', () => {
    expect(read('src/core/BackupManager.ts')).toContain("'state/project-app-keys.json'");
  });
});
