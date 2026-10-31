import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const start = [0, 0, 0, 1];
function packet(width = 960, height = 540): Uint8Array {
  const data = Uint8Array.from([...start, 0x67, 1, ...start, 0x68, 2, ...start, 0x65, 3]);
  const result = new Uint8Array(18 + data.length);
  result.set([73, 68, 86, 49, 1, 1]); // IDV1, Annex B, keyframe
  const view = new DataView(result.buffer);
  view.setUint16(6, width);
  view.setUint16(8, height);
  view.setBigUint64(10, 1_800_000_000_000n);
  result.set(data, 18);
  return result;
}

function viewer() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="surface"></div><div id="viewTransform"><img id="screen"><canvas id="videoCanvas" hidden></canvas><div id="localCursor"></div></div>
    <div id="desktopTools" hidden></div><div id="keyboardBar" hidden></div>
    <button id="toolsButton"></button><button id="keyboardButton"></button><button id="hideKeyboardButton"></button>
    <button id="zoomResetButton" hidden></button><button id="fullscreenButton"></button>
    <button id="modeButton"></button><button id="dragButton"></button><button id="rightButton"></button>
    <button id="stopButton"></button><input id="typeText">
    <button id="unlockButton"></button><button id="retryButton"></button><button id="requestButton"></button>
    <div id="status"></div><div id="liveStatus"></div><div id="control"></div><div id="request"></div>
    <div id="unlock"></div><select id="machine"></select>
  </body>`, { url: 'https://instar.example/dashboard/desktop', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }) });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  const decoders: Array<{ output: (frame: object) => void; error: () => void; closed: boolean }> = [];
  const commands: string[] = [];
  class Decoder {
    decodeQueueSize = 0;
    output: (frame: object) => void;
    error: () => void;
    closed = false;
    constructor(callbacks: { output: (frame: object) => void; error: () => void }) {
      this.output = callbacks.output;
      this.error = callbacks.error;
      decoders.push(this);
    }
    configure() {}
    decode() {}
    close() { this.closed = true; }
  }
  Object.defineProperty(window, 'VideoDecoder', { value: Decoder });
  Object.defineProperty(window, 'EncodedVideoChunk', { value: class { constructor(_: object) {} } });
  const source = fs.readFileSync(new URL('../../dashboard/desktop.js', import.meta.url), 'utf8');
  window.eval(`${source}\ninputEnabled = true; activeVideoCodec = 'h264';
    sendCommand = command => { window.__commands.push(command.type); return Promise.resolve(true); };
    window.__video = { receiveH264, fallbackVideo, leave, getCodec: () => activeVideoCodec };
    window.__verifyTargetForTest = (trustedKey, result) => {
      machineId = 'm_target'; requestId = 'request-1';
      trustedTargetSigningPublicKey = trustedKey;
      return verifyTarget(result);
    };`);
  Object.assign(window, { __commands: commands });
  const video = (window as unknown as { __video: {
    receiveH264(data: Uint8Array, epoch: number): void;
    fallbackVideo(epoch: number): void;
    leave(message: string): void;
    getCodec(): string;
  } }).__video;
  return { dom, video, decoders, commands, window };
}

describe('desktop H.264 viewer resource bounds', () => {
  it('switches to JPEG if a supported decoder never presents its first frame', async () => {
    const v = viewer();
    v.video.receiveH264(packet(1920, 1080), 0);
    await new Promise(resolve => setTimeout(resolve, 2_600));
    expect(v.video.getCodec()).toBe('jpeg');
    expect(v.decoders[0].closed).toBe(true);
    expect(v.commands).toEqual(['video-fallback']);
    v.dom.window.close();
  });

  it('closes oversized decoded output and switches to JPEG compatibility once', () => {
    const v = viewer();
    v.video.receiveH264(packet(), 0);
    expect(v.decoders).toHaveLength(1);
    let closes = 0;
    v.decoders[0].output({ displayWidth: 2560, displayHeight: 1440, close: () => { closes++; } });
    expect(closes).toBe(1);
    expect(v.decoders[0].closed).toBe(true);
    expect(v.video.getCodec()).toBe('jpeg');
    expect(v.commands).toEqual(['video-fallback']);
    expect(v.window.document.getElementById('status')!.textContent).toContain('compatibility mode');
    v.video.fallbackVideo(0);
    expect(v.commands).toEqual(['video-fallback']);
    v.dom.window.close();
  });

  it('closes delayed decoded output after Stop without drawing it', () => {
    const v = viewer();
    v.video.receiveH264(packet(), 0);
    v.video.leave('Stopped.');
    let closes = 0;
    v.decoders[0].output({ displayWidth: 960, displayHeight: 540, close: () => { closes++; } });
    expect(closes).toBe(1);
    expect(v.commands).toEqual([]);
    expect(v.window.document.getElementById('status')!.textContent).toBe('Stopped.');
    v.dom.window.close();
  });

  it('ignores a late decoder error after a same-stream geometry reset', () => {
    const v = viewer();
    v.video.receiveH264(packet(960, 540), 0);
    v.video.receiveH264(packet(640, 360), 0);
    expect(v.decoders).toHaveLength(2);
    expect(v.decoders[0].closed).toBe(true);
    v.decoders[0].error();
    expect(v.video.getCodec()).toBe('h264');
    expect(v.decoders[1].closed).toBe(false);
    expect(v.commands).toEqual([]);
    v.dom.window.close();
  });
});

describe('desktop target selection', () => {
  it('refuses an attacker signing key before accepting a target grant', async () => {
    const v = viewer();
    const verification = (v.window as unknown as { __verifyTargetForTest:
      (key: string, result: object) => Promise<void> }).__verifyTargetForTest('AQID', {
        machineId: 'm_target', videoCodec: 'jpeg', expiresAt: v.window.Date.now() + 60_000,
        targetSigningPublicKey: 'BAUG', targetSignature: 'AQID',
      });
    await expect(verification).rejects.toThrow('does not match the registered machine');
    v.dom.window.close();
  });

  it('does not silently open another machine when a deep-linked target is unavailable', async () => {
    const v = viewer();
    v.window.history.replaceState({}, '', '?machineId=m_requested');
    v.window.eval(`api = async () => ({ machines: [
      { machineId: 'm_studio', label: 'Mac Studio', ready: true,
        targetSigningPublicKey: 'registered-studio-key' },
      { machineId: 'm_requested', label: 'Mama PC', ready: false,
        unavailableReason: 'Mama PC is not ready yet.' }
    ] });
    requestDesktop = async () => { window.__opened = true; };
    window.__loadTargets = loadTargetsAndMaybeOpen;`);
    await (v.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();
    expect((v.window as unknown as { __opened?: boolean }).__opened).toBeUndefined();
    expect(v.window.document.getElementById('status')!.textContent).toBe('Mama PC is not ready yet.');
    expect((v.window.document.getElementById('retryButton') as HTMLButtonElement).hidden).toBe(false);
    expect((v.window.document.getElementById('request') as HTMLDivElement).hidden).toBe(false);
    v.dom.window.close();
  });

  it('shows every registered machine and its unavailable reason before opening the sole ready host', async () => {
    const v = viewer();
    v.window.eval(`api = async () => ({ machines: [
      { machineId: 'm_mama', label: 'Mama PC', ready: false,
        unavailableReason: 'Windows companion is not running.' },
      { machineId: 'm_studio', label: 'Mac Studio', ready: true,
        targetSigningPublicKey: 'registered-studio-key' }
    ] });
    requestDesktop = async () => { window.__opened = true; };
    window.__loadTargets = loadTargetsAndMaybeOpen;`);
    await (v.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();
    expect((v.window as unknown as { __opened?: boolean }).__opened).toBeUndefined();
    expect((v.window.document.getElementById('request') as HTMLDivElement).hidden).toBe(false);
    const options = [...(v.window.document.getElementById('machine') as HTMLSelectElement).options];
    expect(options.map(option => [option.textContent, option.disabled])).toEqual([
      ['Mama PC — Windows companion is not running.', true], ['Mac Studio', false],
    ]);
    expect((v.window.document.getElementById('machine') as HTMLSelectElement).value).toBe('m_studio');
    v.dom.window.close();
  });

  it('shows unavailable machines but disables Open when none can be controlled', async () => {
    const v = viewer();
    v.window.eval(`api = async () => ({ machines: [
      { machineId: 'm_mama', label: 'Mama PC', ready: false,
        unavailableReason: 'Windows companion is not running.' }
    ] });
    window.__loadTargets = loadTargetsAndMaybeOpen;`);
    await (v.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();
    expect((v.window.document.getElementById('request') as HTMLDivElement).hidden).toBe(false);
    expect((v.window.document.getElementById('requestButton') as HTMLButtonElement).disabled).toBe(true);
    expect((v.window.document.getElementById('machine') as HTMLSelectElement).options[0].textContent)
      .toBe('Mama PC — Windows companion is not running.');
    v.dom.window.close();
  });
});
