import { chmod, mkdtemp, mkdir, open, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cameraAcceptanceEvidenceStorage } from '../../src/core/CameraAcceptanceEvidenceStorage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const id = 'fe45a4f2-2bd4-4c72-b16e-43ecda0b441f';

describe.skipIf(!process.getuid)('Camera evidence filesystem reader', () => {
  let root: string;
  let evidenceDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'camera-evidence-'));
    evidenceDir = path.join(root, 'camera-acceptance-evidence');
    await mkdir(evidenceDir, { mode: 0o700 });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'camera-evidence-storage-test' });
  });

  it('loads an owner-only regular record and holds missing or malformed records', async () => {
    const read = cameraAcceptanceEvidenceStorage(root);
    const file = path.join(evidenceDir, id + '.json');
    await expect(read(id)).resolves.toBeNull();
    await writeFile(file, '{', { mode: 0o600 });
    await expect(read(id)).resolves.toBeNull();
    await writeFile(file, JSON.stringify({ verified: true }), { mode: 0o600 });
    await expect(read(id)).resolves.toEqual({ verified: true });
    await expect(read('../' + id)).resolves.toBeNull();
  });

  it('refuses symbolic links and records readable by other accounts', async () => {
    const read = cameraAcceptanceEvidenceStorage(root);
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, '{}', { mode: 0o600 });
    await symlink(outside, path.join(evidenceDir, id + '.json'));
    await expect(read(id)).resolves.toBeNull();
    const publicId = 'b5b3f6c2-3dbe-4c14-86ec-efdfdb027cc5';
    const file = await open(path.join(evidenceDir, publicId + '.json'), 'w', 0o600);
    try {
      await file.writeFile('{}');
      await file.chmod(0o644);
    } finally { await file.close(); }
    await expect(read(publicId)).resolves.toBeNull();
  });

  it('refuses a state root writable by other accounts', async () => {
    await writeFile(path.join(evidenceDir, id + '.json'), '{}', { mode: 0o600 });
    await chmod(root, 0o770);
    try { await expect(cameraAcceptanceEvidenceStorage(root)(id)).resolves.toBeNull(); }
    finally { await chmod(root, 0o700); }
  });

  it('refuses oversized records before reading them', async () => {
    const file = await open(path.join(evidenceDir, id + '.json'), 'w', 0o600);
    try { await file.truncate(4 * 1024 * 1024 + 1); } finally { await file.close(); }
    await expect(cameraAcceptanceEvidenceStorage(root)(id)).resolves.toBeNull();
  });
});
