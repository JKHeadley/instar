import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { INITIATIVE_TASKFLOW_CONTROLLER_ID } from '../core/InitiativeTracker.js';

export interface TaskFlowProjectsAuthorityProof {
  /** The currently selected same-agent TaskFlow authority's native database. */
  databasePath: string;
  /**
   * The source owner's synchronous proof at release. Enrollment must already
   * establish that scoped revision, ownership, grants, and erasure can be
   * checked here without another scan or a hidden-dependent revision.
   */
  isCurrent(): boolean;
}

interface ProjectsSnapshot {
  coverage: 'complete' | 'partial';
  items: Array<{ id: string; title: string }>;
  relationsComplete: false;
}

export interface TaskFlowProjectsComparisonOptions {
  /**
   * Return proof only when an approved disposable or development installation
   * can prove the entire native database work envelope belongs to this
   * private owner, including out-of-kind records and SQLite pager work. No proof means no database access.
   */
  proveAuthority(): TaskFlowProjectsAuthorityProof | null;
  workerUrl?: URL;
}

const require = createRequire(import.meta.url);
const MAX_INPUT_ROWS = 5_000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_ROWS = 250;
const MAX_WORKER_MS = 1_800;

export function createTaskFlowProjectsComparisonSource(options: TaskFlowProjectsComparisonOptions) {
  return {
    async read(signal: AbortSignal): Promise<{ snapshot: ProjectsSnapshot; release: () => boolean } | null> {
      if (signal.aborted) return null;
      let proof: TaskFlowProjectsAuthorityProof | null;
      try {
        proof = options.proveAuthority();
        if (!proof || !path.isAbsolute(proof.databasePath) || !proof.isCurrent()) return null;
      } catch {
        return null;
      }

      const snapshot = await new Promise<ProjectsSnapshot | null>(resolve => {
        let worker: Worker;
        try {
          worker = new Worker(options.workerUrl ?? new URL('./taskFlowProjectsComparison.worker.js', import.meta.url), {
            env: {},
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16 },
            workerData: {
              databasePath: proof.databasePath,
              sqliteModule: require.resolve('better-sqlite3'),
              controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
              maxInputRows: MAX_INPUT_ROWS,
              maxInputBytes: MAX_INPUT_BYTES,
              maxProjectRows: MAX_PROJECT_ROWS,
            },
          });
        } catch {
          resolve(null);
          return;
        }
        let cancelled = false;
        let result: ProjectsSnapshot | null = null;
        const cancel = () => {
          cancelled = true;
          void worker.terminate().catch(() => { /* Settle only upon worker exit. */ });
        };
        const timer = setTimeout(cancel, MAX_WORKER_MS);
        timer.unref();
        signal.addEventListener('abort', cancel, { once: true });
        worker.once('message', (snapshot: ProjectsSnapshot | null) => { result = snapshot; });
        worker.once('error', () => { cancelled = true; });
        worker.once('exit', code => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          resolve(code === 0 && !cancelled && !signal.aborted ? result : null);
        });
        if (signal.aborted) cancel();
      });
      if (!snapshot) return null;
      return {
        snapshot,
        release: () => {
          try { return !signal.aborted && proof.isCurrent(); }
          catch { return false; }
        },
      };
    },
  };
}
