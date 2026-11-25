/**
 * Shared fixture for the borrowed-helper tests (docs/specs/local-verify-borrowed-unit-slices.md):
 * machine keys, an in-memory tree source, a fake GitHub, a scriptable owner-load reader and a
 * HelperService built on a FakeSandboxDriver in a temp state dir.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import type { RouteFacts } from '../../src/localVerify/helper/admission.js';
import { HelperService, type HelperServiceDeps } from '../../src/localVerify/helper/HelperService.js';
import { buildTar, type HeadVerdict, type HelperGitHubReader, type HostTreeSource, type MergeTreeResult, type TreeEntry } from '../../src/localVerify/helper/hostTree.js';
import { HelperDryRunStore, type SandboxImageIdentity } from '../../src/localVerify/helper/dryRunRecord.js';
import type { HelperLane } from '../../src/localVerify/helper/helperProtocol.js';
import type { OwnerLoadReader, OwnerSample } from '../../src/localVerify/helper/governor.js';
import { signHelperRequest, type HelperCancelRequest, type HelperLearnedRequest, type HelperSliceRequest } from '../../src/localVerify/helper/helperProtocol.js';
import type { HelperConfig } from '../../src/localVerify/helper/helperConfig.js';
import { FakeSandboxDriver } from './fakeSandboxDriver.js';

export const sha = (c: string): string => c.repeat(40);
export const id32 = (): string => crypto.randomBytes(16).toString('hex');

export function machineKeys(machineId: string): { signer: MachineSigner; publicKey: string; hash: string } {
  const k = generateSigningKeyPair();
  const hash = signerKeyHashOf(k.publicKey);
  return {
    publicKey: k.publicKey, hash,
    signer: { machineId: () => machineId, signerKeyHash: () => hash, sign: (payload) => ({ machineId, signerKeyHash: hash, sig: edSign(payload, k.privateKey) }) },
  };
}

export function pins(...keys: Array<{ publicKey: string; hash: string }>): MachineKeyLookup {
  return (_m, hash) => {
    const k = keys.find((x) => x.hash === hash);
    return k ? { status: 'ok', publicKeyPem: k.publicKey } : { status: 'unknown' };
  };
}

/** The tree hash the in-memory source gives a set of files (40 hex characters, like git's). */
export const memoryTreeHash = (files: Record<string, string>): string =>
  crypto.createHash('sha1').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex');

/**
 * An in-memory tree source. `files` holds each commit's files by commit id; a built merge tree is
 * added under its tree hash. The merge of two different commits is `merges["<base>:<head>"]`
 * (files, or `'conflict'`), or the head commit's own files when nothing is scripted (a change
 * based on that very `main`).
 */
export class MemoryTrees implements HostTreeSource {
  readonly kind = 'memory';
  fetched: string[] = [];
  merges: Record<string, Record<string, string> | 'conflict'> = {};
  archived: string[] = [];
  constructor(public files: Record<string, Record<string, string>>) {}
  async fetch(_url: string, shas: readonly string[]): Promise<void> {
    for (const s of shas) { this.fetched.push(s); if (!this.files[s]) throw new Error('no such commit'); }
  }
  async mergeTree(baseSha: string, headSha: string): Promise<MergeTreeResult> {
    if (!this.files[baseSha] || !this.files[headSha]) throw new Error('no such commit');
    const m = baseSha === headSha ? this.files[baseSha] : (this.merges[`${baseSha}:${headSha}`] ?? this.files[headSha]);
    if (m === 'conflict') return { conflict: true };
    const tree = memoryTreeHash(m);
    this.files[tree] = m;
    return { tree };
  }
  async entries(s: string): Promise<TreeEntry[]> {
    return Object.entries(this.files[s] ?? {}).map(([p, c]) => ({ mode: '100644', object: crypto.createHash('sha1').update(c).digest('hex'), path: p }));
  }
  async read(s: string, f: string): Promise<string | null> { return this.files[s]?.[f] ?? null; }
  async archive(s: string): Promise<Readable> {
    this.archived.push(s);
    return Readable.from([buildTar(Object.entries(this.files[s] ?? {}).map(([p, c]) => ({ path: p, mode: '100644', data: Buffer.from(c) })))]);
  }
}

/** A fake GitHub: `onMain` answers the merged check, `heads` the open-pull-request listing (default: nothing lists the commit). */
export class FakeGitHub implements HelperGitHubReader {
  readonly kind = 'fake-github';
  onMain = new Map<string, boolean | null | 'rate-limited'>();
  heads = new Map<string, HeadVerdict>();
  calls = 0;
  headCalls = 0;
  async isOnMain(_repo: string, s: string): Promise<boolean | null | 'rate-limited'> { this.calls++; return this.onMain.has(s) ? this.onMain.get(s)! : null; }
  async ownOpenHead(_repo: string, s: string): Promise<HeadVerdict> { this.headCalls++; return this.heads.get(s) ?? 'not-listed'; }
}

export class FakeOwner implements OwnerLoadReader {
  readonly kind = 'fake-owner';
  sampleValue: OwnerSample | null = { ncpu: 16, hostBusyCores: 2, sandboxBusyCores: 0.5, memoryPressure: 'normal', onBattery: false };
  /** Applied after this many samples (to stop mid-slice). */
  after: { n: number; sample: OwnerSample | null } | null = null;
  count = 0;
  async sample(): Promise<OwnerSample | null> {
    this.count++;
    if (this.after && this.count >= this.after.n) return this.after.sample;
    return this.sampleValue;
  }
}

export const HELPER_CFG: HelperConfig = {
  enabled: true, reserveCores: 4, pinnedRepoUrl: 'https://github.com/JKHeadley/instar', repo: 'JKHeadley/instar',
  pinnedRequester: { machineId: 'm_studio', url: 'http://100.64.0.9:4042' }, stopOnBattery: true, sandbox: { cpus: 8, memoryGb: 8, diskGb: 30 },
};

export const UNIT_A = 'tests/unit/alpha.test.ts';
export const UNIT_B = 'tests/unit/beta.test.ts';
export const UNIT_SCAN = 'tests/unit/home-reader.test.ts';
export const UNIT_TMUX = 'tests/unit/tmux-driver.test.ts';
export const HEAD = sha('a');

export function treeFiles(): Record<string, string> {
  return {
    'package.json': '{"name":"instar","version":"1.3.1903","dependencies":{"left-pad":"1.3.0"}}',
    'package-lock.json': '{"name":"instar","version":"1.3.1903","lockfileVersion":3,"packages":{"":{"name":"instar","version":"1.3.1903"},"node_modules/left-pad":{"version":"1.3.0"}}}',
    [UNIT_A]: "import { it } from 'vitest';\nit('a', () => {});\n",
    [UNIT_B]: "import { it } from 'vitest';\nimport { x } from '../../src/x.js';\nit('b', () => { void x; });\n",
    'src/x.ts': 'export const x = 1;\n',
    [UNIT_SCAN]: "import os from 'node:os';\nconst h = os.homedir();\n",
    [UNIT_TMUX]: "it('t', () => {});\n",
  };
}

export interface HelperRig {
  dir: string;
  svc: HelperService;
  driver: FakeSandboxDriver;
  trees: MemoryTrees;
  github: FakeGitHub;
  owner: FakeOwner;
  requester: ReturnType<typeof machineKeys>;
  helperKeys: ReturnType<typeof machineKeys>;
  audits: Array<Record<string, unknown>>;
  clock: { t: number };
  cfg: { value: HelperConfig | null };
  hostFree: { value: number | null };
  slice(over?: Partial<HelperSliceRequest>, signer?: MachineSigner): HelperSliceRequest & { sig: unknown };
  cancel(runAttemptId: string, over?: Partial<HelperCancelRequest>): HelperCancelRequest & { sig: unknown };
  /** A signed learned request about the merged commit's tree (`over.treeHash` names another). */
  learned(runAttemptId: string, observations: HelperLearnedRequest['observations'], over?: Partial<HelperLearnedRequest>): HelperLearnedRequest & { sig: unknown };
  route: RouteFacts;
  /**
   * Send a slice (or preparation) request as the route does. A slice is queued and answered at
   * once; this waits for its LAST signed answer and returns that (status 200), as a run machine
   * reads it from the status answer. Every other answer (a refusal, `preparing`, `owner-busy`) is
   * returned as it came.
   */
  send(body: unknown, route?: RouteFacts): Promise<{ status: number; body: unknown }>;
  /** Prepare the merge of `base` (default: `head` itself, a merged commit) and `head`, and wait until it is ready. */
  prepareReady(runAttemptId: string, head?: string, base?: string): Promise<void>;
  /** Write this helper's own "dry run done" record for a lane, on the fake sandbox's current image unless another is given. */
  dryRunDone(lane?: HelperLane, image?: SandboxImageIdentity): void;
  /** The status entry of one prepared pair. */
  tree(head?: string, base?: string): { baseSha: string; headSha: string; treeHash: string | null; state: string; reason?: string } | undefined;
}

export function helperRig(over: Partial<HelperServiceDeps> = {}, dirs: string[] = [], opts: { dir?: string } = {}): HelperRig {
  // `opts.dir`: a second service on an existing helper's state (a restart, or a new runner version).
  const dir = opts.dir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvhelper-')));
  if (!opts.dir) dirs.push(dir);
  const requester = machineKeys('m_studio');
  const helperKeys = machineKeys('m_laptop');
  const driver = new FakeSandboxDriver();
  // Four merged commits whose trees differ (one marker file each), as real commits' do.
  const commit = (h: string): Record<string, string> => ({ ...treeFiles(), 'COMMIT': `${h}\n` });
  const trees = new MemoryTrees({ [HEAD]: commit(HEAD), [sha('b')]: commit(sha('b')), [sha('c')]: commit(sha('c')), [sha('d')]: commit(sha('d')) });
  const github = new FakeGitHub();
  for (const h of [HEAD, sha('b'), sha('c'), sha('d')]) github.onMain.set(h, true);
  const owner = new FakeOwner();
  const audits: Array<Record<string, unknown>> = [];
  const clock = { t: Date.parse('2026-11-18T20:00:00.000Z') };
  const cfg = { value: HELPER_CFG as HelperConfig | null };
  const hostFree = { value: 500 * 1024 ** 3 as number | null };
  const svc = new HelperService({
    config: () => cfg.value,
    driver, ownerLoad: owner, github, trees,
    signer: helperKeys.signer, keyLookup: () => pins(requester),
    stateDir: dir, helperVersion: '1.3.1903', runnerVersion: 'hr1:runner-one',
    hostFreeBytes: async () => hostFree.value,
    now: () => clock.t,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    audit: (e) => audits.push(e),
    allowLoopback: true,
    ...over,
  });
  const rig: HelperRig = {
    dir, svc, driver, trees, github, owner, requester, helperKeys, audits, clock, cfg, hostFree,
    route: { arrival: 'main', listenerAddress: '100.64.1.2' },
    slice(o = {}, signer = requester.signer) {
      // A merged commit by default (base = head, as on a main verify); a slice with files is compare-only unless said otherwise.
      const head = o.headSha ?? HEAD;
      const req: HelperSliceRequest = { kind: 'slice', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', lane: 'unit', baseSha: o.baseSha ?? head, headSha: head, files: [UNIT_A], deadlineAt: clock.t + 60_000, budgetMs: 10_000, expiresAt: clock.t + 50_000, ...(o.prepare ? {} : { use: 'compare' as const }), ...o };
      return signHelperRequest(signer, req) as HelperSliceRequest & { sig: unknown };
    },
    cancel(runAttemptId, o = {}) {
      return signHelperRequest(requester.signer, { kind: 'cancel', attemptId: id32(), runAttemptId, requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', expiresAt: clock.t + 50_000, ...o } as HelperCancelRequest) as HelperCancelRequest & { sig: unknown };
    },
    learned(runAttemptId, observations, o = {}) {
      return signHelperRequest(requester.signer, { kind: 'learned', attemptId: id32(), runAttemptId, requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', treeHash: memoryTreeHash(trees.files[HEAD]), expiresAt: clock.t + 50_000, observations, ...o } as HelperLearnedRequest) as HelperLearnedRequest & { sig: unknown };
    },
    async send(body, route = rig.route) {
      const a = await svc.handleSlice(body, route);
      const state = (a.body as { state?: unknown } | null)?.state;
      if (state !== 'queued') return a;
      const last = await svc.whenSliceAnswered((a.body as { attemptId: string }).attemptId);
      if (!last) throw new Error('a queued slice has no answer');
      return { status: 200, body: last };
    },
    tree(head = HEAD, base = head) {
      return (svc.status().trees as Array<{ baseSha: string; headSha: string; treeHash: string | null; state: string; reason?: string }>).find((x) => x.headSha === head && x.baseSha === base);
    },
    dryRunDone(lane = 'unit', image = driver.image ?? { imageDigest: 'none', settingsHash: 'none' }) {
      new HelperDryRunStore(dir, () => clock.t).noteAnswered(lane, image, HEAD, [{ file: 'tests/x.test.ts', ms: 100, passed: true }], ['tests/x.test.ts']);
    },
    async prepareReady(runAttemptId, head = HEAD, base = head) {
      const a = await svc.handleSlice(rig.slice({ runAttemptId, baseSha: base, headSha: head, files: [], prepare: true }), rig.route);
      if (a.status !== 202) throw new Error(`prepare answered ${a.status} ${JSON.stringify(a.body)}`);
      for (let i = 0; i < 200; i++) {
        const t = rig.tree(head, base);
        if (t?.state === 'ready') return;
        if (t?.state === 'failed') throw new Error(`prep failed: ${JSON.stringify(t)}`);
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error('prep never ready');
    },
  };
  return rig;
}
