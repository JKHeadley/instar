import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseDesktopDisplays, type DesktopHost } from '../../src/core/DesktopHost.js';
import { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import { WindowsDesktopHost } from '../../src/core/WindowsDesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = { id: '1', name: 'Built-in Retina Display', width: 3024, height: 1964, main: true };
const B = { id: '2', name: 'LG HDR 4K (1)', width: 3840, height: 2160, main: false };

function cleanupScope(filename: string): { localVerifyScopeOk?: { verifyRoot: string } } {
  const marker = `${path.sep}.worktrees${path.sep}.verify${path.sep}`;
  const at = filename.indexOf(marker);
  return at < 0 ? {} : { localVerifyScopeOk: { verifyRoot: filename.slice(0, at + marker.length - 1) } };
}

describe('parseDesktopDisplays', () => {
  it('keeps a good list and cleans host text', () => {
    expect(parseDesktopDisplays({ displays: [A, { ...B, name: 'LG\u0007\n  ' }, { ...B, id: '3', name: '' }] })
      .map(display => display.name)).toEqual([A.name, 'LG', 'Display 3']);
  });
  it('bounds a name and refuses malformed rows', () => {
    expect(parseDesktopDisplays({ displays: [{ ...A, name: 'x'.repeat(200) }] })[0].name).toHaveLength(64);
    for (const bad of [null, {}, { displays: 'x' }, { displays: [{ ...A, id: '../evil' }] },
      { displays: [{ ...A, width: 0 }] }, { displays: [{ ...A, height: 1.5 }] },
      { displays: [{ ...A, main: 'yes' }] }, { displays: [A, A] },
      { displays: Array.from({ length: 17 }, (_, i) => ({ ...A, id: String(i) })) }]) {
      expect(() => parseDesktopDisplays(bad)).toThrow('desktop-displays-invalid');
    }
  });
});

describe.skipIf(process.platform !== 'darwin')('MacDesktopHost screens', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const filename of made.splice(0)) {
      SafeFsExecutor.safeUnlinkSync(filename, { operation: 'tests/unit/desktop-displays.test.ts:helper', ...cleanupScope(filename) });
      SafeFsExecutor.safeRmSync(filename + '.logs', { recursive: true, force: true, operation: 'tests/unit/desktop-displays.test.ts:logs', ...cleanupScope(filename) });
    }
  });
  function helper(mode: 'current' | 'old' = 'current') {
    const filename = path.resolve('dist/native', `instar-desktop-displays-test-${process.pid}-${made.length}`);
    fs.mkdirSync(`${filename}.logs`, { recursive: true });
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const logs = JSON.stringify(`${filename}.logs`);
    const script = `#!${process.execPath}
import fs from 'node:fs';
const logs=${logs},[cmd,arg]=process.argv.slice(2);
fs.appendFileSync(logs+'/argv',process.argv.slice(2).join(' ')+'\\n');
const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]);
if(cmd==='displays'){
  if(${JSON.stringify(mode)}==='old')process.exit(64);
  const rows=fs.existsSync(logs+'/unplugged')?[${JSON.stringify(A)}]:[${JSON.stringify(A)},${JSON.stringify(B)}];
  process.stdout.write(JSON.stringify({displays:rows}));
}else if(cmd==='capture-stream'){
  process.stdin.on('data',()=>{
    if(arg&&fs.existsSync(logs+'/unplugged'))process.exit(69);
    const h=Buffer.alloc(4);h.writeUInt32BE(4);process.stdout.write(Buffer.concat([h,jpeg]));
  });
}else if(cmd==='input-stream'){
  process.stdin.on('data',d=>{fs.appendFileSync(logs+'/input',d);process.stdout.write('{"ok":true}\\n')});
}else if(cmd==='cursor'){process.stdout.write('{"x":0.5,"y":0.5}')}
else process.exit(64);
`;
    fs.writeFileSync(filename, script, { mode: 0o700 });
    made.push(filename);
    const host = new MacDesktopHost(filename);
    return { host, argv: () => fs.readFileSync(`${filename}.logs/argv`, 'utf8').trim().split('\n'),
      input: () => fs.readFileSync(`${filename}.logs/input`, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>),
      unplug: () => fs.writeFileSync(`${filename}.logs/unplugged`, '1') };
  }

  it('reports the main display as current until another is chosen', async () => {
    const { host } = helper();
    expect(host.platform).toBe('macos');
    expect(await host.listDisplays()).toEqual({ displays: [A, B], currentDisplayId: '1', canShowAll: false });
    expect(await host.selectDisplay('2')).toBe(true);
    expect((await host.listDisplays()).currentDisplayId).toBe('2');
  });

  it('keeps the original wire form until a screen is chosen', async () => {
    const { host, argv, input } = helper();
    await host.capture();
    await host.cursor();
    await host.input({ kind: 'move', x: 0.5, y: 0.5 });
    expect(argv()).toEqual(['capture-stream', 'cursor', 'input-stream']);
    expect(input()).toEqual([{ kind: 'move', x: 0.5, y: 0.5 }]);
    await host.stopIndicator();
    await host.cancelInput();
  });

  it('restarts capture on the chosen screen and names it on every pointer action', async () => {
    const { host, argv, input } = helper();
    await host.capture();
    expect(await host.selectDisplay('2')).toBe(true);
    await host.capture();
    await host.cursor();
    await host.input({ kind: 'click', x: 0.1, y: 0.2, button: 'left' });
    await host.input({ kind: 'keyDown', key: 'Control' });
    await host.input({ kind: 'keyUp', key: 'Control' });
    expect(argv()).toEqual(['capture-stream', 'displays', 'capture-stream 2', 'cursor 2', 'input-stream']);
    expect(input()[0]).toEqual({ kind: 'click', x: 0.1, y: 0.2, button: 'left', displayId: '2' });
    expect(input()[1]).toEqual({ kind: 'keyDown', key: 'Control' });
    await host.cancelInput();
  });

  it('refuses a screen that is not there and changes nothing', async () => {
    const { host, argv } = helper();
    await host.capture();
    expect(await host.selectDisplay('9')).toBe(false);
    expect(await host.selectDisplay('../9')).toBe(false);
    await host.capture();
    expect(argv().filter(line => line.startsWith('capture-stream'))).toEqual(['capture-stream']);
  });

  it('returns to the main display when the chosen screen is unplugged', async () => {
    const { host, argv, unplug } = helper();
    await host.selectDisplay('2');
    await host.capture();
    unplug();
    await expect(host.capture()).rejects.toThrow();
    expect(Buffer.isBuffer(await host.capture())).toBe(true);
    expect((await host.listDisplays()).currentDisplayId).toBe('1');
    expect(argv().filter(line => line.startsWith('capture-stream'))).toEqual(['capture-stream 2', 'capture-stream']);
  });

  it('never starts a capture helper when Stop lands during the display re-read', async () => {
    const { host, argv, unplug } = helper();
    await host.selectDisplay('2');
    await host.capture();
    unplug();
    await expect(host.capture()).rejects.toThrow();
    const pending = host.capture();
    host.stopIndicator();
    await expect(pending).rejects.toThrow('mac-desktop-host-capture-cancelled');
    expect(argv().filter(line => line.startsWith('capture-stream'))).toEqual(['capture-stream 2']);
  });

  it('rejects the list on an older helper that has no displays command', async () => {
    await expect(helper('old').host.listDisplays()).rejects.toThrow();
  });
});

describe('WindowsDesktopHost screens', () => {
  const secret = Buffer.alloc(32, 7);
  function host(reply: (op: string, body: Record<string, unknown>) => Response | Promise<Response>) {
    const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
    const send = (async (url: string, init: RequestInit) => {
      const op = url.slice('http://127.0.0.1:44818/'.length);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ op, body });
      return reply(op, body);
    }) as typeof fetch;
    return { calls, value: new WindowsDesktopHost('http://127.0.0.1:44818/', secret, send) };
  }
  const row = { id: 'DISPLAY2', name: 'Dell U2720Q', width: 3840, height: 2160, main: false };

  it('defaults to all screens and sends no displayId until one is chosen', async () => {
    const { calls, value } = host(() => Response.json({ ok: true, displays: [row] }));
    expect(value.platform).toBe('windows');
    await value.startIndicator(() => {});
    expect(await value.listDisplays()).toEqual({ displays: [row], currentDisplayId: null, canShowAll: true });
    await value.input({ kind: 'move', x: 0.5, y: 0.5 });
    expect(calls.at(-1)?.body.displayId).toBeUndefined();
    expect(await value.selectDisplay('DISPLAY2')).toBe(true);
    await value.input({ kind: 'move', x: 0.5, y: 0.5 });
    expect(calls.at(-1)?.body.displayId).toBe('DISPLAY2');
    expect(await value.selectDisplay('DISPLAY9')).toBe(false);
    expect(await value.selectDisplay(null)).toBe(true);
    await value.input({ kind: 'move', x: 0.5, y: 0.5 });
    expect(calls.at(-1)?.body.displayId).toBeUndefined();
    value.stopIndicator();
  });

  it('goes back to all screens only when the chosen one is confirmed gone', async () => {
    let gone = false;
    const { value } = host(op => {
      if (op === 'capture') return new Response('x', { status: 400 });
      return Response.json({ ok: true, displays: gone ? [{ ...row, id: 'DISPLAY1' }] : [row] });
    });
    await value.startIndicator(() => {});
    await value.selectDisplay('DISPLAY2');
    await expect(value.capture()).rejects.toThrow();
    expect((await value.listDisplays()).currentDisplayId).toBe('DISPLAY2');
    gone = true;
    await expect(value.capture()).rejects.toThrow();
    expect((await value.listDisplays()).currentDisplayId).toBeNull();
    value.stopIndicator();
  });

  it('keeps the choice when the desktop cannot be read, as at a UAC prompt', async () => {
    const { value } = host(op => {
      if (op === 'capture') return new Response('x', { status: 400 });
      return Response.json({ ok: true, displays: op === 'displays' && unreadable ? [] : [row] });
    });
    let unreadable = false;
    await value.startIndicator(() => {});
    await value.selectDisplay('DISPLAY2');
    unreadable = true;
    await expect(value.capture()).rejects.toThrow();
    expect((await value.listDisplays()).currentDisplayId).toBe('DISPLAY2');
    value.stopIndicator();
  });

  it('rejects the list when an older companion refuses the request', async () => {
    await expect(host(() => new Response('', { status: 400 })).value.listDisplays()).rejects.toThrow();
  });
});

describe('the Windows companion', () => {
  const source = fs.readFileSync('src/native/remote-desktop/windows/InstarDesktopCompanion.cs', 'utf8');
  it('keeps the whole virtual desktop as the default and as the absolute scale', () => {
    expect(source).toContain('if (!command.ContainsKey("displayId")) return SystemInformation.VirtualScreen;');
    const move = source.slice(source.indexOf('static void MoveTo'), source.indexOf('static void Mouse('));
    expect(move).toContain('Rectangle bounds = SystemInformation.VirtualScreen;');
    expect(move).toContain('Coordinate(fx, shown.Left, shown.Width)');
  });
  it('answers displays without a control lease, and the WSL relay lets it through', () => {
    expect(source).toContain('bool leaseless = op == "probe" || op == "displays" || updateOperation;');
    expect(fs.readFileSync('src/core/WindowsDesktopLocalTransport.ts', 'utf8')).toContain("'displays'");
  });
});

describe('the Windows on-machine indicator', () => {
  const source = fs.readFileSync('src/native/remote-desktop/windows/InstarDesktopCompanion.cs', 'utf8');
  const banner = source.slice(source.indexOf('static void StartBanner'), source.indexOf('static void StopLocked'));
  it('stays on top and on screen, away from window buttons, and can be dragged', () => {
    expect(banner).toContain('form.TopMost = true');
    expect(banner).toContain('"Instar remote control active"');
    expect(banner).toContain('form.Location = KeepOnScreen(at, form.Size)');
    expect(banner).toContain('label.MouseMove');
    expect(banner).not.toContain('area.Top');
    expect(source).toContain('return new Point(area.Right - size.Width, area.Bottom - size.Height);');
  });
  it('still ends control when the indicator goes away', () => {
    expect(banner).toContain('if (BannerExitOwnsLease(ownerLease)) StopLocked();');
  });
});

describe('the macOS helper', () => {
  const source = fs.readFileSync('src/native/remote-desktop/macos/InstarDesktopHost.swift', 'utf8');
  it('captures and reads the pointer on the selected screen, never a hardcoded main', () => {
    const stream = source.slice(source.indexOf('private static func captureStream'));
    expect(stream).not.toContain('$0.displayID == CGMainDisplayID()');
    expect(source).toContain('CGDisplayBounds(selectedDisplay())');
  });
  it('marks arrow keys like a physical keyboard so the Fn-registered hotkeys can match', () => {
    expect(source).toContain('if key.hasPrefix("Arrow") { flags.insert([.maskSecondaryFn, .maskNumericPad]) }');
  });
});

function accessFixture(overrides: Partial<DesktopHost>) {
  const now = 1_800_000_000_000;
  const selections: Array<string | null> = [];
  const inputs: unknown[] = [];
  const keyframes: boolean[] = [];
  const host = {
    probe: async () => ({ screenPermission: true, inputPermission: true, displayCount: 2, sessionActive: true }),
    capture: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    captureH264: async (force: boolean) => {
      keyframes.push(force);
      return { keyframe: force, width: 960, height: 540, data: Buffer.from([0, 0, 0, 1, force ? 0x65 : 0x41]) };
    },
    input: async (action: unknown) => { inputs.push(action); },
    cancelInput: () => {},
    startIndicator: async () => {},
    stopIndicator: () => {},
    ...overrides,
  } as DesktopHost;
  const target = crypto.generateKeyPairSync('ed25519');
  const authority = new DirectDesktopAccess('machine-1', 'Echo Mac', host,
    { get: () => 0, set: () => {}, recordFailure: () => ({ attempts: 0, lockedUntilMs: 0 }) },
    { publicKey: target.publicKey.export({ format: 'der', type: 'spki' }),
      sign: payload => crypto.sign(null, payload, target.privateKey) },
    () => true, token => token === 'dashboard-proof', async () => {}, () => {}, () => now, undefined, 'pin');
  const browser = crypto.generateKeyPairSync('ed25519');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const open = async () => {
    const { requestId } = await authority.begin({ machineId: 'machine-1', topicId: 0, operatorUid: 'dashboard-pin',
      operatorSessionToken: 'dashboard-proof',
      browserPublicKey: browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      browserEcdhPublicKey: ecdh.getPublicKey().toString('base64'),
      browserNonce: '0123456789abcdef', scopeConfirmed: true, videoCodec: 'h264' });
    const state = authority.status(requestId, 'dashboard-proof');
    const proof = crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1',
      requestId, state.connectionNonce])), browser.privateKey).toString('base64');
    const ticket = authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!, proof);
    const stream = await authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
    url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    return { requestId, stream };
  };
  return { authority, open, selections, inputs, keyframes };
}

describe('DirectDesktopAccess screens', () => {
  it('answers supported only from a host that listed its screens, and only for a live grant', async () => {
    const f = accessFixture({ platform: 'macos', selectDisplay: async () => true,
      listDisplays: async () => ({ displays: [A, B], currentDisplayId: '1', canShowAll: false }) });
    const { requestId, stream } = await f.open();
    expect(await f.authority.displays(requestId, 'dashboard-proof')).toEqual({ supported: true, platform: 'macos',
      displays: [A, B], currentDisplayId: '1', canShowAll: false });
    await expect(f.authority.displays(requestId, 'someone-else')).rejects.toThrow();
    stream.release('terminal');
    await expect(f.authority.displays(requestId, 'dashboard-proof')).rejects.toThrow();
  });

  it('tells an older host apart: no method, or a helper that refuses, is unsupported with the platform kept', async () => {
    const none = accessFixture({ platform: 'windows' });
    const first = await none.open();
    expect(await none.authority.displays(first.requestId, 'dashboard-proof')).toEqual({ supported: false,
      platform: 'windows', displays: [], currentDisplayId: null, canShowAll: false });
    const refusing = accessFixture({ platform: 'macos', listDisplays: async () => { throw new Error('old'); } });
    const second = await refusing.open();
    expect((await refusing.authority.displays(second.requestId, 'dashboard-proof')).supported).toBe(false);
    const unknown = accessFixture({});
    const third = await unknown.open();
    expect((await unknown.authority.displays(third.requestId, 'dashboard-proof')).platform).toBeNull();
  });

  it('switches the screen inside the session and forces a keyframe, never reaching host.input', async () => {
    const selections: Array<string | null> = [];
    const f = accessFixture({ selectDisplay: async id => { selections.push(id); return true; } });
    const { stream } = await f.open();
    expect(selections).toEqual([null]);
    await stream.captureEncrypted();
    stream.frameQueued?.();
    await stream.captureEncrypted();
    stream.frameQueued?.();
    await stream.input({ kind: 'selectDisplay', displayId: '2' });
    await stream.captureEncrypted();
    expect(selections).toEqual([null, '2']);
    expect(f.keyframes).toEqual([true, false, true]);
    expect(f.inputs).toEqual([]);
    stream.release('terminal');
  });

  it('keeps the session when the screen is not there, and refuses a malformed id', async () => {
    const f = accessFixture({ selectDisplay: async id => id !== '9' });
    const { requestId, stream } = await f.open();
    await stream.input({ kind: 'selectDisplay', displayId: '9' });
    expect(f.authority.status(requestId, 'dashboard-proof').status).toBe('approved');
    await expect(stream.input({ kind: 'selectDisplay', displayId: '../evil' })).rejects.toThrow('desktop display invalid');
    stream.release('terminal');
  });

  it('refuses selectDisplay on a host that cannot do it', async () => {
    const f = accessFixture({});
    const { stream } = await f.open();
    await expect(stream.input({ kind: 'selectDisplay', displayId: '2' })).rejects.toThrow('desktop display invalid');
    stream.release('terminal');
  });

  it('still admits when the host cannot restore the default screen', async () => {
    const f = accessFixture({ selectDisplay: async () => { throw new Error('helper gone'); } });
    const { stream } = await f.open();
    expect(stream.grantId).toBeTruthy();
    stream.release('terminal');
  });
});
