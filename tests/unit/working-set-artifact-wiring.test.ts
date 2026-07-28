/**
 * Wiring-integrity tests for spec #4 (intelligent-working-set-lazy-sync — the interactive
 * working-set artifact kind). Mirrors ws25-evolution-actions-wiring: a feature whose wiring is
 * silently dropped passes its unit tests but fails HERE. Three layers:
 *
 *  1. SOURCE assertions — the dual registry carries `working-set-artifact` in BOTH halves
 *     (JOURNAL_KINDS static + server.ts registers WORKING_SET_ARTIFACT_KIND_REGISTRATION and
 *     builds the union reader + emit seam); ConfigDefaults ships the dark defaults; the recorder
 *     hook is written by migrateHooks + registered by migrateSettings + the settings template;
 *     the session-start hook injects the grounding block; the recorder route is wired.
 *  2. FUNCTIONAL registration — the registry accepts the kind and resolves it by store.
 *  3. DUAL-REGISTRY coupling — the kind is in JOURNAL_KINDS AND registered (the silent
 *     no-replication trap is naming only one half).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  WORKING_SET_ARTIFACT_KIND_REGISTRATION,
  WORKING_SET_ARTIFACT_KIND,
  WORKING_SET_ARTIFACT_STORE_KEY,
} from '../../src/core/WorkingSetArtifactReplicatedStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('WS artifact wiring — 1. SOURCE assertions (silent-drop guards)', () => {
  it('server.ts registers WORKING_SET_ARTIFACT_KIND_REGISTRATION (dual-registry dynamic half)', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain('WORKING_SET_ARTIFACT_KIND_REGISTRATION');
    expect(src).toContain('replicatedKindRegistry.register(WORKING_SET_ARTIFACT_KIND_REGISTRATION)');
  });

  it('server.ts builds the working-set-artifact union reader + emit seam', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain('WorkingSetArtifactManager');
    expect(src).toContain('workingSetArtifactUnionReader');
    expect(src).toContain('setReplicationEmitter');
    // The route reuses the SAME hoisted instance (sharing is load-bearing for replication).
    expect(src).toContain('let workingSetArtifactManager');
  });

  it('ConfigDefaults ships the dark recorder defaults (recordInteractive false, recordTtlDays 30)', () => {
    const src = read('src/config/ConfigDefaults.ts');
    expect(src).toContain('recordInteractive: false');
    expect(src).toContain('recordTtlDays: 30');
  });

  it('migrateHooks writes the recorder hook + migrateSettings registers the PostToolUse matcher', () => {
    const src = read('src/core/PostUpdateMigrator.ts');
    expect(src).toContain('working-set-artifact-recorder.js');
    expect(src).toContain('getWorkingSetArtifactRecorderHook');
    // PostToolUse Write/Edit registration (existing-agent parity).
    expect(src).toContain("matcher: 'Write|Edit|MultiEdit'");
    // Session-start Layer-3 grounding injection.
    expect(src).toContain('/coherence/working-set/session-context?topic=');
  });

  it('new-install settings template registers the PostToolUse recorder', () => {
    const tpl = read('src/templates/hooks/settings-template.json');
    expect(tpl).toContain('working-set-artifact-recorder.js');
    expect(tpl).toContain('Write|Edit|MultiEdit');
  });

  it('routes.ts wires the recorder + read + grounding routes on the shared manager', () => {
    const src = read('src/server/routes.ts');
    expect(src).toContain("router.post('/coherence/working-set/record'");
    expect(src).toContain("router.get('/coherence/working-set'");
    expect(src).toContain("router.get('/coherence/working-set/session-context'");
    expect(src).toContain('ctx.workingSetArtifactManager');
    // Grounding is advisory + enveloped (untrusted filename data, never an instruction).
    expect(src).toContain('replicated-untrusted-data source="working-set-artifacts"');
  });
});

describe('WS artifact wiring — 2. FUNCTIONAL registration', () => {
  it('the registry accepts the kind and resolves it by store', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(WORKING_SET_ARTIFACT_KIND_REGISTRATION);
    const byStore = registry.getByStore(WORKING_SET_ARTIFACT_STORE_KEY);
    expect(byStore?.kind).toBe(WORKING_SET_ARTIFACT_KIND);
  });
});

describe('WS artifact wiring — 3. DUAL-REGISTRY coupling (both halves or silent no-replication)', () => {
  it('the kind is in JOURNAL_KINDS (static half) AND carried by the registration descriptor', () => {
    expect(JOURNAL_KINDS).toContain(WORKING_SET_ARTIFACT_KIND);
    expect(WORKING_SET_ARTIFACT_KIND_REGISTRATION.kind).toBe(WORKING_SET_ARTIFACT_KIND);
  });

  it('the JournalKind carries a retention bound (exhaustive Record<JournalKind> map)', () => {
    expect(DEFAULT_RETENTION[WORKING_SET_ARTIFACT_KIND]).toBeDefined();
  });
});
