/** A virtual mouse on a Wayland compositor, spoken directly over its socket
 * (`zwlr_virtual_pointer_v1`). No package and no root: the compositor offers it
 * to its own user's programs, and Hyprland, Sway and other wlroots desktops
 * implement it. ydotool would need /dev/uinput; wlrctl is not in Arch's repos.
 *
 * Only the tiny part of the Wayland wire format this needs is here: 32-bit
 * little-endian words, messages of [object id, size << 16 | opcode, args],
 * strings as length + bytes + NUL padded to 4. */
import net from 'node:net';

const DISPLAY = 1;
const REGISTRY = 2;
const SYNC_CALLBACK = 3;
const MANAGER = 4;
const POINTER = 5;

const MANAGER_INTERFACE = 'zwlr_virtual_pointer_manager_v1';
const CONNECT_TIMEOUT_MS = 3_000;
/** Fixed-point pixels of scroll per wheel click, the usual wlroots step. */
const AXIS_STEP = 15;

/** Linux input event codes. */
export const POINTER_BUTTONS = { left: 272, right: 273, middle: 274 } as const;

export type WaylandArg = number | string;

/** One request on the wire. Exported so tests can read back what was sent. */
export function encodeWaylandMessage(objectId: number, opcode: number, args: WaylandArg[]): Buffer {
  const parts: Buffer[] = [];
  for (const arg of args) {
    if (typeof arg === 'string') {
      const text = Buffer.from(`${arg}\0`);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(text.length);
      parts.push(length, text, Buffer.alloc((4 - (text.length % 4)) % 4));
    } else {
      const word = Buffer.alloc(4);
      word.writeUInt32LE(arg >>> 0);
      parts.push(word);
    }
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(objectId, 0);
  header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([header, body]);
}

/** Wayland's 24.8 fixed-point number. */
function fixed(value: number): number {
  return Math.round(value * 256);
}

export class WaylandVirtualPointer {
  private socket: net.Socket | null = null;
  private inbox = Buffer.alloc(0);
  private ready = false;
  private closed = false;

  constructor(private readonly socketPath: string, private readonly onLost: () => void = () => {}) {}

  get alive(): boolean {
    return this.ready && !this.closed;
  }

  /** Rejects when the socket is gone or this compositor has no virtual pointer. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      this.socket = socket;
      let manager: { name: number } | null = null;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { this.close(); reject(error); } else { this.ready = true; resolve(); }
      };
      const timer = setTimeout(() => finish(new Error('wayland-pointer-connect-timeout')), CONNECT_TIMEOUT_MS);
      timer.unref?.();
      socket.on('connect', () => {
        // wl_display.get_registry, then wl_display.sync so the compositor says
        // when it has finished listing what it offers.
        socket.write(encodeWaylandMessage(DISPLAY, 1, [REGISTRY]));
        socket.write(encodeWaylandMessage(DISPLAY, 0, [SYNC_CALLBACK]));
      });
      socket.on('data', chunk => {
        this.inbox = Buffer.concat([this.inbox, chunk]);
        while (this.inbox.length >= 8) {
          const objectId = this.inbox.readUInt32LE(0);
          const word = this.inbox.readUInt32LE(4);
          const size = word >>> 16;
          const opcode = word & 0xffff;
          if (size < 8) { finish(new Error('wayland-pointer-protocol-error')); return; }
          if (this.inbox.length < size) break;
          const body = this.inbox.subarray(8, size);
          if (objectId === DISPLAY && opcode === 0) {
            finish(new Error('wayland-pointer-compositor-error'));
            this.lose();
            return;
          }
          if (objectId === REGISTRY && opcode === 0 && body.length >= 12) {
            const length = body.readUInt32LE(4);
            const name = body.toString('utf8', 8, Math.min(body.length, 8 + Math.max(0, length - 1)));
            if (name === MANAGER_INTERFACE) manager = { name: body.readUInt32LE(0) };
          }
          if (objectId === SYNC_CALLBACK && opcode === 0) {
            if (!manager) { finish(new Error('wayland-pointer-unavailable')); return; }
            socket.write(encodeWaylandMessage(REGISTRY, 0, [manager.name, MANAGER_INTERFACE, 1, MANAGER]));
            // create_virtual_pointer(seat = null: the default seat, new id).
            socket.write(encodeWaylandMessage(MANAGER, 0, [0, POINTER]));
            finish();
          }
          this.inbox = this.inbox.subarray(size);
        }
      });
      socket.on('error', error => { finish(error); this.lose(); });
      socket.on('close', () => { finish(new Error('wayland-pointer-closed')); this.lose(); });
    });
  }

  private lose(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.onLost();
  }

  private send(opcode: number, args: WaylandArg[]): void {
    if (!this.alive || !this.socket) throw new Error('wayland-pointer-not-connected');
    this.socket.write(encodeWaylandMessage(POINTER, opcode, args));
  }

  private time(): number {
    return Date.now() & 0x7fffffff;
  }

  /** x and y within extentWidth × extentHeight, the size of the whole layout. */
  moveAbsolute(x: number, y: number, extentWidth: number, extentHeight: number): void {
    this.send(1, [this.time(), Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), extentWidth, extentHeight]);
    this.send(4, []); // frame
  }

  button(code: number, pressed: boolean): void {
    this.send(2, [this.time(), code, pressed ? 1 : 0]);
    this.send(4, []);
  }

  /** Whole wheel clicks. Positive is down or right. */
  scroll(axis: 'vertical' | 'horizontal', clicks: number): void {
    const which = axis === 'vertical' ? 0 : 1;
    this.send(5, [0]); // axis_source: wheel
    this.send(7, [this.time(), which, fixed(clicks * AXIS_STEP), clicks]); // axis_discrete
    this.send(4, []);
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    // end, not destroy: a release sent just before this must still reach the compositor.
    this.socket?.end();
    this.socket = null;
  }
}
