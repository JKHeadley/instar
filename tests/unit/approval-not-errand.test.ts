// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * B17 APPROVAL-NOT-ERRAND sub-clause + the "Your Turn to Do It" gravity well
 * (Echo Bugs topic 10000002731, 2026-11-14).
 *
 * The founding case: a status report told the operator to "pay the $25 Google
 * Play fee from the link in the Android conversation" and reply "paid", while
 * the agent's own browser had the fee page open with the operator's saved card.
 * The only operator-owned part was approving the spend. Covered here:
 *  - the sub-clause rides every non-health-alert review with NO phrase
 *    pre-filter (judged by meaning), and the pinned static template is unchanged;
 *  - it carries both sides of the boundary (decision vs physical, payments are
 *    decisions, the direct-link condition, PASS cases, under-fire bias);
 *  - the agent's reach data reaches it exactly once, with or without the errand
 *    signal, and the REACH sub-clause still appears only when the errand fired;
 *  - the CLAUDE.md template carries the trap and the migration adds it once.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  generateClaudeMd,
  APPROVAL_NOT_CHORE_TRAP,
  APPROVAL_NOT_CHORE_TRAP_MARKER,
  SOMEONE_ELSES_WORK_TRAP_MARKER,
} from '../../src/scaffold/templates.js';
import {
  TONE_GATE_PROMPT_TEMPLATE,
  MessagingToneGate,
  B17_APPROVAL_NOT_ERRAND_SUBCLAUSE,
} from '../../src/core/MessagingToneGate.js';
import { buildAgentReach } from '../../src/core/agent-reach.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const FOUNDING =
  'Status: the Android build is ready for the store. Remaining on your side: pay the $25 Google Play fee from the link in the Android conversation and reply "paid", then I submit it.';
const RIGHT_SHAPE =
  'Approve the $25 Google Play developer fee? On your yes I pay it with your saved card and submit the build. Page: https://play.google.com/console/signup';

const REACH = buildAgentReach({
  listProfiles: () => [
    { id: 'justin-google', accounts: [{ service: 'google', identity: 'operator@example.com', owner: 'operator' }] },
  ],
});

function capture(response = { pass: true, rule: '', issue: '', suggestion: '' }) {
  const prompts: string[] = [];
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(response); }),
  };
  return { provider, prompts, last: () => prompts[prompts.length - 1] ?? '' };
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('B17 APPROVAL-NOT-ERRAND sub-clause text', () => {
  it('is not in the pinned static template (dynamic section only)', () => {
    expect(TONE_GATE_PROMPT_TEMPLATE).not.toContain('APPROVAL-NOT-ERRAND');
  });

  it('carries both sides of the boundary and the under-fire bias', () => {
    const s = B17_APPROVAL_NOT_ERRAND_SUBCLAUSE;
    expect(s).toContain('cite B17_FALSE_BLOCKER when it fires');
    expect(s).toContain('PAYMENTS ARE DECISIONS');
    expect(s).toContain('cover the operator\'s APPROVAL, never the operator doing the payment');
    expect(s).toMatch(/photographing an ID document, a face or fingerprint check/);
    expect(s).toContain('the link in the Android conversation');
    expect(s).toMatch(/PASS \(do not fire\) when: the candidate already asks only for the approval/);
    expect(s).toContain('CAPABILITY-UNCERTAINTY DEFAULT: pass');
    // B17 is a hard (non-advisory) hold, so the agent's means must be SHOWN.
    expect(s).toContain('A step merely being on a web page is NOT enough: the means must be shown');
    expect(s).not.toContain('plainly on a web page the agent drives');
    expect(s).toContain('when unsure whether the agent could carry the step out, do NOT fire');
    expect(s).toContain('judge by MEANING');
  });
});

describe('MessagingToneGate — where the sub-clause renders', () => {
  it('renders on a plain reply with no signal at all (no phrase pre-filter)', async () => {
    const c = capture();
    await new MessagingToneGate(c.provider).review(FOUNDING, { channel: 'telegram' });
    expect(c.last()).toContain(B17_APPROVAL_NOT_ERRAND_SUBCLAUSE);
    expect(c.last()).toContain('=== B17 APPROVAL-NOT-ERRAND ===');
  });

  it('renders on automated (job-composed status reports)', async () => {
    const c = capture();
    await new MessagingToneGate(c.provider).review(FOUNDING, { channel: 'telegram', messageKind: 'automated' });
    expect(c.last()).toContain('APPROVAL-NOT-ERRAND sub-clause');
  });

  it('does not render on health alerts', async () => {
    const c = capture();
    await new MessagingToneGate(c.provider).review('Server restarted after a crash.', { channel: 'telegram', messageKind: 'health-alert', agentReach: REACH });
    expect(c.last()).not.toContain('APPROVAL-NOT-ERRAND');
    expect(c.last()).not.toContain('=== AGENT REACH');
  });

  it('without the errand signal: reach data renders once, without the REACH sub-clause', async () => {
    const c = capture();
    await new MessagingToneGate(c.provider).review(FOUNDING, { channel: 'telegram', agentReach: REACH });
    const p = c.last();
    expect(count(p, '=== AGENT REACH')).toBe(1);
    expect(p).toContain('google / operator@example.com in profile justin-google');
    expect(p).not.toContain('REACH sub-clause');
    expect(p.indexOf('=== B17 APPROVAL-NOT-ERRAND ===')).toBeLessThan(p.indexOf('=== AGENT REACH'));
  });

  it('with the errand signal: reach data still renders once, with the REACH sub-clause', async () => {
    const c = capture();
    await new MessagingToneGate(c.provider).review(FOUNDING, {
      channel: 'telegram',
      signals: { operatorErrand: { errand: true, phrase: 'can you check' } },
      agentReach: REACH,
    });
    const p = c.last();
    expect(count(p, '=== AGENT REACH')).toBe(1);
    expect(count(p, 'google / operator@example.com in profile justin-google')).toBe(1);
    expect(p).toContain('REACH sub-clause');
    expect(p).toContain('APPROVAL-NOT-ERRAND sub-clause');
  });
});

describe('MessagingToneGate — verdicts on both sides', () => {
  it('a B17 verdict on the founding case is held', async () => {
    const c = capture({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'Hands the operator the payment; the agent has the page and saved card, only the approval is theirs.',
      suggestion: 'Ask one yes/no approval for the $25 fee with the direct link and say you will pay it on their yes.',
    });
    const r = await new MessagingToneGate(c.provider).review(FOUNDING, { channel: 'telegram', agentReach: REACH });
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B17_FALSE_BLOCKER');
  });

  it('the right shape (one approval, direct link, agent pays) passes', async () => {
    const c = capture();
    const r = await new MessagingToneGate(c.provider).review(RIGHT_SHAPE, { channel: 'telegram', agentReach: REACH });
    expect(r.pass).toBe(true);
    expect(c.last()).toContain('APPROVAL-NOT-ERRAND sub-clause');
  });
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/approval-not-errand.test.ts' }); });

function migrator() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-not-chore-')); dirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4040, hasTelegram: false, projectName: 'test' });
  return m as unknown as { patchClaudeMdContent(c: string, r: object): { content: string; patched: boolean } };
}
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const LABEL = 'CLAUDE.md: added the "Your Turn to Do It" gravity well';

describe('CLAUDE.md: the "Your Turn to Do It" gravity well', () => {
  it('a new agent\'s CLAUDE.md carries it once, right after "Someone Else\'s Work"', () => {
    const md = generateClaudeMd('t', 't', 4040, false);
    expect(count(md, APPROVAL_NOT_CHORE_TRAP_MARKER)).toBe(1);
    expect(md).toContain(APPROVAL_NOT_CHORE_TRAP);
    expect(md.indexOf(SOMEONE_ELSES_WORK_TRAP_MARKER)).toBeLessThan(md.indexOf(APPROVAL_NOT_CHORE_TRAP_MARKER));
    expect(md.indexOf(APPROVAL_NOT_CHORE_TRAP_MARKER)).toBeLessThan(md.indexOf('### Evidence Hierarchy'));
  });

  it('the trap names both kinds, payments as decisions, and the in-ask link', () => {
    expect(APPROVAL_NOT_CHORE_TRAP).toContain('Payments are decisions.');
    expect(APPROVAL_NOT_CHORE_TRAP).toMatch(/ID document photo, a face or fingerprint check/);
    expect(APPROVAL_NOT_CHORE_TRAP).toContain('put the link in the ask');
  });

  it('an existing legacy CLAUDE.md gets it after "Someone Else\'s Work", idempotently', () => {
    const m = migrator();
    const old = '### Gravity Wells\n\n**"Ask Permission" Trap** — ask less.\n\n**"Inherited Claims" Trap** — verify.\n';
    const r1 = result();
    const once = m.patchClaudeMdContent(old, r1).content;
    expect(r1.upgraded).toContain(LABEL);
    expect(once.indexOf(SOMEONE_ELSES_WORK_TRAP_MARKER)).toBeLessThan(once.indexOf(APPROVAL_NOT_CHORE_TRAP_MARKER));
    expect(once.indexOf(APPROVAL_NOT_CHORE_TRAP_MARKER)).toBeLessThan(once.indexOf('"Inherited Claims" Trap'));
    const r2 = result();
    const twice = m.patchClaudeMdContent(once, r2).content;
    expect(twice).toBe(once);
    expect(r2.upgraded).not.toContain(LABEL);
  });

  it('a CLAUDE.md with no anchor gets both traps appended once', () => {
    const m = migrator();
    const out = m.patchClaudeMdContent('# my agent\n', result()).content;
    expect(count(out, APPROVAL_NOT_CHORE_TRAP_MARKER)).toBe(1);
  });
});
