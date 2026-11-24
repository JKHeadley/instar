/** Test-renderer boundaries only. These helpers neither launch a browser nor authorize a merge. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const VIEWPORTS = Object.freeze({ desktop: Object.freeze({ width: 1280, height: 728 }), phone: Object.freeze({ width: 390, height: 844 }), tablet: Object.freeze({ width: 768, height: 1024 }), wide: Object.freeze({ width: 1440, height: 900 }) });
export const PINNED_PLAYWRIGHT = '1.65.1';
export const PINNED_AXE = '4.14.1';
export const SEED_NOW = '2026-11-01T12:00:00Z';
const beneath = (parent, child) => child.startsWith(parent + path.sep);
function realDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) throw new Error('An absolute canonical directory is required');
  if (fs.realpathSync(value) !== value || !fs.lstatSync(value).isDirectory()) throw new Error('A real directory is required');
  return value;
}
export function validateRendererConfig(input) {
  const fields = ['fixtureOrigin', 'bootNonce', 'seedNow', 'viewport', 'theme', 'runDir', 'rendererDir', 'stepRemainingMs'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw new Error('Invalid renderer configuration fields');
  const url = new URL(input.fixtureOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 || url.origin !== input.fixtureOrigin || url.username || url.password) throw new Error('Only an exact loopback fixture origin is permitted');
  if (typeof input.bootNonce !== 'string' || !/^[a-f0-9]{64}$/.test(input.bootNonce)) throw new Error('A synthetic fixture nonce is required');
  if (input.seedNow !== SEED_NOW || !Object.hasOwn(VIEWPORTS, input.viewport) || !['light', 'dark'].includes(input.theme)) throw new Error('Use the registered seed, standard viewport and explicit theme');
  if (input.stepRemainingMs !== undefined && (!Number.isFinite(input.stepRemainingMs) || input.stepRemainingMs <= 0 || input.stepRemainingMs > 20 * 60_000)) throw new Error('Invalid remaining step allowance');
  const runDir = realDirectory(input.runDir), rendererDir = realDirectory(input.rendererDir);
  const stat = fs.statSync(runDir);
  if (!/^lv-tmp-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(path.basename(runDir)) || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('The private run folder must be owned and mode 0700');
  return Object.freeze({ ...input, viewportName: input.viewport, viewport: VIEWPORTS[input.viewport], runDir, rendererDir });
}
export function allowsFixtureRequest(value, fixtureOrigin) {
  try { const url = new URL(value); return url.protocol === 'http:' && url.origin === fixtureOrigin && !url.username && !url.password; } catch { return false; }
}
export function browserLaunchOptions(config, executablePath) {
  return { executablePath, handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false, headless: true, host: '127.0.0.1', timeout: 30_000,
    env: { HOME: config.runDir, TMPDIR: config.runDir, TMP: config.runDir, TEMP: config.runDir, TZ: 'UTC', LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    // External browser traffic has no direct proxy route; the fixture is not a forward proxy.
    proxy: { server: config.fixtureOrigin, bypass: '127.0.0.1' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] };
}
export function resolvePinnedHeadlessShell(registry, metadata, rendererDir) {
  const descriptor = metadata.browsers?.find(row => row.name === 'chromium-headless-shell');
  if (!descriptor || !/^\d+$/.test(descriptor.revision) || path.basename(rendererDir) !== descriptor.revision) throw new Error('Pinned shell revision does not match its persistent folder');
  const executable = registry.findExecutable('chromium-headless-shell');
  if (!executable) throw new Error('Pinned shell registry entry is absent');
  const filename = fs.realpathSync(executable.executablePath());
  if (!beneath(fs.realpathSync(rendererDir), filename) || !fs.statSync(filename).isFile()) throw new Error('Pinned browser is outside its renderer folder');
  return { executablePath: filename, revision: descriptor.revision, browserVersion: descriptor.browserVersion, sha256: sha256(fs.readFileSync(filename)) };
}
export function inspectOwnedBrowser(child, expectedExecutable, runDir) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || fs.realpathSync(child.spawnfile) !== fs.realpathSync(expectedExecutable)) throw new Error('Unexpected launched browser identity');
  const profiles = child.spawnargs.filter(arg => arg.startsWith('--user-data-dir='));
  if (profiles.length !== 1) throw new Error('Expected one actual browser profile argument');
  const profileDir = profiles[0].slice('--user-data-dir='.length);
  const actualProfile = fs.realpathSync(profileDir);
  if (!beneath(fs.realpathSync(runDir), actualProfile) || actualProfile !== profileDir) throw new Error('Launched browser profile is outside the owned run');
  return { pid: child.pid, spawnfile: fs.realpathSync(child.spawnfile), profileDir: actualProfile };
}
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('Invalid PNG header');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error('Invalid PNG dimensions');
  return { width, height };
}
