/**
 * Unit tests for two URL guards in convergence-check.sh that together keep the
 * operator able to open what the agent sends them.
 *
 * 1. CLAUDE_LINK — a claude.ai / claude.com artifact or chat link is private to
 *    whichever Claude account published it. The operator may not hold that
 *    account, and must never be told to sign in to Claude to read work their own
 *    agent produced. Note claude.ai sits in the well-known-domain allowlist that
 *    URL_PROVENANCE consults, so provenance does NOT catch this — hence a
 *    dedicated check.
 *
 * 2. Tailscale Funnel (*.ts.net) trust — agent-controlled ingress on the
 *    machine's own tailnet, the same class as the already-trusted
 *    *.trycloudflare.com quick tunnels. Without this, a verified Funnel link is
 *    refused as an "unfamiliar domain", which in practice left no way to hand
 *    the operator a working link while the Cloudflare tunnel was down.
 *
 * Both guards were applied to a deployed agent once and silently lost when
 * PostUpdateMigrator re-deployed this template over them. These tests exist so
 * that regression is caught by CI rather than by the operator receiving a link
 * they cannot open.
 *
 * These tests execute the REAL shipped template script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../src/templates/scripts/convergence-check.sh');

/** Run convergence-check.sh with a given CLAUDE_PROJECT_DIR + stdin message.
 *  Returns the exit code (0 = allowed) and stdout (carries the issue names). */
function runCheck(projectDir: string, message: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      input: message,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      encoding: 'utf-8',
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? -1, out: e.stdout ?? '' };
  }
}

describe('convergence-check operator-reachable links', () => {
  let dir: string;

  function writeConfig(cfg: Record<string, unknown>): void {
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify(cfg));
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reachable-'));
    writeConfig({ tunnel: { hostname: 'echo.dawn-tunnel.dev' }, projectName: 'echo', port: 4042 });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/convergence-check-operator-reachable-links.test.ts cleanup',
    });
  });

  it('script is syntactically valid bash', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });

  describe('CLAUDE_LINK', () => {
    it('blocks a claude.ai artifact link', () => {
      const { code, out } = runCheck(dir, 'Here is the mock: https://claude.ai/code/artifact/abc-123\n');
      expect(code).not.toBe(0);
      expect(out).toContain('CLAUDE_LINK');
    });

    it('blocks a claude.com link too', () => {
      const { code, out } = runCheck(dir, 'See https://claude.com/chat/xyz for the writeup.\n');
      expect(code).not.toBe(0);
      expect(out).toContain('CLAUDE_LINK');
    });

    it('is not fooled by a www. prefix', () => {
      const { code, out } = runCheck(dir, 'Try https://www.claude.ai/code/artifact/abc\n');
      expect(code).not.toBe(0);
      expect(out).toContain('CLAUDE_LINK');
    });

    it('does not fire on the bare word claude in prose', () => {
      const { code } = runCheck(dir, 'I ran this on Claude Code and it worked fine.\n');
      expect(code).toBe(0);
    });

    // Chat clients auto-link a bare host/path, so a scheme-less reference is the
    // MOST likely real case, not an exotic one. Pinned after second-pass review
    // found it slipping through a scheme-anchored pattern.
    it('blocks a scheme-less link that a chat client would auto-link', () => {
      const { code, out } = runCheck(dir, 'See claude.ai/code/artifact/abc for the mock.\n');
      expect(code).not.toBe(0);
      expect(out).toContain('CLAUDE_LINK');
    });

    it('blocks a bare host with no trailing slash', () => {
      const { code, out } = runCheck(dir, 'Go to https://claude.ai and sign in.\n');
      expect(code).not.toBe(0);
      expect(out).toContain('CLAUDE_LINK');
    });

    it('blocks a host followed by a query string', () => {
      const { code, out } = runCheck(dir, 'Open https://claude.ai?q=1 to see it.\n');
      expect(code).not.toBe(0);
      expect(out).toContain('CLAUDE_LINK');
    });

    // The leading boundary class. Without it, dropping the scheme requirement
    // turns every *claude.ai substring into a match.
    it('does NOT fire on a suffix look-alike host (notclaude.ai)', () => {
      expect(runCheck(dir, 'See https://notclaude.ai/x for details.\n').code).toBe(0);
      expect(runCheck(dir, 'See notclaude.ai/x for details.\n').code).toBe(0);
    });

    it('does NOT fire on a prefix look-alike host (claude.ai.evil.com)', () => {
      const { code } = runCheck(dir, 'See https://claude.ai.evil.com/x for details.\n');
      expect(code).toBe(0);
    });

    // Load-bearing for the over-block argument in the side-effects review: this
    // guard must not swallow Anthropic documentation links.
    it('does NOT fire on anthropic documentation links', () => {
      expect(runCheck(dir, 'See https://docs.anthropic.com/en/api for details.\n').code).toBe(0);
    });
  });

  describe('Tailscale Funnel trust', () => {
    it('allows a *.ts.net Funnel link (the fix)', () => {
      const { code } = runCheck(dir, 'Console is at https://mama-pc.tailnet-abc.ts.net/console now.\n');
      expect(code).toBe(0);
    });

    it('allows a deep Funnel path with a query string', () => {
      const { code } = runCheck(
        dir,
        'Open https://mama-pc.tailnet-abc.ts.net/view/8dc2f7ad?sig=deadbeef to read it.\n',
      );
      expect(code).toBe(0);
    });

    it('still BLOCKS a fabricated unrelated host (guard not weakened)', () => {
      const { code, out } = runCheck(dir, 'See https://totally-made-up-host.xyz/thing\n');
      expect(code).not.toBe(0);
      expect(out).toContain('URL_PROVENANCE');
    });

    it('does not trust a look-alike suffix such as notts.net', () => {
      const { code, out } = runCheck(dir, 'See https://evil-notts.net/thing\n');
      expect(code).not.toBe(0);
      expect(out).toContain('URL_PROVENANCE');
    });

    // A DELIBERATE scope decision, pinned so a later reader does not mistake the
    // look-alike control above for tighter coverage than exists: the allowlist
    // trusts the *.ts.net suffix, which is every tailnet on the public internet,
    // not only this agent's. See the side-effects review, section 3.
    it('trusts ANY tailnet, not only this agent\'s (deliberate, documented scope)', () => {
      const { code } = runCheck(dir, 'See https://randostranger.ts.net/x\n');
      expect(code).toBe(0);
    });
  });

  // Over-block caught by CI, 2026-10-22. An existing regression test in
  // convergence-check.test.ts pins that the Claude subscription OAuth login link
  // (which lives on claude.com) must PASS — the agent hands it to the operator
  // during account enrolment, and the operator signing in is the entire point.
  // The first version of CLAUDE_LINK matched every path on the domain and broke it.
  describe('CLAUDE_LINK does not block sign-in links', () => {
    it('passes the claude.com OAuth authorize URL', () => {
      const { code, out } = runCheck(dir, 'Sign in to enroll this account: https://claude.com/oauth/authorize?code=abc123\n');
      expect(out).not.toContain('CLAUDE_LINK');
      expect(code).toBe(0);
    });

    it('passes a claude.ai login URL', () => {
      const { code, out } = runCheck(dir, 'Sign in here: https://claude.ai/login?return_to=%2F\n');
      expect(out).not.toContain('CLAUDE_LINK');
      expect(code).toBe(0);
    });

    it('still blocks an artifact link sent alongside a sign-in link', () => {
      const { code, out } = runCheck(
        dir,
        'Sign in: https://claude.com/oauth/authorize?code=abc and then read https://claude.ai/code/artifact/xyz\n',
      );
      expect(code).not.toBe(0);
      expect(out).toContain('CLAUDE_LINK');
    });
  });
});
