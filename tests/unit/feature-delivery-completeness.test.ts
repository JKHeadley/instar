/**
 * Feature Delivery Completeness — ensures no gaps between init and migrate.
 *
 * The Three-Legged Stool of Feature Delivery in Instar:
 *   1. Server-side code (the feature itself)
 *   2. PostUpdateMigrator (so existing agents get local files on auto-update)
 *   3. Upgrade guide (so agents understand what they got)
 *
 * Without all three, new features ship to npm but existing agents never
 * actually get activated. This happened with External Operation Safety —
 * the code shipped in v0.9.14 but existing agents didn't get the hook,
 * settings, or config defaults until the migrator was updated. Then again
 * with Threadline relay — code shipped in 0.18.4 but the migration didn't
 * land until 0.18.5, leaving a window where existing agents got the feature
 * code but no awareness of it.
 *
 * This test prevents that gap by automatically extracting feature awareness
 * from source files and enforcing parity. Adding a feature to init/templates
 * without a corresponding PostUpdateMigrator section will fail CI.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import { assembleNextMd, gatherFragmentInputs } from '../../scripts/assemble-next-md.mjs';

const srcDir = path.join(process.cwd(), 'src');
const initSource = fs.readFileSync(path.join(srcDir, 'commands/init.ts'), 'utf-8');
const migratorSource = fs.readFileSync(path.join(srcDir, 'core/PostUpdateMigrator.ts'), 'utf-8');
const templatesSource = fs.readFileSync(path.join(srcDir, 'scaffold/templates.ts'), 'utf-8');

describe('Feature Delivery Completeness', () => {
  describe('Hook parity: init installHooks() → PostUpdateMigrator migrateHooks()', () => {
    // Extract all hook filenames written in init.ts's installHooks function
    const hookFilePattern = /writeFileSync\(path\.join\(hooksDir,\s*'([^']+)'\)/g;
    const initHookFiles: string[] = [];
    let match;
    while ((match = hookFilePattern.exec(initSource)) !== null) {
      initHookFiles.push(match[1]);
    }

    it('init.ts installs at least 5 hooks (sanity check)', () => {
      expect(initHookFiles.length).toBeGreaterThanOrEqual(5);
    });

    for (const hookFile of initHookFiles) {
      it(`PostUpdateMigrator installs ${hookFile}`, () => {
        // The migrator must reference this hook file in its source
        expect(migratorSource).toContain(hookFile);
      });
    }
  });

  describe('Settings parity: init → PostUpdateMigrator migrateSettings()', () => {
    it('MCP matcher (mcp__.*) is in both init and migrator', () => {
      expect(initSource).toContain("'mcp__.*'");
      expect(migratorSource).toContain("'mcp__.*'");
    });

    it('dangerous-command-guard is referenced in both init and migrator', () => {
      expect(initSource).toContain('dangerous-command-guard');
      expect(migratorSource).toContain('dangerous-command-guard');
    });

    it('Playwright MCP server is in both init and migrator', () => {
      expect(initSource).toContain('playwright');
      expect(migratorSource).toContain('playwright');
    });
  });

  describe('Config parity: init config defaults → PostUpdateMigrator migrateConfig()', () => {
    // Feature config blocks are object-valued config keys that represent capabilities.
    // Both init.ts (for new agents) and PostUpdateMigrator (for existing agents) must
    // handle each one. If you add a feature config block, add it to this list.
    //
    // WHY THIS LIST EXISTS: The Threadline incident (0.18.4) showed that shipping
    // feature code without migration code leaves existing agents with capabilities
    // they don't know about. This list is the structural enforcement — if init.ts
    // has a config block that's not in the migrator (or vice versa), the test fails
    // and the version can't be published.
    const featureConfigBlocks = [
      'externalOperations',
      'threadline',
    ];

    for (const key of featureConfigBlocks) {
      it(`config.${key} is set in init.ts (new agents)`, () => {
        expect(initSource).toContain(key);
      });

      it(`config.${key} is migrated in PostUpdateMigrator (existing agents)`, () => {
        expect(migratorSource).toContain(key);
      });
    }

    // Auto-detect: if the migrator adds a config block we haven't listed, fail loudly.
    // Pattern: `if (!config.X)` followed by `config.X = {` means it's a feature block.
    const migratorConfigPattern = /if \(!config\.(\w+)\)\s*\{[\s\S]*?config\.\1\s*=/g;
    const detectedBlocks: string[] = [];
    let configMatch;
    while ((configMatch = migratorConfigPattern.exec(migratorSource)) !== null) {
      detectedBlocks.push(configMatch[1]);
    }

    it('all migrator config blocks are tracked in featureConfigBlocks', () => {
      for (const block of detectedBlocks) {
        expect(
          featureConfigBlocks.includes(block),
          `PostUpdateMigrator adds config.${block} but it's not in featureConfigBlocks — add it so parity is enforced`
        ).toBe(true);
      }
    });
  });

  describe('CLAUDE.md section parity: templates.ts ↔ PostUpdateMigrator', () => {
    // Feature CLAUDE.md sections that represent capabilities agents should know about.
    // Both templates.ts (via generateClaudeMd for new agents) and PostUpdateMigrator
    // (via migrateClaudeMd for existing agents) must include each one.
    //
    // When you add a new CLAUDE.md section to templates.ts, add a key phrase here.
    // The test will verify it exists in both files. If it's only in one, CI fails.
    const featureSections = [
      'Self-Discovery',
      'Publishing',
      'Private Viewing',
      'Secret Drop',
      'Commitments & Follow-Through',
      'Attention Queue',
      'Dashboard',
      'File Viewer',
      'Threadline Network',
      'Playbook',
      'Worktree Convention',
      'Multi-Session Autonomy',    // per-topic concurrent autonomous jobs (templates.ts + migrator parity)
      'Process Health (Dashboard Tab)', // Failure-Learning Loop read surface (templates.ts + migrator + shadow-marker parity)
      "Preferences I've learned about you", // Correction & Preference Learning Sentinel Slice 1a read surface (templates.ts + migrator + shadow-marker parity)
      // Coordination-mandate family (coordination-mandate spec §7, G2.2–G2.4): framework-agnostic
      // agent-facing capabilities in BOTH templates.ts and the migrator. Were untracked — a latent
      // red this guard never caught while it sat quarantined in vitest.push.config.ts; tracked here
      // as part of re-arming the gate (2026-06-05 suite triage).
      'Coordination Mandate',           // mandate gate awareness (/mandate/evaluate; deny-by-default; requester≠authorizer)
      'ReviewExchange (autonomous code review)', // mandate-gated two-party review sign-off protocol
      'Cutover Readiness',              // migration readiness read surface (/cutover-readiness; the door stays the operator's)
      '**Session Boot Self-Knowledge**', // vault secret NAMES + operational facts at boot (spec session-boot-self-knowledge; templates.ts + migrator + shadow-marker parity)
      'MTP Protocol — the two EXO 3.0 tests', // ORG-INTENT as machine-readable MTP: identity layer + refusal/endorsement tests (/intent/org/test-action; EXO 3.0 G1; templates.ts + migrator + shadow-marker parity)
      'Agent Digital Passport (EXO 3.0', // portable identity+trust+constraints passport + peer compliance check (/passport, /passport/verify; EXO 3.0 G3; templates.ts + migrator + shadow-marker parity)
      'Agent-Readiness Scoring (EXO 3.0', // coordination-vs-judgment diagnostic (/agent-readiness/score; EXO 3.0 G2; templates.ts + migrator + shadow-marker parity)
      'Learning-Velocity Metric (EXO 3.0', // forward-looking learning KPI (/metrics/learning-velocity; EXO 3.0 G5; templates.ts + migrator + shadow-marker parity)
      '**Operator Binding (Know Your Principal)**',
      "Working-Set Handoff (fetch a topic", // P2 multi-machine coherence: fetch-reflex awareness (POST /coherence/fetch-working-set; WORKING-SET-HANDOFF-SPEC §3.7; templates.ts + migrator parity)
      'Threadline Conversation Coherence (which machine holds', // P3: the A2A holder view (GET /threadline/conversations?scope=mesh; THREADLINE-CONVERSATION-COHERENCE-SPEC §3.4; templates.ts + migrator + shadow parity) // Caroline credential/identity-bleed fix: verified operator auto-bound from authenticated sender + /topic-operator routes + observe-only cross-principal coherence guard (#904/#906/#908/#909/#910; templates.ts + migrator + shadow-marker parity). `**`-wrapped form matches the migrator content-sniff guard + markers (like Session Boot Self-Knowledge).
      'Subscription Pool (multi-account quota', // Subscription & Auth Standard graduate: multi-account quota pool + continuity-guaranteed auto-swap + mobile enrollment, graduated from INTERNAL_PREFIXES to a surfaced capability (templates.ts generateClaudeMd + migrator migrateClaudeMd + shadow-marker parity).
    ];

    for (const section of featureSections) {
      it(`"${section}" is in templates.ts (new agents)`, () => {
        expect(templatesSource).toContain(section);
      });

      it(`"${section}" is in PostUpdateMigrator (existing agents)`, () => {
        expect(migratorSource).toContain(section);
      });
    }

    // STRUCTURAL GUARD (2026-05-24, codex-live-test): every agent-facing
    // capability MUST also reach non-Claude frameworks (Codex AGENTS.md,
    // GEMINI.md) via the migrateFrameworkShadowCapabilities markers[] allowlist.
    // Two live findings on codey proved the cost of a gap here: Secret Drop and
    // Commitments were in the Claude template but NOT in markers[], so Codex
    // agents never learned them and improvised weaker workarounds (a plaintext
    // file the user edits; a raw `sleep` timer). This guard turns "remember to
    // add the marker" into a guarantee — a featureSection with no shadow marker
    // fails CI, so the class of bug cannot recur. (Structure > Willpower.)
    const shadowMarkersMatch = migratorSource.match(/const markers = \[([\s\S]*?)\];/);
    const shadowMarkersBlock = shadowMarkersMatch ? shadowMarkersMatch[1] : '';
    // A featureSection is covered if its phrase appears inside any marker string.
    // (Markers carry markdown decoration like `**X**` / `### X`; substring match
    // tolerates that.)
    it('every agent-facing capability is in migrateFrameworkShadowCapabilities markers[] (reaches Codex/Gemini)', () => {
      expect(shadowMarkersBlock, 'could not locate the markers[] array in PostUpdateMigrator.ts').not.toBe('');
      for (const section of featureSections) {
        expect(
          shadowMarkersBlock.includes(section),
          `Capability "${section}" is in the Claude template but NOT in the shadow-capability markers[] — Codex/Gemini agents will never learn it (they will improvise a weaker workaround). Add a marker for it in migrateFrameworkShadowCapabilities.`,
        ).toBe(true);
      }
    });

    // Auto-detect: if the migrator adds a CLAUDE.md section we haven't listed, fail.
    // Pattern: `if (!content.includes('SectionName'))` in migrateClaudeMd
    const migratorSectionPattern = /if \(!content\.includes\('([^']+)'\)/g;
    const detectedSections: string[] = [];
    let sectionMatch;
    while ((sectionMatch = migratorSectionPattern.exec(migratorSource)) !== null) {
      detectedSections.push(sectionMatch[1]);
    }

    // Some migrator sections are legacy patches for old agents that have since been
    // absorbed into the base template differently. These don't need template parity.
    const legacyMigratorSections = [
      '/secrets/sync-status',     // cross-machine secret-sync status route (concurrent multi-machine workstream) — migrator-only awareness, no user-invokable capability. Was untracked on main → a pre-existing red in this guard; tracked here per the Zero-Failure Standard.
      'Coherence Gate',           // absorbed into base template
      'External Operation Safety', // absorbed into base template
      'Token-Burn Alerts',        // operational self-heal awareness (BurnDetector throttle runbook) — migrator-only, no user-invokable capability / shadow parity. (Was untracked — a pre-existing red in this guard, fixed here.)
      'Per-Component Framework Routing', // capability present in the template as a bold **entry** (matching Token-Burn Alerts / Resource Usage style); the migrator adds the same content as a `## ` section for existing agents. Tracked here like its bold-entry siblings.
      'Parallel-Work Awareness', // bold **entry** in the template + `## ` section in the migrator (cross-topic activity index, Task 3 Phase A) — same pattern as Per-Component above.
      '/capabilities',            // alternate check for Self-Discovery
      'POST /view',               // alternate check for Private Viewing
      '/dashboard',               // alternate check for Dashboard
      '**Dashboard**',            // alternate check for Dashboard (bold markdown variant)
      '**Secret Drop**',          // alternate check for Secret Drop (bold markdown variant — migrateClaudeMd ensure-section)
      '**Commitments & Follow-Through**', // alternate check for Commitments (bold markdown variant — migrateClaudeMd ensure-section)
      '**Publishing**',           // alternate check for Publishing (bold markdown variant — migrateClaudeMd ensure-section)
      '**Attention Queue**',      // alternate check for Attention Queue (bold markdown variant — migrateClaudeMd ensure-section)
      '/coherence/check',         // alternate check for Coherence Gate
      '/operations/evaluate',     // alternate check for External Operation Safety
      'instar playbook',          // alternate check for Playbook
      '## Self-Observations',     // AGENT.md section, not CLAUDE.md — no template parity needed
      '## Identity History',      // AGENT.md section, not CLAUDE.md — no template parity needed
      'Session Continuity',       // conditional (Telegram-only), not a universal feature
      'CONTINUATION',             // alternate check for Session Continuity
      '/api/files/',              // alternate check for File Viewer
      'instar-boot.js',           // plist content check (migrateBootWrapperToCjs), NOT a CLAUDE.md section
      'instar-boot.cjs',          // plist content check (migrateBootWrapperToCjs), NOT a CLAUDE.md section
      // Operational-knowledge sections — runtime self-heal / housekeeping that
      // agents need awareness of, but that don't represent user-invokable
      // capabilities. They live in migrator only, no templates.ts parity required.
      'Version-Skew Self-Recovery',                       // major.minor lifeline coordination
      'coordinated lifeline restart',                     // alternate phrase for Version-Skew
      'restart-cascade dampener',                         // patch-level update self-heal
      'Restart-cascade dampener',                         // alternate case for restart-cascade
      'Maturity honesty (silent-by-default user announcements)', // #698 mature-update-announcements: operational awareness about HOW update announcements are gated/maturity-tagged — update-behavior self-heal knowledge like Version-Skew / restart-cascade, migrator-only (no user-invokable capability / shadow parity). (Was previously untracked — a pre-existing red in this guard, fixed here.)
      'ORG-INTENT.md (Organizational Intent at Runtime)', // org-intent runtime contract
      'sentinelTelegramEscalation',                       // silently-stopped sentinel delivery gate
      'Sentinel Notifications (silently-stopped trio)',   // alternate heading phrase
      'Cross-Agent Communication Discipline (anti-confabulation)', // migrator-only behavioral guard, no template parity
      'Close the Loop (Untracked = Abandoned)', // core operating PRINCIPLE (constitution: docs/STANDARDS-REGISTRY.md), like Structure>Willpower / Deferral=Deletion — mirrored in the template's Core Principles but NOT a user-invokable capability, so no shadow-capability markers[] parity required
      'The "Threadline" hub topic — notifications',       // CMT-519 migrator-only notification-routing guidance, no template parity
      'Cross-Machine Seamlessness (one agent, many machines)', // operational self-heal/handoff awareness (like Version-Skew); not a user-invokable capability
      'What are we working on?',                           // migrator patch for the initiatives Registry-First row, not a capability section
      'Framework-Onboarding Mentor System',               // developer-layer issue-ledger observability; not a Codex/Gemini end-user capability (no shadow-marker parity)
      '**Apprenticeship Program**',                       // developer/overseer-layer capability: the overseer agent (e.g. Echo) drives the apprenticeship/mentorship instance registry + lifecycle gates. Like 'Framework-Onboarding Mentor System' — templated + migrated for the overseer, but not a mentee/end-user capability the Codex/Gemini frameworks invoke, so no shadow-marker parity required. (Was previously untracked — a pre-existing red in this guard, fixed here.)
      'What address reaches me (Threadline routing fingerprint)', // Threadline routing-fingerprint operational knowledge, migrator-only (no template/shadow parity)
      'ContextWedgeSentinel',                              // thinking-block-400 wedge recovery; operational self-heal awareness, migrator-only (no template parity) — see context-wedge-sentinel.md
      '/release-readiness',                                // alternate endpoint check for the templated Release Readiness section
      '/codex/usage',                                      // codex `/status` rate-limit READ surface (templated "Codex Usage" + migrator): observability the agent READS to answer "how much codex usage is left?" — like Release Readiness, discoverable via GET /capabilities; not a framework-shadowed user-invokable capability
      '/metrics/features',                                 // per-feature LLM metrics READ surface (templated "Per-Feature LLM Metrics" + migrator): observability the agent READS to answer "which gates cost most / fire least?" — like /codex/usage and /tokens, not a framework-shadowed user-invokable capability
      '/session/clock',                                    // Session Clock READ surface (templated "Session Clock" + migrator): observability the agent READS to answer "how long have I been running / how much is left?" — like /codex/usage and /metrics/features, not a framework-shadowed user-invokable capability. (Was previously untracked — a pre-existing red in this guard, fixed here.)
      'Agent Updates topic (self-broadcasts about ships, restarts, updates)', // self-broadcast routing operational knowledge, migrator-only
      '/sessions/reap-log',                               // UNIFIED-SESSION-LIFECYCLE §P4 reap-log: operational observability the agent READS to answer "where did my session go?" — like Sentinel Notifications, not a user-invokable capability requiring framework-shadow parity
      '/sessions/reaper/audit',                           // RESPONSIBLE-RESOURCE-USAGE reaper decision audit: operational observability the agent READS to answer "what is the reaper considering / why under load?" — like /sessions/reap-log, migrator-only (no template/shadow parity)
      'Applying config & hook changes to running sessions', // /sessions/restart-all + /sessions/refresh: session-lifecycle operational knowledge in the /sessions/* family (operator/dashboard-facing — CapabilityIndex denylists /sessions/*, like /sessions/reap-log + /sessions/reaper/audit). Templated + migrated for awareness, but not a framework-shadowed user-invokable capability.
      '/worktrees/agent-reaper',                          // RESPONSIBLE-RESOURCE-USAGE stale-worktree reclaim report: operational observability the agent READS to answer "which worktrees can I reclaim?" — like /sessions/reap-log, migrator-only (no template/shadow parity)
      'guard-posture.jsonl',                              // GuardPostureTripwire ("a disabled guard is itself an incident"): operational self-heal awareness the agent READS to answer "why didn't the watchdog catch X / was the guard even on?" — migrator-only behavioral/observability knowledge like 'ContextWedgeSentinel' / Sentinel Notifications, no user-invokable route / template-shadow parity. See guard-posture-tripwire.md
      'Honest standby (turn-receipts)',                   // PresenceProxy honest-classification: behavioral/observability awareness the agent READS to answer "why did you say 'actively working' when stuck / why the noisy 'conversation too long' messages?" — migrator-only behavioral knowledge like 'Sentinel Notifications', no user-invokable route / template-shadow parity
      'Context-wall recovery escalation',                 // /compact-before-respawn escalation rung: behavioral awareness the agent READS to answer "did I lose the conversation when my long session restarted?" — sub-note appended to the Honest-standby section, migrator-only, no user-invokable route / template-shadow parity
      'Duplicate-message suppression',                    // outbound content-dedup at /telegram/reply: behavioral awareness the agent READS to answer "why didn't my message resend / how do I force a repeat (allowDuplicate)?" — migrator-only behavioral knowledge, no user-invokable route / template-shadow parity
      'Topic-Flood Guard',                                // 2026-05-28 attention-queue circuit breaker: operational housekeeping the agent READS (state/attention-suppressed.jsonl) to answer "why are my notices grouped?" — like Sentinel Notifications, migrator-only (no template/shadow parity)
      'Bounded Notification Surface',                     // 2026-06-05 flood #3 (worktree-detector unique-source dodge): the universal last-resort auto-topic budget inside createForumTopic + aggregate-at-the-emitter guidance — operational behavioral knowledge extending 'Topic-Flood Guard', migrator-only (no template/shadow parity)
      'Autonomous-fix loop ("just be Echo")',             // mentor.autonomousFix dark dogfooding-loop awareness: developer-layer operational knowledge added via migrator only (like Framework-Onboarding Mentor System), gated off by default — no new-agent template/shadow parity required
      'Multi-Machine Session Pool (active-active',         // multi-machine session-pool awareness: ships DARK (multiMachine.sessionPool.stage default 'dark'), no-op on a single-machine agent; discoverable via GET /pool + GET /capabilities — operational/dark capability, migrator-tracked like ContextWedgeSentinel/Topic-Flood Guard
      'Correction & Preference Learning Sentinel',         // the content-sniff marker migrateClaudeMd uses for the "Preferences I've learned about you" section (tracked as a featureSection above); this is the alternate-phrase check, like '/release-readiness' for Release Readiness
      '/corrections',                                      // Slice 1b backfill: the migrateClaudeMd `else if (!content.includes('/corrections'))` branch appends the /corrections read-surface line to agents that already have the Slice-1a "Preferences I've learned about you" section — a sub-line of that tracked featureSection, not a separate capability section (like '/release-readiness' / '/codex/usage')
      'framework-issues/observe',                          // durable write path: the migrateClaudeMd `if (!content.includes('framework-issues/observe'))` branch appends the POST /framework-issues/observe line to agents that already have the developer-layer "Framework-Onboarding Mentor System" section — a sub-line of that migrator-only section (allowlisted at 'Framework-Onboarding Mentor System' above), not a new-agent user-invokable capability needing template/shadow parity
      'Throttle-survivable capture',                       // correction-capture-backlog: the migrateClaudeMd branch inserts the throttle-survivable backlog bullet INTO the already-tracked "Preferences I've learned about you" (Correction & Preference Learning) section for agents that already have it — a sub-line of that tracked featureSection (like '/corrections'), an internal resilience mechanism (no user-invokable route / framework-shadow parity required); ALSO emitted by the template directly so a fresh init is never double-patched
      '**Apprenticeship Program**',                        // developer-layer mentorship-program awareness (overseer/mentor/mentee lifecycle + gates) added via migrator only, like 'Framework-Onboarding Mentor System' — a dev-layer capability discoverable via GET /apprenticeship/instances + GET /capabilities, not a framework-shadowed end-user capability needing template/shadow parity
      'Maturity honesty (silent-by-default user announcements)', // mature-update-announcements spec: behavioral/operational guard (how the agent self-narrates a ship — opt-in, maturity-tagged), migrator-only like 'Cross-Agent Communication Discipline' / 'Agent Updates topic' — no user-invokable route / template-shadow parity
      '/session/clock',                                    // ROBUST-SESSION-TIME-AWARENESS read surface (templated "Session Clock" + migrator): observability the agent READS to answer "how long have I been running / how much is left?" — like /codex/usage and /metrics/features, not a framework-shadowed user-invokable capability
      'Token-Burn Alerts',                                 // BurnDetector noise/activity-gate awareness (monitoring.burnDetection): operational observability the agent READS to answer "why am I getting these token alerts / turn them off" — migrator-only behavioral/config guidance like 'Topic-Flood Guard' / Sentinel Notifications, no user-invokable route / template-shadow parity. (Was previously untracked — a pre-existing red in this guard, fixed here.)
      '/resources/summary',                                // per-agent ResourceLedger Phase B (CPU/memory) READ surface (templated "Resource Usage (CPU + memory + rate-limit events)" + migrator): observability the agent READS to answer "how much CPU/memory am I using right now?" — like /codex/usage, /metrics/features, /session/clock, and /resources/rate-limits, not a framework-shadowed user-invokable capability
      '/mandate/evaluate',                                 // alternate (content-sniff) check for Coordination Mandate — tracked as a featureSection above
      '/review-exchange',                                  // alternate (content-sniff) check for ReviewExchange — tracked as a featureSection above
      '/cutover-readiness',                                // alternate (content-sniff) check for Cutover Readiness — tracked as a featureSection above
      '/cutover-readiness/import-dryrun',                  // sub-line splice sniff key: the migrateClaudeMd else-if branch inserts the import-rehearsal line INTO the already-tracked Cutover Readiness section for agents that predate it (like '/corrections' for Preferences)
      '/providers/registry',                               // provider-substrate-live-wiring (June-15 subscription-path) read surface (templated "Anthropic Subscription-Path Routing" + migrator): observability the agent READS to answer "are we ready for June 15 / is the escape hatch installed?" plus an Anthropic-specific config lever — like /session/clock and /resources/summary, not a framework-shadowed user-invokable capability (the lever only applies to claude-code internal calls; Codex/Gemini agents have no claude -p traffic to reroute)
      'Is my channel to a peer alive? (A2A delivery health)', // A2A-DURABLE-DELIVERY read surface (templated + migrator parity): observability the agent READS to answer "is my channel to <peer> alive / did they get it?" via GET /threadline/peers/health[/:fp] — same READ-surface class as /codex/usage, /metrics/features, /session/clock, /sessions/reap-log; not a framework-shadowed user-invokable capability
    ];

    it('all new migrator CLAUDE.md sections are tracked', () => {
      for (const section of detectedSections) {
        const isTracked = featureSections.includes(section) || legacyMigratorSections.includes(section);
        expect(
          isTracked,
          `PostUpdateMigrator adds CLAUDE.md section "${section}" but it's not tracked — add it to featureSections or legacyMigratorSections`
        ).toBe(true);
      }
    });
  });

  describe('Upgrade guide lifecycle', () => {
    const upgradesDir = path.join(process.cwd(), 'upgrades');
    const fragmentsDir = path.join(upgradesDir, 'next');
    const nextGuidePath = path.join(upgradesDir, 'NEXT.md');

    // Release notes are authored as per-PR FRAGMENTS (upgrades/next/<slug>.md)
    // so concurrent PRs never collide on a single shared NEXT.md. A legacy
    // upgrades/NEXT.md remains supported (backward compat). "In-flight release
    // notes exist" therefore means: at least one fragment OR a legacy NEXT.md.
    // Between a release cut and the next PR, neither may be present — that is a
    // valid (notes-already-consumed) state, so the existence assertion only
    // fires when we'd otherwise expect in-flight notes.
    const hasFragments =
      fs.existsSync(fragmentsDir) &&
      fs.readdirSync(fragmentsDir).some((f) => f.endsWith('.md'));
    const hasLegacyNext = fs.existsSync(nextGuidePath);

    it('release-note source exists as fragments or a legacy NEXT.md (or notes were just consumed)', () => {
      // At least one delivery surface must be wired: in-flight notes (fragments
      // / NEXT.md) OR a shipped versioned guide. A repo with neither has no
      // release-note machinery at all.
      const versionedGuides = fs
        .readdirSync(upgradesDir)
        .filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f));
      expect(hasFragments || hasLegacyNext || versionedGuides.length > 0).toBe(true);
    });

    it('in-flight release notes (assembled fragments + NEXT.md) carry required sections', () => {
      if (!hasFragments && !hasLegacyNext) {
        // No in-flight notes (post-release-cut, pre-next-PR). Nothing to assert.
        return;
      }
      const { inputs } = gatherFragmentInputs(upgradesDir);
      const assembled = assembleNextMd(inputs);
      expect(assembled).toContain('## What Changed');
      expect(assembled).toContain('## What to Tell Your User');
      expect(assembled).toContain('## Summary of New Capabilities');
    });

    it('at least one versioned upgrade guide exists (proof of delivery)', () => {
      const files = fs.readdirSync(upgradesDir);
      const versionedGuides = files.filter(f => /^\d+\.\d+\.\d+\.md$/.test(f));
      expect(versionedGuides.length).toBeGreaterThan(0);
    });
  });
});
