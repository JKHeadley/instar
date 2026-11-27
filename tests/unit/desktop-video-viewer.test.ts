import { describe, expect, it, vi } from 'vitest';
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
    <div id="unlock"></div><select id="machine"></select><ul id="machineNotes"></ul>
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
    expect((v.window.document.getElementById('retryButton') as HTMLButtonElement).hidden).toBe(false);
    expect(options.map(option => [option.textContent, option.disabled])).toEqual([
      ['Mama PC — Windows companion is not running.', true], ['Mac Studio', false],
    ]);
    expect((v.window.document.getElementById('machine') as HTMLSelectElement).value).toBe('m_studio');
    v.dom.window.close();
  });

  it('rechecks an unanswered Mac alongside a ready machine and enables it after a successful reply', async () => {
    const v = viewer();
    const doc = v.window.document;
    const peer = { machineId: 'peer', label: 'Mac Mini', targetSigningPublicKey: 'peer-key' };
    const local = { machineId: 'local', label: 'Mac Studio', ready: true, targetSigningPublicKey: 'local-key' };
    const reason = 'Could not check this machine’s desktop. Select Check again to retry.';
    const targets = vi.fn()
      .mockResolvedValueOnce({ machines: [local, { ...peer, ready: false, unavailableReason: reason }] })
      .mockRejectedValueOnce(new Error('The check timed out.'))
      .mockResolvedValueOnce({ machines: [local, { ...peer, ready: true }] });
    Object.assign(v.window, { targets });
    v.window.eval('api = window.targets; refreshLockedCard = () => {}; refreshSetup = async () => {};');
    await v.window.eval('loadTargetsAndMaybeOpen()');
    const machine = doc.querySelector<HTMLSelectElement>('#machine')!;
    const retry = doc.querySelector<HTMLButtonElement>('#retryButton')!;
    expect(machine.options[1].disabled).toBe(true);
    expect(machine.options[1].textContent).toContain(reason);
    expect(doc.querySelector('#machineNotes')!.textContent).toContain(reason);
    expect(machine.value).toBe(local.machineId);
    expect(retry.hidden).toBe(false);
    retry.click();
    await vi.waitFor(() => expect(doc.querySelector('#status')!.textContent).toBe('The check timed out.'));
    expect(retry.disabled).toBe(false);
    expect(machine.options[1].disabled).toBe(true);
    expect(doc.querySelector<HTMLButtonElement>('#requestButton')!.disabled).toBe(false);
    retry.click();
    await vi.waitFor(() => expect(machine.options[1].disabled).toBe(false));
    expect(targets.mock.calls).toEqual([['/desktop/targets'], ['/desktop/targets'], ['/desktop/targets']]);
    expect(machine.options[1].textContent).toBe(peer.label);
    expect(doc.querySelector('#machineNotes')!.textContent).toBe('');
    expect(retry.hidden).toBe(true);
    v.dom.window.close();
  });

  it.each(['ready', 'removed', 'unavailable', 'missing key'])('rechecks the selected machine when it is %s', async state => {
    const v = viewer();
    const doc = v.window.document;
    const alpha = { machineId: 'alpha', label: 'Alpha', ready: true, targetSigningPublicKey: 'a-key' };
    const beta = { ...alpha, machineId: 'beta', label: 'Beta', targetSigningPublicKey: 'b-key' };
    const gamma = { machineId: 'gamma', label: 'Gamma', ready: false };
    const refreshed = state === 'removed' ? [alpha] : [
      alpha, { ...beta, ready: state !== 'unavailable', targetSigningPublicKey: state === 'missing key' ? '' : beta.targetSigningPublicKey }, gamma,
    ];
    const targets = vi.fn().mockResolvedValueOnce({ machines: [alpha, beta, gamma] })
      .mockResolvedValueOnce({ machines: refreshed });
    const open = vi.fn();
    Object.assign(v.window, { targets, openFixture: open });
    v.window.eval('api = window.targets; refreshLockedCard = () => {}; refreshSetup = async () => {}; requestDesktop = window.openFixture;');
    await v.window.eval('loadTargetsAndMaybeOpen()');
    const picker = doc.querySelector<HTMLSelectElement>('#machine')!;
    picker.value = beta.machineId;
    const retry = doc.querySelector<HTMLButtonElement>('#retryButton')!;
    retry.click();
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    expect(picker.value).toBe(state === 'ready' ? beta.machineId : alpha.machineId);
    expect(picker.selectedOptions[0].disabled).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(targets.mock.calls).toEqual([['/desktop/targets'], ['/desktop/targets']]);
    v.dom.window.close();
  });

  it.each(['manual', 'deep link'])('hides retry while a %s open is pending and restores it on failure', async mode => {
    const v = viewer();
    const doc = v.window.document;
    const retry = doc.querySelector<HTMLButtonElement>('#retryButton')!;
    if (mode === 'deep link') v.window.history.replaceState({}, '', '?machineId=ready');
    let failOpen!: (error: Error) => void;
    const pending = new Promise((_, reject) => { failOpen = reject; });
    Object.defineProperty(v.window.crypto, 'subtle', { value: { generateKey: () => pending } });
    v.window.eval(`api = async () => ({ machines: [
      { machineId: 'ready', label: 'Mac Studio', ready: true, targetSigningPublicKey: 'key' },
      { machineId: 'unknown', label: 'Mac Mini', ready: false, unavailableReason: 'Could not check.' }
    ] }); refreshLockedCard = () => {};`);
    const loading = v.window.eval('loadTargetsAndMaybeOpen()');
    if (mode === 'manual') {
      await loading;
      expect(retry.hidden).toBe(false);
      doc.querySelector<HTMLButtonElement>('#requestButton')!.click();
    }
    await vi.waitFor(() => expect(doc.querySelector<HTMLButtonElement>('#requestButton')!.disabled).toBe(true));
    expect(retry.hidden).toBe(true);
    failOpen(new Error('Fixture open failed'));
    await loading;
    await vi.waitFor(() => expect(doc.querySelector('#status')!.textContent).toBe('Fixture open failed'));
    expect(retry.hidden).toBe(false);
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
