import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LinuxDesktopHost, linuxKeysym, parseXrandrMonitors, type LinuxRunner } from '../../src/core/LinuxDesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { desktopProbeUnavailableReason } from '../../src/core/DesktopProbeReadiness.js';

const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const MONITORS = 'Monitors: 2\n 0: +*DP-1 1920/500x1080/300+0+0  DP-1\n 1: +HDMI-1 1280/400x1024/300+1920+0  HDMI-1\n';

type Call = { file: string; args: string[]; display?: string };

function fakeRunner(overrides: Partial<Record<string, (args: string[]) => Buffer | Error>> = {}) {
  const calls: Call[] = [];
  const run: LinuxRunner = async (file, args, { env }) => {
    calls.push({ file, args, display: env.DISPLAY });
    const handler = overrides[file];
    if (handler) { const out = handler(args); if (out instanceof Error) throw out; return out; }
    if (file === 'xdotool' && args[0] === 'getdisplaygeometry') return Buffer.from('3200 1080\n');
    if (file === 'xdotool' && args[0] === 'getmouselocation') return Buffer.from('X=1600\nY=540\nSCREEN=0\nWINDOW=1\n');
    if (file === 'xrandr') return Buffer.from(MONITORS);
    if (file === 'import' && args[0] === '-version') return Buffer.from('Version: ImageMagick 6');
    if (file === 'import') return JPEG;
    if (file.endsWith('-command') || file === 'loginctl') throw new Error('not installed');
    return Buffer.alloc(0);
  };
  return { run, calls };
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'linux-desktop-host test cleanup' }); });

function socketDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x11-'));
  dirs.push(dir);
  for (const name of names) fs.writeFileSync(path.join(dir, name), '');
  return dir;
}

describe('LinuxDesktopHost', () => {
  it('finds this user\'s own lowest X display, and none on a headless server', () => {
    const uid = process.getuid!();
    expect(new LinuxDesktopHost({ socketDir: socketDir(['X3', 'X1', 'other']), uid }).resolveDisplay()).toBe(':1');
    expect(new LinuxDesktopHost({ socketDir: socketDir(['X0']), uid: uid + 1 }).resolveDisplay()).toBeNull();
    expect(new LinuxDesktopHost({ socketDir: path.join(os.tmpdir(), 'no-such-x11-dir') }).resolveDisplay()).toBeNull();
    expect(new LinuxDesktopHost({ display: ':7' }).resolveDisplay()).toBe(':7');
    expect(() => new LinuxDesktopHost({ display: 'evil;rm' })).toThrow('linux-desktop-display-invalid');
  });

  it('reports a headless server as an inactive session with a plain reason', async () => {
    const host = new LinuxDesktopHost({ socketDir: path.join(os.tmpdir(), 'no-such-x11-dir'), run: fakeRunner().run });
    const probe = await host.probe();
    expect(probe).toMatchObject({ sessionActive: false, screenPermission: false, displayCount: 0, linux: { display: null } });
    expect(desktopProbeUnavailableReason(probe)).toContain('no X display');
    expect(desktopProbeUnavailableReason(probe)).not.toContain('Mac');
  });

  it('reports a live X session as ready, and a missing capture tool truthfully', async () => {
    const ready = await new LinuxDesktopHost({ display: ':1', run: fakeRunner().run }).probe();
    expect(ready).toMatchObject({ sessionActive: true, screenPermission: true, inputPermission: true, displayCount: 2, screenLocked: false });
    const noImport = await new LinuxDesktopHost({ display: ':1',
      run: fakeRunner({ import: () => new Error('ENOENT') }).run }).probe();
    expect(noImport.screenPermission).toBe(false);
    expect(desktopProbeUnavailableReason(noImport)).toContain('ImageMagick');
    const dead = await new LinuxDesktopHost({ display: ':1',
      run: fakeRunner({ xdotool: () => new Error('cannot open display') }).run }).probe();
    expect(dead.sessionActive).toBe(false);
    expect(desktopProbeUnavailableReason(dead)).toContain(':1');
  });

  it('reads a locked screen from the screen locker', async () => {
    const probe = await new LinuxDesktopHost({ display: ':1',
      run: fakeRunner({ 'xfce4-screensaver-command': () => Buffer.from('The screensaver is active\n') }).run }).probe();
    expect(probe).toMatchObject({ sessionActive: false, screenLocked: true });
    expect(desktopProbeUnavailableReason(probe)).toContain('locked');
    const idle = await new LinuxDesktopHost({ display: ':1',
      run: fakeRunner({ 'xfce4-screensaver-command': () => Buffer.from('The screensaver is inactive\n') }).run }).probe();
    expect(idle.screenLocked).toBe(false);
  });

  it('captures and takes input only while a session is connected', async () => {
    const { run, calls } = fakeRunner();
    const host = new LinuxDesktopHost({ display: ':1', run });
    await expect(host.capture()).rejects.toThrow('linux-desktop-session-unavailable');
    await expect(host.input({ kind: 'move', x: 0, y: 0 })).rejects.toThrow('linux-desktop-session-unavailable');
    await host.startIndicator(() => undefined);
    expect(await host.capture()).toEqual(JPEG);
    expect(calls.find(c => c.file === 'import' && c.args.includes('jpeg:-'))?.display).toBe(':1');
    host.stopIndicator();
    await expect(host.capture()).rejects.toThrow('linux-desktop-session-unavailable');
  });

  it('maps viewer input to xdotool on the whole screen and on one chosen screen', async () => {
    const { run, calls } = fakeRunner();
    const host = new LinuxDesktopHost({ display: ':1', run });
    await host.startIndicator(() => undefined);
    const last = () => calls.filter(c => c.file === 'xdotool' && c.args[0] !== 'getdisplaygeometry').at(-1)!.args;
    await host.input({ kind: 'click', x: 1, y: 1, button: 'right', count: 2 });
    expect(last()).toEqual(['mousemove', '3199', '1079', 'click', '--repeat', '2', '--delay', '40', '3']);
    expect(await host.selectDisplay('HDMI-1')).toBe(true);
    await host.input({ kind: 'move', x: 0, y: 0 });
    expect(last()).toEqual(['mousemove', '1920', '0']);
    await host.capture();
    expect(calls.filter(c => c.file === 'import').at(-1)!.args).toEqual(
      ['-silent', '-window', 'root', '-crop', '1280x1024+1920+0', '+repage', '-quality', '70', 'jpeg:-']);
    expect(await host.cursor()).toEqual({ x: 0, y: expect.closeTo(540 / 1023, 5) });
    expect(await host.selectDisplay('nope')).toBe(false);
    await host.input({ kind: 'type', text: '-rf hello' });
    expect(last()).toEqual(['type', '--clearmodifiers', '--delay', '8', '--', '-rf hello']);
  });

  it('turns pixel scrolling into wheel clicks and keeps the remainder', async () => {
    const { run } = fakeRunner();
    const seen: string[][] = [];
    const host = new LinuxDesktopHost({ display: ':1', run: async (f, a, o) => { if (f === 'xdotool' && a[0] === 'click') seen.push(a); return run(f, a, o); } });
    await host.startIndicator(() => undefined);
    await host.input({ kind: 'scroll', dx: 0, dy: 30 });
    expect(seen).toHaveLength(0);
    await host.input({ kind: 'scroll', dx: -80, dy: 30 });
    expect(seen.at(-1)).toEqual(['click', '--repeat', '1', '--delay', '5', '5', 'click', '--repeat', '2', '--delay', '5', '6']);
  });

  it('lets go of held keys and buttons on Stop', async () => {
    const { run, calls } = fakeRunner();
    const host = new LinuxDesktopHost({ display: ':1', run });
    await host.startIndicator(() => undefined);
    await host.input({ kind: 'keyDown', key: 'Control' });
    await host.input({ kind: 'buttonDown', x: 0.5, y: 0.5, button: 'left' });
    host.stopIndicator();
    await new Promise(resolve => setImmediate(resolve));
    expect(calls.at(-1)!.args).toEqual(['keyup', 'Control_L', 'mouseup', '1']);
  });

  it('ends the session when the X display goes away', async () => {
    let alive = true;
    const { run } = fakeRunner({ xdotool: () => (alive ? Buffer.from('100 100') : new Error('gone')) });
    const host = new LinuxDesktopHost({ display: ':1', run, heartbeatMs: 10 });
    let lost = 0;
    await host.startIndicator(() => { lost++; });
    alive = false;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(lost).toBe(1);
    await expect(host.capture()).rejects.toThrow('linux-desktop-session-unavailable');
  });

  it('sends nothing after Stop, even for an action already waiting on the screen size', async () => {
    let releaseGeometry!: () => void;
    const gate = new Promise<void>(resolve => { releaseGeometry = resolve; });
    let slow = false;
    const { run, calls } = fakeRunner();
    const host = new LinuxDesktopHost({ display: ':1', run: async (f, a, o) => {
      if (slow && f === 'xdotool' && a[0] === 'getdisplaygeometry') await gate;
      return run(f, a, o);
    } });
    await host.startIndicator(() => undefined);
    slow = true;
    const pending = host.input({ kind: 'buttonDown', x: 0.5, y: 0.5, button: 'left' });
    await new Promise(resolve => setImmediate(resolve));
    host.stopIndicator();
    releaseGeometry();
    await expect(pending).rejects.toThrow('linux-desktop-input-cancelled');
    expect(calls.some(c => c.args.includes('mousedown'))).toBe(false);
  });

  it('releases a press on Stop even when the press itself timed out', async () => {
    const { run, calls } = fakeRunner();
    const host = new LinuxDesktopHost({ display: ':1', run: async (f, a, o) => {
      if (f === 'xdotool' && a[0] === 'keydown') throw new Error('timeout');
      return run(f, a, o);
    } });
    await host.startIndicator(() => undefined);
    await expect(host.input({ kind: 'keyDown', key: 'Alt' })).rejects.toThrow('timeout');
    host.stopIndicator();
    await new Promise(resolve => setImmediate(resolve));
    expect(calls.at(-1)!.args).toEqual(['keyup', 'Alt_L']);
  });

  it('refuses a Wayland login unless a display is chosen, and reads logind\'s lock hint', async () => {
    const logind = (type: string, locked: string) => (args: string[]) => Buffer.from(args[0] === 'show-user'
      ? 'Sessions=3\n' : `Type=${type}\nActive=yes\nLockedHint=${locked}\n`);
    const uid = process.getuid!();
    const wayland = await new LinuxDesktopHost({ socketDir: socketDir(['X0']), uid,
      run: fakeRunner({ loginctl: logind('wayland', 'no') }).run }).probe();
    expect(wayland).toMatchObject({ sessionActive: false, linux: { wayland: true } });
    expect(desktopProbeUnavailableReason(wayland)).toContain('Wayland');
    const chosen = await new LinuxDesktopHost({ display: ':5', run: fakeRunner({ loginctl: logind('wayland', 'no') }).run }).probe();
    expect(chosen.sessionActive).toBe(true);
    const locked = await new LinuxDesktopHost({ display: ':1', run: fakeRunner({ loginctl: logind('x11', 'yes') }).run }).probe();
    expect(locked).toMatchObject({ sessionActive: false, screenLocked: true });
  });

  it('maps keys and parses monitors', () => {
    expect(linuxKeysym('Meta')).toBe('Super_L');
    expect(linuxKeysym('PageUp')).toBe('Page_Up');
    expect(linuxKeysym('F12')).toBe('F12');
    expect(linuxKeysym('q')).toBe('q');
    expect(() => linuxKeysym('Ctrl;reboot')).toThrow();
    const rows = parseXrandrMonitors(' 0: +VNC-0 1600/423x1000/265+0+0  VNC-0\n');
    expect(rows).toEqual([{ id: 'VNC-0', name: 'VNC-0', main: true, width: 1600, height: 1000, x: 0, y: 0 }]);
  });
});
