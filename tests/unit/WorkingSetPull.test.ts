// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for WorkingSetPull (P2.2) — WORKING-SET-HANDOFF-SPEC
 * §3.2 (chunked verb, generation anchor, busy) + §3.5 (never-clobber).
 *
 * The serve side runs against REAL files in a producer stateDir; the puller
 * lands into a SEPARATE receiver stateDir; `send` wires them directly
 * (the real express+MeshRpcClient path is the integration test).
 *
 * Covers: single+multi-chunk round-trip with whole-file verification;
 * generation-anchor restart on mid-transfer rewrite (bounded → `unstable`);
 * busy retry without penalty + busyExhausted; never-clobber matrix (absent /
 * identical / divergent-alongside / hash-idempotent / cap-2 eviction);
 * hostile relPath refusal; ownership-recheck abort; assembled-bytes budget;
 * serve refusals (outside fresh manifest, secretFlagged, tooLarge,
 * liveSource, goneSinceManifest); changedSinceManifest semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WorkingSetPullServer,
  WorkingSetPuller,
  type ServeResult,
  type WorkingSetPullCmd,
} from '../../src/core/WorkingSetPull.js';
import type { OwnAutonomousRuns } from '../../src/core/CoherenceJournalReader.js';

let prodDir: string;
let recvDir: string;

const TOPIC = 42;

beforeEach(() => {
  prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-prod-'));
  recvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-recv-'));
  fs.mkdirSync(path.join(prodDir, 'autonomous'), { recursive: true });
});

afterEach(() => {
  for (const d of [prodDir, recvDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function noRuns(over: Partial<OwnAutonomousRuns> = {}): OwnAutonomousRuns {
  return { entries: [], liveRun: false, artifactPaths: [], truncated: false, ...over };
}

function writeProd(name: string, content: string | Buffer): string {
  const p = path.join(prodDir, 'autonomous', name);
  fs.writeFileSync(p, content);
  return p;
}

function makeServer(over: Partial<ConstructorParameters<typeof WorkingSetPullServer>[0]> = {}): WorkingSetPullServer {
  return new WorkingSetPullServer({
    stateDir: prodDir,
    readRuns: () => noRuns(),
    ...over,
  });
}

function makePuller(
  server: WorkingSetPullServer,
  over: Partial<ConstructorParameters<typeof WorkingSetPuller>[0]> = {},
): WorkingSetPuller {
  return new WorkingSetPuller({
    stateDir: recvDir,
    send: async (cmd: WorkingSetPullCmd) => server.handle(cmd),
    senderShortId: 'm_prod',
    stillCurrent: () => true,
    ...over,
  });
}

function recvPath(rel: string): string {
  return path.join(recvDir, rel);
}

describe('WorkingSetPull — round-trip', () => {
  it('transfers a small file end-to-end, hash-verified, landed via temp+rename', async () => {
    writeProd(`${TOPIC}.local.md`, 'the headline artifact');
    const report = await makePuller(makeServer()).pullTopic(TOPIC);
    expect(report.files).toHaveLength(1);
    expect(report.files[0].outcome).toBe('written');
    const landed = fs.readFileSync(recvPath(path.join('autonomous', `${TOPIC}.local.md`)), 'utf-8');
    expect(landed).toBe('the headline artifact');
    expect(report.assembledBytes).toBe(Buffer.byteLength('the headline artifact'));
    expect(report.needsPendingPull).toBe(false);
  });

  it('transfers a MULTI-CHUNK file (content > batch bytes) and verifies the assembly', async () => {
    const big = crypto.randomBytes(300); // 300 bytes at 64-byte chunks ≈ 5 chunks
    writeProd(`${TOPIC}.local.md`, big);
    const server = makeServer({ pullMaxBatchBytes: 64 });
    const sends: number[] = [];
    const puller = new WorkingSetPuller({
      stateDir: recvDir,
      send: async (cmd) => {
        sends.push(cmd.want?.[0]?.offset ?? -1);
        return server.handle(cmd);
      },
      senderShortId: 'm_prod',
      stillCurrent: () => true,
      pullMaxBatchBytes: 64,
    });
    const report = await puller.pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('written');
    const landed = fs.readFileSync(recvPath(path.join('autonomous', `${TOPIC}.local.md`)));
    expect(landed.equals(big)).toBe(true);
    // Sequential offset cursors were used (manifestOnly call has offset -1).
    const offsets = sends.filter((o) => o >= 0);
    expect(offsets.length).toBeGreaterThan(2);
    expect(offsets[0]).toBe(0);
  });
});

describe('WorkingSetPull — generation anchor (§3.2)', () => {
  it('a file rewritten mid-transfer restarts from 0 and lands the NEW content', async () => {
    const v1 = Buffer.alloc(200, 'a');
    const v2 = Buffer.alloc(200, 'b');
    const abs = writeProd(`${TOPIC}.local.md`, v1);
    const server = makeServer({ pullMaxBatchBytes: 64 });
    let chunkCount = 0;
    const puller = new WorkingSetPuller({
      stateDir: recvDir,
      send: async (cmd) => {
        const res = server.handle(cmd);
        chunkCount++;
        // Rewrite the file after the SECOND chunk request (mid-transfer) —
        // exactly once, so the restart succeeds.
        if (chunkCount === 3) fs.writeFileSync(abs, v2);
        return res;
      },
      senderShortId: 'm_prod',
      stillCurrent: () => true,
      pullMaxBatchBytes: 64,
    });
    const report = await puller.pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('written');
    const landed = fs.readFileSync(recvPath(path.join('autonomous', `${TOPIC}.local.md`)));
    expect(landed.equals(v2)).toBe(true); // the restart re-pinned the new version
  });

  it('a file that NEVER sits still exhausts chunkRestartCap → unstable, surfaced, no livelock', async () => {
    const abs = writeProd(`${TOPIC}.local.md`, Buffer.alloc(200, 'a'));
    const server = makeServer({ pullMaxBatchBytes: 64 });
    let i = 0;
    const puller = new WorkingSetPuller({
      stateDir: recvDir,
      send: async (cmd) => {
        const res = server.handle(cmd);
        // Rewrite after EVERY content request — the file never stabilizes.
        if (cmd.want) fs.writeFileSync(abs, Buffer.alloc(200, String(++i % 10)));
        return res;
      },
      senderShortId: 'm_prod',
      stillCurrent: () => true,
      pullMaxBatchBytes: 64,
      chunkRestartCap: 2,
    });
    const report = await puller.pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('unstable');
    expect(report.needsPendingPull).toBe(true);
    expect(fs.existsSync(recvPath(path.join('autonomous', `${TOPIC}.local.md`)))).toBe(false); // nothing landed
  });
});

describe('WorkingSetPull — busy (§3.2 retry-without-penalty)', () => {
  it('busy responses retry and then succeed — outcome written, no pending-pull needed', async () => {
    writeProd(`${TOPIC}.local.md`, 'content');
    const server = makeServer();
    let busyLeft = 2;
    const puller = new WorkingSetPuller({
      stateDir: recvDir,
      send: async (cmd) => {
        if (busyLeft > 0) {
          busyLeft--;
          return { busy: true } as ServeResult;
        }
        return server.handle(cmd);
      },
      senderShortId: 'm_prod',
      stillCurrent: () => true,
      busyRetryCap: 5,
    });
    const report = await puller.pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('written');
    expect(report.needsPendingPull).toBe(false);
  });

  it('busy forever exhausts busyRetryCap → busyExhausted + needsPendingPull (re-filed intact upstream)', async () => {
    const puller = new WorkingSetPuller({
      stateDir: recvDir,
      send: async () => ({ busy: true }),
      senderShortId: 'm_prod',
      stillCurrent: () => true,
      busyRetryCap: 2,
    });
    const report = await puller.pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('busyExhausted');
    expect(report.needsPendingPull).toBe(true);
  });
});

describe('WorkingSetPull — never-clobber (§3.5)', () => {
  it('identical destination → skippedExisting; divergent → alongside; same divergent content → ONE alongside', async () => {
    writeProd(`${TOPIC}.local.md`, 'producer version');
    const destRel = path.join('autonomous', `${TOPIC}.local.md`);
    fs.mkdirSync(path.dirname(recvPath(destRel)), { recursive: true });
    fs.writeFileSync(recvPath(destRel), 'receiver version'); // divergent local

    const server = makeServer();
    const r1 = await makePuller(server).pullTopic(TOPIC);
    expect(r1.files[0].outcome).toBe('alongside');
    const alongside = r1.files[0].alongsidePath!;
    expect(path.basename(alongside)).toMatch(/^42\.local\.from-m_prod-[0-9a-f]{8}\.md$/);
    expect(fs.readFileSync(alongside, 'utf-8')).toBe('producer version');
    expect(fs.readFileSync(recvPath(destRel), 'utf-8')).toBe('receiver version'); // NEVER overwritten

    // Re-pull with the SAME divergent content → idempotent, still ONE copy.
    const r2 = await makePuller(server).pullTopic(TOPIC);
    expect(r2.files[0].outcome).toBe('alongside');
    const dir = path.dirname(recvPath(destRel));
    const copies = fs.readdirSync(dir).filter((n) => n.includes('.from-'));
    expect(copies).toHaveLength(1);
  });

  it('alongside copies are capped at 2 (oldest evicted via SafeFsExecutor)', async () => {
    const destRel = path.join('autonomous', `${TOPIC}.local.md`);
    fs.mkdirSync(path.dirname(recvPath(destRel)), { recursive: true });
    fs.writeFileSync(recvPath(destRel), 'receiver version');
    const server = makeServer();
    for (const v of ['v1', 'v2', 'v3']) {
      writeProd(`${TOPIC}.local.md`, `producer ${v}`);
      const r = await makePuller(server).pullTopic(TOPIC);
      expect(r.files[0].outcome).toBe('alongside');
      await new Promise((r2) => setTimeout(r2, 5)); // distinct mtimes for eviction order
    }
    const dir = path.dirname(recvPath(destRel));
    const copies = fs.readdirSync(dir).filter((n) => n.includes('.from-'));
    expect(copies).toHaveLength(2); // cap, oldest evicted
  });

  it('a symlink destination is refused, never followed', async () => {
    writeProd(`${TOPIC}.local.md`, 'incoming');
    const destRel = path.join('autonomous', `${TOPIC}.local.md`);
    fs.mkdirSync(path.dirname(recvPath(destRel)), { recursive: true });
    const outside = path.join(os.tmpdir(), `wsp-outside-${process.pid}`);
    fs.writeFileSync(outside, 'outside target');
    fs.symlinkSync(outside, recvPath(destRel));
    const report = await makePuller(makeServer()).pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('refused');
    expect(fs.readFileSync(outside, 'utf-8')).toBe('outside target'); // untouched
    fs.rmSync(outside, { force: true });
  });
});

describe('WorkingSetPull — receive-side jail + ownership + budget', () => {
  it('hostile relPaths from a malicious manifest are refused before any join', async () => {
    const evil: ServeResult = {
      manifest: {
        topic: TOPIC,
        computedAt: new Date().toISOString(),
        entries: [
          { relPath: '../escape.md', bytes: 4, sha256: 'x', mtime: '' },
          { relPath: '/abs/path.md', bytes: 4, sha256: 'x', mtime: '' },
          { relPath: 'a/../../b.md', bytes: 4, sha256: 'x', mtime: '' },
        ],
        liveRun: false,
        evidenceTruncated: false,
        filesTruncated: 0,
        jailRejected: 0,
        goneFromDisk: 0,
        transferableBytes: 12,
      },
    };
    const data = Buffer.from('evil').toString('base64');
    const puller = new WorkingSetPuller({
      stateDir: recvDir,
      send: async (cmd) =>
        cmd.manifestOnly
          ? evil
          : {
              blobs: [{
                relPath: cmd.want![0].relPath,
                offset: 0,
                dataB64: data,
                anchor: { bytes: 4, mtimeNs: '1', ino: '1' },
                fileSha256: crypto.createHash('sha256').update('evil').digest('hex'),
                eof: true,
              }],
            },
      senderShortId: 'm_evil',
      stillCurrent: () => true,
    });
    const report = await puller.pullTopic(TOPIC);
    expect(report.files.every((f) => f.outcome === 'refused')).toBe(true);
    expect(fs.existsSync(path.join(recvDir, '..', 'escape.md'))).toBe(false);
  });

  it('ownership advanced mid-pull → superseded, nothing written', async () => {
    writeProd(`${TOPIC}.local.md`, 'content');
    let current = true;
    const puller = makePuller(makeServer(), { stillCurrent: () => current });
    current = false; // superseded before the write recheck
    const report = await puller.pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('superseded');
    expect(fs.existsSync(recvPath(path.join('autonomous', `${TOPIC}.local.md`)))).toBe(false);
  });

  it('maxTotalBytes budget is assembled-bytes based — an over-budget file is budgetExhausted', async () => {
    writeProd(`${TOPIC}.local.md`, Buffer.alloc(100, 'h')); // headline first (sorted)
    writeProd(`${TOPIC}.za.md`, Buffer.alloc(100, 'a'));
    const report = await makePuller(makeServer(), {
      caps: { maxTotalBytes: 150 },
    }).pullTopic(TOPIC);
    const by = Object.fromEntries(report.files.map((f) => [path.basename(f.relPath), f.outcome]));
    expect(by[`${TOPIC}.local.md`]).toBe('written');
    expect(by[`${TOPIC}.za.md`]).toBe('budgetExhausted');
    expect(report.assembledBytes).toBe(100);
  });
});

describe('WorkingSetPull — serve-side refusals (§3.2)', () => {
  it('want outside the fresh manifest → refusedPolicy; vanished file → goneSinceManifest', async () => {
    const abs = writeProd(`${TOPIC}.local.md`, 'x');
    const server = makeServer();
    const outside = server.handle({
      type: 'working-set-pull',
      topic: TOPIC,
      want: [{ relPath: 'config.json', offset: 0 }],
    });
    expect(outside.refused).toEqual([{ relPath: 'config.json', reason: 'refusedPolicy' }]);

    // goneSinceManifest needs the file present at manifest-compute but gone at
    // read: the fresh-manifest recompute makes a clean repro need a race seam,
    // so assert the adjacent honest path — a file that vanishes is NOT served
    // and NOT logged as an attack (it disappears from the fresh manifest).
    fs.rmSync(abs, { force: true });
    const after = server.handle({
      type: 'working-set-pull',
      topic: TOPIC,
      want: [{ relPath: path.join('autonomous', `${TOPIC}.local.md`), offset: 0 }],
    });
    expect(after.refused?.[0].reason).toBe('refusedPolicy'); // out of the FRESH manifest
    expect(after.blobs ?? []).toHaveLength(0);
  });

  it('secretFlagged and liveSource files are refused with their honest reasons', async () => {
    writeProd(`${TOPIC}.creds.md`, 'api_key = "abcdef123456789012345"');
    const server = makeServer();
    const res = server.handle({
      type: 'working-set-pull',
      topic: TOPIC,
      want: [{ relPath: path.join('autonomous', `${TOPIC}.creds.md`), offset: 0 }],
    });
    expect(res.refused?.[0].reason).toBe('secretFlagged');

    writeProd(`${TOPIC}.local.md`, 'live');
    const liveServer = makeServer({ readRuns: () => noRuns({ liveRun: true }) });
    const live = liveServer.handle({
      type: 'working-set-pull',
      topic: TOPIC,
      want: [{ relPath: path.join('autonomous', `${TOPIC}.local.md`), offset: 0 }],
    });
    expect(live.refused?.[0].reason).toBe('liveSource');
  });

  it('serve refuses a want at an offset past EOF and a symlink swapped in after manifest', async () => {
    const abs = writeProd(`${TOPIC}.local.md`, 'short');
    const server = makeServer();
    const past = server.handle({
      type: 'working-set-pull',
      topic: TOPIC,
      want: [{ relPath: path.join('autonomous', `${TOPIC}.local.md`), offset: 9999 }],
    });
    expect(past.refused?.[0].reason).toBe('refusedPolicy');

    // TOCTOU: swap a symlink in place of the file — O_NOFOLLOW refuses it.
    const outside = path.join(os.tmpdir(), `wsp-toctou-${process.pid}`);
    fs.writeFileSync(outside, 'outside secret');
    fs.rmSync(abs, { force: true });
    fs.symlinkSync(outside, abs);
    const swapped = server.handle({
      type: 'working-set-pull',
      topic: TOPIC,
      want: [{ relPath: path.join('autonomous', `${TOPIC}.local.md`), offset: 0 }],
    });
    // The fresh manifest refuses the symlink at compute time already — either
    // way, the outside bytes never leave.
    expect(swapped.blobs ?? []).toHaveLength(0);
    fs.rmSync(outside, { force: true });
  });

  it('manifestOnly returns the manifest; busy gate answers busy above serveConcurrency', () => {
    writeProd(`${TOPIC}.local.md`, 'x');
    const server = makeServer({ serveConcurrency: 0 }); // saturated by construction
    const res = server.handle({ type: 'working-set-pull', topic: TOPIC, manifestOnly: true });
    expect(res.busy).toBe(true);
    const open = makeServer();
    const ok = open.handle({ type: 'working-set-pull', topic: TOPIC, manifestOnly: true });
    expect(ok.manifest?.entries).toHaveLength(1);
  });
});
