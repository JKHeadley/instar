import type { PendingLogin } from './PendingLoginStore.js';
import { enrollPaneSessionName } from './FrameworkLoginDriver.js';

export type ClaudePasteBackResult =
  | 'complete' | 'pending' | 'pane-dead' | 'pane-not-ready' | 'send-failed' | 'invalid-code';

export interface ClaudePasteBackControllerDeps {
  captureOutput: (session: string, lines: number) => string | null;
  sendInput: (session: string, input: string) => boolean;
  clearHistory: (session: string) => void;
  credentialReady: (login: PendingLogin) => boolean | Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
}

/** Single readiness-checked funnel for memory-only Claude OAuth paste-back codes. */
export class ClaudePasteBackController {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(private readonly deps: ClaudePasteBackControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.waitMs = Math.max(1_000, Math.min(60_000, deps.waitMs ?? 30_000));
    this.pollMs = Math.max(100, Math.min(5_000, deps.pollMs ?? 2_000));
    this.sleep = deps.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
    }));
  }

  async finish(login: PendingLogin, code: string | undefined, signal: AbortSignal): Promise<ClaudePasteBackResult> {
    signal.throwIfAborted();
    if (code === undefined) return await this.deps.credentialReady(login) ? 'complete' : 'pending';
    if (!validCode(code)) return 'invalid-code';
    if (login.framework !== 'claude-code' || login.kind !== 'url-code-paste') return 'invalid-code';
    const pane = enrollPaneSessionName(login.framework, login.configHome);
    let frame: string | null = null;
    try { frame = this.deps.captureOutput(pane, 12); } catch { /* @silent-fallback-ok — null produces the explicit pane-dead refusal */ frame = null; }
    if (!frame?.trim()) return 'pane-dead';
    const lastLine = frame.split('\n').map((line) => line.trimEnd()).filter(Boolean).pop() ?? '';
    if (!/paste/i.test(frame) || !/code/i.test(frame) || /[#$%]\s*$/.test(lastLine)) return 'pane-not-ready';
    signal.throwIfAborted();
    if (!this.deps.sendInput(pane, code.trim())) return 'send-failed';
    try { this.deps.clearHistory(pane); } catch { /* @silent-fallback-ok — credential is already consumed; cleanup cannot alter the typed completion proof */ }
    const deadline = this.now() + this.waitMs;
    while (this.now() < deadline) {
      signal.throwIfAborted();
      await this.sleep(Math.min(this.pollMs, Math.max(1, deadline - this.now())), signal);
      if (await this.deps.credentialReady(login)) return 'complete';
    }
    return await this.deps.credentialReady(login) ? 'complete' : 'pending';
  }
}

export function validClaudePasteBackCode(value: string): boolean { return validCode(value); }

function validCode(value: string): boolean {
  if (typeof value !== 'string') return false;
  const code = value.trim();
  if (!code || code.length > 512 || /^https?:\/\//i.test(code) || code.includes('://')) return false;
  // eslint-disable-next-line no-control-regex -- this value is typed into a live pane.
  return !/[\s\x00-\x1f\x7f]/.test(code);
}
