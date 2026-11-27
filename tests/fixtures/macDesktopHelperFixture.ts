import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const fixtureRoot = process.platform === 'darwin'
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mac-desktop-helper-'))
  : '';
export const desktopHelperFixtureDir = fixtureRoot ? fs.realpathSync(fixtureRoot) : '';

/** Only the configured packaged location changes. The helper still checks the real file. */
export function pointPackagedDirAtFixture(packagedDir: string): void {
  const realpath = fs.realpathSync;
  vi.spyOn(fs, 'realpathSync').mockImplementation((file, options) =>
    file === packagedDir ? desktopHelperFixtureDir : realpath(file, options));
}

export function disposeDesktopHelperFixture(): void {
  if (!fixtureRoot) return;
  SafeFsExecutor.safeRmSync(fixtureRoot, {
    recursive: true, force: true, operation: 'tests/fixtures/macDesktopHelperFixture.ts',
  });
}
