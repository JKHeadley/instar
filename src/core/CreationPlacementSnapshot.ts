/** Complete, non-flushing Chief placement read kept off conversation HTTP handlers. */
import fs from 'node:fs';
import path from 'node:path';
import { foldTreeState, foldBindingState, type UnionEntry } from './ChiefOfStaffStore.js';

export interface CreationPlacementView {
  version: string;
  complete: boolean;
  parents: ReadonlyMap<string, string | null>;
  confirmedProjects: ReadonlySet<string>;
}

/** Failures are unknown; ENOENT is a genuinely absent stream directory only. */
export function creationPlacementSourceVersion(stateDir: string, pending: unknown): string | null {
  try {
    // A stable queue signature is still an incomplete durable view. Do not publish absence
    // while a recorded placement is waiting to reach the journal's high-water mark.
    if (Array.isArray(pending) && pending.some(status => status && typeof status === 'object'
      && typeof status.lastSeq === 'number' && typeof status.highWaterSeq === 'number'
      && status.lastSeq > status.highWaterSeq)) return null;
    const root = path.join(stateDir, 'state', 'coherence-journal');
    const files: unknown[] = [];
    for (const dir of [root, path.join(root, 'peers')]) {
      let names: string[];
      try { names = fs.readdirSync(dir); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') { files.push([dir, 'absent']); continue; } throw err; }
      const relevant = names.filter(n => /^.+\.chief-of-staff-record(?:\.\d+)?\.jsonl$/.test(n)).sort();
      files.push([dir, relevant.map(n => { const s = fs.statSync(path.join(dir, n)); return [n, s.size, s.mtimeMs, s.ctimeMs, s.ino]; })]);
    }
    return JSON.stringify([files, pending]);
  } catch { return null; /* @silent-fallback-ok: null explicitly means unavailable, never an empty authoritative tree. */ }
}

export class CreationPlacementSnapshot {
  private view: CreationPlacementView | null = null;
  private attempted: string | null | undefined = undefined;
  private queued = false;
  constructor(private readonly deps: { enabled(): boolean; version(): string | null; load(): UnionEntry[] | null }) {}

  get(): CreationPlacementView {
    if (!this.deps.enabled()) return this.unknown('disabled');
    const version = this.deps.version();
    if (version !== null && this.view?.version === version) return this.view;
    if (version !== this.attempted) this.refresh();
    return this.unknown(version ?? 'unavailable');
  }

  refresh(): void {
    if (this.queued || !this.deps.enabled()) return;
    this.queued = true;
    setImmediate(() => {
      this.queued = false;
      const before = this.deps.version();
      this.attempted = before;
      if (before === null) { this.view = null; return; }
      try {
        const union = this.deps.load();
        const after = this.deps.version();
        if (!union || after !== before || !this.deps.enabled()) { this.view = null; return; }
        const parents = new Map([...foldTreeState(union)].map(([key, node]) => [key, node.parentConversationKey]));
        const confirmedProjects = new Set([...foldBindingState(union)].filter(([, b]) => !!b.binding && b.confirmed && !b.closed).map(([key]) => key));
        this.view = { version: before, complete: true, parents, confirmedProjects };
      } catch { this.view = null; /* @silent-fallback-ok: exposed as incomplete and retried by existing Chief ticks/source changes. */ }
    });
  }
  private unknown(version: string): CreationPlacementView { return { version, complete: false, parents: new Map(), confirmedProjects: new Set() }; }
}
