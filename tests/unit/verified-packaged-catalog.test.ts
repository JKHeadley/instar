import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalCapabilityInventory, readDoorwaySources } from '../../src/core/CapabilityRegistry.js';
import { readDoorwayRegistry } from '../../src/core/DoorwayRegistryReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { executePackagedDoorwayScan } from '../../src/scheduler/PackagedDoorwayExecution.js';
import { readCommittedDoorwayObservation } from '../../src/core/CommittedDoorwayObservation.js';
import { ScheduledDoorwayObservationStore } from '../../src/core/ScheduledDoorwayObservationStore.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { readVerifiedPackagedDoorwayAssets, readVerifiedPackagedCatalog } from '../../src/core/VerifiedPackagedCatalog.js';

const VERSION = '0.0.1';
const FIXTURE_ENV = { ...process.env, INSTAR_RELEASE_PRIVATE_KEY_PEM: '', INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH: '' };
const MANIFEST = '{\r\n  "lastReviewedAt": "2026-11-01", "doors": {}\r\n}\r\n';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('readVerifiedPackagedCatalog', () => {
  let root: string;
  let catalogPath: string;
  let lockPath: string;
  let trustedPin: string;

  function writeKeypair(): string {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(root, '.instar-release-keys/private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'src/scaffold/keys/instar-release-pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  }

  function sign(): void {
    execFileSync(process.execPath, ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: root, env: FIXTURE_ENV });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-verified-catalog-'));
    for (const subdir of ['.instar-release-keys', 'scripts', 'src/scaffold/keys']) {
      fs.mkdirSync(path.join(root, subdir), { recursive: true });
    }
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts/sign-instar-lockfile.mjs'), path.join(root, 'scripts/sign-instar-lockfile.mjs'));
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: VERSION }));
    catalogPath = path.join(root, 'scripts/model-registry-freshness.manifest.json');
    lockPath = path.join(root, 'dist/jobs/instar.lock.json');
    fs.writeFileSync(catalogPath, MANIFEST);
    trustedPin = writeKeypair();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'verified-packaged-catalog.test cleanup' });
  });

  const read = () => readVerifiedPackagedCatalog(root, VERSION, trustedPin);

  it('runs the signed bytes, isolates manual state and attests only the exact ledger run', async () => {
    const proberPath = path.join(root, 'scripts/doorway-scan.mjs');
    fs.writeFileSync(proberPath, 'export function probeDoorFree(door) { return { probeStatus: door.id === "fixture" ? "ok" : "timeout" }; }');
    fs.writeFileSync(catalogPath, JSON.stringify({
      lastReviewedAt: '2026-11-01',
      doors: {
        fixture: { probe: { kind: 'cli-version' } },
        paid: { probe: { kind: 'cli-version', metered: true } },
      },
    }));
    sign();
    const assets = readVerifiedPackagedDoorwayAssets(root, VERSION, trustedPin);
    expect(assets.status).toBe('verified');
    fs.writeFileSync(proberPath, 'throw new Error("reopened executable")');
    fs.writeFileSync(catalogPath, '{}');

    const stateDir = path.join(root, 'workspace', '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const manual = path.join(stateDir, 'state', 'doorway-scan.json');
    fs.writeFileSync(manual, 'original manual bytes');
    const config = path.join(stateDir, 'config.json');
    fs.writeFileSync(config, '{broken');
    const history = new JobRunHistory(stateDir);
    history.setMachineId('local');
    const runId = history.recordStart({
      slug: 'doorway-scan', sessionId: 'fixture', trigger: 'test', origin: 'instar',
      runner: 'script', lockTrust: 'trusted',
    });
    const run = history.findRun(runId)!;
    const store = new ScheduledDoorwayObservationStore(stateDir, 'local', ['fixture', 'paid']);
    const options = { stateDir, run, machineId: 'local', assets, timeoutMs: 2000 };
    await expect(executePackagedDoorwayScan(options)).rejects.toThrow('packaged-execution-disabled');
    expect(store.readStaged(runId)).toBeNull();
    fs.writeFileSync(config, JSON.stringify({ maintenance: { doorwayScan: { packagedExecution: true } } }));
    const digest = await executePackagedDoorwayScan(options);
    expect(readCommittedDoorwayObservation(runId, 'local', history, store).status).toBe('unavailable');
    history.recordCompletion({ runId, result: 'success', scheduledDoorwayObservationDigest: digest });
    expect(readCommittedDoorwayObservation(runId, 'local', history, store)).toMatchObject({
      status: 'committed',
      observation: { runId, observations: [{ doorId: 'fixture', probeStatus: 'ok' }] },
    });
    expect(fs.readFileSync(manual, 'utf8')).toBe('original manual bytes');
  });

  it('returns the review date from the same verified bytes as the catalog', () => {
    sign();
    expect(read()).toEqual({
      status: 'verified',
      lastReviewedAt: '2026-11-01',
      catalog: { lastReviewedAt: '2026-11-01', doors: {} },
    });
    fs.writeFileSync(catalogPath, MANIFEST.replaceAll('\r\n', '\n'));
    expect(read()).toEqual({ status: 'tampered', reason: 'catalog-digest-mismatch' });
  });

  it('distinguishes an absent lock and a valid legacy lock from tampering', () => {
    expect(read()).toEqual({ status: 'unavailable', reason: 'catalog-lock-unavailable-or-invalid' });
    SafeFsExecutor.safeUnlinkSync(catalogPath, { operation: 'verified-packaged-catalog.test legacy lock' });
    sign();
    expect(read()).toEqual({ status: 'unavailable', reason: 'catalog-digest-absent' });
  });

  it('uses the installed catalog and review date for both registry and capability reads', () => {
    const model = { id: 'fixture-model', frontier: true };
    fs.writeFileSync(catalogPath, JSON.stringify({
      lastReviewedAt: '2026-11-01',
      doors: { fixture: { topModels: [model] } },
    }));
    sign();

    const projectDir = path.join(root, 'agent-workspace');
    const checkoutScripts = path.join(projectDir, 'scripts');
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(checkoutScripts, { recursive: true });
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(checkoutScripts, 'model-registry-freshness.manifest.json'), JSON.stringify({
      lastReviewedAt: '2026-11-12',
      doors: { fixture: { topModels: [{ id: 'checkout-shadow' }] } },
    }));

    const packagedCatalog = read();
    expect(readDoorwayRegistry({ projectDir, stateDir, packagedCatalog })).toMatchObject({
      status: 'ok',
      lastReviewedAt: '2026-11-01',
      body: { doorways: [{ doorId: 'fixture', topModels: [model] }] },
    });
    const now = '2026-11-24T00:00:00.000Z';
    const inventory = readDoorwaySources(projectDir, stateDir, now, 'local', packagedCatalog);
    expect(inventory.entries).toHaveLength(1);
    expect(inventory.entries[0]).toMatchObject({
      capabilityId: 'models:fixture/fixture-model',
      evidence: { manifestVerifiedAt: '2026-11-01' },
    });

    const oldProjection = readLocalCapabilityInventory(projectDir, stateDir, 'local', Date.parse(now));
    fs.writeFileSync(path.join(stateDir, 'capability-registry.json'), JSON.stringify(oldProjection));
    expect(readLocalCapabilityInventory(projectDir, stateDir, 'local', Date.parse(now), packagedCatalog).entries)
      .toEqual(inventory.entries);
    fs.writeFileSync(catalogPath, '{}');
    const tampered = read();
    expect(readDoorwayRegistry({ projectDir, stateDir, packagedCatalog: tampered })).toEqual({
      status: 'corrupt',
      reason: 'catalog-digest-mismatch',
    });
    expect(() => readLocalCapabilityInventory(projectDir, stateDir, 'local', Date.parse(now), tampered))
      .toThrow('catalog-digest-mismatch');
  });

  it('keeps an absent installed catalog unavailable even when a checkout catalog exists', () => {
    const packagedCatalog = read();
    expect(readDoorwayRegistry({ projectDir: root, stateDir: root }).status).toBe('ok');
    expect(readDoorwayRegistry({ projectDir: root, stateDir: root, packagedCatalog })).toEqual({
      status: 'no-manifest',
      reason: 'catalog-lock-unavailable-or-invalid',
    });
    expect(() => readDoorwaySources(root, root, undefined, 'local', packagedCatalog))
      .toThrow('catalog-lock-unavailable-or-invalid');
  });

  it('rejects a replacement bundled key and a lock valid under that key', () => {
    writeKeypair();
    sign();
    expect(read()).toEqual({ status: 'tampered', reason: 'catalog-key-pin-mismatch' });
  });

  it('rejects a changed lock and a lock from another release', () => {
    sign();
    expect(readVerifiedPackagedCatalog(root, '0.0.2', trustedPin)).toEqual({
      status: 'tampered', reason: 'catalog-release-version-mismatch',
    });
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    fs.writeFileSync(lockPath, JSON.stringify({ ...lock, catalogHash: `sha256:${'0'.repeat(64)}` }));
    expect(read()).toEqual({ status: 'tampered', reason: 'catalog-lock-invalid' });
  });

  it('rejects a symlink even when its target contains the signed catalog bytes', () => {
    sign();
    const alternate = path.join(root, 'alternate.json');
    fs.renameSync(catalogPath, alternate);
    fs.symlinkSync(alternate, catalogPath, 'file');
    expect(read()).toEqual({ status: 'tampered', reason: 'catalog-file-unavailable-or-invalid' });
  });

  it('rejects a symlinked parent directory', () => {
    sign();
    const scripts = path.dirname(catalogPath);
    const alternate = path.join(root, 'alternate-scripts');
    fs.renameSync(scripts, alternate);
    fs.symlinkSync(alternate, scripts, 'junction');
    expect(read()).toEqual({ status: 'tampered', reason: 'catalog-file-unavailable-or-invalid' });
  });

  it('rejects a symlinked package root even when the package itself verifies', () => {
    sign();
    const alias = path.join(root, 'alias');
    fs.symlinkSync(root, alias, 'junction');
    expect(readVerifiedPackagedCatalog(alias, VERSION, trustedPin)).toEqual({
      status: 'tampered', reason: 'catalog-lock-unavailable-or-invalid',
    });
  });

  it('rejects a validly signed catalog with invalid schema', () => {
    fs.writeFileSync(catalogPath, '{"lastReviewedAt":"bad date","doors":{}}');
    sign();
    expect(read()).toEqual({ status: 'tampered', reason: 'catalog-schema-invalid' });
  });

  it('refuses a signed catalog above the maximum read size', () => {
    fs.writeFileSync(catalogPath, Buffer.alloc(1024 * 1024 + 1));
    sign();
    expect(read()).toEqual({ status: 'tampered', reason: 'catalog-file-unavailable-or-invalid' });
  });
});
