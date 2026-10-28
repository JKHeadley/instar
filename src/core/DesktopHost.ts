/** Machine-local capture and input boundary. A Windows or Linux companion
 * implements this contract only after its own permission and live-session proof. */
export type DesktopInput =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right' }
  | { kind: 'type'; text: string };

export interface DesktopProbe {
  screenPermission: boolean;
  inputPermission: boolean;
  displayCount: number;
  sessionActive: boolean;
}

export interface DesktopHost {
  probe(): Promise<DesktopProbe>;
  capture(): Promise<Buffer>;
  input(action: DesktopInput): Promise<void>;
  cancelInput(): void;
  startIndicator(onUnexpectedExit: () => void): Promise<void>;
  stopIndicator(): void;
}
