import fs from 'node:fs';
import path from 'node:path';

export type LocalHistoryDirectoryIdentity = Pick<fs.BigIntStats, "dev" | "ino">;

interface PinnedDirectory {
  path: string;
  fd: number;
  identity: fs.BigIntStats;
}

function unavailable(): never {
  throw new Error('local-history-copy-volume');
}

/** Pin trusted, already-created directories during copy admission. The caller
 * still owns path-safe opening and validation at each actual write. */
export function pinLocalHistoryCopyVolume(
  uploadDirectory: string,
  destinationDirectories: readonly string[],
  expectedIdentities: ReadonlyMap<string, LocalHistoryDirectoryIdentity> = new Map(),
) {
  const directories: PinnedDirectory[] = [];
  const close = () => {
    for (const directory of directories.splice(0)) fs.closeSync(directory.fd);
  };
  const revalidate = () => {
    if (!directories.length) unavailable();
    try {
      for (const directory of directories) {
        const current = fs.lstatSync(directory.path, { bigint: true });
        if (!current.isDirectory() || current.dev !== directory.identity.dev || current.ino !== directory.identity.ino) {
          unavailable();
        }
      }
    } catch {
      unavailable();
    }
  };
  try {
    if (!destinationDirectories.length) unavailable();
    for (const directory of [uploadDirectory, ...destinationDirectories]) {
      const absolute = path.resolve(directory);
      const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      let identity: fs.BigIntStats;
      try {
        identity = fs.fstatSync(fd, { bigint: true });
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
      directories.push({ path: absolute, fd, identity });
      const expected = expectedIdentities.get(absolute);
      if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) unavailable();
      if (!identity.isDirectory() || identity.dev !== directories[0].identity.dev) unavailable();
    }
    revalidate();
  } catch {
    close();
    unavailable();
  }

  return Object.freeze({
    revalidate,
    measure() {
      revalidate();
      try {
        const stat = fs.statfsSync(directories[0].path, { bigint: true });
        revalidate();
        const total = stat.blocks * stat.bsize;
        const free = stat.bavail * stat.bsize;
        if (stat.bsize <= 0n || total <= 0n || free < 0n || free > total || total > BigInt(Number.MAX_SAFE_INTEGER)) {
          unavailable();
        }
        return { blockBytes: Number(stat.bsize), total: Number(total), free: Number(free) };
      } catch {
        unavailable();
      }
    },
    assertFileVolume(fd: number) {
      revalidate();
      try {
        const identity = fs.fstatSync(fd, { bigint: true });
        if (!identity.isFile() || identity.dev !== directories[0].identity.dev) unavailable();
      } catch {
        unavailable();
      }
    },
    close,
  });
}
