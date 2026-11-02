/** Machine-local capture and input boundary. A Windows or Linux companion
 * implements this contract only after its own permission and live-session proof. */
export type DesktopButton = 'left' | 'right' | 'middle';

export type DesktopInput =
  | { kind: 'move'; x: number; y: number }
  /** count 2 or 3 sends a double or triple click as one action. */
  | { kind: 'click'; x: number; y: number; button: DesktopButton; count?: 1 | 2 | 3 }
  | { kind: 'buttonDown' | 'buttonUp'; x: number; y: number; button: DesktopButton }
  | { kind: 'scroll'; dx: number; dy: number }
  | { kind: 'type'; text: string }
  | { kind: 'keyDown' | 'keyUp'; key: DesktopKey }
  /** Handled by the grant authority, never by host.input. null = host default. */
  | { kind: 'selectDisplay'; displayId: string | null };

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

/** Every key a viewer may hold or tap. Shared by the browser viewer, the
 * native app and both host helpers, which each map the same names. */
export const DESKTOP_KEYS: readonly string[] = Object.freeze(['Meta', 'Control', 'Alt', 'Shift',
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  ...FUNCTION_KEYS, ...LETTERS, ...DIGITS]);
const KEY_SET = new Set(DESKTOP_KEYS);

export type DesktopKey = string;

export function isDesktopKey(key: unknown): key is DesktopKey {
  return typeof key === 'string' && KEY_SET.has(key);
}

export function isDesktopButton(button: unknown): button is DesktopButton {
  return button === 'left' || button === 'right' || button === 'middle';
}

/** Shape check applied before any host sees an action. */
export function validDesktopInput(action: DesktopInput): boolean {
  if (!action || typeof action !== 'object') return false;
  if (action.kind === 'move' || action.kind === 'click' || action.kind === 'buttonDown' || action.kind === 'buttonUp') {
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y)
      || action.x < 0 || action.x > 1 || action.y < 0 || action.y > 1) return false;
    if (action.kind === 'move') return true;
    if (!isDesktopButton(action.button)) return false;
    if (action.kind === 'click' && action.count !== undefined
      && action.count !== 1 && action.count !== 2 && action.count !== 3) return false;
    return true;
  }
  if (action.kind === 'scroll') {
    return Number.isFinite(action.dx) && Number.isFinite(action.dy)
      && Math.abs(action.dx) <= 1_000 && Math.abs(action.dy) <= 1_000;
  }
  if (action.kind === 'keyDown' || action.kind === 'keyUp') return isDesktopKey(action.key);
  return action.kind === 'type' && typeof action.text === 'string'
    && action.text.length > 0 && action.text.length <= 1_024 && !action.text.includes('\0');
}

export interface DesktopProbe {
  screenPermission: boolean;
  inputPermission: boolean;
  displayCount: number;
  sessionActive: boolean;
  /** macOS helper diagnostics only; absent on other host adapters. */
  consoleSessionPresent?: boolean;
  onConsole?: boolean;
  loginDone?: boolean;
  screenLocked?: boolean;
  /** macOS only: which identity holds the permission. `own` is the helper
   * itself; `inherited` depends on what started this server's process tree. */
  screenGrant?: 'own' | 'inherited' | 'none';
  inputGrant?: 'own' | 'inherited' | 'none';
}

export type DesktopPlatform = 'macos' | 'windows';

export interface DesktopDisplay {
  /** Opaque to viewers; the host resolves it. */
  id: string;
  name: string;
  /** Real pixels. */
  width: number;
  height: number;
  main: boolean;
}

export interface DesktopDisplayList {
  displays: DesktopDisplay[];
  /** null only where canShowAll is true: every screen in one picture. */
  currentDisplayId: string | null;
  canShowAll: boolean;
}

const DISPLAY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_DISPLAYS = 16;

export function validDisplayId(value: unknown): value is string {
  return typeof value === 'string' && DISPLAY_ID.test(value);
}

/** Host helpers report untrusted text. Bound it before any viewer sees it. */
export function parseDesktopDisplays(raw: unknown): DesktopDisplay[] {
  const rows = (raw as { displays?: unknown } | null)?.displays;
  if (!Array.isArray(rows) || rows.length > MAX_DISPLAYS) throw new Error('desktop-displays-invalid');
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const { id, name, width, height, main } = (row ?? {}) as Record<string, unknown>;
    if (!validDisplayId(id) || seen.has(id) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || (width as number) < 1 || (width as number) > 65_535
      || (height as number) < 1 || (height as number) > 65_535 || typeof main !== 'boolean') {
      throw new Error('desktop-displays-invalid');
    }
    seen.add(id);
    const label = typeof name === 'string'
      ? [...name].map(c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').trim().slice(0, 64) : '';
    return { id, name: label || `Display ${index + 1}`, width: width as number, height: height as number, main };
  });
}

export interface DesktopHost {
  /** Absent on a host that cannot tell a viewer which shortcuts apply. */
  readonly platform?: DesktopPlatform;
  /** Absent, or rejecting, means this host cannot switch screens. */
  listDisplays?(): Promise<DesktopDisplayList>;
  /** False when the display is not on this machine; the current one stays. */
  selectDisplay?(displayId: string | null): Promise<boolean>;
  probe(): Promise<DesktopProbe>;
  requestPermission?(): Promise<{ screenPermission: boolean; inputPermission: boolean }>;
  capture(): Promise<Buffer>;
  captureH264?(forceKeyframe: boolean): Promise<import('./DesktopVideo.js').DesktopH264Frame | null>;
  cursor?(): Promise<{ x: number; y: number }>;
  input(action: DesktopInput): Promise<void>;
  cancelInput(): void;
  setInputFailureHandler?(handler: () => void): void;
  startIndicator(onUnexpectedExit: () => void): Promise<void>;
  stopIndicator(): void;
}
