/**
 * CloudflareNamedProvider — Tier-1 persistent Cloudflare named tunnel.
 *
 * Extracted from the original `TunnelManager.startNamedTunnel()` and
 * `startConfigFileTunnel()` so the manager can drive multiple providers
 * through `TunnelProvider`. The named path supports two auth modes,
 * preserved verbatim from the original behavior:
 *
 *   - Token auth: `cloudflared` via `Tunnel.withToken(token)`. The URL
 *     is the configured hostname (passed via `hostname`); cloudflared
 *     surfaces 'connected' rather than 'url'.
 *   - Config-file auth: spawn `cloudflared tunnel --config <file> run`
 *     directly. URL is the configured hostname; we watch stderr for
 *     "Registered tunnel connection" / "Connection registered" to know
 *     the tunnel is up.
 *
 * `isAvailable()` returns false when neither token NOR configFile is
 * configured, so the manager skips this provider on quick-only installs.
 *
 * Like the quick provider, this module owns ONLY spawn + URL emission
 * + teardown. Retry, reconnect, fallback, and notification are owned by
 * the manager per the spec's single-owner mandate.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { bin, install, Tunnel } from 'cloudflared';
import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderTier,
} from './TunnelProvider.js';

export interface CloudflareNamedProviderOptions {
  /** Cloudflare tunnel token (token-auth mode). */
  token?: string;
  /** Config file path (config-file-auth mode). */
  configFile?: string;
  /** Public hostname for the tunnel (e.g. echo.dawn-tunnel.dev). */
  hostname?: string;
  /** Start timeout in milliseconds (default: 30_000 for token; 15_000 for config-file). */
  startTimeoutMs?: number;
}

export class CloudflareNamedProvider implements TunnelProvider {
  readonly name: ProviderName = 'cloudflare-named';
  readonly tier: ProviderTier = 1;

  private readonly token?: string;
  private readonly configFile?: string;
  private readonly hostname?: string;
  private readonly startTimeoutMs?: number;

  constructor(opts: CloudflareNamedProviderOptions) {
    this.token = opts.token;
    this.configFile = opts.configFile;
    this.hostname = opts.hostname;
    this.startTimeoutMs = opts.startTimeoutMs;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.token && !this.configFile) return false;
    if (this.configFile && !fs.existsSync(this.configFile)) return false;
    return typeof bin === 'string' && bin.length > 0;
  }

  start(localPort: number): Promise<TunnelProviderHandle> {
    // Named tunnel doesn't actually use localPort — the hostname is
    // pre-configured in Cloudflare to map to the agent's local port.
    // Accepting the parameter keeps the TunnelProvider signature uniform.
    void localPort;
    if (this.configFile) {
      return this.startConfigFile();
    }
    if (this.token) {
      return this.startWithToken();
    }
    return Promise.reject(new Error('binary-missing: named tunnel requires either a token or a configFile'));
  }

  private async startWithToken(): Promise<TunnelProviderHandle> {
    if (!fs.existsSync(bin)) {
      try { await install(bin); } catch (err) {
        throw new Error(`binary-missing: cloudflared install failed: ${(err as Error).message}`);
      }
    }

    return new Promise<TunnelProviderHandle>((resolve, reject) => {
      let tunnel: Tunnel;
      try {
        tunnel = Tunnel.withToken(this.token!);
      } catch (err) {
        reject(new Error(`process-exit: failed to spawn cloudflared (token): ${(err as Error).message}`));
        return;
      }

      const hostname = this.hostname;
      const timeoutMs = this.startTimeoutMs ?? 30_000;
      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { tunnel.stop(); } catch { /* may already be dead */ }
        reject(new Error('timeout: cloudflared named tunnel did not connect within the start budget'));
      }, timeoutMs);

      const finalize = (url: string): void => {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          url,
          stop: () => this.stopHandle(tunnel),
        });
      };

      tunnel.once('url', (url: string) => {
        if (resolved) return;
        finalize(url);
      });

      tunnel.once('connected', () => {
        // For token-auth named tunnels, cloudflared often surfaces
        // 'connected' before/instead of 'url'; the public URL is the
        // pre-configured hostname.
        if (resolved) return;
        if (hostname) {
          finalize(`https://${hostname}`);
        }
      });

      tunnel.on('error', (err: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        const msg = (err?.message ?? '').toLowerCase();
        if (msg.includes('429') || msg.includes('1015') || msg.includes('rate limit')) {
          reject(new Error(`rate-limited: cloudflared named tunnel rate-limited: ${err.message}`));
          return;
        }
        reject(err);
      });

      tunnel.on('exit', (code: number | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`process-exit code ${code}: named tunnel exited before URL emit`));
      });
    });
  }

  private startConfigFile(): Promise<TunnelProviderHandle> {
    const configFile = this.configFile!;
    const hostname = this.hostname;
    const timeoutMs = this.startTimeoutMs ?? 15_000;

    return new Promise<TunnelProviderHandle>((resolve, reject) => {
      if (!fs.existsSync(configFile)) {
        reject(new Error(`binary-missing: tunnel config file not found: ${configFile}`));
        return;
      }
      if (!fs.existsSync(bin)) {
        // Spawn will fail; surface as binary-missing for consistency.
        reject(new Error(`binary-missing: cloudflared binary not installed: ${bin}`));
        return;
      }

      const child = spawn(bin, ['tunnel', '--config', configFile, 'run'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;
      let stderrBuffer = '';
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // Config-file tunnels sometimes never log a 'connection registered'
        // line but still come up. If hostname is configured, accept it as
        // the URL — same behavior as the legacy implementation.
        if (hostname) {
          resolve({
            url: `https://${hostname}`,
            stop: () => this.stopChild(child),
          });
        } else {
          try { child.kill('SIGTERM'); } catch { /* already dead */ }
          reject(new Error('timeout: named config-file tunnel timed out and no hostname configured'));
        }
      }, timeoutMs);

      child.stderr.on('data', (data: Buffer) => {
        const line = data.toString();
        stderrBuffer = (stderrBuffer + line).slice(-500);
        if (resolved) return;
        if (line.includes('Registered tunnel connection') || line.includes('Connection registered')) {
          if (hostname) {
            resolved = true;
            clearTimeout(timeout);
            resolve({
              url: `https://${hostname}`,
              stop: () => this.stopChild(child),
            });
          }
        }
      });

      child.on('error', (err: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`process-exit: failed to start config-file tunnel: ${err.message}`));
      });

      child.on('exit', (code: number | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`process-exit code ${code}: config-file tunnel exited before connection: ${stderrBuffer}`));
      });
    });
  }

  private async stopHandle(tunnel: Tunnel): Promise<void> {
    const proc = tunnel.process;
    const pid = proc?.pid;
    try { tunnel.stop(); } catch { /* already dead */ }
    if (!pid) return;
    await this.killWithEscalation(pid);
  }

  private async stopChild(child: ReturnType<typeof spawn>): Promise<void> {
    const pid = child.pid;
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    if (!pid) return;
    await this.killWithEscalation(pid);
  }

  private async killWithEscalation(pid: number, timeoutMs = 5_000): Promise<void> {
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      try {
        process.kill(pid, 0);
      } catch {
        clearTimeout(timer);
        resolve(true);
        return;
      }
      const poll = setInterval(() => {
        try {
          process.kill(pid, 0);
        } catch {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(true);
        }
      }, 200);
    });
    if (!exited) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  }
}
