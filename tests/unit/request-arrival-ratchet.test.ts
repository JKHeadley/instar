/**
 * Identity A4 point 3, the build-time test: a new address-only "is this local?" test fails the
 * build. A site is an address-only local test when it calls `isLoopbackPeer(` or compares a
 * `remoteAddress` with a loopback literal. It is arrival-aware when `mayBeLocalArrival(` or
 * `arrivalOf(` appears on the same line or within the three lines above it. Every site that is not
 * arrival-aware must be one of those that existed when the same-network listener was added (the
 * listener also rewrites its sockets' address, so those answer no there too). The baseline may only
 * shrink: make a new local test ask `mayBeLocalArrival(req)` first (src/core/requestArrival.ts).
 *
 * Its limit, stated: it reads one line and the three above it, so a test split over more lines
 * (an address read into a variable and compared far below) is not seen. The real backstop for
 * those is the listener rewriting its sockets' `remoteAddress` to `sn:<address>`, which no loopback
 * comparison accepts; this test exists so new code asks the arrival first and says so.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../src');
/** Address-only local tests not preceded by an arrival check, per file, when the listener was added. */
const BASELINE: Record<string, number> = {
  'core/DirectDesktopAccess.ts': 1,
  'core/FeatureActionApplier.ts': 3,
  'core/MeshUrlAdvertiser.ts': 1,
  'core/MutualSshRuntime.ts': 2,
  'server/WebSocketManager.ts': 1,
  'server/documentLinkRoutes.ts': 3,
  'server/mobileBrowserDevices.ts': 3,
  'server/mobileLocalOwnerDevice.ts': 1,
  'server/mobilePairingRoutes.ts': 1,
  'server/peerUrlGuard.ts': 2,
  'server/routes.ts': 3,
  'server/skillLearningRoutes.ts': 2,
  'server/telegramOriginRoutes.ts': 3,
  'threadline/ThreadlineMcpHttpService.ts': 2,
};
/** Where the primitives are defined. */
const DEFINITIONS = new Set(['core/desktopTransport.ts', 'core/requestArrival.ts']);
const SITE = /isLoopback\w*\(|localAddress|remoteAddress[^\n]*(127\.0\.0\.1|'::1'|startsWith\('127\.)|(127\.0\.0\.1|'::1')[^\n]*remoteAddress/;
const AWARE = /mayBeLocalArrival\(|arrivalOf\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function unawareSites(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (DEFINITIONS.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || !SITE.test(line)) return;
      const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (AWARE.test(window)) return;
      found[rel] = (found[rel] ?? 0) + 1;
    });
  }
  return found;
}

describe('request arrival ratchet (identity A4 point 3)', () => {
  it('no new address-only local test outside arrivalOf', () => {
    const found = unawareSites();
    const grown = Object.entries(found).filter(([f, n]) => n > (BASELINE[f] ?? 0)).map(([f, n]) => `${f}: ${n} (baseline ${BASELINE[f] ?? 0})`);
    expect(grown, `New address-only local test(s). Ask mayBeLocalArrival(req) first (src/core/requestArrival.ts):\n${grown.join('\n')}`).toEqual([]);
  });

  it('the scanner sees a planted address-only test (positive control)', () => {
    const planted = 'if (isLoopbackPeer(req.socket.remoteAddress)) return true;';
    expect(SITE.test(planted)).toBe(true);
    expect(AWARE.test(planted)).toBe(false);
    expect(AWARE.test('if (!mayBeLocalArrival(req) || !isLoopbackPeer(req.socket.remoteAddress)) return false;')).toBe(true);
  });

  it('the baseline is exact: a fixed site must be removed from it', () => {
    const found = unawareSites();
    const stale = Object.entries(BASELINE).filter(([f, n]) => (found[f] ?? 0) < n).map(([f, n]) => `${f}: ${found[f] ?? 0} (baseline ${n})`);
    expect(stale, `Lower these baseline entries:\n${stale.join('\n')}`).toEqual([]);
  });
});
