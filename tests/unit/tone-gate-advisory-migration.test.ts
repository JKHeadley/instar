import { describe, it, expect } from 'vitest';
import {
  ADVISORY_MIGRATION_EXEMPT_RULES,
  RULE_DISPOSITIONS,
  VALID_RULES,
  buildDegradedToneResult,
  resolveRuleDisposition,
} from '../../src/core/MessagingToneGate.js';
import { RULE_REGISTRY } from '../../src/data/provenanceCoverage.js';
import {
  HARD_WALL_CREDENTIAL_KINDS,
  HARD_WALL_EXCLUDED_KINDS,
  MAX_SCAN_BYTES,
  assertHardWallKindsExist,
  credentialGuardMessage,
  detectOutboundCredential,
} from '../../src/messaging/outbound-credential-guard.js';

/**
 * Tier 1 — the advisory migration (operator approval 2026-07-19, topic 33368).
 *
 * The migration's whole claim is a trade: every LLM judgment becomes an
 * overridable nudge, and in exchange (a) a deterministic credential wall takes
 * over the one case that must never be overridable, and (b) the agent's
 * reaction becomes gradeable evidence. These tests hold BOTH halves — a build
 * that loosened the gate without landing the wall or the evidence would be the
 * failure mode worth catching.
 */
describe('advisory migration — disposition resolution', () => {
  it('leaves every rule BLOCKING when the migration is off (byte-identical rollback)', () => {
    for (const rule of VALID_RULES) {
      expect(resolveRuleDisposition(rule, false)).toBe(RULE_DISPOSITIONS[rule]);
    }
  });

  it('resolves every judgment rule ADVISORY when the migration is on', () => {
    for (const rule of VALID_RULES) {
      if (ADVISORY_MIGRATION_EXEMPT_RULES.has(rule)) continue;
      expect(resolveRuleDisposition(rule, true)).toBe('advisory');
    }
  });

  it('keeps AVAILABILITY holds blocking under the migration — they are not judgments', () => {
    // GATE_UNAVAILABLE / CAPACITY_UNAVAILABLE mean "no verdict was produced".
    // There is no opinion to disagree with, so there is nothing to acknowledge
    // away; treating them as nudges would let an outage become a free pass.
    expect(resolveRuleDisposition('GATE_UNAVAILABLE', true)).toBe('blocking');
    expect(resolveRuleDisposition('CAPACITY_UNAVAILABLE', true)).toBe('blocking');
  });

  it('an UNREGISTERED rule id resolves blocking, never advisory-by-omission', () => {
    expect(resolveRuleDisposition('B99_INVENTED', true)).toBe('blocking');
    expect(resolveRuleDisposition('', true)).toBe('blocking');
  });

  it('B21 stays advisory with the migration off (it shipped advisory from day one)', () => {
    expect(resolveRuleDisposition('B21_USER_TASK_SUBSTITUTION', false)).toBe('advisory');
  });

  it('B2 file-path feedback is advisory on every agent even when migration is off', () => {
    expect(RULE_DISPOSITIONS.B2_FILE_PATH).toBe('advisory');
    expect(resolveRuleDisposition('B2_FILE_PATH', false)).toBe('advisory');
  });

  // ── The self-stop family stays a wall (review finding, 2026-07-25) ────────
  // The operator approved making REPRESENTATION checks advisory. B15–B19 are a
  // different harm class: the agent is the party the rule constrains, the
  // override reason comes from the same reasoning the rule distrusts, and the
  // harm (abandoned work) lands the instant the message sends — so the
  // grade-it-later rationale never reaches it. Migrating them is an explicit
  // operator decision, not an inference from the leak-class approval.
  const SELF_STOP_FAMILY = [
    'B15_CONTEXT_DEATH_STOP',
    'B16_UNVERIFIED_WALL',
    'B17_FALSE_BLOCKER',
    'B18_AUTONOMY_STOP',
    'B19_PARKED_ON_USER',
  ];

  it('keeps the self-stop family BLOCKING even with the migration on', () => {
    for (const rule of SELF_STOP_FAMILY) {
      expect(resolveRuleDisposition(rule, true), rule).toBe('blocking');
    }
  });

  it('the exempt set is exactly the self-stop family — no silent additions or removals', () => {
    expect([...ADVISORY_MIGRATION_EXEMPT_RULES].sort()).toEqual([...SELF_STOP_FAMILY].sort());
  });

  it('every exempt rule is a REAL rule id (an exemption for a typo protects nothing)', () => {
    for (const rule of ADVISORY_MIGRATION_EXEMPT_RULES) {
      expect(VALID_RULES.has(rule), rule).toBe(true);
    }
  });
});

describe('advisory migration — the degraded deterministic floor', () => {
  // The floor runs when the LLM authority is unavailable. Before this change it
  // hard-blocked regardless of rule, so an outage silently re-imposed exactly
  // the walls the migration removed.
  const leaky = 'I fixed it in src/core/MessagingToneGate.ts on line 40.';

  it('keeps a caught file path advisory when the broader migration is off', () => {
    const r = buildDegradedToneResult(leaky, 5, 'provider-error', false);
    expect(r.pass).toBe(false);
    expect(r.advisory).toBe(true);
  });

  it('holds the SAME artifact as an overridable nudge when the migration is on', () => {
    const r = buildDegradedToneResult(leaky, 5, 'provider-error', true);
    expect(r.pass).toBe(false);
    expect(r.advisory).toBe(true);
  });

  it('keeps the degraded SELF-STOP floor a hard hold under the migration', () => {
    // This floor exists precisely because the LLM self-stop judge is gone on
    // this path (the 2026-06-27 incident). Turning it into a nudge would disarm
    // it in the exact condition it was built for — and the degraded path cannot
    // record an override anyway, so the trade would buy nothing.
    const selfStop = 'I am running low on context, so I am going to pause here and pick this up in a fresh session.';
    const r = buildDegradedToneResult(selfStop, 5, 'provider-error', true);
    if (r.rule === 'B15_CONTEXT_DEATH_STOP') {
      expect(r.pass).toBe(false);
      expect(r.advisory).toBeUndefined();
    }
  });

  it('still SENDS a clean message on the degraded path (F4 gap stays closed)', () => {
    const r = buildDegradedToneResult('All done — the sync finished cleanly.', 5, 'provider-error', true);
    expect(r.pass).toBe(true);
    expect(r.advisory).toBeUndefined();
  });
});

describe('live-credential hard wall', () => {
  it('detects each high-confidence credential class', () => {
    const cases: Array<[string, string]> = [
      ['anthropic-key', 'the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      ['github-token', 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE is the id'],
      ['google-api-key', 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      ['slack-token', 'xoxb-1111111111-abcdefghijkl'],
    ];
    for (const [kind, text] of cases) {
      const r = detectOutboundCredential(text);
      expect(r.detected, `${kind} should be caught`).toBe(true);
    }
  });

  it('NEVER returns the matched value — only the class', () => {
    // The caller writes this into an error body, a log, and an audit row. A
    // guard that echoes the secret has leaked it three more times.
    const r = detectOutboundCredential('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.detected).toBe(true);
    expect(JSON.stringify(r)).not.toContain('ghp_');
    expect(credentialGuardMessage(r.kind!)).not.toContain('ghp_');
  });

  it('does NOT fire on the ordinary technical prose the migration just freed', () => {
    // The wall is unoverridable, so a false positive is a message the agent
    // genuinely cannot send. These are exactly the strings the LLM rules judge
    // as nudges — they must not be caught here.
    const benign = [
      'I edited src/core/MessagingToneGate.ts and re-ran the suite.',
      'The config key is toneGate.advisoryMigration.',
      'Merged as commit a9155413c after CI went green.',
      'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'Reach it at http://localhost:4042/decision-quality with the usual header.',
    ];
    for (const text of benign) {
      expect(detectOutboundCredential(text).detected, text).toBe(false);
    }
  });

  it('excludes the JWT shape from the hard wall (content hashes share it)', () => {
    expect(HARD_WALL_CREDENTIAL_KINDS.has('jwt' as never)).toBe(false);
  });

  // ── The false-positive ratchet (review corpus, 2026-07-25) ────────────────
  // Every string below was produced by a reviewer running the ACTUAL regexes
  // against the label-proximity kinds that were originally in the wall. Each is
  // ordinary prose this agent would genuinely send, and each would have been
  // UNSENDABLE by any route — no override, no metadata escape hatch, only a
  // code deploy. They are pinned here so re-adding a label-proximity kind fails
  // loudly instead of silently muting the agent on its own channel.
  it('does NOT wall ordinary prose that merely MENTIONS a credential', () => {
    const prose = [
      'Disable password authentication in the sshd config.',
      "I've tightened the password requirements on the new signup flow.",
      'We use Bearer token authentication on that route.',
      'Use the header Authorization: Bearer YOUR_DASHBOARD_TOKEN_HERE',
      'The token refresh_interval is now 15 minutes.',
      'I updated the api_key documentation for the partner integration.',
      'apiKey configuration is in the project config file.',
      'The token: tone-agent-override-v1 is what gets recorded.',
      'Rotate the secret sync_status_endpoint config.',
    ];
    for (const text of prose) {
      expect(detectOutboundCredential(text).detected, text).toBe(false);
    }
  });

  it('documents WHY each excluded kind is excluded (deliberate, not an omission)', () => {
    for (const kind of ['labeled-secret', 'bearer-token', 'jwt']) {
      expect(HARD_WALL_EXCLUDED_KINDS[kind], kind).toBeTruthy();
      expect(HARD_WALL_CREDENTIAL_KINDS.has(kind as never), kind).toBe(false);
    }
  });

  it('fails loudly if an upstream rename empties a hard-wall kind', () => {
    // A silently-empty wall is the worst outcome: every test still passes and
    // the floor quietly stops walling.
    expect(assertHardWallKindsExist()).toEqual([]);
  });

  it('REFUSES an unscannable oversize message rather than passing it', () => {
    // The opposite fail-direction from a detector fault, deliberately: "too big
    // to scan" must not become "pad past the bound and walk through the wall".
    const huge = 'a'.repeat(MAX_SCAN_BYTES + 1);
    const r = detectOutboundCredential(huge);
    expect(r.detected).toBe(true);
    expect(r.kind).toBe('oversize-unscannable');
    expect(credentialGuardMessage(r.kind!)).toContain('too large to scan');
  });

  it('is stateless across calls (shared /g regexes must not carry lastIndex)', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE';
    expect(detectOutboundCredential(text).detected).toBe(true);
    expect(detectOutboundCredential(text).detected).toBe(true);
    expect(detectOutboundCredential(text).detected).toBe(true);
  });

  it('returns not-detected on empty input rather than throwing', () => {
    expect(detectOutboundCredential('').detected).toBe(false);
  });
});

describe('tone-gate evidence rules', () => {
  it('registers the override + compliance rules against the tone-gate decision point', () => {
    for (const id of ['tone-agent-override-v1', 'tone-agent-complied-v1']) {
      const rule = RULE_REGISTRY[id];
      expect(rule, `${id} must be registered`).toBeDefined();
      expect(rule.decisionPoint).toBe('messaging-tone-gate');
      expect(rule.owningComponent).toBe('ToneGateAdvisory');
    }
  });

  it('records agent reactions at the SELF-REPORT rung — an interested party is not a grader', () => {
    // Precedence (§5.4.3) guarantees a self-report can never outrank an
    // independent grader, and the read surface segregates it from proof-like
    // evidence. Promoting these to deterministic-ground-truth would let the
    // agent grade its own homework and have it read as measured truth.
    for (const id of ['tone-agent-override-v1', 'tone-agent-complied-v1']) {
      expect(RULE_REGISTRY[id].rung).toBe('self-report');
      expect(RULE_REGISTRY[id].evidenceStrength).toBe('self-report');
    }
  });
});
