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
import { HelperService, type HelperServiceDeps } from '../../src/localVerify/helper/HelperService.js';
import { buildTar, type HostTreeSource, type MergedOnMainChecker, type TreeEntry } from '../../src/localVerify/helper/hostTree.js';
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

export class MemoryTrees implements HostTreeSource {
  readonly kind = 'memory';
  fetched: string[] = [];
  constructor(public files: Record<string, Record<string, string>>) {}
  async fetch(_url: string, s: string): Promise<void> { this.fetched.push(s); if (!this.files[s]) throw new Error('no such commit'); }
  async entries(s: string): Promise<TreeEntry[]> {
    return Object.entries(this.files[s] ?? {}).map(([p, c]) => ({ mode: '100644', object: crypto.createHash('sha1').update(c).digest('hex'), path: p }));
  }
  async read(s: string, f: string): Promise<string | null> { return this.files[s]?.[f] ?? null; }
  async archive(s: string): Promise<Readable> {
    return Readable.from([buildTar(Object.entries(this.files[s] ?? {}).map(([p, c]) => ({ path: p, mode: '100644', data: Buffer.from(c) })))]);
  }
}

export class FakeGitHub implements MergedOnMainChecker {
  readonly kind = 'fake-github';
  onMain = new Map<string, boolean | null>();
  calls = 0;
  async isOnMain(_repo: string, s: string): Promise<boolean | null> { this.calls++; return this.onMain.has(s) ? this.onMain.get(s)! : null; }
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
  pinnedRequesters: ['m_studio'], stopOnBattery: true, sandbox: { cpus: 8, memoryGb: 8, diskGb: 30 },
};

export const UNIT_A = 'tests/unit/alpha.test.ts';
export const UNIT_B = 'tests/unit/beta.test.ts';
export const UNIT_SCAN = 'tests/unit/home-reader.test.ts';
export const UNIT_TMUX = 'tests/unit/tmux-driver.test.ts';
export const HEAD = sha('a');

export function treeFiles(): Record<string, string> {
  return {
    'package.json': '{"name":"instar"}',
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
  cancel(runAttemptId: string): HelperCancelRequest & { sig: unknown };
  learned(runAttemptId: string, observations: HelperLearnedRequest['observations'], over?: Partial<HelperLearnedRequest>): HelperLearnedRequest & { sig: unknown };
  route: { localAddress: string };
  prepareReady(runAttemptId: string, head?: string): Promise<void>;
}

export function helperRig(over: Partial<HelperServiceDeps> = {}, dirs: string[] = []): HelperRig {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvhelper-')));
  dirs.push(dir);
  const requester = machineKeys('m_studio');
  const helperKeys = machineKeys('m_laptop');
  const driver = new FakeSandboxDriver();
  const trees = new MemoryTrees({ [HEAD]: treeFiles(), [sha('b')]: treeFiles(), [sha('c')]: treeFiles(), [sha('d')]: treeFiles() });
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
    stateDir: dir, helperVersion: '1.3.1903',
    hostFreeBytes: async () => hostFree.value,
    now: () => clock.t,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    audit: (e) => audits.push(e),
    allowLoopback: true,
    ...over,
  });
  const rig: HelperRig = {
    dir, svc, driver, trees, github, owner, requester, helperKeys, audits, clock, cfg, hostFree,
    route: { localAddress: '100.64.1.2' },
    slice(o = {}, signer = requester.signer) {
      const req: HelperSliceRequest = { kind: 'slice', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', headSha: HEAD, files: [UNIT_A], deadlineAt: clock.t + 60_000, budgetMs: 10_000, expiresAt: clock.t + 50_000, ...o };
      return signHelperRequest(signer, req) as HelperSliceRequest & { sig: unknown };
    },
    cancel(runAttemptId) {
      return signHelperRequest(requester.signer, { kind: 'cancel', attemptId: id32(), runAttemptId, requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', expiresAt: clock.t + 50_000 } as HelperCancelRequest) as HelperCancelRequest & { sig: unknown };
    },
    learned(runAttemptId, observations, o = {}) {
      return signHelperRequest(requester.signer, { kind: 'learned', attemptId: id32(), runAttemptId, requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', headSha: HEAD, expiresAt: clock.t + 50_000, observations, ...o } as HelperLearnedRequest) as HelperLearnedRequest & { sig: unknown };
    },
    async prepareReady(runAttemptId, head = HEAD) {
      const a = await svc.handleSlice(rig.slice({ runAttemptId, headSha: head, files: [], prepare: true }), rig.route);
      if (a.status !== 202) throw new Error(`prepare answered ${a.status} ${JSON.stringify(a.body)}`);
      for (let i = 0; i < 200; i++) {
        const t = (svc.status().trees as Array<{ headSha: string; state: string }>).find((x) => x.headSha === head);
        if (t?.state === 'ready') return;
        if (t?.state === 'failed') throw new Error(`prep failed: ${JSON.stringify(t)}`);
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error('prep never ready');
    },
  };
  return rig;
}
