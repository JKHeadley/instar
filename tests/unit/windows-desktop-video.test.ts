import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WindowsDesktopHost, resolveWindowsDesktopVideo } from '../../src/core/WindowsDesktopHost.js';

const secret = Buffer.alloc(32, 9);
const endpoint = 'http://172.22.96.1:44818/';
const companion = readFileSync('src/native/remote-desktop/windows/InstarDesktopCompanion.cs', 'utf8');
const relay = readFileSync('scripts/windows-desktop-local-transport.ps1', 'utf8');

const SPS = [0, 0, 0, 1, 0x67, 0x42, 0x00, 0x28];
const PPS = [0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80];
const IDR = [0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00];
const DELTA = [0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x00];
function packet(keyframe: boolean, width = 1728, height = 1080): Buffer {
  const header = Buffer.alloc(5);
  header[0] = keyframe ? 1 : 0;
  header.writeUInt16BE(width, 1);
  header.writeUInt16BE(height, 3);
  return Buffer.concat([header, Buffer.from(keyframe ? [...SPS, ...PPS, ...IDR] : DELTA)]);
}

function signedBy(op: string, init: RequestInit): boolean {
  const headers = init.headers as Record<string, string>;
  const digest = createHash('sha256').update(String(init.body)).digest('hex');
  return headers['X-Instar-Desktop-Mac'] === createHmac('sha256', secret)
    .update(`instar-windows-desktop-v1\n${op}\n${headers['X-Instar-Desktop-Time']}\n${headers['X-Instar-Desktop-Nonce']}\n${digest}`)
    .digest('base64url');
}

/** A companion stand-in that checks every signature like the real one. */
function fakeCompanion(video: (body: Record<string, unknown>) => Response) {
  const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
  const send = (async (url: string, init: RequestInit) => {
    const op = url.slice(endpoint.length);
    if (!signedBy(op, init)) return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ op, body });
    if (op === 'capture-h264') return video(body);
    if (op === 'displays') return Response.json({ displays: [{ id: 'DISPLAY2', name: 'Side', width: 1920, height: 1200, main: false }] });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { send, calls };
}

describe('Windows desktop video switch', () => {
  it('is live on a development agent and dark on the fleet unless set explicitly', () => {
    expect(resolveWindowsDesktopVideo({})).toBe(false);
    expect(resolveWindowsDesktopVideo({ developmentAgent: false })).toBe(false);
    expect(resolveWindowsDesktopVideo({ developmentAgent: true })).toBe(true);
    expect(resolveWindowsDesktopVideo({ developmentAgent: true, remoteDesktop: { windowsVideo: { enabled: false } } })).toBe(false);
    expect(resolveWindowsDesktopVideo({ remoteDesktop: { windowsVideo: { enabled: true } } })).toBe(true);
    expect(resolveWindowsDesktopVideo({ developmentAgent: true, remoteDesktop: { windowsVideo: {} } })).toBe(true);
  });

  it('offers no video method when switched off, so sessions keep pictures', () => {
    expect(new WindowsDesktopHost(endpoint, secret).captureH264).toBeUndefined();
    expect(new WindowsDesktopHost(endpoint, secret, fetch, 2_000, { video: false }).captureH264).toBeUndefined();
    expect(typeof new WindowsDesktopHost(endpoint, secret, fetch, 2_000, { video: true }).captureH264).toBe('function');
    expect(new WindowsDesktopHost(endpoint, secret, fetch, 2_000, { video: true }).videoFrameIntervalMs).toBe(50);
    expect(new WindowsDesktopHost(endpoint, secret).videoFrameIntervalMs).toBeUndefined();
  });
});

describe('Windows desktop video from the companion', () => {
  it('asks for a keyframe on the leased screen and parses the access unit', async () => {
    const fake = fakeCompanion(body => new Response(packet(body.keyframe === true),
      { headers: { 'Content-Type': 'video/h264' } }));
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true });
    await host.startIndicator(() => {});
    expect(await host.selectDisplay('DISPLAY2')).toBe(true);
    const key = await host.captureH264!(true);
    expect(key).toMatchObject({ keyframe: true, width: 1728, height: 1080 });
    expect(key!.data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    const delta = await host.captureH264!(false);
    expect(delta).toMatchObject({ keyframe: false, width: 1728, height: 1080 });
    const requests = fake.calls.filter(call => call.op === 'capture-h264');
    expect(requests.map(call => call.body.keyframe)).toEqual([true, false]);
    expect(requests.every(call => call.body.displayId === 'DISPLAY2')).toBe(true);
    expect(requests.every(call => typeof call.body.leaseId === 'string')).toBe(true);
    host.stopIndicator();
  });

  it('treats an empty reply as no new picture yet', async () => {
    const fake = fakeCompanion(() => new Response(new Uint8Array(0), { headers: { 'Content-Type': 'video/h264' } }));
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true });
    await host.startIndicator(() => {});
    expect(await host.captureH264!(false)).toBeNull();
    host.stopIndicator();
  });

  it('throws on a refusal, a wrong type or a broken unit so the session falls back to pictures', async () => {
    const replies: Array<() => Response> = [
      // An older companion knows no video operation and answers 400.
      () => new Response('{"error":"desktop-unavailable"}', { status: 400, headers: { 'Content-Type': 'application/json' } }),
      () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } }),
      // A "keyframe" without parameter sets.
      () => new Response(Buffer.concat([Buffer.from([1, 6, 192, 4, 56]), Buffer.from(IDR)]), { headers: { 'Content-Type': 'video/h264' } }),
      // Larger than the viewer contract allows.
      () => new Response(packet(true, 1920, 1200), { headers: { 'Content-Type': 'video/h264' } }),
    ];
    for (const reply of replies) {
      const host = new WindowsDesktopHost(endpoint, secret, fakeCompanion(reply).send, 2_000, { video: true });
      await host.startIndicator(() => {});
      await expect(host.captureH264!(true)).rejects.toThrow();
      host.stopIndicator();
    }
  });

  it('gives up on video after five seconds of empty replies', async () => {
    let now = 1_000;
    const fake = fakeCompanion(() => new Response(new Uint8Array(0), { headers: { 'Content-Type': 'video/h264' } }));
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true, now: () => now });
    await host.startIndicator(() => {});
    expect(await host.captureH264!(false)).toBeNull();
    now += 4_999;
    expect(await host.captureH264!(false)).toBeNull();
    now += 1;
    await expect(host.captureH264!(false)).rejects.toThrow('windows-desktop-video-stalled');
    host.stopIndicator();
  });

  it('resets the empty-reply clock on every picture', async () => {
    let now = 1_000; let empty = true;
    const fake = fakeCompanion(body => empty ? new Response(new Uint8Array(0), { headers: { 'Content-Type': 'video/h264' } })
      : new Response(packet(body.keyframe === true), { headers: { 'Content-Type': 'video/h264' } }));
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true, now: () => now });
    await host.startIndicator(() => {});
    await host.captureH264!(false);
    now += 4_000; empty = false;
    expect(await host.captureH264!(true)).not.toBeNull();
    now += 4_000; empty = true;
    expect(await host.captureH264!(false)).toBeNull();
    host.stopIndicator();
  });

  it('starts the empty-reply clock afresh for a new lease', async () => {
    let now = 1_000;
    const fake = fakeCompanion(() => new Response(new Uint8Array(0), { headers: { 'Content-Type': 'video/h264' } }));
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true, now: () => now });
    await host.startIndicator(() => {});
    expect(await host.captureH264!(false)).toBeNull();
    host.stopIndicator();
    now += 60_000; // long after the old lease's first empty reply
    await host.startIndicator(() => {});
    expect(await host.captureH264!(false)).toBeNull();
    host.stopIndicator();
  });

  it('refuses video without a live lease', async () => {
    const host = new WindowsDesktopHost(endpoint, secret, fakeCompanion(() => new Response(packet(true),
      { headers: { 'Content-Type': 'video/h264' } })).send, 2_000, { video: true });
    await expect(host.captureH264!(true)).rejects.toThrow('lease-unavailable');
  });

  it('counts Windows-side time for video like pictures', async () => {
    const fake = fakeCompanion(() => new Response(packet(true),
      { headers: { 'Content-Type': 'video/h264', 'X-Instar-Relay-Ms': '12' } }));
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true });
    await host.startIndicator(() => {});
    await host.captureH264!(true);
    expect(host.captureTiming()).toEqual({ count: 1, totalMs: 12, maxMs: 12 });
    host.stopIndicator();
  });
});

describe('Windows companion video contract (source)', () => {
  it('accepts the video operation in the companion and the relay', () => {
    expect(companion).toContain('op != "capture-h264"');
    expect(relay).toMatch(/ValidateSet\([^)]*'capture-h264'/);
    expect(relay).toMatch(/@\([^)]*'capture-h264'[^)]*\) -notcontains \$op/);
  });

  it('checks the lease under the gate, then waits for a picture off the accept loop', () => {
    const start = companion.indexOf('if (op == "capture-h264") {');
    const block = companion.slice(start, companion.indexOf('return;', start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('lock (Gate) {');
    expect(block).toContain('OwnsLease(lease)');
    expect(block).toContain('InteractiveDesktop()');
    expect(block).not.toContain('.Take(');
    expect(block).toContain('ThreadPool.QueueUserWorkItem(delegate { ServeVideo(client, stream, video, keyframe); });');
    const serve = companion.slice(companion.indexOf('static void ServeVideo('));
    const body = serve.slice(0, serve.indexOf('\n    }\n'));
    expect(body).toContain('video.Take(keyframe, keyframe ? 300 : 50)');
    expect(body).toContain('"video/h264"');
    expect(body).not.toContain('lock (Gate)');
    expect(body).toContain('finally { stream.Dispose(); client.Close(); }');
  });

  it('fails a stalled stream and stops an idle one, so a viewer never freezes', () => {
    expect(companion).toContain('failure = "video-stalled";');
    expect(companion).toContain('if (Video != null && Video.Idle) StopVideo();');
    expect(companion).toContain('if (stopped) return null; // the lease stopped while this request waited');
    expect(companion).toContain('if (encoder.TakeDropped()) forceKeyframe = true;');
    expect(companion).toMatch(/activate\.ShutdownObject\(\); \} catch \{ \/\* releases the encoder session/);
  });

  it('stops video whenever the lease stops', () => {
    const stop = companion.slice(companion.indexOf('static void StopLocked() {'));
    expect(stop.slice(0, stop.indexOf('}')).trim()).toContain('StopVideo();');
  });

  it('keeps the encoder inside the viewer contract', () => {
    expect(companion).toContain('Set32(output, MtProfile, 66)'); // baseline
    expect(companion).toContain('Set32(output, MtLevel, 40)'); // level 4.0
    expect(companion).toMatch(/1920\.0 \/ area\.Width, 1080\.0 \/ area\.Height/);
    expect(companion).toContain('& ~1');
  });

  it('stays within the C# 5 compiler PowerShell uses', () => {
    const code = companion.replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code).not.toMatch(/\$"/); // string interpolation
    expect(code).not.toMatch(/\?\./); // null-conditional
    expect(code).not.toMatch(/\bnameof\(/);
    expect(code).not.toMatch(/\bout var\b/);
    expect(code).not.toMatch(/\)\s*=>\s*[^{(]*;\s*$/m); // expression-bodied members
  });
});
