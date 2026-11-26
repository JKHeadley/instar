/**
 * Tells the operator, once, that a Mac's desktop helper needs its macOS
 * permission again, but only when Remote Desktop has been used on this Mac
 * recently (operator direction 2026-11-20: no cards about unused features). Without this the machine only reads "not ready", and only
 * to someone who looks. Signal only: it never grants, blocks or restarts.
 */
import type { DesktopProbe } from './DesktopHost.js';
import { desktopProbeUnavailableReason } from './DesktopProbeReadiness.js';

const FIRST_CHECK_MS = 60_000;
const RECHECK_MS = 15 * 60_000;

export interface DesktopHelperPermissionNoticeDeps {
  machineLabel: string;
  machineId: string;
  probe(): Promise<DesktopProbe & { ready: boolean }>;
  sourceHash(): string | null;
  /**
   * True when someone has used Remote Desktop on this machine recently. A
   * permission problem on a Mac nobody remotes into is not worth a card: the
   * Machines page still reads "not ready" and the desktop page explains the
   * fix the moment someone opens it.
   */
  recentlyUsed(): boolean;
  /** True for the first agent on this Mac to raise this notice. */
  claim(): boolean;
  /** Gives the notice back so a later check, or a sibling agent, can raise it. */
  release(): void;
  raise(item: { id: string; conditionKey: string; title: string; body: string }): Promise<unknown>;
  clear(conditionKey: string, resolution: string): void;
}

export class DesktopHelperPermissionNotice {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raisedKey: string | null = null;
  private running = false;

  constructor(private readonly deps: DesktopHelperPermissionNoticeDeps) {}

  start(): void {
    this.timer = setTimeout(() => void this.tick(), FIRST_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One check. Public so tests drive it without a clock. */
  async check(): Promise<void> {
    const probe = await this.deps.probe();
    const hash = this.deps.sourceHash();
    if (!hash) return;
    const conditionKey = `desktop-helper-permission:${this.deps.machineId}:${hash.slice(0, 16)}`;
    if (probe.screenPermission && probe.inputPermission) {
      // Unconditional: the item outlives this process, and closing none is a no-op.
      this.deps.clear(conditionKey, 'macOS permission is back for this helper');
      this.raisedKey = null;
      return;
    }
    if (!probe.helperChange || this.raisedKey === conditionKey) return;
    // Checked before claim(): an agent nobody uses for Remote Desktop must leave
    // the notice for a sibling agent on this Mac that is used.
    if (!this.deps.recentlyUsed() || !this.deps.claim()) return;
    try {
      await this.deps.raise({
        id: conditionKey, conditionKey,
        title: probe.helperChange.kind === 'first-grant'
          ? `${this.deps.machineLabel}: Remote Desktop needs its Mac permission`
          : `${this.deps.machineLabel}: Remote Desktop needs its Mac permission again`,
        body: desktopProbeUnavailableReason(probe),
      });
    } catch (error) {
      this.deps.release();
      throw error;
    }
    this.raisedKey = conditionKey;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.check();
    } catch { // @silent-fallback-ok — a failed check repeats at the next tick; the helper reason stays on /desktop/diagnostics.
    } finally {
      this.running = false;
      this.timer = setTimeout(() => void this.tick(), RECHECK_MS);
      this.timer.unref?.();
    }
  }
}
