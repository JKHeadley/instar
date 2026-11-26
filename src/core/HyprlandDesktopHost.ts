/** Native Linux desktop host for a Hyprland session (Wayland), the desktop on
 * Omarchy. Hyprland offers its own user's programs what the X11 host gets from
 * the X server: `grim` for the picture, `hyprctl -j` for screens and the cursor,
 * a virtual pointer for the mouse (WaylandVirtualPointer) and `wtype` for keys.
 * Omarchy ships grim, hyprctl and wtype. No port is opened and no root is used:
 * the picture and the input travel only over the existing signed, encrypted
 * desktop stream.
 *
 * Measured on Omarchy 4.0.6 (topic 136848):
 * - A display that idled off gives grim no frame, so it hangs. Moving the
 *   pointer wakes it, so connecting and the heartbeat both do that.
 * - Omarchy's lock screen keeps logind's LockedHint at "no", so a locked screen
 *   is not detectable. It shows as a password box, and typing works.
 * - wtype's modifier chords reach applications but never Hyprland's own
 *   shortcuts (Super+Return and the like). The viewer can use the mouse for those.
 * - `hyprctl dispatch` became Lua in Hyprland 0.56, so nothing here relies on it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validDesktopInput, validDisplayId, type DesktopButton, type DesktopDisplay, type DesktopDisplayList,
  type DesktopHost, type DesktopInput, type DesktopProbe } from './DesktopHost.js';
import { defaultLinuxRunner, LinuxDesktopHost, linuxKeysym, type LinuxDesktopHostOptions, type LinuxRunner } from './LinuxDesktopHost.js';
import { POINTER_BUTTONS, WaylandVirtualPointer } from './WaylandVirtualPointer.js';

const FRAME_LIMIT = 4_000_000;
const TEXT_LIMIT = 256 * 1024;
const COMMAND_TIMEOUT_MS = 3_000;
const HEARTBEAT_MS = 2_000;
/** Pixels of viewer scroll per wheel click, the same as the X11 host. */
const SCROLL_STEP = 40;
const CLICK_GAP_MS = 40;
const SIGNATURE = /^[A-Za-z0-9_-]{1,128}$/;
const WAYLAND_SOCKET = /^wayland-\d{1,4}$/;

/** A US keyboard's Shift row. The viewer sends a lowercase key plus Shift, and
 * `wtype -M shift -k a` (or `-k A`) types a lowercase a, measured on Omarchy, so
 * Shift alone is sent as the character it makes, through wtype's text path. */
const SHIFTED_DIGITS: Record<string, string> = { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' };

export function shiftedCharacter(key: string): string | null {
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  return SHIFTED_DIGITS[key] ?? null;
}

/** Viewer modifier names to wtype's names. */
const MODIFIERS: Record<string, string> = { Meta: 'logo', Control: 'ctrl', Alt: 'alt', Shift: 'shift' };

export interface HyprlandSession { signature: string; waylandDisplay: string; runtimeDir: string }

/** The running Hyprland that belongs to this user, from the lock file it keeps
 * under its runtime folder: a pid line and the Wayland socket's name. */
export function findHyprlandSession(runtimeDir: string,
  isRunning: (pid: number) => boolean = pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, // @silent-fallback-ok — a process we can't signal is not ours to show.
): HyprlandSession | null {
  let names: string[];
  try { names = fs.readdirSync(path.join(runtimeDir, 'hypr')); } catch { return null; } // @silent-fallback-ok — no folder means no Hyprland.
  const found: { session: HyprlandSession; started: number }[] = [];
  for (const signature of names) {
    if (!SIGNATURE.test(signature)) continue;
    try {
      const lock = path.join(runtimeDir, 'hypr', signature, 'hyprland.lock');
      const [pidLine, socketLine] = fs.readFileSync(lock, 'utf8').split('\n');
      const pid = Number(pidLine);
      const waylandDisplay = (socketLine ?? '').trim();
      if (!Number.isSafeInteger(pid) || pid <= 0 || !WAYLAND_SOCKET.test(waylandDisplay) || !isRunning(pid)) continue;
      if (!fs.existsSync(path.join(runtimeDir, waylandDisplay))) continue;
      found.push({ session: { signature, waylandDisplay, runtimeDir }, started: fs.statSync(lock).mtimeMs });
    } catch { /* @silent-fallback-ok — a leftover folder from an old login. */ }
  }
  found.sort((a, b) => b.started - a.started);
  return found[0]?.session ?? null;
}

interface Area { x: number; y: number; width: number; height: number }
interface Monitor extends Area { id: string; name: string; main: boolean; pixelWidth: number; pixelHeight: number; awake: boolean }

/** `hyprctl -j monitors`. width/height are real pixels; x, y and the pointer use
 * layout coordinates, which are pixels divided by scale. */
export function parseHyprlandMonitors(text: string): Monitor[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('hyprland-monitors-invalid');
  const out: Monitor[] = [];
  for (const row of rows.slice(0, 16)) {
    const { name, width, height, x, y, scale, transform, focused, dpmsStatus, disabled } = (row ?? {}) as Record<string, unknown>;
    if (disabled === true || typeof name !== 'string' || !Number.isFinite(width) || !Number.isFinite(height)
      || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const factor = typeof scale === 'number' && scale > 0 ? scale : 1;
    // Transforms 1, 3, 5 and 7 turn the screen on its side.
    const sideways = typeof transform === 'number' && transform % 2 === 1;
    const raw = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    const id = validDisplayId(raw) ? raw : `m${out.length}`;
    if (out.some(monitor => monitor.id === id)) continue;
    out.push({ id, name: name.slice(0, 64), main: focused === true, awake: dpmsStatus !== false,
      pixelWidth: width as number, pixelHeight: height as number,
      x: x as number, y: y as number,
      width: Math.round((sideways ? height as number : width as number) / factor),
      height: Math.round((sideways ? width as number : height as number) / factor) });
  }
  if (out.length && !out.some(monitor => monitor.main)) out[0].main = true;
  return out;
}

export interface HyprlandDesktopHostOptions {
  run?: LinuxRunner;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
  /** Tests stand in for the compositor's socket. */
  pointerFactory?: (socketPath: string, onLost: () => void) => WaylandVirtualPointer;
  sleep?: (ms: number) => Promise<void>;
  toolExists?: (name: string) => boolean;
}

function defaultRuntimeDir(env: NodeJS.ProcessEnv): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  return env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
}

function toolOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { /* @silent-fallback-ok — not in this folder. */ }
  }
  return false;
}

export class HyprlandDesktopHost implements DesktopHost {
  readonly platform = 'linux' as const;
  private readonly run: LinuxRunner;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly runtimeDir: string;
  private readonly heartbeatMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly toolExists: (name: string) => boolean;
  private session: HyprlandSession | null = null;
  private pointer: WaylandVirtualPointer | null = null;
  private selectedDisplayId: string | null = null;
  private indicatorActive = false;
  private indicatorLost: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  /** Bumps at every Start and Stop. Work that outlives its session compares and gives up. */
  private epoch = 0;
  /** True from the start of startIndicator until Stop: the only time a pointer may exist. */
  private pointerAllowed = false;
  private pointerConnecting: { epoch: number; pointer: Promise<WaylandVirtualPointer> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly heldModifiers = new Set<string>();
  private readonly heldButtons = new Set<DesktopButton>();
  private scrollRest = { dx: 0, dy: 0 };
  private readonly timing = { count: 0, total: 0, max: 0 };

  constructor(private readonly options: HyprlandDesktopHostOptions = {}) {
    this.run = options.run ?? defaultLinuxRunner;
    this.baseEnv = options.env ?? process.env;
    this.runtimeDir = options.runtimeDir ?? defaultRuntimeDir(this.baseEnv);
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.toolExists = options.toolExists ?? (name => toolOnPath(name, this.baseEnv));
  }

  private currentSession(): HyprlandSession {
    const session = findHyprlandSession(this.runtimeDir);
    if (!session) throw new Error('hyprland-no-session');
    this.session = session;
    return session;
  }

  private env(session: HyprlandSession): NodeJS.ProcessEnv {
    return { PATH: this.baseEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: this.baseEnv.HOME ?? os.homedir(), LANG: 'C.UTF-8',
      XDG_RUNTIME_DIR: session.runtimeDir, WAYLAND_DISPLAY: session.waylandDisplay, HYPRLAND_INSTANCE_SIGNATURE: session.signature };
  }

  private async tool(file: string, args: string[], limit = TEXT_LIMIT, extra: { input?: string; timeoutMs?: number } = {}): Promise<Buffer> {
    const session = this.currentSession();
    return this.run(file, args, { env: this.env(session), limit, timeoutMs: extra.timeoutMs ?? COMMAND_TIMEOUT_MS,
      ...(extra.input !== undefined ? { input: extra.input } : {}) });
  }

  private async monitors(): Promise<Monitor[]> {
    return parseHyprlandMonitors((await this.tool('hyprctl', ['-j', 'monitors'])).toString('utf8'));
  }

  private layout(monitors: Monitor[]): Area {
    if (!monitors.length) throw new Error('hyprland-no-monitors');
    const x = Math.min(...monitors.map(row => row.x));
    const y = Math.min(...monitors.map(row => row.y));
    return { x, y, width: Math.max(...monitors.map(row => row.x + row.width)) - x,
      height: Math.max(...monitors.map(row => row.y + row.height)) - y };
  }

  private async area(): Promise<Area> {
    const monitors = await this.monitors();
    if (this.selectedDisplayId !== null) {
      const chosen = monitors.find(row => row.id === this.selectedDisplayId);
      if (chosen) return chosen;
      this.selectedDisplayId = null;
    }
    return this.layout(monitors);
  }

  async probe(): Promise<DesktopProbe> {
    const dark = (display: string | null, capturer: boolean): DesktopProbe => ({ screenPermission: false, inputPermission: false,
      displayCount: 0, sessionActive: false, linux: { display, capturer, compositor: 'hyprland' } });
    const session = findHyprlandSession(this.runtimeDir);
    if (!session) return dark(null, false);
    const tools = this.toolExists('grim') && this.toolExists('wtype');
    let monitors: Monitor[];
    try { monitors = await this.monitors(); } catch { return dark(session.waylandDisplay, tools); } // @silent-fallback-ok — a compositor that does not answer is an inactive session, reported as such.
    return { screenPermission: tools && monitors.length > 0, inputPermission: tools,
      displayCount: Math.max(1, monitors.length), sessionActive: monitors.length > 0, screenLocked: false,
      linux: { display: session.waylandDisplay, capturer: tools, compositor: 'hyprland' } };
  }

  async listDisplays(): Promise<DesktopDisplayList> {
    const displays: DesktopDisplay[] = (await this.monitors())
      .map(({ id, name, pixelWidth, pixelHeight, main }) => ({ id, name, width: pixelWidth, height: pixelHeight, main }));
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
    const args = ['-t', 'jpeg', '-q', '70'];
    if (this.selectedDisplayId !== null) {
      const chosen = (await this.monitors()).find(row => row.id === this.selectedDisplayId);
      if (chosen) args.push('-o', chosen.name);
    }
    args.push('-');
    const frame = await this.tool('grim', args, FRAME_LIMIT);
    if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8
      || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
      throw new Error('hyprland-desktop-frame-invalid');
    }
    const ms = Date.now() - started;
    this.timing.count++; this.timing.total += ms; this.timing.max = Math.max(this.timing.max, ms);
    return frame;
  }

  private async cursorPosition(): Promise<{ x: number; y: number }> {
    const parsed = JSON.parse((await this.tool('hyprctl', ['-j', 'cursorpos'])).toString('utf8')) as { x?: unknown; y?: unknown };
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') throw new Error('hyprland-desktop-cursor-invalid');
    return { x: parsed.x, y: parsed.y };
  }

  async cursor(): Promise<{ x: number; y: number }> {
    this.requireActive();
    const { x, y } = await this.cursorPosition();
    const a = await this.area();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp((x - a.x) / Math.max(1, a.width - 1)), y: clamp((y - a.y) / Math.max(1, a.height - 1)) };
  }

  /** Connected on demand, so a pointer lost to a compositor restart comes back.
   * Refused outside a session, so nothing can reopen it after Stop. Concurrent
   * callers (input and the heartbeat) share one connection. */
  private async connectedPointer(): Promise<WaylandVirtualPointer> {
    if (this.pointer?.alive) return this.pointer;
    if (!this.pointerAllowed) throw new Error('hyprland-desktop-input-cancelled');
    // Only within one session: a connect left over from a stopped one will refuse itself.
    if (this.pointerConnecting?.epoch === this.epoch) return this.pointerConnecting.pointer;
    const session = this.currentSession();
    const socketPath = path.join(session.runtimeDir, session.waylandDisplay);
    const epoch = this.epoch;
    const created = this.options.pointerFactory?.(socketPath, () => { if (this.pointer === created) this.pointer = null; })
      ?? new WaylandVirtualPointer(socketPath, () => { if (this.pointer === created) this.pointer = null; });
    const pointer = (async () => {
      await created.connect();
      if (epoch !== this.epoch || !this.pointerAllowed) {
        created.close();
        throw new Error('hyprland-desktop-input-cancelled');
      }
      this.pointer = created;
      return created;
    })();
    const connecting = { epoch, pointer };
    this.pointerConnecting = connecting;
    const clear = () => { if (this.pointerConnecting === connecting) this.pointerConnecting = null; };
    pointer.then(clear, clear); // @silent-fallback-ok — bookkeeping only; every caller awaits `pointer` itself and sees its failure.
    return pointer;
  }

  /** The viewer's 0..1 point, sent as a position within the whole layout. */
  private async moveTo(x: number, y: number, generation: number): Promise<WaylandVirtualPointer> {
    const monitors = await this.monitors();
    this.check(generation);
    const layout = this.layout(monitors);
    const chosen = this.selectedDisplayId !== null ? monitors.find(row => row.id === this.selectedDisplayId) : undefined;
    const a = chosen ?? layout;
    const pointer = await this.connectedPointer();
    this.check(generation);
    pointer.moveAbsolute(a.x + x * (a.width - 1) - layout.x, a.y + y * (a.height - 1) - layout.y, layout.width, layout.height);
    return pointer;
  }

  /** A display that idled off gives grim nothing. Any pointer movement wakes it. */
  private async wakeIfAsleep(monitors: Monitor[]): Promise<void> {
    if (monitors.every(row => row.awake)) return;
    const layout = this.layout(monitors);
    const { x, y } = await this.cursorPosition();
    const pointer = await this.connectedPointer();
    // Two positions, because moving to where the pointer already is may not count.
    const atRightEdge = x - layout.x >= layout.width - 1;
    pointer.moveAbsolute(x - layout.x + (atRightEdge ? -1 : 1), y - layout.y, layout.width, layout.height);
    pointer.moveAbsolute(x - layout.x, y - layout.y, layout.width, layout.height);
  }

  async input(action: DesktopInput): Promise<void> {
    if (!validDesktopInput(action) || action.kind === 'selectDisplay') throw new Error('hyprland-desktop-input-invalid');
    this.requireActive();
    const generation = this.generation;
    const step = this.queue.then(() => this.apply(action, generation));
    this.queue = step.catch(() => undefined); // @silent-fallback-ok — the caller sees this step's own rejection.
    await step;
  }

  /** Throws when Stop has happened since the action was queued. */
  private check(generation: number): void {
    if (generation !== this.generation || !this.indicatorActive) throw new Error('hyprland-desktop-input-cancelled');
  }

  private async apply(action: DesktopInput, generation: number): Promise<void> {
    this.check(generation);
    switch (action.kind) {
      case 'move':
        await this.moveTo(action.x, action.y, generation);
        return;
      case 'click': {
        const pointer = await this.moveTo(action.x, action.y, generation);
        const code = POINTER_BUTTONS[action.button];
        for (let i = 0; i < (action.count ?? 1); i++) {
          this.check(generation);
          // Tracked while pressed: Stop in the gap must let go, the same as a drag.
          this.heldButtons.add(action.button);
          pointer.button(code, true);
          await this.sleep(CLICK_GAP_MS);
          if (generation !== this.generation) throw new Error('hyprland-desktop-input-cancelled');
          pointer.button(code, false);
          this.heldButtons.delete(action.button);
          await this.sleep(CLICK_GAP_MS);
        }
        return;
      }
      case 'buttonDown':
      case 'buttonUp': {
        const down = action.kind === 'buttonDown';
        const pointer = await this.moveTo(action.x, action.y, generation);
        this.check(generation);
        if (down) this.heldButtons.add(action.button);
        pointer.button(POINTER_BUTTONS[action.button], down);
        if (!down) this.heldButtons.delete(action.button);
        return;
      }
      case 'scroll': {
        const pointer = await this.connectedPointer();
        this.check(generation);
        for (const axis of ['dy', 'dx'] as const) {
          const total = this.scrollRest[axis] + action[axis];
          const clicks = Math.trunc(total / SCROLL_STEP);
          this.scrollRest[axis] = total - clicks * SCROLL_STEP;
          if (clicks) pointer.scroll(axis === 'dy' ? 'vertical' : 'horizontal', Math.max(-25, Math.min(25, clicks)));
        }
        return;
      }
      case 'type':
        // On stdin, not as an argument: a typed password must not show up in `ps`.
        this.check(generation);
        await this.tool('wtype', ['-'], TEXT_LIMIT, { input: action.text, timeoutMs: COMMAND_TIMEOUT_MS + action.text.length * 20 });
        return;
      case 'keyDown':
      case 'keyUp': {
        // wtype presses and lets go within one run: a key held across runs would
        // be released when its virtual keyboard goes away. So a modifier is kept
        // here and sent with the next key.
        const modifier = MODIFIERS[action.key];
        if (modifier) {
          if (action.kind === 'keyDown') this.heldModifiers.add(modifier); else this.heldModifiers.delete(modifier);
          return;
        }
        const keysym = linuxKeysym(action.key);
        if (action.kind === 'keyUp') return;
        const held = [...this.heldModifiers];
        this.check(generation);
        const shifted = held.length === 1 && held[0] === 'shift' ? shiftedCharacter(keysym) : null;
        if (shifted) {
          await this.tool('wtype', ['-'], TEXT_LIMIT, { input: shifted });
          return;
        }
        await this.tool('wtype', [...held.flatMap(name => ['-M', name]), '-k', keysym, ...held.flatMap(name => ['-m', name])]);
        return;
      }
      default:
        throw new Error('hyprland-desktop-input-invalid');
    }
  }

  /** Blocks queued input at once, then lets go of anything still held. */
  cancelInput(): void {
    this.generation++;
    this.scrollRest = { dx: 0, dy: 0 };
    this.heldModifiers.clear();
    for (const button of this.heldButtons) {
      try { this.pointer?.button(POINTER_BUTTONS[button], false); } catch { /* @silent-fallback-ok — no connection left to release through; the pointer is going away with it. */ }
    }
    this.heldButtons.clear();
  }

  async startIndicator(onUnexpectedExit: () => void): Promise<void> {
    if (this.indicatorActive) throw new Error('hyprland-desktop-indicator-already-active');
    const epoch = ++this.epoch;
    this.pointerAllowed = true;
    // Stop can arrive during any of these waits, and a failed start owes the same clean-up.
    const stillMine = () => { if (epoch !== this.epoch) throw new Error('hyprland-desktop-start-cancelled'); };
    try {
      const monitors = await this.monitors();
      stillMine();
      await this.connectedPointer();
      stillMine();
      await this.wakeIfAsleep(monitors);
      stillMine();
    } catch (error) {
      if (epoch === this.epoch) this.stopIndicator();
      throw error;
    }
    this.indicatorActive = true;
    this.indicatorLost = onUnexpectedExit;
    // Tell whoever sits at the screen, where a notifier exists. Best effort.
    void this.tool('notify-send', ['-u', 'normal', 'Instar', 'Remote Desktop is connected to this screen.']).catch(() => {
      // @silent-fallback-ok — not every desktop runs a notification daemon.
    });
    const signature = this.session?.signature;
    this.heartbeat = setInterval(() => {
      void (async () => {
        if (findHyprlandSession(this.runtimeDir)?.signature !== signature) throw new Error('hyprland-session-changed');
        const monitors = await this.monitors();
        if (epoch === this.epoch) await this.wakeIfAsleep(monitors);
      })().catch(() => {
        // @silent-fallback-ok — not silent: a desktop that stops answering ends
        // the grant through onUnexpectedExit, which the stream manager reports.
        // An answer from a session that has already ended changes nothing.
        if (epoch === this.epoch) this.loseIndicator();
      });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  stopIndicator(): void {
    this.cancelInput();
    this.epoch++;
    this.pointerAllowed = false;
    this.indicatorActive = false;
    this.indicatorLost = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.pointer?.close();
    this.pointer = null;
  }

  private loseIndicator(): void {
    if (!this.indicatorActive) return;
    const lost = this.indicatorLost;
    this.stopIndicator();
    lost?.();
  }

  private requireActive(): void {
    if (!this.indicatorActive) throw new Error('hyprland-desktop-session-unavailable');
  }
}

/** Native Linux's desktop host: Hyprland when this user has a Hyprland session,
 * and otherwise X11. A login can start or end while the agent runs, so this asks
 * at each probe and only stays put while a viewer is connected.
 * `remoteDesktop.linuxDisplay` means X11, whatever else is running. */
export class LinuxAutoDesktopHost implements DesktopHost {
  readonly platform = 'linux' as const;
  private readonly x11: LinuxDesktopHost;
  private readonly hyprland: HyprlandDesktopHost;
  private readonly runtimeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  /** A viewer is connected or connecting: the choice stays put. */
  private connected = false;
  /** Whichever start is newest; an older one's late failure changes nothing. */
  private startToken = 0;
  private current: DesktopHost;

  constructor(private readonly options: LinuxDesktopHostOptions & { x11?: LinuxDesktopHost; hyprland?: HyprlandDesktopHost; runtimeDir?: string;
    hyprctlInstalled?: () => boolean } = {}) {
    this.env = options.env ?? process.env;
    this.runtimeDir = options.runtimeDir ?? defaultRuntimeDir(this.env);
    this.x11 = options.x11 ?? new LinuxDesktopHost(options);
    this.hyprland = options.hyprland ?? new HyprlandDesktopHost({ env: this.env, runtimeDir: this.runtimeDir });
    this.current = this.x11;
  }

  private pick(): DesktopHost {
    if (this.connected) return this.current;
    this.current = !this.options.display && findHyprlandSession(this.runtimeDir) ? this.hyprland : this.x11;
    return this.current;
  }

  async probe(): Promise<DesktopProbe> {
    const probe = await this.pick().probe();
    // Hyprland is here but nobody has signed in: there is no X display to look
    // for either, and the wording should say what actually fixes it.
    if (this.current === this.x11 && !this.options.display && probe.linux && !probe.linux.display) {
      const installed = this.options.hyprctlInstalled?.() ?? toolOnPath('hyprctl', this.env);
      if (installed) return { ...probe, linux: { ...probe.linux, compositor: 'hyprland' } };
    }
    return probe;
  }

  listDisplays(): Promise<DesktopDisplayList> { return this.pick().listDisplays!(); }
  selectDisplay(displayId: string | null): Promise<boolean> { return this.pick().selectDisplay!(displayId); }
  capture(): Promise<Buffer> { return this.current.capture(); }
  captureTiming(): { count: number; totalMs: number; maxMs: number } { return this.current.captureTiming!(); }
  cursor(): Promise<{ x: number; y: number }> { return this.current.cursor!(); }
  input(action: DesktopInput): Promise<void | { refused: string }> { return this.current.input(action); }
  cancelInput(): void { this.current.cancelInput(); }

  async startIndicator(onUnexpectedExit: () => void): Promise<void> {
    const host = this.pick();
    const token = ++this.startToken;
    this.connected = true;
    try {
      await host.startIndicator(() => { if (token === this.startToken) this.connected = false; onUnexpectedExit(); });
    } catch (error) {
      if (token === this.startToken) this.connected = false;
      throw error;
    }
  }

  stopIndicator(): void {
    this.current.stopIndicator();
    this.connected = false;
  }
}
