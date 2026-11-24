import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { CoherenceJournal } from './CoherenceJournal.js';

export interface ChiefOfStaffComparisonKey {
  conversationKey: string;
  hasInitiativePointer: boolean;
}

interface Options {
  journal: CoherenceJournal;
  /**
   * Existing trusted authority for the request's single-agent, disposable,
   * whole-owner scope. It must cover the local journal work envelope (including
   * directory inventory), all referenced identities, and current grants and
   * erasure. No peers or out-of-band writers may participate.
   */
  isAuthorized(): boolean;
  workerUrl?: URL;
}

export interface ChiefOfStaffComparisonWorkerInput {
  file: string;
  machine: string;
  lastSeq: number;
  fingerprint: string;
  byteLimit: number;
  keyLimit: number;
  directoryEntryLimit: number;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_KEYS = 250;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_WORKER_MS = 1_800;

export function comparisonJournalFingerprint(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** A local source observation. Its caller retains publication authority. */
export function createChiefOfStaffProjectComparisonJournal(options: Options) {
  return {
    async read(signal: AbortSignal): Promise<{ keys: ChiefOfStaffComparisonKey[]; release: () => boolean } | null> {
      if (signal.aborted) return null;

      let release: () => boolean;
      let input: ChiefOfStaffComparisonWorkerInput;
      try {
        if (!options.isAuthorized()) return null;
        const frontier = options.journal.chiefOfStaffComparisonFrontier();
        if (!frontier || !path.isAbsolute(frontier.file) || frontier.lastSeq > MAX_ROWS) return null;
        const stat = fs.lstatSync(frontier.file, { bigint: true });
        if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(MAX_BYTES)) return null;
        const fingerprint = comparisonJournalFingerprint(stat);
        input = {
          file: frontier.file, machine: frontier.machine, lastSeq: frontier.lastSeq, fingerprint,
          byteLimit: MAX_BYTES, keyLimit: MAX_KEYS, directoryEntryLimit: MAX_DIRECTORY_ENTRIES,
        };
        release = () => {
          if (signal.aborted) return false;
          try {
            return options.isAuthorized() && frontier.isCurrent()
              && comparisonJournalFingerprint(fs.lstatSync(frontier.file, { bigint: true })) === fingerprint;
          } catch {
            return false;
          }
        };
      } catch {
        return null;
      }

      const keys = await new Promise<ChiefOfStaffComparisonKey[] | null>(resolve => {
        let worker: Worker;
        try {
          worker = new Worker(options.workerUrl ?? new URL('./ChiefOfStaffProjectComparisonJournal.worker.js', import.meta.url), {
            env: {},
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16 },
            workerData: input,
          });
        } catch {
          resolve(null);
          return;
        }
        let cancelled = false;
        let result: ChiefOfStaffComparisonKey[] | null = null;
        const cancel = () => {
          if (cancelled) return;
          cancelled = true;
          void worker.terminate().catch(() => { /* Settle only after the worker exits. */ });
        };
        const timer = setTimeout(cancel, MAX_WORKER_MS);
        timer.unref();
        signal.addEventListener('abort', cancel, { once: true });
        worker.once('message', (keys: ChiefOfStaffComparisonKey[] | null) => { result = keys; });
        worker.once('error', () => { cancelled = true; });
        worker.once('exit', code => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          resolve(code === 0 && !cancelled && !signal.aborted ? result : null);
        });
        if (signal.aborted) cancel();
      });
      return keys && release() ? { keys, release } : null;
    },
  };
}
