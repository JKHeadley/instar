import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findHyprlandSession, HyprlandDesktopHost, LinuxAutoDesktopHost, parseHyprlandMonitors } from '../../src/core/HyprlandDesktopHost.js';
import { encodeWaylandMessage, POINTER_BUTTONS, WaylandVirtualPointer } from '../../src/core/WaylandVirtualPointer.js';
import { desktopProbeUnavailableReason } from '../../src/core/DesktopProbeReadiness.js';
import type { LinuxDesktopHost, LinuxRunner } from '../../src/core/LinuxDesktopHost.js';
import type { DesktopProbe } from '../../src/core/DesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const dirs: string[] = [];
const servers: net.Server[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/hyprland-desktop-host.test.ts' });
});

/** A runtime folder holding a Hyprland session's lock file and Wayland socket. */
function runtimeWithSession(signature = 'abc_123', pid = process.pid, socket = 'wayland-1'): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'hypr', signature), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hypr', signature, 'hyprland.lock'), `${pid}\n${socket}\n`);
  fs.writeFileSync(path.join(dir, socket), '');
  return dir;
}

const MONITORS = JSON.stringify([
  { name: 'DP-1', width: 3840, height: 2160, x: 0, y: 0, scale: 2, transform: 0, focused: true, dpmsStatus: true, disabled: false },
  { name: 'HDMI-A-1', width: 1280, height: 1024, x: 1920, y: 0, scale: 1, transform: 0, focused: false, dpmsStatus: true, disabled: false },
]);

class FakePointer {
  alive = false;
  moves: number[][] = [];
  buttons: [number, boolean][] = [];
  scrolls: [string, number][] = [];
  closed = false;
  async connect(): Promise<void> { this.alive = true; }
  moveAbsolute(x: number, y: number, w: number, h: number): void { this.moves.push([x, y, w, h]); }
  button(code: number, pressed: boolean): void { this.buttons.push([code, pressed]); }
  scroll(axis: string, clicks: number): void { this.scrolls.push([axis, clicks]); }
  close(): void { this.closed = true; this.alive = false; }
}

type Call = { file: string; args: string[]; env: NodeJS.ProcessEnv; input?: string };

function host(overrides: { monitors?: string; run?: Partial<Record<string, (args: string[]) => Buffer | Error>>; tools?: boolean; runtimeDir?: string } = {}) {
  const calls: Call[] = [];
  const pointer = new FakePointer();
  const run: LinuxRunner = async (file, args, { env, input }) => {
    calls.push({ file, args, env, input });
    const handler = overrides.run?.[file];
    if (handler) { const out = handler(args); if (out instanceof Error) throw out; return out; }
    if (file === 'hyprctl' && args[1] === 'monitors') return Buffer.from(overrides.monitors ?? MONITORS);
    if (file === 'hyprctl' && args[1] === 'cursorpos') return Buffer.from('{"x": 960, "y": 540}');
    if (file === 'grim') return JPEG;
    return Buffer.alloc(0);
  };
  const runtimeDir = overrides.runtimeDir ?? runtimeWithSession();
  const instance = new HyprlandDesktopHost({ run, runtimeDir, env: { PATH: '/usr/bin', HOME: '/home/x' }, heartbeatMs: 3_600_000,
    pointerFactory: () => pointer as unknown as WaylandVirtualPointer, sleep: async () => {}, toolExists: () => overrides.tools ?? true });
  return { instance, calls, pointer, runtimeDir };
}

describe('findHyprlandSession', () => {
  it('finds a running session from its lock file', () => {
    const dir = runtimeWithSession('sig_1');
    expect(findHyprlandSession(dir)).toEqual({ signature: 'sig_1', waylandDisplay: 'wayland-1', runtimeDir: dir });
  });

  it('ignores a leftover from an old login, a missing socket and junk', () => {
    const dead = runtimeWithSession('sig_1', 4242);
    expect(findHyprlandSession(dead, () => false)).toBeNull();
    const noSocket = runtimeWithSession('sig_1');
    SafeFsExecutor.safeUnlinkSync(path.join(noSocket, 'wayland-1'), { operation: 'tests/unit/hyprland-desktop-host.test.ts' });
    expect(findHyprlandSession(noSocket)).toBeNull();
    const badName = runtimeWithSession('sig_1');
    fs.writeFileSync(path.join(badName, 'hypr', 'sig_1', 'hyprland.lock'), `${process.pid}\n../../etc/passwd\n`);
    expect(findHyprlandSession(badName)).toBeNull();
    expect(findHyprlandSession(tempDir())).toBeNull();
    expect(findHyprlandSession('/nonexistent/run')).toBeNull();
  });
});

describe('parseHyprlandMonitors', () => {
  it('keeps real pixels for the viewer and layout size for the pointer', () => {
    const [first, second] = parseHyprlandMonitors(MONITORS);
    expect(first).toMatchObject({ id: 'DP-1', main: true, pixelWidth: 3840, pixelHeight: 2160, width: 1920, height: 1080, awake: true });
    expect(second).toMatchObject({ id: 'HDMI-A-1', main: false, x: 1920, width: 1280 });
  });

  it('turns a sideways screen, skips a disabled one, and reads a screen that idled off', () => {
    const rows = parseHyprlandMonitors(JSON.stringify([
      { name: 'A', width: 1080, height: 1920, x: 0, y: 0, scale: 1, transform: 1, focused: false, dpmsStatus: false },
      { name: 'B', width: 800, height: 600, x: 0, y: 0, disabled: true },
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ width: 1920, height: 1080, awake: false, main: true });
  });

  it('refuses output that is not a list', () => {
    expect(() => parseHyprlandMonitors('{"error":"x"}')).toThrow('hyprland-monitors-invalid');
  });
});

describe('HyprlandDesktopHost', () => {
  it('probes as ready with its tools, a session and a monitor, and never as locked', async () => {
    const { instance, calls } = host();
    await expect(instance.probe()).resolves.toMatchObject({ screenPermission: true, inputPermission: true, displayCount: 2,
      sessionActive: true, screenLocked: false, linux: { display: 'wayland-1', capturer: true, compositor: 'hyprland' } });
    const env = calls[0].env;
    expect(env.WAYLAND_DISPLAY).toBe('wayland-1');
    expect(env.HYPRLAND_INSTANCE_SIGNATURE).toBe('abc_123');
    expect(env.XDG_RUNTIME_DIR).toBeTruthy();
  });

  it('says what is wrong: no sign-in, tools missing, or a desktop that stopped answering', async () => {
    const noSession = await host({ runtimeDir: tempDir() }).instance.probe();
    expect(noSession.linux).toMatchObject({ display: null, compositor: 'hyprland' });
    expect(desktopProbeUnavailableReason(noSession)).toContain('Nobody is signed in');

    const noTools = await host({ tools: false }).instance.probe();
    expect(noTools.screenPermission).toBe(false);
    expect(desktopProbeUnavailableReason(noTools)).toContain('grim and wtype');

    const stopped = await host({ run: { hyprctl: () => new Error('dead') } }).instance.probe();
    expect(stopped.sessionActive).toBe(false);
    expect(desktopProbeUnavailableReason(stopped)).toContain('did not answer');
  });

  it('captures a JPEG, of one screen once chosen, and refuses anything else', async () => {
    const { instance, calls } = host();
    await expect(instance.capture()).rejects.toThrow('session-unavailable');
    await instance.startIndicator(() => {});
    await expect(instance.capture()).resolves.toEqual(JPEG);
    expect(calls.filter(c => c.file === 'grim').at(-1)!.args).toEqual(['-t', 'jpeg', '-q', '70', '-']);
    await expect(instance.selectDisplay('HDMI-A-1')).resolves.toBe(true);
    await instance.capture();
    expect(calls.filter(c => c.file === 'grim').at(-1)!.args).toEqual(['-t', 'jpeg', '-q', '70', '-o', 'HDMI-A-1', '-']);
    await expect(instance.selectDisplay('NOPE')).resolves.toBe(false);
    instance.stopIndicator();

    const bad = host({ run: { grim: () => Buffer.from('not a jpeg') } }).instance;
    await bad.startIndicator(() => {});
    await expect(bad.capture()).rejects.toThrow('frame-invalid');
    bad.stopIndicator();
  });

  it('lists screens in real pixels, and maps the viewer point within the chosen screen', async () => {
    const { instance, pointer } = host();
    await expect(instance.listDisplays()).resolves.toMatchObject({ canShowAll: true, currentDisplayId: null,
      displays: [{ id: 'DP-1', width: 3840, height: 2160, main: true }, { id: 'HDMI-A-1', width: 1280 }] });
    await instance.startIndicator(() => {});
    // The whole layout: 1920 + 1280 wide, 1080 tall (the second screen's height is 1024).
    await instance.input({ kind: 'move', x: 1, y: 1 });
    expect(pointer.moves.at(-1)).toEqual([3199, 1079, 3200, 1080]);
    await instance.selectDisplay('HDMI-A-1');
    await instance.input({ kind: 'move', x: 0, y: 0 });
    expect(pointer.moves.at(-1)).toEqual([1920, 0, 3200, 1080]);
    instance.stopIndicator();
  });

  it('clicks with the right button, repeats a double click, and holds a drag until released', async () => {
    const { instance, pointer } = host();
    await instance.startIndicator(() => {});
    await instance.input({ kind: 'click', x: 0.5, y: 0.5, button: 'right', count: 2 });
    expect(pointer.buttons).toEqual([[POINTER_BUTTONS.right, true], [POINTER_BUTTONS.right, false], [POINTER_BUTTONS.right, true], [POINTER_BUTTONS.right, false]]);
    pointer.buttons.length = 0;
    await instance.input({ kind: 'buttonDown', x: 0, y: 0, button: 'left' });
    instance.cancelInput();
    // Stop lets go of what the viewer was still holding.
    expect(pointer.buttons).toEqual([[POINTER_BUTTONS.left, true], [POINTER_BUTTONS.left, false]]);
    instance.stopIndicator();
  });

  it('scrolls whole wheel clicks and carries the remainder', async () => {
    const { instance, pointer } = host();
    await instance.startIndicator(() => {});
    await instance.input({ kind: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 30 });
    expect(pointer.scrolls).toEqual([]);
    await instance.input({ kind: 'scroll', x: 0.5, y: 0.5, dx: -40, dy: 50 });
    expect(pointer.scrolls).toEqual([['vertical', 2], ['horizontal', -1]]);
    instance.stopIndicator();
  });

  it('types on stdin, so typed text never appears in a process list', async () => {
    const { instance, calls } = host();
    await instance.startIndicator(() => {});
    await instance.input({ kind: 'type', text: 'hunter2 --flag' });
    const call = calls.filter(c => c.file === 'wtype').at(-1)!;
    expect(call.args).toEqual(['-']);
    expect(call.input).toBe('hunter2 --flag');
    instance.stopIndicator();
  });

  it('sends a held modifier with the next key, in the same run', async () => {
    const { instance, calls } = host();
    await instance.startIndicator(() => {});
    await instance.input({ kind: 'keyDown', key: 'Control' });
    expect(calls.some(c => c.file === 'wtype')).toBe(false);
    await instance.input({ kind: 'keyDown', key: 'c' });
    expect(calls.filter(c => c.file === 'wtype').at(-1)!.args).toEqual(['-M', 'ctrl', '-k', 'c', '-m', 'ctrl']);
    await instance.input({ kind: 'keyUp', key: 'c' });
    await instance.input({ kind: 'keyUp', key: 'Control' });
    await instance.input({ kind: 'keyDown', key: 'Enter' });
    expect(calls.filter(c => c.file === 'wtype').at(-1)!.args).toEqual(['-k', 'Return']);
    instance.stopIndicator();
  });

  it('sends Shift plus a key as the character it makes, and other chords as chords', async () => {
    const { instance, calls } = host();
    await instance.startIndicator(() => {});
    await instance.input({ kind: 'keyDown', key: 'Shift' });
    await instance.input({ kind: 'keyDown', key: 'a' });
    expect(calls.filter(c => c.file === 'wtype').at(-1)).toMatchObject({ args: ['-'], input: 'A' });
    await instance.input({ kind: 'keyUp', key: 'a' });
    await instance.input({ kind: 'keyDown', key: '1' });
    expect(calls.filter(c => c.file === 'wtype').at(-1)).toMatchObject({ args: ['-'], input: '!' });
    await instance.input({ kind: 'keyUp', key: '1' });
    // Shift+Tab has no character, and Ctrl+Shift+C must stay a chord.
    await instance.input({ kind: 'keyDown', key: 'Tab' });
    expect(calls.filter(c => c.file === 'wtype').at(-1)!.args).toEqual(['-M', 'shift', '-k', 'Tab', '-m', 'shift']);
    await instance.input({ kind: 'keyDown', key: 'Control' });
    await instance.input({ kind: 'keyDown', key: 'c' });
    expect(calls.filter(c => c.file === 'wtype').at(-1)!.args).toEqual(['-M', 'shift', '-M', 'ctrl', '-k', 'c', '-m', 'shift', '-m', 'ctrl']);
    instance.stopIndicator();
  });

  it('wakes a display that idled off when connecting, and leaves an awake one alone', async () => {
    const asleep = JSON.stringify([{ name: 'Virtual-1', width: 1280, height: 800, x: 0, y: 0, scale: 1, focused: true, dpmsStatus: false }]);
    const off = host({ monitors: asleep });
    await off.instance.startIndicator(() => {});
    expect(off.pointer.moves.length).toBeGreaterThan(0);
    off.instance.stopIndicator();

    const on = host();
    await on.instance.startIndicator(() => {});
    expect(on.pointer.moves).toEqual([]);
    on.instance.stopIndicator();
  });

  it('the heartbeat wakes a display that goes off during a session', async () => {
    let monitors = MONITORS;
    const pointer = new FakePointer();
    const instance = new HyprlandDesktopHost({ runtimeDir: runtimeWithSession(), env: { PATH: '/usr/bin' }, heartbeatMs: 2, toolExists: () => true, sleep: async () => {},
      pointerFactory: () => pointer as unknown as WaylandVirtualPointer,
      run: async (file, args) => Buffer.from(args[1] === 'monitors' ? monitors : args[1] === 'cursorpos' ? '{"x":5,"y":5}' : '') });
    await instance.startIndicator(() => {});
    expect(pointer.moves).toEqual([]);
    monitors = JSON.stringify(JSON.parse(MONITORS).map((row: object) => ({ ...row, dpmsStatus: false })));
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(pointer.moves.length).toBeGreaterThan(0);
    instance.stopIndicator();
  });

  it('ends the grant when the desktop goes away', async () => {
    const runtimeDir = runtimeWithSession();
    const calls: string[] = [];
    const instance = new HyprlandDesktopHost({ runtimeDir, env: { PATH: '/usr/bin' }, heartbeatMs: 5, toolExists: () => true,
      pointerFactory: () => new FakePointer() as unknown as WaylandVirtualPointer, sleep: async () => {},
      run: async (file, args) => { calls.push(file); return Buffer.from(args[1] === 'monitors' ? MONITORS : ''); } });
    const lost = new Promise<void>(resolve => { void instance.startIndicator(resolve); });
    await new Promise(resolve => setTimeout(resolve, 15));
    SafeFsExecutor.safeUnlinkSync(path.join(runtimeDir, 'wayland-1'), { operation: 'tests/unit/hyprland-desktop-host.test.ts' });
    await lost;
    await expect(instance.capture()).rejects.toThrow('session-unavailable');
  });

  it('Stop while reading the screens leaves the host free for the next viewer, with no pointer made', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const made: FakePointer[] = [];
    const runtimeDir = runtimeWithSession();
    const instance = new HyprlandDesktopHost({ runtimeDir, env: { PATH: '/usr/bin' }, heartbeatMs: 3_600_000, toolExists: () => true, sleep: async () => {},
      pointerFactory: () => { const p = new FakePointer(); made.push(p); return p as unknown as WaylandVirtualPointer; },
      run: async (file, args) => { if (args[1] === 'monitors') { await gate; return Buffer.from(MONITORS); } return Buffer.alloc(0); } });
    const starting = instance.startIndicator(() => {});
    instance.stopIndicator();
    release();
    await expect(starting).rejects.toThrow('start-cancelled');
    expect(made).toEqual([]);
    await instance.startIndicator(() => {});
    await expect(instance.capture()).rejects.toThrow('frame-invalid'); // admitted: this fake has no grim frame
    instance.stopIndicator();
  });

  it('a pointer finishing its connection after Stop is closed, not kept', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    class SlowPointer extends FakePointer { override async connect(): Promise<void> { await gate; this.alive = true; } }
    const slow = new SlowPointer();
    const instance = new HyprlandDesktopHost({ runtimeDir: runtimeWithSession(), env: { PATH: '/usr/bin' }, heartbeatMs: 3_600_000, toolExists: () => true, sleep: async () => {},
      pointerFactory: () => slow as unknown as WaylandVirtualPointer,
      run: async (file, args) => Buffer.from(args[1] === 'monitors' ? MONITORS : '') });
    const starting = instance.startIndicator(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    instance.stopIndicator();
    release();
    await expect(starting).rejects.toThrow('cancelled');
    expect(slow.closed).toBe(true);
  });

  it('a new start during an old connect gets its own pointer and is not failed by the old one', async () => {
    const gates: (() => void)[] = [];
    const made: FakePointer[] = [];
    class SlowPointer extends FakePointer { override async connect(): Promise<void> { await new Promise<void>(resolve => gates.push(resolve)); this.alive = true; } }
    const instance = new HyprlandDesktopHost({ runtimeDir: runtimeWithSession(), env: { PATH: '/usr/bin' }, heartbeatMs: 3_600_000, toolExists: () => true, sleep: async () => {},
      pointerFactory: () => { const p = new SlowPointer(); made.push(p); return p as unknown as WaylandVirtualPointer; },
      run: async (file, args) => Buffer.from(args[1] === 'monitors' ? MONITORS : '') });
    const first = instance.startIndicator(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    instance.stopIndicator();
    const second = instance.startIndicator(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(made).toHaveLength(2);
    gates.forEach(open => open());
    await expect(first).rejects.toThrow('cancelled');
    await expect(second).resolves.toBeUndefined();
    expect(made[0].closed).toBe(true);
    expect(made[1].alive).toBe(true);
    instance.stopIndicator();
  });

  it('a failed start cleans up, and leaves the next start possible', async () => {
    let fail = true;
    const { instance, pointer } = host({ run: { hyprctl: args => {
      if (args[1] === 'cursorpos' && fail) return new Error('no cursor');
      if (args[1] === 'cursorpos') return Buffer.from('{"x":1,"y":1}');
      return Buffer.from(JSON.stringify([{ name: 'V', width: 800, height: 600, x: 0, y: 0, focused: true, dpmsStatus: false }]));
    } } });
    await expect(instance.startIndicator(() => {})).rejects.toThrow('no cursor');
    expect(pointer.closed).toBe(true);
    fail = false;
    pointer.closed = false;
    await instance.startIndicator(() => {});
    instance.stopIndicator();
  });

  it('nothing reopens the pointer after Stop, and an in-flight action sends nothing', async () => {
    let release = () => {};
    let waitOnce = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const made: FakePointer[] = [];
    const instance = new HyprlandDesktopHost({ runtimeDir: runtimeWithSession(), env: { PATH: '/usr/bin' }, heartbeatMs: 3_600_000, toolExists: () => true, sleep: async () => {},
      pointerFactory: () => { const p = new FakePointer(); made.push(p); return p as unknown as WaylandVirtualPointer; },
      run: async (file, args) => { if (args[1] === 'monitors' && !waitOnce) { await gate; } return Buffer.from(args[1] === 'monitors' ? MONITORS : ''); } });
    await instance.startIndicator(() => {});
    waitOnce = false;
    const moving = instance.input({ kind: 'move', x: 0.5, y: 0.5 });
    await new Promise(resolve => setTimeout(resolve, 5));
    instance.stopIndicator();
    release();
    await expect(moving).rejects.toThrow('cancelled');
    expect(made).toHaveLength(1);
    expect(made[0].moves).toEqual([]);
  });

  it('Stop in the gap of a click lets go of the button', async () => {
    let stop = () => {};
    const pointer = new FakePointer();
    const instance = new HyprlandDesktopHost({ runtimeDir: runtimeWithSession(), env: { PATH: '/usr/bin' }, heartbeatMs: 3_600_000, toolExists: () => true,
      pointerFactory: () => pointer as unknown as WaylandVirtualPointer,
      sleep: async () => { stop(); },
      run: async (file, args) => Buffer.from(args[1] === 'monitors' ? MONITORS : '') });
    await instance.startIndicator(() => {});
    stop = () => instance.stopIndicator();
    await expect(instance.input({ kind: 'click', x: 0.5, y: 0.5, button: 'left' })).rejects.toThrow('cancelled');
    expect(pointer.buttons).toEqual([[POINTER_BUTTONS.left, true], [POINTER_BUTTONS.left, false]]);
  });

  it('input and the heartbeat share one pointer connection', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let count = 0;
    class SlowPointer extends FakePointer { override async connect(): Promise<void> { count++; await gate; this.alive = true; } }
    const instance = new HyprlandDesktopHost({ runtimeDir: runtimeWithSession(), env: { PATH: '/usr/bin' }, heartbeatMs: 3_600_000, toolExists: () => true, sleep: async () => {},
      pointerFactory: () => new SlowPointer() as unknown as WaylandVirtualPointer,
      run: async (file, args) => Buffer.from(args[1] === 'monitors' ? MONITORS : '') });
    const reach = instance as unknown as { pointerAllowed: boolean; connectedPointer(): Promise<unknown> };
    reach.pointerAllowed = true;
    const both = Promise.all([reach.connectedPointer(), reach.connectedPointer()]);
    release();
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(count).toBe(1);
  });

  it('a late failure from an ended session does not end the next one', async () => {
    let rejectOld: (error: Error) => void = () => {};
    let first = true;
    const runtimeDir = runtimeWithSession();
    let lost = 0;
    const instance = new HyprlandDesktopHost({ runtimeDir, env: { PATH: '/usr/bin' }, heartbeatMs: 2, toolExists: () => true, sleep: async () => {},
      pointerFactory: () => new FakePointer() as unknown as WaylandVirtualPointer,
      run: async (file, args) => {
        if (args[1] === 'monitors' && first && callsStarted) { first = false; return new Promise<Buffer>((_, reject) => { rejectOld = reject; }); }
        return Buffer.from(args[1] === 'monitors' ? MONITORS : '');
      } });
    let callsStarted = false;
    await instance.startIndicator(() => { lost++; });
    callsStarted = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    instance.stopIndicator();
    await instance.startIndicator(() => { lost++; });
    rejectOld(new Error('old hyprctl failed'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(lost).toBe(0);
    instance.stopIndicator();
  });

  it('drops queued input after Stop', async () => {
    const { instance } = host();
    await instance.startIndicator(() => {});
    instance.stopIndicator();
    await expect(instance.input({ kind: 'move', x: 0, y: 0 })).rejects.toThrow('session-unavailable');
  });
});

describe('LinuxAutoDesktopHost', () => {
  function x11(probe: Partial<DesktopProbe> = {}) {
    return { probe: async () => ({ screenPermission: false, inputPermission: false, displayCount: 0, sessionActive: false,
      linux: { display: null, capturer: false }, ...probe }), startIndicator: async () => {}, stopIndicator: () => {}, cancelInput: () => {} } as unknown as LinuxDesktopHost;
  }

  it('uses Hyprland while this user has a session, and X11 otherwise', async () => {
    const { instance: hyprland } = host();
    const withSession = new LinuxAutoDesktopHost({ x11: x11(), hyprland, runtimeDir: runtimeWithSession() });
    await expect(withSession.probe()).resolves.toMatchObject({ linux: { compositor: 'hyprland', display: 'wayland-1' } });

    const without = new LinuxAutoDesktopHost({ x11: x11({ sessionActive: true, linux: { display: ':1', capturer: true } }), hyprland, runtimeDir: tempDir() });
    await expect(without.probe()).resolves.toMatchObject({ linux: { display: ':1' } });
  });

  it('a configured X display always means X11', async () => {
    const { instance: hyprland } = host();
    const auto = new LinuxAutoDesktopHost({ display: ':1', x11: x11({ linux: { display: ':1', capturer: true } }), hyprland, runtimeDir: runtimeWithSession() });
    await expect(auto.probe()).resolves.toMatchObject({ linux: { display: ':1' } });
  });

  it('on a Hyprland machine with nobody signed in, says so instead of suggesting a virtual X server', async () => {
    const { instance: hyprland } = host();
    const installed = await new LinuxAutoDesktopHost({ x11: x11(), hyprland, runtimeDir: tempDir(), hyprctlInstalled: () => true }).probe();
    expect(desktopProbeUnavailableReason(installed)).toContain('Nobody is signed in');
    const plainServer = await new LinuxAutoDesktopHost({ x11: x11(), hyprland, runtimeDir: tempDir(), hyprctlInstalled: () => false }).probe();
    expect(desktopProbeUnavailableReason(plainServer)).toContain('virtual desktop');
  });

  it('stays on the chosen host while a start is pending, and is free again if the start fails', async () => {
    const dir = runtimeWithSession();
    let fail: (error: Error) => void = () => {};
    const hyprland = { startIndicator: () => new Promise<void>((_, reject) => { fail = reject; }),
      probe: async () => ({ screenPermission: true, inputPermission: true, displayCount: 1, sessionActive: true, linux: { display: 'wayland-1', capturer: true, compositor: 'hyprland' } }),
      stopIndicator: () => {}, cancelInput: () => {} } as unknown as HyprlandDesktopHost;
    const auto = new LinuxAutoDesktopHost({ x11: x11(), hyprland, runtimeDir: dir });
    const starting = auto.startIndicator(() => {});
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'wayland-1'), { operation: 'tests/unit/hyprland-desktop-host.test.ts' });
    // The session is gone, but a start is pending, so the choice holds.
    await expect(auto.probe()).resolves.toMatchObject({ linux: { display: 'wayland-1' } });
    fail(new Error('down'));
    await expect(starting).rejects.toThrow('down');
    await expect(auto.probe()).resolves.toMatchObject({ linux: { display: null } }); // re-chosen: X11
  });

  it('an old start failing late does not unpin a newer one', async () => {
    const dir = runtimeWithSession();
    const rejects: ((error: Error) => void)[] = [];
    const hyprland = { startIndicator: () => new Promise<void>((_, reject) => { rejects.push(reject); }),
      probe: async () => ({ screenPermission: true, inputPermission: true, displayCount: 1, sessionActive: true, linux: { display: 'wayland-1', capturer: true, compositor: 'hyprland' } }),
      stopIndicator: () => {}, cancelInput: () => {} } as unknown as HyprlandDesktopHost;
    const auto = new LinuxAutoDesktopHost({ x11: x11(), hyprland, runtimeDir: dir });
    const first = auto.startIndicator(() => {});
    void auto.startIndicator(() => {}).catch(() => {});
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'wayland-1'), { operation: 'tests/unit/hyprland-desktop-host.test.ts' });
    rejects[0](new Error('old'));
    await expect(first).rejects.toThrow('old');
    await expect(auto.probe()).resolves.toMatchObject({ linux: { display: 'wayland-1' } });
  });

  it('does not switch hosts while a viewer is connected', async () => {
    const dir = runtimeWithSession();
    const { instance: hyprland } = host({ runtimeDir: dir });
    const auto = new LinuxAutoDesktopHost({ x11: x11(), hyprland, runtimeDir: dir });
    await auto.startIndicator(() => {});
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'wayland-1'), { operation: 'tests/unit/hyprland-desktop-host.test.ts' });
    const probe = await auto.probe();
    expect(probe.linux?.compositor).toBe('hyprland');
    auto.stopIndicator();
  });
});

describe('wiring', () => {
  it('the server builds the choosing host on native Linux, passing the configured display through', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/server/AgentServer.ts'), 'utf8');
    expect(source).toContain('new LinuxAutoDesktopHost({ display: options.config.remoteDesktop?.linuxDisplay ?? null })');
    expect(source).not.toContain('new LinuxDesktopHost(');
  });
});

describe('WaylandVirtualPointer on the wire', () => {
  /** A compositor that offers the given globals and records what it receives. */
  async function compositor(globals: string[]) {
    const dir = tempDir();
    const socketPath = path.join(dir, 'wayland-1');
    const received: { id: number; op: number; body: Buffer }[] = [];
    let buffer = Buffer.alloc(0);
    const clients: net.Socket[] = [];
    const server = net.createServer(socket => {
      clients.push(socket);
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const size = buffer.readUInt32LE(4) >>> 16;
          if (buffer.length < size) break;
          const message = { id: buffer.readUInt32LE(0), op: buffer.readUInt32LE(4) & 0xffff, body: buffer.subarray(8, size) };
          received.push(message);
          buffer = buffer.subarray(size);
          if (message.id === 1 && message.op === 0) {
            const callback = message.body.readUInt32LE(0);
            globals.forEach((name, index) => socket.write(encodeWaylandMessage(2, 0, [index + 7, name, 2])));
            socket.write(encodeWaylandMessage(callback, 0, [0]));
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    return { socketPath, received, clients };
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it('binds the manager, creates a pointer, and sends move, click and scroll as the protocol spells them', async () => {
    const { socketPath, received } = await compositor(['wl_compositor', 'zwlr_virtual_pointer_manager_v1', 'wl_seat']);
    const pointer = new WaylandVirtualPointer(socketPath);
    await pointer.connect();
    expect(pointer.alive).toBe(true);
    pointer.moveAbsolute(900.4, 500, 1280, 800);
    pointer.button(POINTER_BUTTONS.left, true);
    pointer.scroll('vertical', -2);
    await settle();

    const bind = received.find(m => m.id === 2 && m.op === 0)!;
    expect(bind.body.readUInt32LE(0)).toBe(8); // the name the compositor gave the manager
    expect(bind.body.toString('utf8', 8, 39)).toBe('zwlr_virtual_pointer_manager_v1');
    const create = received.find(m => m.id === 4 && m.op === 0)!;
    expect([create.body.readUInt32LE(0), create.body.readUInt32LE(4)]).toEqual([0, 5]);

    const sent = received.filter(m => m.id === 5);
    expect(sent.map(m => m.op)).toEqual([1, 4, 2, 4, 5, 7, 4]);
    const move = sent[0].body;
    expect([move.readUInt32LE(4), move.readUInt32LE(8), move.readUInt32LE(12), move.readUInt32LE(16)]).toEqual([900, 500, 1280, 800]);
    const press = sent[2].body;
    expect([press.readUInt32LE(4), press.readUInt32LE(8)]).toEqual([272, 1]);
    const discrete = sent[5].body;
    expect([discrete.readUInt32LE(4), discrete.readInt32LE(8), discrete.readInt32LE(12)]).toEqual([0, -2 * 15 * 256, -2]);
    pointer.close();
  });

  it('refuses a compositor without the protocol, and a missing socket', async () => {
    const { socketPath } = await compositor(['wl_compositor']);
    await expect(new WaylandVirtualPointer(socketPath).connect()).rejects.toThrow('wayland-pointer-unavailable');
    await expect(new WaylandVirtualPointer(path.join(tempDir(), 'none')).connect()).rejects.toThrow();
  });

  it('reports a lost connection and stops sending', async () => {
    const { socketPath, clients } = await compositor(['zwlr_virtual_pointer_manager_v1']);
    let lost = 0;
    const pointer = new WaylandVirtualPointer(socketPath, () => { lost++; });
    await pointer.connect();
    clients[0].destroy();
    await settle();
    expect(lost).toBe(1);
    expect(pointer.alive).toBe(false);
    expect(() => pointer.moveAbsolute(1, 1, 2, 2)).toThrow('not-connected');
  });

  it('a compositor error ends the pointer instead of being ignored', async () => {
    const { socketPath, clients } = await compositor(['zwlr_virtual_pointer_manager_v1']);
    let lost = 0;
    const pointer = new WaylandVirtualPointer(socketPath, () => { lost++; });
    await pointer.connect();
    clients[0].write(encodeWaylandMessage(1, 0, [5, 1, 'bad request']));
    await settle();
    expect(lost).toBe(1);
    expect(pointer.alive).toBe(false);
  });
});
