/** Machine-local capture and input boundary. A Windows or Linux companion
 * implements this contract only after its own permission and live-session proof. */
export type DesktopInput =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right' }
  | { kind: 'buttonDown' | 'buttonUp'; x: number; y: number; button: 'left' | 'right' }
  | { kind: 'scroll'; dx: number; dy: number }
  | { kind: 'type'; text: string }
  | { kind: 'keyDown' | 'keyUp'; key: DesktopKey };

export type DesktopKey = 'Meta' | 'Control' | 'Alt' | 'Shift' | 'Enter' | 'Tab'
  | 'Escape' | 'Backspace' | 'Delete' | 'Space' | 'ArrowLeft' | 'ArrowRight'
  | 'ArrowUp' | 'ArrowDown' | 'a' | 'c' | 'v' | 'x' | 'z';

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

export interface DesktopHost {
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
