/** Native Linux desktop host for an X11 session (a desktop login or a virtual
 * X server such as TigerVNC/Xvfb). Capture and input run through the standard
 * X tools (`import` from ImageMagick, `xdotool`, `xrandr`) under this agent's
 * own user and X authority, so no network port is opened: the picture and the
 * input travel only over the existing signed, encrypted desktop stream.
 *
 * A machine with no X display of its own (a plain server) reports an inactive
 * session, so admission refuses it truthfully instead of pretending. Wayland
 * compositors do not allow this kind of capture or input; Hyprland has its own
 * host (HyprlandDesktopHost), and other Wayland desktops are not supported. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardChildStdin } from './pipeErrorGuard.js';
import { validDesktopInput, validDisplayId, type DesktopButton, type DesktopDisplay, type DesktopDisplayList,
  type DesktopHost, type DesktopInput, type DesktopProbe } from './DesktopHost.js';

const FRAME_LIMIT = 4_000_000;
const TEXT_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 3_000;
const HEARTBEAT_MS = 2_000;
/** Pixels of viewer scroll per wheel click; X11 scrolls in clicks, not pixels. */
const SCROLL_STEP = 40;
const DISPLAY_NAME = /^:\d{1,4}(\.\d{1,2})?$/;

export type LinuxRunner = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; limit: number; timeoutMs: number; input?: string })
  => Promise<Buffer>;

export const defaultLinuxRunner: LinuxRunner = (file, args, { env, limit, timeoutMs, input }) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { env, encoding: 'buffer', maxBuffer: limit, timeout: timeoutMs, windowsHide: true },
    (error, stdout) => (error ? reject(error) : resolve(stdout as Buffer)));
  guardChildStdin(child.stdin, 'linux-desktop-host');
  if (input !== undefined) child.stdin?.end(input);
});

export interface LinuxDesktopHostOptions {
  /** `remoteDesktop.linuxDisplay`, e.g. ":1". Absent: find this user's own X server. */
  display?: string | null;
  run?: LinuxRunner;
  /** Where X servers put their sockets; tests point this elsewhere. */
  socketDir?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
}

const BUTTONS: Record<DesktopButton, string> = { left: '1', middle: '2', right: '3' };

/** Viewer key names to X keysyms. Letters and digits pass through. */
const KEYSYMS: Record<string, string> = {
  Meta: 'Super_L', Control: 'Control_L', Alt: 'Alt_L', Shift: 'Shift_L',
  Enter: 'Return', Tab: 'Tab', Escape: 'Escape', Backspace: 'BackSpace', Delete: 'Delete', Space: 'space',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down', Insert: 'Insert',
};

export function linuxKeysym(key: string): string {
  if (KEYSYMS[key]) return KEYSYMS[key];
  if (/^F([1-9]|1[0-2])$/.test(key) || /^[a-z0-9]$/.test(key)) return key;
  throw new Error('linux-desktop-key-invalid');
}

interface Area { x: number; y: number; width: number; height: number }
interface Monitor extends Area { id: string; name: string; main: boolean }

/** `xrandr --listmonitors` rows look like ` 0: +*VNC-0 1600/423x1000/265+0+0  VNC-0`. */
export function parseXrandrMonitors(text: string): Monitor[] {
  const out: Monitor[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\d+:\s+([+*]*)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
    if (!m) continue;
    const raw = m[2].replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    const id = validDisplayId(raw) ? raw : `m${out.length}`;
    if (out.some(row => row.id === id)) continue;
    out.push({ id, name: m[2].slice(0, 64), main: m[1].includes('*'), width: Number(m[3]), height: Number(m[4]),
      x: Number(m[5]), y: Number(m[6]) });
    if (out.length >= 16) break;
  }
  if (out.length && !out.some(row => row.main)) out[0].main = true;
  return out;
}

export class LinuxDesktopHost implements DesktopHost {
  readonly platform = 'linux' as const;
  private readonly run: LinuxRunner;
  private readonly socketDir: string;
  private readonly uid: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly heartbeatMs: number;
  private selectedDisplayId: string | null = null;
  private indicatorActive = false;
  private indicatorLost: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly heldKeys = new Set<string>();
  private readonly heldButtons = new Set<DesktopButton>();
  private scrollRest = { dx: 0, dy: 0 };
  private readonly timing = { count: 0, total: 0, max: 0 };

  constructor(private readonly options: LinuxDesktopHostOptions = {}) {
    if (options.display != null && !DISPLAY_NAME.test(options.display)) throw new Error('linux-desktop-display-invalid');
    this.run = options.run ?? defaultLinuxRunner;
    this.socketDir = options.socketDir ?? '/tmp/.X11-unix';
    this.uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
    this.baseEnv = options.env ?? process.env;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  /** The configured display, else the lowest-numbered X server owned by this user. */
  resolveDisplay(): string | null {
    if (this.options.display) return this.options.display;
    let names: string[];
    try { names = fs.readdirSync(this.socketDir); } catch { return null; } // @silent-fallback-ok — no X sockets = headless.
    const owned = names.map(name => /^X(\d{1,4})$/.exec(name)).filter((m): m is RegExpExecArray => !!m)
      .filter(m => { try { return fs.statSync(path.join(this.socketDir, m[0])).uid === this.uid; } catch { return false; } }) // @silent-fallback-ok — an unreadable socket is not ours.
      .map(m => Number(m[1])).sort((a, b) => a - b);
    return owned.length ? `:${owned[0]}` : null;
  }

  private env(display: string): NodeJS.ProcessEnv {
    const home = this.baseEnv.HOME ?? os.homedir();
    const xauthority = this.baseEnv.XAUTHORITY ?? path.join(home, '.Xauthority');
    return { PATH: this.baseEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, DISPLAY: display, XAUTHORITY: xauthority, LANG: 'C.UTF-8' };
  }

  private async tool(file: string, args: string[], limit = TEXT_LIMIT, display = this.resolveDisplay()): Promise<Buffer> {
    if (!display) throw new Error('linux-desktop-no-display');
    return this.run(file, args, { env: this.env(display), limit, timeoutMs: COMMAND_TIMEOUT_MS });
  }

  private async rootArea(): Promise<Area> {
    const out = (await this.tool('xdotool', ['getdisplaygeometry'])).toString('utf8').trim();
    const m = /^(\d+)\s+(\d+)$/.exec(out);
    if (!m) throw new Error('linux-desktop-geometry-invalid');
    return { x: 0, y: 0, width: Number(m[1]), height: Number(m[2]) };
  }

  private async monitors(): Promise<Monitor[]> {
    return parseXrandrMonitors((await this.tool('xrandr', ['--listmonitors'])).toString('utf8'));
  }

  private async area(): Promise<Area> {
    if (this.selectedDisplayId === null) return this.rootArea();
    const monitor = (await this.monitors()).find(row => row.id === this.selectedDisplayId);
    if (monitor) return monitor;
    this.selectedDisplayId = null;
    return this.rootArea();
  }

  async probe(): Promise<DesktopProbe> {
    const display = this.resolveDisplay();
    const dark = (extra: { wayland?: boolean } = {}): DesktopProbe => ({ screenPermission: false, inputPermission: false,
      displayCount: 0, sessionActive: false, linux: { display, capturer: false, ...extra } });
    if (!display) return dark();
    const login = await this.loginSessions();
    // A Wayland login also owns an Xwayland socket, which answers X tools but
    // shows a black or partial screen. Only an explicitly chosen display is trusted there.
    if (!this.options.display && login.wayland) return dark({ wayland: true });
    let root: Area;
    try { root = await this.rootArea(); } catch { return dark(); } // @silent-fallback-ok — no reachable X server is an inactive session, reported as such.
    const [canCapture, monitors, lockerLocked] = await Promise.all([
      this.tool('import', ['-version']).then(() => true, () => false), // @silent-fallback-ok — missing ImageMagick = no screen permission.
      this.monitors().catch(() => [] as Monitor[]), // @silent-fallback-ok — xrandr absent still leaves the whole screen.
      this.screenLocked(),
    ]);
    const locked = lockerLocked || login.locked;
    return {
      screenPermission: canCapture && root.width > 0, inputPermission: true,
      displayCount: Math.max(1, monitors.length), sessionActive: !locked, screenLocked: locked,
      linux: { display, capturer: canCapture },
    };
  }

  /** systemd-logind's view of this user's active graphical login, when there is
   * one: its type (x11/wayland) and its LockedHint, which covers lockers that
   * have no query command (light-locker, GNOME's own shield). A virtual X
   * server started over SSH has no such login and reads neither. */
  private async loginSessions(): Promise<{ wayland: boolean; locked: boolean }> {
    const result = { wayland: false, locked: false };
    if (this.uid < 0) return result;
    const env = { PATH: this.baseEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
    const read = (args: string[]) => this.run('loginctl', args, { env, limit: TEXT_LIMIT, timeoutMs: COMMAND_TIMEOUT_MS })
      .then(out => out.toString('utf8'));
    try {
      const ids = (/^Sessions=(.*)$/m.exec(await read(['show-user', String(this.uid), '-p', 'Sessions']))?.[1] ?? '')
        .split(/\s+/).filter(id => /^[A-Za-z0-9_-]{1,32}$/.test(id)).slice(0, 16);
      for (const id of ids) {
        const out = await read(['show-session', id, '-p', 'Type', '-p', 'Active', '-p', 'LockedHint']);
        const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1]?.trim();
        if (field('Active') !== 'yes') continue;
        const type = field('Type');
        if (type === 'wayland') result.wayland = true;
        if ((type === 'x11' || type === 'wayland') && field('LockedHint') === 'yes') result.locked = true;
      }
    } catch { /* @silent-fallback-ok — no logind (containers, some servers): the X checks decide alone. */ }
    return result;
  }

  /** Asks the common screen lockers. Unknown or absent lockers read as unlocked. */
  private async screenLocked(): Promise<boolean> {
    for (const [tool, args] of [['xfce4-screensaver-command', ['-q']], ['gnome-screensaver-command', ['-q']],
      ['mate-screensaver-command', ['-q']], ['xscreensaver-command', ['-time']]] as const) {
      try {
        const out = (await this.tool(tool, [...args])).toString('utf8');
        if (/\bis active\b|screen locked|\blocked\b/i.test(out) && !/\binactive\b|non-blanked|unlocked/i.test(out)) return true;
      } catch { /* @silent-fallback-ok — this locker is not installed or not running. */ }
    }
    return false;
  }

  async listDisplays(): Promise<DesktopDisplayList> {
    const displays: DesktopDisplay[] = (await this.monitors())
      .map(({ id, name, width, height, main }) => ({ id, name, width, height, main }));
    return { displays, currentDisplayId: this.selectedDisplayId, canShowAll: true };
  }

  async selectDisplay(displayId: string | null): Promise<boolean> {
    if (displayId !== null) {
      if (!validDisplayId(displayId)) return false;
      if (!(await this.monitors()).some(row => row.id === displayId)) return false;
    }
    this.selectedDisplayId = displayId;
    return true;
  }

  captureTiming(): { count: number; totalMs: number; maxMs: number } {
    return { count: this.timing.count, totalMs: this.timing.total, maxMs: this.timing.max };
  }

  async capture(): Promise<Buffer> {
    this.requireActive();
    const started = Date.now();
    const args = ['-silent', '-window', 'root'];
    if (this.selectedDisplayId !== null) {
      const a = await this.area();
      if (this.selectedDisplayId !== null) args.push('-crop', `${a.width}x${a.height}+${a.x}+${a.y}`, '+repage');
    }
    args.push('-quality', '70', 'jpeg:-');
    const frame = await this.tool('import', args, FRAME_LIMIT);
    if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8
      || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
      throw new Error('linux-desktop-frame-invalid');
    }
    const ms = Date.now() - started;
    this.timing.count++; this.timing.total += ms; this.timing.max = Math.max(this.timing.max, ms);
    return frame;
  }

  async cursor(): Promise<{ x: number; y: number }> {
    this.requireActive();
    const out = (await this.tool('xdotool', ['getmouselocation', '--shell'])).toString('utf8');
    const x = Number(/^X=(-?\d+)$/m.exec(out)?.[1]);
    const y = Number(/^Y=(-?\d+)$/m.exec(out)?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('linux-desktop-cursor-invalid');
    const a = await this.area();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp((x - a.x) / Math.max(1, a.width - 1)), y: clamp((y - a.y) / Math.max(1, a.height - 1)) };
  }

  private async point(x: number, y: number): Promise<[string, string]> {
    const a = await this.area();
    return [String(Math.round(a.x + x * (a.width - 1))), String(Math.round(a.y + y * (a.height - 1)))];
  }

  async input(action: DesktopInput): Promise<void> {
    if (!validDesktopInput(action) || action.kind === 'selectDisplay') throw new Error('linux-desktop-input-invalid');
    this.requireActive();
    const generation = this.generation;
    const step = this.queue.then(() => this.apply(action, generation));
    this.queue = step.catch(() => undefined); // @silent-fallback-ok — the caller sees this step's own rejection.
    await step;
  }

  /** Runs one xdotool command only if Stop has not happened since the action
   * was queued; re-checked after every await, right before the command runs. */
  private async act(generation: number, args: string[]): Promise<void> {
    if (generation !== this.generation || !this.indicatorActive) throw new Error('linux-desktop-input-cancelled');
    await this.tool('xdotool', args);
  }

  private async apply(action: DesktopInput, generation: number): Promise<void> {
    switch (action.kind) {
      case 'move':
        await this.act(generation, ['mousemove', ...(await this.point(action.x, action.y))]);
        return;
      case 'click':
        await this.act(generation, ['mousemove', ...(await this.point(action.x, action.y)),
          'click', '--repeat', String(action.count ?? 1), '--delay', '40', BUTTONS[action.button]]);
        return;
      case 'buttonDown':
      case 'buttonUp': {
        const down = action.kind === 'buttonDown';
        const at = await this.point(action.x, action.y);
        // Track a press before sending it: a press that lands but times out
        // must still be released by Stop. Releasing an unpressed button is harmless.
        if (down) {
          if (generation !== this.generation) throw new Error('linux-desktop-input-cancelled');
          this.heldButtons.add(action.button);
        }
        await this.act(generation, ['mousemove', ...at, down ? 'mousedown' : 'mouseup', BUTTONS[action.button]]);
        if (!down) this.heldButtons.delete(action.button);
        return;
      }
      case 'scroll': {
        const args: string[] = [];
        for (const axis of ['dy', 'dx'] as const) {
          const total = this.scrollRest[axis] + action[axis];
          const clicks = Math.trunc(total / SCROLL_STEP);
          this.scrollRest[axis] = total - clicks * SCROLL_STEP;
          if (!clicks) continue;
          const button = axis === 'dy' ? (clicks > 0 ? '5' : '4') : (clicks > 0 ? '7' : '6');
          args.push('click', '--repeat', String(Math.min(25, Math.abs(clicks))), '--delay', '5', button);
        }
        if (args.length) await this.act(generation, args);
        return;
      }
      case 'type':
        await this.act(generation, ['type', '--clearmodifiers', '--delay', '8', '--', action.text]);
        return;
      case 'keyDown':
      case 'keyUp': {
        const keysym = linuxKeysym(action.key);
        if (action.kind === 'keyDown') {
          if (generation !== this.generation) throw new Error('linux-desktop-input-cancelled');
          this.heldKeys.add(keysym);
        }
        await this.act(generation, [action.kind === 'keyDown' ? 'keydown' : 'keyup', keysym]);
        if (action.kind === 'keyUp') this.heldKeys.delete(keysym);
        return;
      }
      default:
        throw new Error('linux-desktop-input-invalid');
    }
  }

  /** Blocks queued input at once, then lets go of anything still held. */
  cancelInput(): void {
    this.generation++;
    this.scrollRest = { dx: 0, dy: 0 };
    const args: string[] = [];
    for (const key of this.heldKeys) args.push('keyup', key);
    for (const button of this.heldButtons) args.push('mouseup', BUTTONS[button]);
    this.heldKeys.clear();
    this.heldButtons.clear();
    if (!args.length) return;
    void this.tool('xdotool', args).catch(() => {
      // @silent-fallback-ok — input is already blocked; an X server that
      // cannot be reached also holds no keys for this user.
    });
  }

  async startIndicator(onUnexpectedExit: () => void): Promise<void> {
    if (this.indicatorActive) throw new Error('linux-desktop-indicator-already-active');
    await this.rootArea();
    this.indicatorActive = true;
    this.indicatorLost = onUnexpectedExit;
    // Tell whoever sits at the screen, where a notifier exists. Best effort.
    void this.tool('notify-send', ['-u', 'normal', 'Instar', 'Remote Desktop is connected to this screen.']).catch(() => {
      // @silent-fallback-ok — not every desktop runs a notification daemon.
    });
    this.heartbeat = setInterval(() => {
      void this.rootArea().catch(() => {
        // @silent-fallback-ok — not silent: a display that stops answering ends
        // the grant through onUnexpectedExit, which the stream manager reports.
        this.loseIndicator();
      });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  stopIndicator(): void {
    this.cancelInput();
    this.indicatorActive = false;
    this.indicatorLost = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private loseIndicator(): void {
    if (!this.indicatorActive) return;
    const lost = this.indicatorLost;
    this.stopIndicator();
    lost?.();
  }

  private requireActive(): void {
    if (!this.indicatorActive) throw new Error('linux-desktop-session-unavailable');
  }
}
