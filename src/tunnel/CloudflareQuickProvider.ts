/**
 * CloudflareQuickProvider — Tier-1 zero-config Cloudflare quick tunnel.
 *
 * Extracted from the original `TunnelManager.startQuickTunnel()` so the
 * manager can drive multiple providers through the common
 * `TunnelProvider` interface. Behavior preserved verbatim where it
 * doesn't conflict with the spec's single-owner mandate:
 *
 *   - Owns: spawning `cloudflared` with --config-isolation; resolving
 *     when the quick-tunnel URL emits; tearing down on stop().
 *   - Does NOT own: retry/backoff, reconnect-on-disconnect, failure
 *     notification, episode/consent state. Those are the manager's
 *     responsibility now (per
 *     specs/dev-infrastructure/tunnel-failure-resilience.md Part 1's
 *     "single-owner mandate" that retires the old in-provider reconnect
 *     loop).
 *
 * Failure-mode classification is surfaced via the rejection Error's
 * `message`; the manager parses to `ProviderFailureReason`. This module
 * uses fixed substrings the manager recognizes:
 *   - "rate-limited" (Cloudflare 429 / 1015 detected from cloudflared stderr)
 *   - "binary-missing" (the bundled cloudflared binary path doesn't exist)
 *   - "timeout" (URL didn't emit within the start budget)
 *   - "process-exit code N" (child exited before URL emit)
 */

import fs from 'node:fs';
import path from 'node:path';
import { bin, install, Tunnel } from 'cloudflared';
import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderTier,
} from './TunnelProvider.js';

export interface CloudflareQuickProviderOptions {
  /** Local port to expose. */
  port: number;
  /** State directory for the quick-tunnel isolation config file. */
  stateDir: string;
  /** Start timeout in milliseconds (default: 30_000). */
  startTimeoutMs?: number;
}

/**
 * Classify a cloudflared quick-tunnel failure into a fixed-substring reason the
 * TunnelManager parses to a ProviderFailureReason. Pure + exported so the
 * decision boundary (esp. the Cloudflare 429/1015 rate-limit detection) is
 * unit-testable. Depends on the caller having captured cloudflared's real stderr
 * (the 'stderr' event) into `stderr` — otherwise the rate-limit text never
 * reaches the haystack and the classification falls through to generic.
 */
export function classifyQuickTunnelError(msg: string, stderr: string): Error {
  const haystack = `${msg} ${stderr}`.toLowerCase();
  // Cloudflare's quick-tunnel rate-limit surfaces as 429 / error 1015.
  if (haystack.includes('429') || haystack.includes('1015') || haystack.includes('rate limit') || haystack.includes('too many requests')) {
    return new Error(`rate-limited: cloudflared quick-tunnel rate-limited (${msg})`);
  }
  if (haystack.includes('enoent') || haystack.includes('not found') || haystack.includes('binary-missing')) {
    return new Error(`binary-missing: ${msg}`);
  }
  if (haystack.includes('dns') || haystack.includes('eai_again') || haystack.includes('econnrefused') || haystack.includes('network')) {
    return new Error(`network: ${msg}`);
  }
  // Preserve as-is so the manager's classifier sees the original prefix.
  return new Error(msg);
}

export class CloudflareQuickProvider implements TunnelProvider {
  readonly name: ProviderName = 'cloudflare-quick';
  readonly tier: ProviderTier = 1;

  private readonly port: number;
  private readonly stateDir: string;
  private readonly startTimeoutMs: number;

  constructor(opts: CloudflareQuickProviderOptions) {
    this.port = opts.port;
    this.stateDir = opts.stateDir;
    this.startTimeoutMs = opts.startTimeoutMs ?? 30_000;
  }

  async isAvailable(): Promise<boolean> {
    // The cloudflared npm package installs the binary on-demand via
    // install(bin). availability == we can install or already have it.
    // We don't actually do the install here; we just confirm the path
    // is resolvable. Install happens during start().
    return typeof bin === 'string' && bin.length > 0;
  }

  start(localPort: number): Promise<TunnelProviderHandle> {
    // localPort overrides constructor-time port for flexibility, but we
    // default to the constructor value.
    const port = localPort || this.port;
    return new Promise((resolve, reject) => {
      void this.startInner(port, resolve, reject);
    });
  }

  private async startInner(
    port: number,
    resolve: (h: TunnelProviderHandle) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      if (!fs.existsSync(bin)) {
        try {
          await install(bin);
        } catch (installErr) {
          reject(new Error(`binary-missing: cloudflared install failed: ${(installErr as Error).message}`));
          return;
        }
      }
    } catch {
      reject(new Error('binary-missing: cloudflared binary path unresolvable'));
      return;
    }

    const localUrl = `http://127.0.0.1:${port}`;
    let tunnel: Tunnel;

    try {
      // Empty config to prevent cloudflared from reading
      // ~/.cloudflared/config.yml, whose named-tunnel ingress rules
      // would override the quick-tunnel's --url proxy. Preserved from
      // the original implementation.
      const emptyConfig = path.join(this.stateDir, 'cloudflared-quick.yml');
      const dir = path.dirname(emptyConfig);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(emptyConfig, '# Quick tunnel — no ingress rules\n');
      tunnel = Tunnel.quick(localUrl, { '--config': emptyConfig });
    } catch (err) {
      reject(new Error(`process-exit: failed to spawn cloudflared: ${(err as Error).message}`));
      return;
    }

    let resolved = false;
    let urlEmitted: string | null = null;
    let stderrTail = '';

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { tunnel.stop(); } catch { /* may already be dead */ }
        reject(new Error('timeout: cloudflared quick tunnel did not emit a URL within the start budget'));
      }
    }, this.startTimeoutMs);

    // Capture cloudflared's REAL stderr. The `cloudflared` wrapper emits a
    // 'stderr' event per child stderr line (incl. the "429 Too Many Requests /
    // error code 1015" rate-limit line). Without listening here, stderrTail
    // stayed empty → 'exit' logged "no stderr captured" → classifyError's
    // 429/1015 detection was DEAD for the exit path, so the manager could never
    // recognize (or back off on) a Cloudflare rate-limit. (Found live 2026-05-31:
    // a quick tunnel 429'd but surfaced only as opaque "process-exit code 1".)
    tunnel.on('stderr', (data: string) => {
      stderrTail = (stderrTail + ' ' + data).slice(-2000);
    });

    tunnel.once('url', (url: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      urlEmitted = url;
      resolve({
        url,
        stop: () => this.stopHandle(tunnel),
      });
    });

    tunnel.on('error', (err: Error) => {
      // Capture stderr-ish context. The cloudflared npm wrapper emits
      // 'error' for child exit failures; we use the message as is.
      stderrTail = (stderrTail + ' ' + (err?.message ?? '')).slice(-500);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(this.classifyError(err?.message ?? '', stderrTail));
      }
      // After resolution, we do NOT auto-reconnect. The manager owns
      // disconnect handling per the single-owner mandate.
    });

    tunnel.on('exit', (code: number | null) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        const msg = code === 0
          ? 'process-exit: cloudflared exited cleanly before URL emission'
          : `process-exit code ${code}: ${stderrTail || 'no stderr captured'}`;
        reject(this.classifyError(msg, stderrTail));
      }
      // Post-resolution exits are surfaced to the manager via the
      // handle's lifecycle. (The handle itself doesn't reconnect.)
    });

    // urlEmitted is referenced only inside the closure above; this
    // suppresses an unused-variable lint while documenting intent.
    void urlEmitted;
  }

  private classifyError(msg: string, stderr: string): Error {
    return classifyQuickTunnelError(msg, stderr);
  }

  private async stopHandle(tunnel: Tunnel): Promise<void> {
    // Force-stop with PID escalation, mirroring TunnelManager.forceStop's
    // SIGINT → SIGKILL pattern. This is security-load-bearing per spec
    // Part 5 (relay teardown must guarantee the child process dies).
    const proc = tunnel.process;
    const pid = proc?.pid;
    try { tunnel.stop(); } catch { /* may already be dead */ }
    if (!pid) return;

    // Poll for exit; escalate to SIGKILL after 5s.
    const timeoutMs = 5_000;
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
