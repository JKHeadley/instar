/** Refuse an npm release that would omit the Mac desktop helper. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(root, 'dist/native/instar-desktop-host');
const bytes = fs.readFileSync(binary);
if (bytes.length < 4096 || bytes.readUInt32BE(0) !== 0xcafebabe) {
  throw new Error('Release desktop host is missing or is not a universal Mach-O binary');
}
const count = bytes.readUInt32BE(4);
if (count < 2 || count > 8 || bytes.length < 8 + count * 20) {
  throw new Error('Release desktop host has an invalid architecture table');
}
const archs = new Set();
for (let i = 0; i < count; i++) archs.add(bytes.readUInt32BE(8 + i * 20));
if (!archs.has(0x0100000c) || !archs.has(0x01000007)) {
  throw new Error('Release desktop host must contain arm64 and x86_64');
}
if (!(fs.statSync(binary).mode & 0o111)) {
  throw new Error('Release desktop host is not executable');
}
const manifest = JSON.parse(fs.readFileSync(`${binary}.json`, 'utf8'));
if (!/^[a-f0-9]{64}$/.test(manifest.sourceHash ?? '')) {
  throw new Error('Release desktop host has no source hash, so Macs could not tell when their kept copy is current');
}
// The publish job re-checks the artifact on Linux, where codesign is absent.
if (process.platform === 'darwin') {
  const details = execFileSync('codesign', ['-d', '-r-', '--verbose=2', binary], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (process.env.INSTAR_MACOS_SIGNING_IDENTITY?.trim() && /designated => cdhash/.test(details)) {
    throw new Error('Release desktop host lost its signing identity, so macOS grants would not survive an update');
  }
}

// The wedge canary (machine-self-maintenance Part E, F1): a no-UI app bundle beside the helper.
const canaryApp = path.join(root, 'dist/native/InstarWedgeCanary.app');
const canaryBinary = path.join(canaryApp, 'Contents/MacOS/InstarWedgeCanary');
const canaryBytes = fs.readFileSync(canaryBinary);
if (canaryBytes.length < 4096 || canaryBytes.readUInt32BE(0) !== 0xcafebabe) {
  throw new Error('Release wedge canary is missing or is not a universal Mach-O binary');
}
const canaryArchCount = canaryBytes.readUInt32BE(4);
const canaryArchs = new Set();
for (let i = 0; i < canaryArchCount && 8 + (i + 1) * 20 <= canaryBytes.length; i++) canaryArchs.add(canaryBytes.readUInt32BE(8 + i * 20));
if (!canaryArchs.has(0x0100000c) || !canaryArchs.has(0x01000007)) {
  throw new Error('Release wedge canary must contain arm64 and x86_64');
}
if (!(fs.statSync(canaryBinary).mode & 0o111)) {
  throw new Error('Release wedge canary is not executable');
}
const plist = fs.readFileSync(path.join(canaryApp, 'Contents/Info.plist'), 'utf8');
for (const key of ['LSBackgroundOnly', 'LSUIElement']) {
  if (!new RegExp(`<key>${key}</key>\\s*<true/>`).test(plist)) throw new Error(`Release wedge canary must set ${key}: it must never show a window or a Dock icon`);
}
if (!fs.existsSync(path.join(canaryApp, 'Contents/_CodeSignature/CodeResources'))) {
  throw new Error('Release wedge canary bundle is not signed');
}
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--verify', '--strict', canaryApp], { stdio: ['ignore', 'pipe', 'pipe'] });
}
console.log('Universal macOS desktop host and wedge canary are packaged and executable');
