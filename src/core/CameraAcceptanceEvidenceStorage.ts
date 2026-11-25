import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseCameraEvidenceRecord } from './CameraAcceptanceEvidenceSource.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_BYTES = 4 * 1024 * 1024;

async function privateEvidenceDirectory(stateDir: string, uid: number, create: boolean) {
  const root = await realpath(stateDir);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.uid !== uid || (rootStat.mode & 0o022) !== 0) return null;
  const directory = path.join(root, 'camera-acceptance-evidence');
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const stat = await lstat(directory);
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0 ? { directory, stat } : null;
}

/** Read a single bounded artifact from the agent-private directory on the serving holder. */
export function cameraAcceptanceEvidenceStorage(stateDir: string) {
  return async (requestId: string): Promise<unknown> => {
    if (!REQUEST_ID.test(requestId) || !process.getuid || !constants.O_NOFOLLOW) return null;
    const uid = process.getuid();
    try {
      const location = await privateEvidenceDirectory(stateDir, uid, false);
      if (!location) return null;
      const { directory, stat: dir } = location;

      const file = await open(path.join(directory, requestId + '.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const currentDir = await lstat(directory);
        if (currentDir.dev !== dir.dev || currentDir.ino !== dir.ino || !currentDir.isDirectory()
          || currentDir.uid !== uid || (currentDir.mode & 0o077) !== 0) return null;
        const before = await file.stat();
        if (!before.isFile() || before.uid !== uid || (before.mode & 0o077) !== 0
          || before.nlink !== 1 || before.size === 0 || before.size > MAX_BYTES) return null;

        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const after = await file.stat();
        if (length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
        return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
      } finally {
        await file.close();
      }
    } catch {
      // @silent-fallback-ok: unavailable, untrusted or malformed storage holds the result.
      return null;
    }
  };
}

export type CameraEvidenceSaveResult = 'saved' | 'exists' | 'invalid' | 'unavailable';

/** The trusted caller must verify actual trial provenance before publishing. */
export async function saveCameraAcceptanceEvidence(stateDir: string, input: unknown): Promise<CameraEvidenceSaveResult> {
  const record = parseCameraEvidenceRecord(input);
  if (!record) return 'invalid';
  if (!process.getuid || !constants.O_NOFOLLOW) return 'unavailable';
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > MAX_BYTES) return 'invalid';

  try {
    const location = await privateEvidenceDirectory(stateDir, process.getuid(), true);
    if (!location) return 'unavailable';
    const { directory, stat } = location;
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const opened = await directoryHandle.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) return 'unavailable';

      const temp = path.join(directory, '.camera-' + randomUUID() + '.tmp');
      const destination = path.join(directory, record.requestId + '.json');
      const staged = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let result: CameraEvidenceSaveResult;
      try {
        try {
          await staged.writeFile(bytes);
          await staged.sync();
        } finally {
          await staged.close();
        }
        try {
          await link(temp, destination);
          result = 'saved';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          result = 'exists';
        }
      } finally {
        await SafeFsExecutor.safeUnlink(temp, { operation: 'camera-acceptance-evidence-staging-cleanup' });
      }
      await directoryHandle.sync();
      const rootHandle = await open(path.dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try {
        await rootHandle.sync();
      } finally {
        await rootHandle.close();
      }
      return result;
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // @silent-fallback-ok: a failed or ambiguous durable publication is not acknowledged.
    return 'unavailable';
  }
}
