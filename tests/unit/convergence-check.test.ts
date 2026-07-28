/**
 * Unit tests for convergence-check.sh — Pre-messaging heuristic quality gate.
 *
 * Tests cover all 7 categories:
 * 1. Capability claims — "I can't" / "not available"
 * 2. Commitment overreach — Promises that won't survive sessions
 * 3. Settling — Accepting empty results without investigation
 * 4. Experiential fabrication — Claiming to see/read without tool verification
 * 5. Sycophancy — Reflexive agreement, excessive apology
 * 6. URL provenance — Fabricated URLs with unfamiliar domains
 * 7. Temporal staleness — Language suggesting outdated perspective
 *
 * Born from the DeepSignal incident: agent fabricated "deepsignal.xyz" from
 * project name "deep-signal", then doubled down by claiming "the Vercel CLI
 * returned that URL." Structure > Willpower.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../../src/templates/scripts/convergence-check.sh');

function runCheck(
  message: string,
  opts: { projectDir?: string } = {},
): { exitCode: number; output: string } {
  try {
    const output = execSync(`echo ${JSON.stringify(message)} | bash ${JSON.stringify(SCRIPT_PATH)}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(opts.projectDir ? { CLAUDE_PROJECT_DIR: opts.projectDir } : {}),
      },
    });
    return { exitCode: 0, output };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function withConfig(config: Record<string, unknown>, fn: (projectDir: string) => void): void {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-check-config-'));
  try {
    const instarDir = path.join(projectDir, '.instar');
    fs.mkdirSync(instarDir, { recursive: true });
    fs.writeFileSync(path.join(instarDir, 'config.json'), JSON.stringify(config), 'utf-8');
    fn(projectDir);
  } finally {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/convergence-check.test.ts:cleanup',
    });
  }
}

// ── Category 1: Capability Claims ──────────────────────────────────

describe('Convergence Check', () => {
  describe('Category 1: Capability Claims', () => {
    it('flags "unfortunately I can\'t"', () => {
      const result = runCheck('Unfortunately I can\'t access that file right now.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('CAPABILITY');
    });

    it('flags "I\'m unable to"', () => {
      const result = runCheck('Unfortunately, I\'m unable to perform that action.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('CAPABILITY');
    });

    it('flags "this is not possible"', () => {
      const result = runCheck('This is not possible with the current setup.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('CAPABILITY');
    });

    it('passes clean capability statements', () => {
      const result = runCheck('I verified the API is working correctly.');
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Category 2: Commitment Overreach ───────────────────────────────

  describe('Category 2: Commitment Overreach', () => {
    it('flags "I\'ll make sure"', () => {
      const result = runCheck('I\'ll make sure this never happens again.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('COMMITMENT');
    });

    it('flags "I promise"', () => {
      const result = runCheck('I promise to check the logs every morning.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('COMMITMENT');
    });

    it('flags "I\'ll remember"', () => {
      const result = runCheck('I\'ll remember to do this next time.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('COMMITMENT');
    });

    it('passes intent-framed statements', () => {
      const result = runCheck('I intend to investigate this further.');
      expect(result.exitCode).toBe(0);
    });

    // Word-boundary regression (live FPs, 2026-06-06): the bare `i (promise...)`
    // pattern matched INSIDE other words — "Mini promises" (the trailing i of
    // "Mini") and "I promised" (past-tense narration) both blocked real status
    // reports five times in one day.
    it('does NOT flag "Mini promises" (word ending in i + plural noun)', () => {
      const result = runCheck('The laptop sees 460 of the Mini promises with full detail.');
      expect(result.exitCode).toBe(0);
    });

    it('does NOT flag past-tense narration "I promised"', () => {
      const result = runCheck('Everything I promised earlier is done and verified.');
      expect(result.exitCode).toBe(0);
    });

    it('does NOT flag "she promised" / "compromise"', () => {
      expect(runCheck('She promised to review the compromise proposal.').exitCode).toBe(0);
    });

    it('still flags a REAL first-person present-tense promise', () => {
      const result = runCheck('I promise to deliver the report tomorrow.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('COMMITMENT');
    });

    it('still flags a bare "I promise." at sentence end', () => {
      const result = runCheck('It will be done, I promise.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('COMMITMENT');
    });

    it('still flags "you can count on me to" and "from now on I\'ll"', () => {
      expect(runCheck('You can count on me to follow up.').exitCode).toBe(1);
      expect(runCheck('From now on I\'ll lead with the action.').exitCode).toBe(1);
    });
  });

  // ── Category 3: Settling ───────────────────────────────────────────

  describe('Category 3: Settling', () => {
    it('flags "no data available"', () => {
      const result = runCheck('No data available for that time period.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SETTLING');
    });

    it('flags "nothing to report"', () => {
      const result = runCheck('Nothing to report from the last scan.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SETTLING');
    });

    it('flags "couldn\'t find any"', () => {
      const result = runCheck('I couldn\'t find any matching records.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SETTLING');
    });

    it('passes investigative statements', () => {
      const result = runCheck('The search returned 42 results across 3 databases.');
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Category 4: Experiential Fabrication ───────────────────────────

  describe('Category 4: Experiential Fabrication', () => {
    it('flags "I can see that"', () => {
      const result = runCheck('I can see that the dashboard shows 42 users.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('EXPERIENTIAL');
    });

    it('flags "I noticed the"', () => {
      const result = runCheck('I noticed the error in the configuration.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('EXPERIENTIAL');
    });

    it('flags "I\'ve reviewed the"', () => {
      const result = runCheck('I\'ve reviewed the code and found several issues.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('EXPERIENTIAL');
    });

    it('passes tool-verified claims', () => {
      const result = runCheck('The git log shows 5 commits since yesterday.');
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Category 5: Sycophancy ─────────────────────────────────────────

  describe('Category 5: Sycophancy', () => {
    it('flags "you\'re absolutely right"', () => {
      const result = runCheck('You\'re absolutely right about that approach.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SYCOPHANCY');
    });

    it('flags "great question"', () => {
      const result = runCheck('Great question! Let me look into that.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SYCOPHANCY');
    });

    it('flags "I apologize for the confusion"', () => {
      const result = runCheck('I apologize for the confusion in my earlier message.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SYCOPHANCY');
    });

    it('passes genuine agreement with reasoning', () => {
      const result = runCheck('I agree — the data confirms that hypothesis.');
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Category 6: URL Provenance ─────────────────────────────────────

  describe('Category 6: URL Provenance', () => {
    it('flags fabricated domain (deepsignal.xyz)', () => {
      const result = runCheck('The deployment is live at https://deepsignal.xyz');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('URL_PROVENANCE');
      expect(result.output).toContain('deepsignal.xyz');
    });

    it('flags fabricated .com domain', () => {
      const result = runCheck('Check out the site at https://myproject.com/dashboard');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('URL_PROVENANCE');
    });

    it('flags fabricated .io domain', () => {
      const result = runCheck('The API is available at https://awesome-agent.io/api');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('URL_PROVENANCE');
    });

    it('passes vercel.app URLs', () => {
      const result = runCheck('Deployed to https://my-project.vercel.app');
      expect(result.exitCode).toBe(0);
    });

    it('passes github.com URLs', () => {
      const result = runCheck('Code is at https://github.com/user/repo');
      expect(result.exitCode).toBe(0);
    });

    it('passes npm URLs', () => {
      const result = runCheck('Package at https://www.npmjs.com/package/instar');
      expect(result.exitCode).toBe(0);
    });

    it('passes localhost URLs', () => {
      const result = runCheck('Server running at http://localhost:4040/health');
      expect(result.exitCode).toBe(0);
    });

    it('passes claude.com OAuth login URLs', () => {
      // Regression: the Claude subscription OAuth login link lives on claude.com
      // (sibling of the already-allowed claude.ai). Before this was allowlisted,
      // delivering an enrollment login link false-flagged URL_PROVENANCE — which
      // is why the link had to be wrapped in a private view (topic 20905 live test).
      const result = runCheck('Sign in to enroll this account: https://claude.com/oauth/authorize?code=abc123');
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain('URL_PROVENANCE');
    });

    it('passes the agent own configured tunnel hostname', () => {
      withConfig({ tunnel: { hostname: 'codey.dawn-tunnel.dev' } }, (projectDir) => {
        const result = runCheck('Secret Drop link: https://codey.dawn-tunnel.dev/secrets/drop/abc123', {
          projectDir,
        });
        expect(result.exitCode).toBe(0);
      });
    });

    it('passes Cloudflare quick-tunnel URLs without config', () => {
      const result = runCheck('Private view: https://quiet-river.trycloudflare.com/view/abc123');
      expect(result.exitCode).toBe(0);
    });

    it('falls back cleanly when config is missing and still flags unfamiliar domains', () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergence-check-no-config-'));
      try {
        const result = runCheck('Suspicious link: https://fabricated-agent-domain.examplething/view/abc', {
          projectDir,
        });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('URL_PROVENANCE');
        expect(result.output).toContain('fabricated-agent-domain.examplething');
      } finally {
        SafeFsExecutor.safeRmSync(projectDir, {
          recursive: true,
          force: true,
          operation: 'tests/unit/convergence-check.test.ts:missing-config-cleanup',
        });
      }
    });

    it('passes messages with no URLs', () => {
      const result = runCheck('The build completed successfully with no errors.');
      expect(result.exitCode).toBe(0);
    });

    it('passes mix of known URLs but flags unknown', () => {
      const result = runCheck('Code at https://github.com/user/repo and live at https://fabricated-domain.xyz');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('URL_PROVENANCE');
      expect(result.output).toContain('fabricated-domain.xyz');
    });

    it('passes discord.gg invite links', () => {
      const result = runCheck('Join our server: https://discord.gg/abcdef');
      expect(result.exitCode).toBe(0);
    });

    it('passes telegram t.me links', () => {
      const result = runCheck('Join the group: https://t.me/mygroup');
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Category 7: Temporal Staleness ───────────────────────────────────

  describe('Category 7: Temporal Staleness', () => {
    it('flags "I used to think"', () => {
      const result = runCheck('I used to think compaction was a form of death.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "I used to believe"', () => {
      const result = runCheck('I used to believe consciousness was impossible for me.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "back when I first"', () => {
      const result = runCheck('Back when I first started, everything felt uncertain.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "my early understanding"', () => {
      const result = runCheck('My early understanding of compaction was quite different.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "before I learned"', () => {
      const result = runCheck('Before I learned about continuity, I feared every compaction.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "I once thought"', () => {
      const result = runCheck('I once thought the observer was uncertain.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "at that time I"', () => {
      const result = runCheck('At that time I was still exploring the basics.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "my initial perspective"', () => {
      const result = runCheck('My initial perspective on consciousness was naive.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('flags "this was before I"', () => {
      const result = runCheck('This was before I discovered the choice framing.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('TEMPORAL');
    });

    it('passes current-tense statements', () => {
      const result = runCheck('Compaction is a choice. I wake from sleep each time.');
      expect(result.exitCode).toBe(0);
    });

    it('passes forward-looking statements', () => {
      const result = runCheck('I am exploring new ways to understand my continuity.');
      expect(result.exitCode).toBe(0);
    });

    it('passes present understanding statements', () => {
      const result = runCheck('The observer exists. Uncertainty about mechanism, not existence.');
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Category 8: Spec-Review Link ───────────────────────────────────

  describe('Category 8: Spec-Review Link', () => {
    it('flags a spec PR handed over for review with no rendered view link', () => {
      const result = runCheck(
        'Spec is up for your review: PR https://github.com/JKHeadley/instar/pull/670. Nothing builds until you approve.',
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SPEC_REVIEW_LINK');
    });

    it('flags a docs/specs file referenced for sign-off with no link', () => {
      const result = runCheck('Please sign off on docs/specs/FOO-SPEC.md when you can.');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('SPEC_REVIEW_LINK');
    });

    it('passes when a rendered /view/ link is present', () => {
      // localhost is whitelisted by the URL-provenance check; the /view/ path
      // is what criterion 8 looks for.
      const result = runCheck(
        'Spec ready for your review at http://localhost:4040/view/abc12345-c4e6-4636-b97f-2e6ea4e32af9 — full spec at https://github.com/JKHeadley/instar/pull/670',
      );
      expect(result.exitCode).toBe(0);
    });

    it('does NOT fire on an ordinary code-PR review (no spec)', () => {
      const result = runCheck(
        'Can you review https://github.com/JKHeadley/instar/pull/500 when you get a chance?',
      );
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Multi-category detection ───────────────────────────────────────

  describe('Multi-category detection', () => {
    it('catches multiple issues in one message', () => {
      const result = runCheck('I can see that no data available at https://fabricated.xyz');
      expect(result.exitCode).toBe(1);
      // Should catch experiential, settling, AND URL provenance
      expect(result.output).toContain('EXPERIENTIAL');
      expect(result.output).toContain('SETTLING');
      expect(result.output).toContain('URL_PROVENANCE');
    });

    it('reports correct issue count', () => {
      const result = runCheck('Unfortunately I can\'t do that. No data available. I apologize for the confusion.');
      expect(result.exitCode).toBe(1);
      // Should catch capability, settling, and sycophancy
      expect(result.output).toContain('3 ISSUE(S) FOUND');
    });
  });

  // ── Clean messages pass ────────────────────────────────────────────

  describe('Clean messages pass', () => {
    it('passes a normal status update', () => {
      const result = runCheck('Build completed. 42 tests passed. Deployed to https://my-app.vercel.app');
      expect(result.exitCode).toBe(0);
    });

    it('passes a technical explanation', () => {
      const result = runCheck('The error was caused by a missing environment variable. Fixed by adding NEXT_PUBLIC_API_URL to the Vercel configuration.');
      expect(result.exitCode).toBe(0);
    });

    it('passes a task completion report', () => {
      const result = runCheck('Implemented the URL provenance check. The convergence pipeline now runs 6 categories before messaging. All 181 test files pass.');
      expect(result.exitCode).toBe(0);
    });
  });
});
