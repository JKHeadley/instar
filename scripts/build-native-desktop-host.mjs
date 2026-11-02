/** Build the local macOS desktop adapter into the package's dist tree.
 * Other platforms use their own adapters and must not claim this one exists. */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_HOST_IDENTIFIER = 'ai.instar.desktop-host';
// Change this when the build itself changes what the helper does: installed
// Macs keep their copy until this hash moves, and moving it costs a macOS grant.
const BUILD_RECIPE = `v1 -parse-as-library -O ${DESKTOP_HOST_IDENTIFIER}`;
const releaseUniversal = process.argv.includes('--release-universal');
const universal = releaseUniversal || (process.env.INSTAR_RELEASE_BUILD === '1' && process.platform === 'darwin');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowsSource = path.join(root, 'src/native/remote-desktop/windows/InstarDesktopCompanion.cs');
const windowsPackageDir = path.join(root, 'dist/native/windows');
fs.mkdirSync(windowsPackageDir, { recursive: true });
fs.copyFileSync(windowsSource, path.join(windowsPackageDir, 'InstarDesktopCompanion.cs'));
// Written on every platform: the publish job builds the package on Linux and
// adds the macOS binary afterwards, from the same pinned source revision.
const macSource = fs.readFileSync(path.join(root, 'src/native/remote-desktop/macos/InstarDesktopHost.swift'));
fs.mkdirSync(path.join(root, 'dist/native'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/native/instar-desktop-host.json'), `${JSON.stringify({
  sourceHash: crypto.createHash('sha256').update(macSource).update('\0').update(BUILD_RECIPE).digest('hex'),
})}\n`);
if (releaseUniversal && process.platform !== 'darwin') {
  throw new Error('The universal macOS desktop host must be built on macOS');
}

if (process.platform === 'darwin') {
  const source = path.join(root, 'src/native/remote-desktop/macos/InstarDesktopHost.swift');
  const binary = path.join(root, 'dist/native/instar-desktop-host');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const compile = (output, target) => execFileSync('xcrun', [
    'swiftc', ...(target ? ['-target', target] : []),
    '-parse-as-library', '-O', source, '-o', output,
  ], { cwd: root, stdio: 'inherit', timeout: 120_000 });
  if (universal) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-desktop-host-'));
    // The macOS publish runner is ephemeral; its intermediate slices stay
    // outside the npm package and disappear with the runner.
    const arm = path.join(temp, 'arm64');
    const intel = path.join(temp, 'x86_64');
    compile(arm, 'arm64-apple-macosx13.0');
    compile(intel, 'x86_64-apple-macosx13.0');
    execFileSync('lipo', ['-create', arm, intel, '-output', binary], { cwd: root, stdio: 'inherit', timeout: 30_000 });
    // macOS binds a Screen Recording grant to the binary's designated
    // requirement. A real identity keeps that requirement stable across
    // releases; an ad-hoc signature pins it to this exact build's hash.
    const signingIdentity = process.env.INSTAR_MACOS_SIGNING_IDENTITY?.trim() || '-';
    if (signingIdentity === '-') {
      console.warn('No INSTAR_MACOS_SIGNING_IDENTITY: ad-hoc signing, so a changed helper needs a new macOS grant');
    }
    execFileSync('codesign', ['--force', '--identifier', DESKTOP_HOST_IDENTIFIER,
      ...(signingIdentity === '-' ? [] : ['--options', 'runtime', '--timestamp']),
      '--sign', signingIdentity, binary], { cwd: root, stdio: 'inherit', timeout: 120_000 });
    const archs = execFileSync('lipo', ['-archs', binary], { encoding: 'utf8', timeout: 10_000 }).trim().split(/\s+/);
    if (!archs.includes('arm64') || !archs.includes('x86_64')) {
      throw new Error(`Desktop host is missing a release architecture: ${archs.join(', ')}`);
    }
  } else {
    compile(binary);
  }
  fs.chmodSync(binary, 0o755);
  console.log(universal ? 'Built universal macOS desktop host' : 'Built local macOS desktop host');
}
