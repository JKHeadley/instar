/** What one machine does for guided Remote Desktop setup: report itself, turn
 * the feature on, and put macOS's own permission surfaces in front of a person.
 * Nothing here grants access. Reached locally, or by a peer over machine auth. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopSetupPane } from './DesktopSetupGuide.js';

const PROMPT_INTERVAL_MS = 60_000;
const NOTICE_WAIT_MS = 4_000;
/** Fixed strings. Nothing from a request reaches the command line. */
const SETTINGS_URLS: Record<DesktopSetupPane, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  input: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

export type DesktopSetupRequest =
  | { action: 'status' }
  | { action: 'turn-on'; frontMachineId: string }
  | { action: 'turn-off' }
  | { action: 'show-prompt' }
  | { action: 'open-settings'; pane: DesktopSetupPane };

export class DesktopSetupRefused extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 409) { super(message); }
}

export interface DesktopSetupTargetDeps {
  stateDir: string;
  platform: string;
  /** This machine's live config object; turn-on updates it in place. */
  config: { remoteDesktop?: { enabled?: boolean; frontMachineId?: string; peerClaimRefused?: boolean } };
  /** Whether this process started with the feature on. */
  configuredAtBoot: boolean;
  diagnostics: () => Promise<Record<string, unknown>>;
  requestPermission: (() => Promise<unknown>) | null;
  requestRestart: () => boolean | Promise<boolean>;
  helperPath: () => string | null;
  /** Whether a peer may turn this machine on. Prompts and status need only the front. */
  peerClaimAllowed: boolean;
  /** Native Linux has no desktop to offer; WSL reaches Windows through its companion. */
  wsl?: boolean;
  /** Tells the operator a peer, not this machine's own page, turned this machine on. */
  onPeerEnable?: (senderMachineId: string) => Promise<void>;
  /** Ends any live desktop grant at once: a restart can be deferred for an hour. */
  endLiveAccess: () => void;
  openUrl?: (url: string) => Promise<void>;
  now?: () => number;
}

function openWithSystem(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], { timeout: 5_000 }, error => (error ? reject(error) : resolve()));
  });
}

export class DesktopSetupTarget {
  private readonly now: () => number;
  private readonly openUrl: (url: string) => Promise<void>;
  private lastPromptAt = 0;
  private lastSwitchAt = 0;
  private readonly lastSettingsAt = new Map<DesktopSetupPane, number>();

  constructor(private readonly d: DesktopSetupTargetDeps) {
    this.now = d.now ?? Date.now;
    this.openUrl = d.openUrl ?? openWithSystem;
  }

  async status(): Promise<Record<string, unknown>> {
    const diagnostics = await this.d.diagnostics();
    let helperPath: string | null = null;
    try { helperPath = this.d.helperPath(); }
    catch { /* @silent-fallback-ok — the guide then omits the path from its fallback text. */ }
    const front = this.d.config.remoteDesktop?.frontMachineId;
    return { ...diagnostics, platform: this.d.platform,
      configured: this.d.config.remoteDesktop?.enabled === true,
      configuredAtBoot: this.d.configuredAtBoot,
      restartPending: this.restartPending(),
      peerClaim: this.d.peerClaimAllowed,
      ...(this.d.wsl ? { wsl: true } : {}),
      ...(front ? { frontMachineId: front } : {}),
      ...(helperPath ? { helperPath } : {}) };
  }

  /** `senderMachineId` is null for this machine's own page. */
  async run(request: DesktopSetupRequest, senderMachineId: string | null): Promise<Record<string, unknown>> {
    const front = this.d.config.remoteDesktop?.frontMachineId;
    if (request.action === 'status') return this.status();
    if (request.action === 'turn-on') return this.turnOn(request.frontMachineId, senderMachineId);
    if (request.action === 'turn-off') return this.turnOff(senderMachineId);
    // A peer may only reach a machine that already names it as front.
    if (senderMachineId && front !== senderMachineId) {
      throw new DesktopSetupRefused('front-mismatch', 'This machine takes setup from a different front.', 403);
    }
    if (this.d.platform !== 'darwin') {
      throw new DesktopSetupRefused('not-macos', 'This step only applies to a Mac.');
    }
    if (!this.d.requestPermission) throw new DesktopSetupRefused('target-off', 'Remote Desktop has not started on this machine.');
    const live = await this.d.diagnostics();
    if (live.sessionActive !== true || live.screenLocked !== false) {
      throw new DesktopSetupRefused('locked', 'This Mac is locked or has no active session, so a pop-up would do nothing.');
    }
    if (request.action === 'show-prompt') {
      if (this.now() - this.lastPromptAt < PROMPT_INTERVAL_MS) {
        throw new DesktopSetupRefused('wait', 'A pop-up was shown in the last minute.', 429);
      }
      this.lastPromptAt = this.now();
      // macOS holds this until someone answers, and the caller polls the live
      // check. A failure shows as the check not changing.
      void Promise.resolve().then(() => this.d.requestPermission!()).catch(() => {
        console.warn('[desktop-setup] permission prompt could not be shown');
      });
      this.audit('show-prompt', senderMachineId, 'requested');
      return { accepted: true };
    }
    if (this.now() - (this.lastSettingsAt.get(request.pane) ?? 0) < PROMPT_INTERVAL_MS) {
      throw new DesktopSetupRefused('wait', 'That settings page was opened in the last minute.', 429);
    }
    this.lastSettingsAt.set(request.pane, this.now());
    try { await this.openUrl(SETTINGS_URLS[request.pane]); }
    catch { throw new DesktopSetupRefused('open-failed', 'That Mac could not open System Settings.'); }
    this.audit('open-settings', senderMachineId, request.pane);
    return { accepted: true };
  }

  private assertSwitchAllowed(): void {
    if (this.now() - this.lastSwitchAt < PROMPT_INTERVAL_MS) {
      throw new DesktopSetupRefused('wait', 'This machine was changed in the last minute.', 429);
    }
    // Reserved here, before any wait, so an overlapping change cannot get in.
    this.lastSwitchAt = this.now();
  }

  private async restart(senderMachineId: string | null): Promise<Record<string, unknown>> {
    // A restart already waiting on the supervisor is the one this change needs.
    const restartRequested = this.restartPending() || await this.d.requestRestart();
    if (!restartRequested) throw new DesktopSetupRefused('restart-unavailable', 'The change is saved, but this machine could not restart itself.', 503);
    this.audit('restart', senderMachineId, 'requested');
    return { restartRequested: true };
  }

  private async turnOn(frontMachineId: string, senderMachineId: string | null): Promise<Record<string, unknown>> {
    if (senderMachineId && senderMachineId !== frontMachineId) {
      throw new DesktopSetupRefused('front-mismatch', 'Only the front machine can claim this machine.', 403);
    }
    if (senderMachineId && !this.d.peerClaimAllowed) {
      throw new DesktopSetupRefused('setup-off', 'Guided setup is not switched on for this machine.');
    }
    if (this.d.platform === 'linux' && !this.d.wsl) {
      throw new DesktopSetupRefused('not-supported', 'Remote Desktop does not run on this kind of machine yet.');
    }
    const current = this.d.config.remoteDesktop;
    const wasOn = current?.enabled === true && current.frontMachineId === frontMachineId;
    if (wasOn && this.d.configuredAtBoot) return { restartRequested: false, alreadyOn: true };
    this.assertSwitchAllowed();
    let noticeFailed = false;
    if (!wasOn) {
      const reserved = this.lastSwitchAt;
      try {
        // A peer's claim that cannot be recorded does not happen.
        if (senderMachineId) this.audit('claim', senderMachineId, 'requested', true);
        // No await from here to the rename: the check and the write are one step.
        this.writeConfig(block => {
          if (typeof block.frontMachineId === 'string' && block.frontMachineId !== frontMachineId) {
            throw new DesktopSetupRefused('other-front', 'This machine takes Remote Desktop from a different front.');
          }
          if (senderMachineId && block.peerClaimRefused === true) {
            throw new DesktopSetupRefused('turned-off-here', 'Remote Desktop was turned off on this machine itself. Turn it on from its own page.');
          }
          const { peerClaimRefused: _cleared, ...rest } = block;
          return { ...rest, enabled: true, frontMachineId };
        });
      } catch (error) {
        // A refused change spends no slot.
        this.lastSwitchAt = reserved - PROMPT_INTERVAL_MS;
        throw error;
      }
      this.audit('turn-on', senderMachineId, 'written');
      if (senderMachineId) {
        // The notice must not hold up the restart or outlast the front's wait.
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            this.d.onPeerEnable ? this.d.onPeerEnable(senderMachineId) : Promise.reject(new Error('no-notice-channel')),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('notice-timeout')), NOTICE_WAIT_MS); timer.unref?.(); }),
          ]).finally(() => clearTimeout(timer));
        } catch {
          noticeFailed = true;
          this.audit('notice', senderMachineId, 'failed');
        }
      }
    }
    return { ...await this.restart(senderMachineId), ...(noticeFailed ? { noticeFailed: true } : {}) };
  }

  private async turnOff(senderMachineId: string | null): Promise<Record<string, unknown>> {
    if (senderMachineId && this.d.config.remoteDesktop?.frontMachineId !== senderMachineId) {
      throw new DesktopSetupRefused('front-mismatch', 'This machine takes setup from a different front.', 403);
    }
    // Off on the machine itself is revocation: no limit stands in front of it.
    if (senderMachineId) this.assertSwitchAllowed();
    else this.lastSwitchAt = this.now();
    // Live access ends first: a failed config write must not leave it running.
    this.d.endLiveAccess();
    // Off on the machine itself is the undo for a claim, so it sticks against peers.
    this.writeConfig(block => ({ ...block, enabled: false, ...(senderMachineId ? {} : { peerClaimRefused: true }) }));
    this.audit('turn-off', senderMachineId, 'written');
    return this.restart(senderMachineId);
  }

  private restartPending(): boolean {
    try {
      const flag = JSON.parse(fs.readFileSync(path.join(this.d.stateDir, 'state', 'restart-requested.json'), 'utf8')) as { expiresAt?: unknown };
      return typeof flag.expiresAt === 'string' && Date.parse(flag.expiresAt) > this.now();
    } catch { return false; /* @silent-fallback-ok — no readable request means none is waiting. */ }
  }

  private writeConfig(change: (block: Record<string, unknown>) => Record<string, unknown>): void {
    const configPath = path.join(this.d.stateDir, 'config.json');
    const file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const block = change({ ...(file.remoteDesktop as Record<string, unknown> | undefined) });
    file.remoteDesktop = block;
    const temp = `${configPath}.${process.pid}.desktop-setup.tmp`;
    fs.writeFileSync(temp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, configPath);
    this.d.config.remoteDesktop = block;
  }

  private audit(action: string, senderMachineId: string | null, outcome: string, required = false): void {
    try {
      const dir = path.join(this.d.stateDir, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'desktop-setup.jsonl'), JSON.stringify({
        at: new Date(this.now()).toISOString(), action, outcome, sender: senderMachineId ?? 'local',
      }) + '\n', { mode: 0o600 });
    } catch (error) {
      if (required) throw new DesktopSetupRefused('audit-failed', 'This machine could not record the change, so it made none.', 503);
      console.warn('[desktop-setup] audit write failed:', error instanceof Error ? error.message : String(error));
    }
  }
}
