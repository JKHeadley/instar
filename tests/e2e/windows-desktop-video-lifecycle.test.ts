/**
 * Windows Remote Desktop video, production path. The always-on part checks the
 * server builds the Windows host with the resolved video switch. The live part
 * (WSL with the companion installed, WINDOWS_DESKTOP_VIDEO_LIVE_TEST=1) drives
 * the real companion through the same discovery and PowerShell relay the
 * server uses, measures the delivered frame rate and decodes the keyframe.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isWslHost } from '../../src/core/wslPlatform.js';
import { desktopFrameIntervalMs } from '../../src/server/DesktopStreamManager.js';
import { discoverWindowsDesktopCompanion } from '../../src/core/WindowsDesktopCompanionDiscovery.js';
import { windowsDesktopLocalSend } from '../../src/core/WindowsDesktopLocalTransport.js';
import { WindowsDesktopHost, resolveWindowsDesktopVideo } from '../../src/core/WindowsDesktopHost.js';

const live = process.platform === 'linux' && process.env.WINDOWS_DESKTOP_VIDEO_LIVE_TEST === '1';

describe('Windows desktop video production boot', () => {
  it('builds the Windows host with the resolved video switch', () => {
    const server = readFileSync('src/server/AgentServer.ts', 'utf8');
    const construction = server.slice(server.indexOf('return new WindowsDesktopHost('));
    expect(construction.slice(0, construction.indexOf(';'))).toContain('{ video: resolveWindowsDesktopVideo(options.config) }');
    expect(server).toMatch(/import \{ WindowsDesktopHost, resolveWindowsDesktopVideo \} from '\.\.\/core\/WindowsDesktopHost\.js';/);
    // Packaged with the companion the installer compiles.
    expect(readFileSync('scripts/build-native-desktop-host.mjs', 'utf8')).toContain('InstarDesktopCompanion.cs');
  });

  it('leaves the fleet on pictures and development agents on video by default', () => {
    expect(resolveWindowsDesktopVideo({ developmentAgent: false })).toBe(false);
    expect(resolveWindowsDesktopVideo({ developmentAgent: true })).toBe(true);
  });

  it.skipIf(!live)('streams real H.264 from the Windows companion at 15 or more pictures a second', async () => {
    expect(isWslHost()).toBe(true);
    const companion = discoverWindowsDesktopCompanion();
    const host = new WindowsDesktopHost(companion.endpoint, companion.secret,
      windowsDesktopLocalSend(companion.endpoint, companion.localTransportScript), 5_000, { video: true });
    expect((await host.probe()).sessionActive).toBe(true);
    await host.startIndicator(() => {});
    const units: Buffer[] = [];
    let keyframe: Buffer | null = null;
    let empty = 0;
    try {
      const deadline = Date.now() + 10_000;
      while (!keyframe && Date.now() < deadline) {
        const frame = await host.captureH264!(true);
        if (frame?.keyframe) { keyframe = frame.data; units.push(frame.data); }
      }
      expect(keyframe, 'first keyframe within 10 s').not.toBeNull();
      // Same pacing as DesktopStreamManager for this host's video session.
      const interval = desktopFrameIntervalMs(host.videoFrameIntervalMs);
      expect(interval).toBe(50);
      const started = Date.now();
      let next = started;
      while (Date.now() - started < 10_000) {
        const frame = await host.captureH264!(false);
        if (frame) units.push(frame.data); else empty++;
        next += interval;
        const wait = next - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait)); else next = Date.now();
      }
      const fps = (units.length - 1) / ((Date.now() - started) / 1000);
      console.log(`windows video: ${units.length - 1} pictures in 10 s = ${fps.toFixed(1)} fps, ${empty} empty, `
        + `avg ${Math.round(units.reduce((sum, unit) => sum + unit.length, 0) / units.length)} bytes, `
        + `windows-side ${JSON.stringify(host.captureTiming())}`);
      expect(fps).toBeGreaterThanOrEqual(15);
      const ffmpeg = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(path => existsSync(path));
      if (ffmpeg) {
        const decoded = spawnSync(ffmpeg, ['-v', 'error', '-f', 'h264', '-i', 'pipe:0', '-f', 'null', '-'],
          { input: Buffer.concat(units), timeout: 30_000 });
        expect(decoded.status, decoded.stderr?.toString()).toBe(0);
        expect(decoded.stderr.toString()).toBe('');
      }
    } finally {
      host.stopIndicator();
    }
  }, 60_000);
});
