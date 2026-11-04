/**
 * Plain and Complete (docs/UX-AND-AGENT-AGENCY-STANDARD.md Rule 8) — the
 * test-time check over fixed server notices, plus the build-time lint.
 *
 * Both sides of the boundary use real texts: the notices Justin actually
 * received (2026-11-03 "moved machines", "Session respawned.", the pinned-profile
 * note) must be flagged, and their rewrites must pass.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  USER_NOTICE_CATALOG,
  movedMachinesMidStepNotice,
  plainMachineName,
  SESSION_RESTARTING_NOTICE,
  SESSION_BACK_NOTICE,
  PROFILE_REAPPLY_NOTICE,
} from '../../src/messaging/userNotices.js';
import { findPlainNoticeProblems } from '../../src/messaging/plainNoticeCheck.js';
import { isSystemOrProxyMessage } from '../../src/messaging/shared/isSystemOrProxyMessage.js';
// @ts-expect-error — plain .mjs script, no type declarations
import { lintSource } from '../../scripts/lint-plain-user-notices.mjs';

const REPO = path.resolve(__dirname, '../..');

/** Real texts as they reached the operator before this change. */
const BEFORE = {
  movedMachines: 'This conversation moved machines mid-task (drain bound (30000ms) reached — final turn may be partial). Work resumes on the new machine — the final turn before the move may be partial.',
  respawned: 'Session respawned.',
  restarting: '🔄 Session restarting — message queued.',
  profile: "this topic's pinned profile wasn't applied before my last restart — applying it now (the session will briefly restart when idle) [#1]",
  configPath: 'You asked me to "Swap this topic from Fable 5.1 to Opus 5.5" but it looks like that setting reverted. Config topic.model = "gpt-6-sol", expected "Opus 5.5"',
  reasonCode: '🪦 1 background session was shut down: • `job-x` — it was shut down automatically (reason: rerouted-login-expired)',
};

describe('findPlainNoticeProblems — too technical', () => {
  it('flags the moved-machines notice Justin flagged (raw reason, ms count, "final turn")', () => {
    const codes = findPlainNoticeProblems(BEFORE.movedMachines).map((p) => `${p.code}:${p.match}`);
    expect(codes).toEqual(expect.arrayContaining(['INTERNAL_TERM:drain bound', 'INTERNAL_TERM:final turn', 'DURATION_IN_MS:30000ms']));
  });
  it('flags internal words, counters, code identifiers and reason codes', () => {
    expect(findPlainNoticeProblems(BEFORE.profile).map((p) => p.code)).toEqual(expect.arrayContaining(['INTERNAL_TERM', 'BRACKET_COUNTER']));
    expect(findPlainNoticeProblems(BEFORE.reasonCode).map((p) => p.code)).toContain('REASON_CODE');
    expect(findPlainNoticeProblems('Failed: ENOENT while reading state').map((p) => p.code)).toContain('ERRNO');
    expect(findPlainNoticeProblems('The setting machineCoherence was reset by the boot sweep today').map((p) => p.code))
      .toEqual(expect.arrayContaining(['CAMEL_CASE', 'INTERNAL_TERM']));
  });
  it('does not flag ordinary words that contain an internal word, or product names', () => {
    expect(findPlainNoticeProblems('I sent the photo from your iPhone to this conversation just now.')).toEqual([]);
    expect(findPlainNoticeProblems('The payment cleared and the drained battery is charging again now.').map((p) => p.match))
      .not.toContain('drain bound');
  });
});

describe('findPlainNoticeProblems — too vague (floor only)', () => {
  it('flags a notice too short to say what happened, what it means and what to do', () => {
    expect(findPlainNoticeProblems(BEFORE.respawned).map((p) => p.code)).toEqual(expect.arrayContaining(['TOO_SHORT', 'INTERNAL_TERM']));
    expect(findPlainNoticeProblems(BEFORE.restarting).map((p) => p.code)).toContain('TOO_SHORT');
  });
});

describe('USER_NOTICE_CATALOG — every fixed server notice is plain', () => {
  for (const entry of USER_NOTICE_CATALOG) {
    it(`${entry.id} passes the plain-language check`, () => {
      expect(findPlainNoticeProblems(entry.render())).toEqual([]);
    });
  }

  it('the moved-machines notice names the machine, says what it means and what to do — once', () => {
    const t = movedMachinesMidStepNotice('Mac Studio');
    expect(t).toContain('the Mac Studio');
    expect(t).toMatch(/may be incomplete/);
    expect(t).toMatch(/ask me to check it/);
    // It must not promise a check nothing performs.
    expect(t).not.toMatch(/I'll check|I will check/);
    // Says the incompleteness once (the old text said it twice).
    expect(t.match(/incomplete|partial/g)).toHaveLength(1);
  });

  it('never shows a machine id; an unresolved name is said plainly (Rule 7)', () => {
    expect(plainMachineName('m_03b30f5b32c6ef3eb0afd3ca7054e252')).toBe('another machine');
    expect(plainMachineName('3f9a2c71e0b4')).toBe('another machine');
    expect(plainMachineName(null)).toBe('another machine');
    expect(plainMachineName('Mama PC')).toBe('the Mama PC');
    expect(plainMachineName("Justin's Laptop")).toBe("Justin's Laptop");
    expect(movedMachinesMidStepNotice('m_03b30f5b32c6ef3eb0afd3ca7054e252')).not.toContain('m_03b3');
  });
});

describe('reworded lifecycle notices are still recognised as non-replies', () => {
  it.each([
    SESSION_RESTARTING_NOTICE, SESSION_BACK_NOTICE,
    movedMachinesMidStepNotice('Mac Studio'), movedMachinesMidStepNotice(null),
    // legacy wordings still in message history
    'Session respawned.', '🔄 Session restarting — message queued.', BEFORE.movedMachines,
  ])('%s', (text) => {
    expect(isSystemOrProxyMessage(text)).toBe(true);
  });
  it('a real reply is still a real reply', () => {
    expect(isSystemOrProxyMessage('I moved the config file and the tests pass now.')).toBe(false);
  });
  it('the profile notice keeps its plain wording', () => {
    expect(PROFILE_REAPPLY_NOTICE).toMatch(/model settings you chose/);
  });
});

describe('lint-plain-user-notices — build-time guard at send sites', () => {
  const terms = JSON.parse(fs.readFileSync(path.join(REPO, 'src/data/plain-notice-terms.json'), 'utf-8')).internalTerms
    .map((t: string) => ({ term: t, re: new RegExp(`(^|[^A-Za-z0-9_-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, t === t.toUpperCase() && t.length <= 4 ? '' : 'i') }));

  it('catches a raw internal reason pasted into user text (the 2026-11-03 shape)', () => {
    const src = 'void telegram.sendToTopic(topicNum, `This conversation moved machines mid-task (${detail}). Work resumes.`);';
    expect(lintSource(src, terms).map((h: { code: string }) => h.code)).toEqual(['RAW_REASON']);
  });
  it('catches err.message / String(err) and internal words in literals', () => {
    const src = [
      'await this.sendToTopic(id, `Failed: ${err.message}`);',
      'await this.sendToTopic(id, `Failed: ${String(err)}`);',
      "await telegram.sendToTopic(id, 'Session respawned.');",
      'await this.sendToChannel(ch, `Could not ${error}`);',
      'await this.sendToTopic(id, `Failed: ${err instanceof Error ? err.message : String(err)}`);',
      'await this.sendToChannel(ch, `Failed: ${(err as Error).message}`);',
    ].join('\n');
    expect(lintSource(src, terms).map((h: { code: string }) => h.code))
      .toEqual(['RAW_REASON', 'RAW_REASON', 'INTERNAL_TERM', 'RAW_REASON', 'RAW_REASON', 'RAW_REASON']);
  });
  it('allows a translated reason and a waived line', () => {
    const src = [
      'await this.sendToTopic(id, `It was shut down — ${plainEnglishReason(ev.reason)}.`);',
      '// @plain-notice-ok: the person asked for this id',
      'await this.sendToTopic(id, `Here is the id: ${detail}`);',
    ].join('\n');
    expect(lintSource(src, terms)).toEqual([]);
  });
  it('the repository passes against its baseline, and a new raw reason fails it', () => {
    execFileSync('node', ['scripts/lint-plain-user-notices.mjs'], { cwd: REPO, stdio: 'pipe' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-notice-lint-'));
    try {
      fs.mkdirSync(path.join(tmp, 'src', 'data'), { recursive: true });
      fs.copyFileSync(path.join(REPO, 'src/data/plain-notice-terms.json'), path.join(tmp, 'src/data/plain-notice-terms.json'));
      fs.writeFileSync(path.join(tmp, 'src', 'x.ts'), 'telegram.sendToTopic(1, `moved (${detail})`);\n');
      fs.writeFileSync(path.join(tmp, 'baseline.json'), '{}\n');
      let code = 0;
      try {
        execFileSync('node', [path.join(REPO, 'scripts/lint-plain-user-notices.mjs'), '--root', tmp, '--baseline', path.join(tmp, 'baseline.json')], { stdio: 'pipe' });
      } catch (e) { code = (e as { status: number }).status; }
      expect(code).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/userNotices.test.ts:lint-tmp' });
    }
  });
});
