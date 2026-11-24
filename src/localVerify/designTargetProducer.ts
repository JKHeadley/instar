/** Internal verifier lifecycle only. No run-JSON activation or candidate-authored build receipts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTargetBuildAuthority, type TargetCommand, type TargetBuildAuthority } from '../designGate/targetBuild.js';
import { createRuntimeSnapshotOwner, runtimeSnapshotDescription, validateRuntimeSnapshot, type RuntimeSnapshotHandle, type SnapshotBudget } from '../designGate/runtimeSnapshot.js';
import type { ExecResult } from './orchestrator.js';
export interface DesignTargetContext {
  readonly runId: string; readonly verifyRoot: string; readonly runDir: string;
  readonly baseSha: string; readonly mergeTree: string; readonly headSha: string;
  readonly deadlineAt: number; readonly now: () => number;
  readonly changedPaths: readonly string[];
  readonly readBaseFile: (file: string) => Promise<string | null>;
  readonly readSourceIdentity: () => Promise<{ tree: string; clean: boolean }>;
}
export interface DesignTargetRelease { status: 'released' | 'cleanup-unconfirmed'; roots: readonly string[]; ownershipRetained?: true }
export interface DesignTargetProducer {
  observeCommand(command: TargetCommand, execute: () => Promise<ExecResult>): Promise<void>;
  completeBuild(): Promise<void>;
  postLanes(signal?: AbortSignal): Promise<void>;
  release(): Promise<DesignTargetRelease>;
}
export interface DesignTargetPort { open(context: DesignTargetContext): Promise<DesignTargetProducer | null> }
type SnapshotOwner = Awaited<ReturnType<typeof createRuntimeSnapshotOwner>>;
type Retry = () => Promise<DesignTargetRelease>;
/** Live registration is not serializable. The installed backend must journal/read back actual inflight custody. */
export interface DesignTargetCustodyLease {
  readonly runId: string; readonly verifyRoot: string; readonly runDir: string;
  readonly attempt: { attemptToken: string; pid: number; pgid: number };
  readonly registration: { id: string; retryRelease: Retry };
  assertOwned(purpose: 'admission' | 'recovery'): Promise<void>;
  admitRoot(root: string): Promise<{ root: string; registration: DesignTargetCustodyLease['registration'] }>;
  reconcile(outcome: DesignTargetRelease): Promise<void>;
}
export interface InstalledDesignTargetOptions {
  selectFromBase(context: Pick<DesignTargetContext, 'baseSha' | 'mergeTree' | 'headSha' | 'changedPaths' | 'readBaseFile'>): Promise<boolean>;
  budget: SnapshotBudget;
  handoff(lease: { snapshot: RuntimeSnapshotHandle; deadlineAt: number; now: () => number; signal?: AbortSignal; reserveChildLaunch: SnapshotOwner['reserveChildLaunch'] }): Promise<void>;
  /** Must retain retryRelease and journal exact attempt/root ownership BEFORE acknowledging. */
  custody: { establish(context: DesignTargetContext, retryRelease: Retry): Promise<DesignTargetCustodyLease> };
}
export function createInstalledDesignTargetProducer(options: InstalledDesignTargetOptions): DesignTargetPort {
  if (typeof options.selectFromBase !== 'function' || typeof options.handoff !== 'function' || typeof options.custody?.establish !== 'function') throw new Error('Design target requires installed selector, consumer and upfront custody');
  const budget = Object.freeze({ ...options.budget }), selectFromBase = options.selectFromBase, handoff = options.handoff, custody = options.custody;
  return Object.freeze({
    async open(context: DesignTargetContext): Promise<DesignTargetProducer | null> {
      if (!await selectFromBase(Object.freeze({ baseSha: context.baseSha, mergeTree: context.mergeTree, headSha: context.headSha, changedPaths: context.changedPaths, readBaseFile: context.readBaseFile }))) return null;
      const verifyRoot = await fs.realpath(context.verifyRoot), runDir = await fs.realpath(context.runDir);
      let authority: TargetBuildAuthority | undefined, owner: SnapshotOwner | undefined, snapshot: RuntimeSnapshotHandle | undefined, lease: DesignTargetCustodyLease | undefined;
      let closed = false, completing = false;
      const check = (signal?: AbortSignal) => {
        if (closed || signal?.aborted) throw new Error('Design producer admission revoked');
        if (context.now() >= context.deadlineAt) throw new Error('Design producer total deadline expired');
      };
      const release: Retry = async () => {
        closed = true; authority?.release();
        const outcome = owner ? await owner.release() : { status: 'released' as const, roots: [] };
        if (!lease) return outcome;
        try { await lease.reconcile(outcome); }
        catch {
          // The already-established owner retains this SAME retry closure; reconciliation failure is not release.
          await lease.assertOwned('recovery');
          return { status: 'cleanup-unconfirmed', roots: outcome.roots, ownershipRetained: true };
        }
        if (outcome.status === 'cleanup-unconfirmed') { await lease.assertOwned('recovery'); return { ...outcome, ownershipRetained: true }; }
        return outcome;
      };
      try {
        check();
        const accepted = await custody.establish(context, release);
        if (!accepted || accepted.runId !== context.runId || accepted.verifyRoot !== verifyRoot || accepted.runDir !== runDir
          || !/^[a-f0-9]{16,64}$/.test(accepted.attempt?.attemptToken ?? '') || accepted.attempt.pid !== process.pid || accepted.attempt.pgid !== process.pid
          || !accepted.registration?.id || accepted.registration.retryRelease !== release
          || typeof accepted.assertOwned !== 'function' || typeof accepted.admitRoot !== 'function' || typeof accepted.reconcile !== 'function') throw new Error('Missing or mismatched live design custody registration');
        lease = accepted; check(); await lease.assertOwned('admission'); check();
        authority = await createTargetBuildAuthority({ root: runDir, identity: { runId: context.runId, side: 'merge', baseSha: context.baseSha, tree: context.mergeTree }, readSourceIdentity: context.readSourceIdentity }); check();
      } catch (error) { if (lease) { try { await release(); } catch { /* Upfront custodian still owns the retry closure. */ } } throw error; }
      return Object.freeze({
        async observeCommand(command: TargetCommand, execute: () => Promise<ExecResult>) { check(); await authority!.observeCommand(command, execute); },
        async completeBuild() {
          check(); if (completing || snapshot) throw new Error('Design build completion already used'); completing = true;
          await lease!.assertOwned('admission'); check();
          const source = await authority!.seal(); check();
          owner = await createRuntimeSnapshotOwner({ verifyRoot, runDir, runId: context.runId, deadlineAt: context.deadlineAt, budget, now: context.now,
            admitRoot: async root => {
              check(); await lease!.assertOwned('admission'); check();
              const receipt = await lease!.admitRoot(root); check();
              if (receipt?.root !== root || receipt.registration !== lease!.registration || !root.startsWith(path.join(verifyRoot, 'design-targets') + path.sep)) throw new Error('Exact snapshot root lacks live durable custody');
            } }); check();
          snapshot = await owner.materialize(source); check();
        },
        async postLanes(signal?: AbortSignal) {
          check(signal); if (!snapshot || !owner) throw new Error('No owned completed design build');
          await lease!.assertOwned('admission'); check(signal);
          const current = await context.readSourceIdentity(); check(signal);
          if (current.tree !== context.mergeTree || !current.clean) throw new Error('Design source binding changed before handoff');
          await validateRuntimeSnapshot(snapshot); check(signal);
          await handoff({ snapshot, deadlineAt: context.deadlineAt, now: context.now, signal,
            reserveChildLaunch: handle => {
              check(signal); const admitted = owner!.reserveChildLaunch(handle);
              return Object.freeze({ beforeSpawn: () => { check(signal); admitted.beforeSpawn(); }, started: admitted.started, notStarted: admitted.notStarted });
            } }); check(signal);
          await validateRuntimeSnapshot(snapshot); check(signal); runtimeSnapshotDescription(snapshot);
        },
        release,
      });
    },
  });
}
