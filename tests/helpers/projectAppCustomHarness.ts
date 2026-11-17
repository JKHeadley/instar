/**
 * A real ProjectAppCustomSource over in-memory journals (docs/specs/project-apps-sandbox.md):
 * the `project-app-record` and `project-app-blob` streams validated by their own store schemas,
 * a real WorkBoardService over its own stream, a real key file and disk blob store in a temp dir,
 * and a project dir with converged / unconverged specs. Shared by the unit and integration suites.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectAppCustomSource } from '../../src/server/ProjectAppCustomSource.js';
import { projectAppRecordStoreSchema } from '../../src/core/ProjectAppStore.js';
import { projectAppBlobStoreSchema } from '../../src/core/ProjectAppBlobStore.js';
import { WorkBoardService, resolveWorkBoardSettings } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema } from '../../src/core/WorkCardStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { StoreFieldSchema } from '../../src/core/ReplicatedRecordEnvelope.js';

export const OWNER = 'justin';
export const PROJECT = 'telegram:4242';
export const CONVERGED_SPEC = 'docs/specs/sales-app.md';
export const DRAFT_SPEC = 'docs/specs/draft-app.md';

type UnionEntry = { data: Record<string, unknown>; origin: string };
type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;
const CTX = { countDroppedField: () => {}, countJailReject: () => {} } as never;

export interface Harness {
  dir: string; stateDir: string;
  source: ProjectAppCustomSource;
  svc: WorkBoardService;
  records: UnionEntry[]; blobs: UnionEntry[]; board: UnionEntry[];
  notices: Array<{ conversationKey: string; text: string }>;
  lease: { holds: boolean; holder: string | null };
  now: () => number;
  advance: (ms: number) => void;
  /** A fresh source over the same journals and key file (another boot, or a reader). */
  rebuild: (overrides?: Partial<ConstructorParameters<typeof ProjectAppCustomSource>[0]>) => ProjectAppCustomSource;
}

export function makeHarness(opts: { limits?: ConstructorParameters<typeof ProjectAppCustomSource>[0]['limits']; owner?: string | null; dirs?: string[] } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'pa-custom-'));
  opts.dirs?.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, CONVERGED_SPEC), '---\ntitle: "Sales app"\nreview-convergence: "2026-11-17T00:00:00Z"\nreview-report: "docs/specs/reports/sales.md"\n---\n# Sales app\n');
  fs.writeFileSync(path.join(dir, DRAFT_SPEC), '---\ntitle: "Draft"\n---\n# Draft\n');
  fs.writeFileSync(path.join(dir, 'outside.md'), '---\nreview-convergence: x\nreview-report: y\n---\n');

  let clock = Date.parse('2026-11-17T03:00:00Z'); let logical = 0;
  const records: UnionEntry[] = []; const blobs: UnionEntry[] = []; const board: UnionEntry[] = [];
  const emitter = (into: UnionEntry[], schema: StoreFieldSchema) => (_key: string, build: Build) => {
    const hlc: HlcTimestamp = { physical: (clock += 10), logical: logical++, node: 'm_self' };
    const data = build(hlc, 'm_self');
    if (!data) return { outcome: 'skipped' };
    if (!schema.validate(data, CTX)) return { outcome: 'dropped:invalid' };
    into.push({ data, origin: 'm_self' });
    return { outcome: 'emitted', seq: into.length, hlc };
  };
  const settings = resolveWorkBoardSettings({});
  const owner = opts.owner === undefined ? OWNER : opts.owner;
  const svc = new WorkBoardService({
    machineId: 'm_self', emit: emitter(board, workCardRecordStoreSchema), loadUnion: () => board, now: () => clock, settings: () => settings,
    ownerPersonKey: () => owner, detectCredential: () => null, dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: '' }), displayName: (k) => k,
  });
  const notices: Array<{ conversationKey: string; text: string }> = [];
  const lease = { holds: true, holder: 'm_self' as string | null };
  const base = {
    machineId: 'm_self', stateDir, projectDir: dir,
    emitRecord: emitter(records, projectAppRecordStoreSchema),
    emitBlob: emitter(blobs, projectAppBlobStoreSchema),
    loadRecords: () => [...records], loadBlobs: () => [...blobs], workBoardUnion: () => svc.entries(), workBoard: () => svc,
    ownerPersonKey: () => owner,
    holdsLease: () => lease.holds, leaseHolder: () => lease.holder, leaseEpoch: () => 3,
    projects: () => [{ conversationKey: PROJECT, title: 'Example: sales pipeline' }],
    notifyProject: (conversationKey: string, text: string) => { notices.push({ conversationKey, text }); },
    now: () => clock,
    ...(opts.limits ? { limits: opts.limits } : {}),
  };
  const h: Harness = {
    dir, stateDir, svc, records, blobs, board, notices, lease,
    source: new ProjectAppCustomSource(base),
    now: () => clock,
    advance: (ms) => { clock += ms; },
    rebuild: (o = {}) => new ProjectAppCustomSource({ ...base, ...o }),
  };
  return h;
}

/** The owner's phone-presence approve on a card, through the Work Board's own tap (as the phone route does). */
export function phoneApprove(h: Harness, cardId: string, proof: 'presence' | 'pin' = 'presence') {
  const v = h.svc.view(cardId)!;
  const r = h.svc.tap({ kind: 'person', personKey: OWNER, proof, isOwner: true }, cardId, { action: 'approve', materialHash: v.card.materialHash });
  h.source.invalidate();
  return r;
}
