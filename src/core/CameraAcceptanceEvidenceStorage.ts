import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_BYTES = 4 * 1024 * 1024;

/** Read a single bounded artifact from the agent-private directory on the serving holder. */
export function cameraAcceptanceEvidenceStorage(stateDir: string) {
  return async (requestId: string): Promise<unknown> => {
    if (!REQUEST_ID.test(requestId) || !process.getuid || !constants.O_NOFOLLOW) return null;
    const uid = process.getuid();
    try {
      const root = await realpath(stateDir);
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.uid !== uid || (rootStat.mode & 0o022) !== 0) return null;
      const directory = path.join(root, 'camera-acceptance-evidence');
      const dir = await lstat(directory);
      if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0) return null;

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
