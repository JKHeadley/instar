/** Refuse an npm release that would omit the Mac desktop helper. */
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
console.log('Universal macOS desktop host is packaged and executable');
