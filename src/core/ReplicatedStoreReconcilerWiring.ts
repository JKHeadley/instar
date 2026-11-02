/**
 * The per-store seams and the git-carried probe for ReplicatedStoreReconciler.
 *
 * Spec: docs/specs/statesync-writer-agnostic-reconciler.md §5.4–§6.
 *
 * Kept out of server.ts so the wiring ratchet can assert, in a unit test, that every
 * registered replicated store is either seamed here or allow-listed with a reason, and
 * that each seam calls the SAME builder (with the same options) as its in-process hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { ReconcileRow, ReconcileStoreSeam, GitCarriedVerdict } from './ReplicatedStoreReconciler.js';
import type { BuildRecordData } from './ReplicatedRecordEmitter.js';
import { stableJson } from './stableJson.js';
import { readDeletionIntents } from './DeletionIntentLog.js';
import { redactForLiveTail } from './liveTailRedaction.js';
import { PreferencesManager } from './PreferencesManager.js';
import { PREF_STORE_KEY, buildPrefRecordData } from './PreferencesReplicatedStore.js';
import { RelationshipManager } from './RelationshipManager.js';
import {
  RELATIONSHIP_STORE_KEY,
  deriveRelationshipRecordKey,
  buildRelationshipRecordData,
  buildRelationshipTombstoneFromKey,
} from './RelationshipsReplicatedStore.js';
import { KnowledgeManager } from '../knowledge/KnowledgeManager.js';
import {
  KNOWLEDGE_STORE_KEY,
  deriveKnowledgeRecordKey,
  buildKnowledgeRecordData,
  buildKnowledgeTombstoneFromKey,
} from './KnowledgeReplicatedStore.js';
import { UserManager } from '../users/UserManager.js';
import { USER_STORE_KEY, deriveUserRecordKey, buildUserRecordData } from './UserRegistryReplicatedStore.js';
import { LEARNING_STORE_KEY, deriveLearningRecordKey, buildLearningRecordData } from './LearningsReplicatedStore.js';
import {
  EVOLUTION_ACTION_STORE_KEY,
  deriveEvolutionActionRecordKey,
  buildEvolutionActionRecordData,
} from './EvolutionActionsReplicatedStore.js';
import { matchTestIdentity } from '../users/testIdentityMarkers.js';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import type { LearningEntry, ActionItem } from './types.js';

/**
 * Registered replicated stores the reconciler does NOT cover, each with its reason. The
 * wiring ratchet fails when a registered store is neither seamed nor listed here.
 */
export const RECONCILER_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  topicOperator: 'single server-constructed writer (TopicOperatorStore); no CLI or per-request path',
  threadlinePairing: 'written only by the server pairing flow; no CLI path',
  subscriptionAccountMeta: 'derived from the server subscription pool; no out-of-process writer',
  topicPins: 'written only by the server pin store; no CLI path',
  topicClaimAnnotations: 'written only by the server claim-annotation route; no CLI path',
  workingSetArtifact: 'written only by the server working-set recorder route; no CLI path',
  classReview: 'written only by the server class-review flow; no CLI path',
  appConversations: 'written only by the server app-conversation routes (AppConversationStore); no CLI path',
  mobileDeviceKeyLedger: 'written only by the server device activation/revocation paths and boot reconciliation (MobileDeviceKeyLedger); no CLI path',
});

function sourceFp(raw: unknown): string {
  return createHash('sha256').update(stableJson(raw)).digest('hex');
}

export interface ReconcilerSeamDeps {
  stateDir: string;
  /** `config.relationships.relationshipsDir`; absent ⇒ no relationships seam. */
  relationshipsDir?: string;
  testIdentityKey?: string;
  /** The server's EvolutionManager (its list methods re-read disk on every call). */
  evolution: { listLearnings(): LearningEntry[]; listActions(): ActionItem[] };
}

export function buildReconcilerSeams(deps: ReconcilerSeamDeps): ReconcileStoreSeam[] {
  const { stateDir } = deps;
  const seams: ReconcileStoreSeam[] = [];

  // preferences — sole writer is the correction loop; puts-only (no delete path).
  seams.push({
    store: PREF_STORE_KEY,
    paths: [path.join(stateDir, 'preferences.json')],
    snapshot: () => {
      const file = path.join(stateDir, 'preferences.json');
      if (!fs.existsSync(file)) return { rows: [], skipped: 0, present: false };
      const rows: ReconcileRow[] = [];
      for (const entry of new PreferencesManager(stateDir).read().preferences) {
        rows.push({
          recordKey: entry.dedupeKey,
          sourceFp: sourceFp(entry),
          build: (hlc, origin, observed) =>
            buildPrefRecordData({ entry, hlc, op: 'put', origin, observed, scrub: redactForLiveTail }),
        });
      }
      return { rows, skipped: 0, present: true };
    },
  });

  // relationships — one file per record; deletions from explicit intents.
  if (deps.relationshipsDir) {
    const dir = deps.relationshipsDir;
    seams.push({
      store: RELATIONSHIP_STORE_KEY,
      paths: [dir],
      snapshot: () => {
        const read = RelationshipManager.readAllFromDisk(dir);
        const rows: ReconcileRow[] = [];
        let skipped = read.skipped;
        for (const record of read.records) {
          if (matchTestIdentity({ id: '', channels: record.channels ?? [] }) !== null) {
            skipped++;
            continue;
          }
          const key = deriveRelationshipRecordKey(record.channels ?? []);
          if (key === null) continue;
          rows.push({
            recordKey: key,
            sourceFp: sourceFp(record),
            build: (hlc, origin, observed) => buildRelationshipRecordData({ record, hlc, origin, observed }),
          });
        }
        return { rows, skipped, present: read.present };
      },
      deletionIntents: () => readDeletionIntents(stateDir, RELATIONSHIP_STORE_KEY),
      tombstoneFromKey: (recordKey, deletedAt): BuildRecordData => (hlc, origin, observed) =>
        buildRelationshipTombstoneFromKey({ recordKey, deletedAt, hlc, origin, observed }),
    });
  }

  // knowledge — the CLI is the only ingest path; deletions from explicit intents.
  seams.push({
    store: KNOWLEDGE_STORE_KEY,
    paths: [path.join(stateDir, 'knowledge', 'catalog.json')],
    snapshot: () => {
      const read = KnowledgeManager.readCatalogStrict(stateDir);
      const rows: ReconcileRow[] = [];
      for (const record of read.sources) {
        const key = deriveKnowledgeRecordKey(record.title, record.url, record.type);
        if (key === null) continue;
        rows.push({
          recordKey: key,
          sourceFp: sourceFp(record),
          build: (hlc, origin, observed) => buildKnowledgeRecordData({ record, hlc, origin, observed }),
        });
      }
      return { rows, skipped: read.skipped, present: read.present };
    },
    deletionIntents: () => readDeletionIntents(stateDir, KNOWLEDGE_STORE_KEY),
    tombstoneFromKey: (recordKey, deletedAt): BuildRecordData => (hlc, origin, observed) =>
      buildKnowledgeTombstoneFromKey({ recordKey, deletedAt, hlc, origin, observed }),
  });

  // userRegistry — puts-only (several in-memory managers rewrite users.json whole).
  seams.push({
    store: USER_STORE_KEY,
    paths: [path.join(stateDir, 'users.json')],
    snapshot: () => {
      const read = UserManager.readProfilesFromDisk(stateDir, deps.testIdentityKey);
      const rows: ReconcileRow[] = [];
      for (const record of read.profiles) {
        const key = deriveUserRecordKey(record.channels);
        if (key === null) continue;
        rows.push({
          recordKey: key,
          sourceFp: sourceFp(record),
          build: (hlc, origin, observed) => buildUserRecordData({ record, hlc, origin, observed }),
        });
      }
      return { rows, skipped: read.skipped, present: read.present };
    },
  });

  // learnings — puts-only.
  seams.push({
    store: LEARNING_STORE_KEY,
    paths: [path.join(stateDir, 'state', 'evolution', 'learning-registry.json')],
    snapshot: () => {
      const rows: ReconcileRow[] = [];
      for (const record of deps.evolution.listLearnings()) {
        const key = deriveLearningRecordKey(record.title, record.category, record.source);
        if (key === null) continue;
        rows.push({
          recordKey: key,
          sourceFp: sourceFp(record),
          build: (hlc, origin, observed) => buildLearningRecordData({ record, hlc, origin, observed }),
        });
      }
      return { rows, skipped: 0, present: true };
    },
  });

  // evolutionActions — puts-only.
  seams.push({
    store: EVOLUTION_ACTION_STORE_KEY,
    paths: [path.join(stateDir, 'state', 'evolution', 'action-queue.json')],
    snapshot: () => {
      const rows: ReconcileRow[] = [];
      for (const record of deps.evolution.listActions()) {
        const key = deriveEvolutionActionRecordKey(record.title, record.commitTo, record.createdAt);
        if (key === null) continue;
        rows.push({
          recordKey: key,
          sourceFp: sourceFp(record),
          build: (hlc, origin, observed) => buildEvolutionActionRecordData({ record, hlc, origin, observed }),
        });
      }
      return { rows, skipped: 0, present: true };
    },
  });

  return seams;
}

// ── Git-carried probe (§5.5) ───────────────────────────────────────────────

export interface GitProbeDeps {
  /** The repo working directory to run git in (the project dir). */
  cwd: string;
  /** Is git-sync active here (a GitSyncManager, or an enabled `git-sync` job)? */
  gitSyncActive: () => boolean;
  /** Injectable git runner (tests). Resolves stdout; rejects on a non-zero exit. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** Files whose mtime invalidates the cached verdicts (index + ignore files). */
  watchFiles?: string[];
}

function defaultRunGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = SafeGitExecutor.readStream(args, {
        cwd,
        operation: 'src/core/ReplicatedStoreReconcilerWiring.ts:gitCarried',
        sourceTreeReadOk: true,
        timeout: 15_000,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`git exited ${code}`))));
  });
}

function mtimeSig(files: string[]): string {
  return files
    .map((f) => {
      try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { /* @silent-fallback-ok: an absent watch file is part of the signature. */ return `${f}:-`; }
    })
    .join('|');
}

/**
 * A store is carried when any of its paths is tracked by git (peer content may already be
 * in it), or git-sync is active and a path holds untracked, non-ignored files. Outside a
 * git work tree nothing can carry it. Verdicts are cached until git-sync state, the index
 * or an ignore file changes, so steady-state ticks spawn no git process.
 */
export function makeGitCarriedProbe(deps: GitProbeDeps): (seam: ReconcileStoreSeam) => Promise<GitCarriedVerdict> {
  const runGit = deps.runGit ?? defaultRunGit;
  const watch = deps.watchFiles ?? [
    path.join(deps.cwd, '.git', 'index'),
    path.join(deps.cwd, '.gitignore'),
    path.join(deps.cwd, '.instar', '.gitignore'),
  ];
  const cache = new Map<string, { sig: string; verdict: GitCarriedVerdict }>();
  let inWorkTree: boolean | null = null;
  return async (seam) => {
    const active = deps.gitSyncActive();
    const sig = `${active}|${mtimeSig(watch)}`;
    const hit = cache.get(seam.store);
    if (hit && hit.sig === sig && hit.verdict !== 'probe-failed') return hit.verdict;
    let verdict: GitCarriedVerdict;
    try {
      if (inWorkTree === null) {
        try {
          inWorkTree = (await runGit(['rev-parse', '--is-inside-work-tree'], deps.cwd)).trim() === 'true';
        } catch { /* @silent-fallback-ok: not a git work tree ⇒ nothing can carry the file. */
          inWorkTree = false;
        }
      }
      if (!inWorkTree) {
        verdict = 'local';
      } else {
        const rel = seam.paths.map((p) => path.relative(deps.cwd, p)).filter((p) => !p.startsWith('..'));
        if (rel.length === 0) {
          verdict = 'local';
        } else {
          const tracked = (await runGit(['ls-files', '--', ...rel], deps.cwd)).trim().length > 0;
          if (tracked) verdict = 'carried';
          else if (!active) verdict = 'local';
          else {
            const untracked = (await runGit(['ls-files', '--others', '--exclude-standard', '--', ...rel], deps.cwd)).trim();
            verdict = untracked.length > 0 ? 'carried' : 'local';
          }
        }
      }
    } catch { /* @silent-fallback-ok: an unexpected git failure skips the store (the safe side) and is counted as probe-failed, never read as a quiet success. */
      verdict = 'probe-failed';
    }
    cache.set(seam.store, { sig, verdict });
    return verdict;
  };
}
