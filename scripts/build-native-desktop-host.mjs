/** Build the local macOS desktop adapter into the package's dist tree.
 * Other platforms use their own adapters and must not claim this one exists. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = path.join(root, 'src/native/remote-desktop/macos/InstarDesktopHost.swift');
  const binary = path.join(root, 'dist/native/instar-desktop-host');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-O', source, '-o', binary], {
    cwd: root,
    stdio: 'inherit',
    timeout: 120_000,
  });
  fs.chmodSync(binary, 0o755);
  console.log('Built local macOS desktop host');
}
