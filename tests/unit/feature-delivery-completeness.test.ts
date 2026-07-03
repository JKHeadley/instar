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
      // gate-prompts-judge-by-meaning §Migration: the Outbound Message Gate
      // awareness section. Full parity — templates.ts generateClaudeMd + migrator
      // migrateClaudeMd + migrateFrameworkShadowCapabilities markers[] (so a
      // Codex/Gemini agent also learns its messages are judged by MEANING).
      '### Outbound Message Gate',
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
      'Durable Inbound Message Queue', // custody queue + hold-for-stability (templates.ts + migrator parity, CMT-1118)
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
      'Model-Tier Escalation (EXPERIMENTAL', // FABLE-MODEL-ESCALATION-SPEC §10: heavy-work model escalation awareness (POST /sessions/:name/model-swap, tier enum only; dark fleet default; templates.ts + migrator + shadow-marker parity — a Codex agent spawning claude-code sessions can use the swap surface too).
      'Outbound advisory for automated messages', // outbound-jargon-filepath-gap §5: the inform-only preflight for automated job sends — what a "NOT SENT — advisory" transcript line means + the fix-then-re-run / --ack-advisory moves (templates.ts + migrator + shadow-marker parity).
      'Topic Profile (per-topic model', // TOPIC-PROFILE-SPEC §12: per-topic durable {model, thinkingMode, framework} pins resolved at spawn with gentlest-swap respawn — a user-invokable capability ("use codex here" / "pin this topic to Fable" / "set high thinking"). Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[] (framework-agnostic — a Codex agent can carry per-topic pins too).
      'Links that survive machine boundaries (WS4.4', // MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4: pool-stable private-view links — the fronting machine proxies /view/:id to the holder with an audience-bound single-use signed user-auth assertion. Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd. Ships DARK (multiMachine.seamlessness.ws44PoolLinks, dev-gated); a single-machine agent is a no-op.
      'Shared pool-cache (WS4.4(f)', // MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 clause (f), CMT-1416 follow-up: every pool-scope surface (sessions/jobs/attention/guards/…) routes its per-peer fan-out through ONE shared PoolPollCache so each peer is hit once per interval (not once per surface per client), with honest stale-tagging under CPU load-shed; observability at GET /pool/poll-cache. Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[] (both `**`-bold and `### ` heading variants). Ships DARK (multiMachine.seamlessness.ws44PoolCache, dev-gated); a single-machine agent is a no-op (no peers).
      'One Memory (replicated stores)', // multi-machine-replicated-store-foundation §7: the no-clobber union-reader + operator-resolved conflicts (/state/conflicts, /state/resolve-conflict) + origin-tagged rollback-unmerge (/state/quarantine). Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[] (both `**`-bold and `### ` heading variants). Ships DARK (multiMachine.stateSync.<store>); a single-machine agent is a no-op.
      'Feedback-Inbox Receiving End', // feedback-factory-migration Q2b (Option-B receiving end): the operated-instance drain-status read surface (GET /feedback-inbox/status) — "are fleet feedback reports flowing / stuck?". Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[]. Ships DARK (feedbackFactory.receiverPersistence.enabled + a Blob token env); the route 503s when dark.
      'Feedback-Factory Processing (operated feedback factory)', // feedback-factory-migration §191: the operated-instance clustering side — GET /feedback-factory/stats (read-only counts) + POST /feedback-factory/process (one clustering pass) + the cadenced feedback-factory-process built-in job (tier-1 supervised, off by default). Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[]. Ships DARK — dev-gated (feedbackFactory.processing): LIVE on a development agent, both routes 503 on the fleet.
      'Verified Pairing — is my channel to a peer mutually verified', // secure-a2a-verified-pairing: the agent-facing awareness for mutual SAS pairing — "never send a peer a credential until it shows mutual-verified" (GET /threadline/pairing; the threadline_pair MCP tool; the dashboard PIN-gated verify). Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[] (both `**`-bold and `### ` heading variants). Ships DARK (threadline.verifiedPairing.enabled, dev-gated; routes 503 when off); a credential to an unverified peer is REFUSED fail-closed.
      'Mesh Rope Health (recovery probe + partition alerts)', // U4.3 + U4.5 (u4-3-breaker-recovery-probe + u4-5-rope-health-alerts): the rope recovery probe ("why did a dead rope come back by itself?" -> /health ropeHealth) + the rope-health alerts monitor (GET /mesh/rope-health, the rope-health-digest job, partition-alert semantics: lid-close is never urgent). Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[]. Both features ship dev-gated (live-on-dev day one, dark fleet: the route 503s, the probe is inert).
      'Context-Aware Outbound Review', // context-aware-outbound-review §4.3: the response-review awareness block — GET /review/history + logs/response-review-decisions.jsonl (the durable would-block audit) + the "check contextMeta before assuming the reviewer erred" proactive trigger, carrying the house dark-feature honesty phrasing (501 on most installs). Full parity: templates.ts generateClaudeMd + migrator migrateClaudeMd + migrateFrameworkShadowCapabilities markers[]. The context layer ships dev-gated dark (responseReview.conversationalContext); the enforcement flip stays the operator's manual §D9-gated action.
      'Cold-Start Lifeline Fallback', // G1 "Agent Is Always Reachable" corollary 2: the user-facing cold-start/restart failure reply (why + lifeline pointer + copy-paste debug block) on the deterministic delivery path. Full parity: templates.ts generateClaudeMd (### heading) + migrator migrateClaudeMd (### heading) + migrateFrameworkShadowCapabilities markers[]. Always-on safety floor (the standard forbids dark-shipping reachability); framework-agnostic server behavior, so a Codex/Gemini agent learns to explain it too.
      'Durable Conversation Identity', // durable-conversation-identity §6.2(b)/§9: the GET /conversations* read surface — a negative topicId is a MINTED conversation id (a Slack channel/thread), resolvable at /conversations/:id; /conversations/health is the tripwire surface. Full parity: templates.ts generateClaudeMd (### heading) + migrator migrateClaudeMd (### heading) + migrateFrameworkShadowCapabilities markers[]. Recording is always-on foundation (kill-switchable via conversationIdentity.recording.enabled); only DELIVERY (followThrough) is dev-gated.
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
      'Permission-Prompt Floor',  // framework-permission-prompt-robustness: migrateClaudeMd adds a `### Permission-Prompt Floor` awareness section so existing agents learn the always-on resolver; the generateClaudeMd (new-agent template) counterpart is a tracked minor follow-up, so for now this is migrator-only awareness, not template-shadow parity.
      'Machine Load Assessment',  // robust-load-assessment-fleet (CMT-1703): migrateClaudeMd + generateClaudeMd both add the load-assess.sh awareness section via the shared MACHINE_LOAD_ASSESSMENT_CLAUDEMD_SECTION(); ships ON for all agents (observe-only, no dark gate / no framework-shadow marker), so it's tracked here.
      'Dynamic MCP Lifecycle',  // DYNAMIC-MCP-LIFECYCLE-SPEC: migrateClaudeMd + generateClaudeMd both add the load-on-demand awareness section via the shared DYNAMIC_MCP_CLAUDEMD_SECTION(port); honestly tagged experimental/dark (a dark capability behind sessions.dynamicMcp.enabled, not a framework-spawn behavior, so no framework-shadow marker), so it's tracked here.
      'Real-Check Verification',  // autonomous-completion-real-checks (ACT-152): the migrator adds a full `### Real-Check Verification` section, while the template (generateClaudeMd) carries the same info inline as a bullet under "Autonomous Completion Discipline" (no `### ` section of that name) — so the section is migrator-only awareness, not template-shadow parity.
      'Cartographer Doc-Tree',    // cartographer-doc-tree-schema spec #1: GET /cartographer/* READ surface the agent uses to orient in deep code — added via migrator as a full `### ` section; the template carries only a Registry-table row (no full section), so it's migrator-only awareness like '/session/clock' / '/resources/summary', not template-shadow parity.
      'Keep the map true',        // cartographer-doc-freshness spec #2: the Tier-1 inline-refresh affordance (POST /cartographer/node/refresh) — a niche, freshnessSweep-gated agent affordance added via migrator as a `### ` section, same migrator-only classification as the spec #1 cartographer section above (not a universal user-invokable capability needing template-shadow parity).
      'Standards Enforcement Coverage', // cartographer-conformance-audit spec #3: GET /conformance/coverage* READ surface (per-standard enforcement-coverage of docs/STANDARDS-REGISTRY.md) — added via migrator as a `### ` section, same migrator-only classification as the spec #1/#2 cartographer sections above (a conformanceAudit-gated observe-only audit, not a universal user-invokable capability needing template-shadow parity).
      'Scope a sub-agent to a subtree', // cartographer-subtree-nav spec #5: GET /cartographer/navigate READ surface (minimal relevant subtree for a query → paths to scope a sub-agent to) — added via migrator as a `### ` section, same migrator-only classification as the spec #1/#2/#3 cartographer sections above (a cartographer.enabled-gated deterministic observe-only navigator, not a universal user-invokable capability needing template-shadow parity).
      'serves a cached snapshot', // cartographer event-loop safety (fix instar#1069): migrateClaudeMd content-sniff key for the "Cartographer event-loop safety" section — behavioral awareness (snapshot-backed /health+/stale semantics, the freshnessSweep.framework knob, the detectInWorker rollback) added via migrator as a `### ` section, same migrator-only classification as the cartographer sections above (no user-invokable capability / template-shadow parity).
      '/secrets/sync-status',     // cross-machine secret-sync status route (concurrent multi-machine workstream) — migrator-only awareness, no user-invokable capability. Was untracked on main → a pre-existing red in this guard; tracked here per the Zero-Failure Standard.
      'Honest progress messaging (silent-freeze watchdog + promise beacon)', // HONEST-PROGRESS-MESSAGING C: behavioral-awareness section (what the two notifiers are + their defaults + how to tune/disable) added via migrator AND emitted by the template directly (so a fresh init self-matches, never double-patched) — like the cartographer sections above; not a user-invokable capability needing template-shadow parity.
      'Multi-transport mesh comms', // multi-transport-mesh-comms: behavioral-awareness section (the multi-rope Tailscale/LAN/Cloudflare failover, /health meshEndpoints read, "why unreachable/flapping" trigger, meshTransport.enabled kill-switch) added via migrator AND emitted by the template directly (so a fresh init self-matches, never double-patched) — same migrator-only classification as the lease-self-heal / honest-progress sections above; not a user-invokable capability needing template-shadow parity.
      'Fork-Bomb Spawn Cap', // forkbomb-prevention-simple: behavioral-awareness section for the host-wide concurrent-LLM-subprocess cap (a SAFETY FLOOR, ON by default — never dark) + the GET /spawn-limiter read surface + the intelligence.spawnCap/env tuning knobs — added via migrator AND emitted by the template directly (so a fresh init self-matches, never double-patched). Migrator-only awareness like the multi-transport / honest-progress sections above; not a user-invokable capability needing template-shadow parity (the /spawn-limiter capability is already in CapabilityIndex).
      'Autonomous-run silence backstop', // autonomous-progress-heartbeat (AutonomousProgressHeartbeat): dark-by-default (monitoring.autonomousProgressHeartbeat), dryRun-first behavioral-awareness section describing the liveness backstop + GET /autonomous-heartbeat — added via migrateClaudeMd content-sniff, same migrator-only classification as the 'Honest progress messaging' / Action-Claim sections above (not a universal user-invokable capability needing template-shadow parity).
      'Autonomous Liveness Reconciler', // autonomous-liveness-reconciler (AutonomousLivenessReconciler): dev-gated dark (monitoring.autonomousLivenessReconciler), dryRun-first behavioral-awareness section describing the level-triggered "dead but marked active" self-heal + GET /autonomous/liveness — added via migrateClaudeMd content-sniff, same migrator-only classification as the 'Autonomous-run silence backstop' heartbeat section above (not a universal user-invokable capability needing template-shadow parity).
      'Action-Claim Follow-Through Sentinel', // action-claim-followthrough-sentinel (#1178): signal-only, dark-by-default (messaging.actionClaim.enabled) behavioral-awareness section added via migrator (PostUpdateMigrator) — migrator-only awareness like the cartographer / 'Honest progress messaging' sections above, not a user-invokable capability needing template-shadow parity. Tracked here per the Zero-Failure Standard (was untracked → main-wide red after #1178 merged).
      'Parallel-Hand PR Lease', // parallel-hand-pr-lease: dev-cycle infra, dev-gated dark (monitoring.prHandLease) behavioral-awareness section — both generateClaudeMd (fresh init self-matches) AND migrateClaudeMd append it on this content-sniff marker, same migrator-only classification as the Action-Claim / cartographer sections above (not a universal user-invokable capability needing template-shadow parity).
      'run off Claude by default', // provider-fallback-default-policy (CMT-1554/1555): the migrateClaudeMd content-sniff marker for the corrective "Per-Component Framework Routing" default-ON subsection. The TEMPLATE (generateClaudeMd) edits the existing section's sentences in place (a fresh init self-matches), while the migrator APPENDS a corrective subsection on this new marker (migrateClaudeMd only appends, never edits in place) — so it's behavioral-awareness like 'Honest progress messaging' above, not a separate user-invokable capability needing template-shadow parity.
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
      'Playwright Profile Registry', // playwright-profile-registry spec (P4): dev-gated DARK, machine-local browser-profile↔account registry for self-unblock — fleet routes 503 when off. Migrator-only awareness (added via migrateClaudeMd content-sniff; also emitted by the template so fresh init self-matches), not a universal user-invokable capability needing Codex/Gemini template-shadow parity (same classification as the cartographer / secret-sync-status sections above).
      'Action-Claim Follow-Through Sentinel', // action-claim-followthrough-sentinel spec (P2, PR #1178): signal-only word-vs-action follow-through sentinel, dark by default (messaging.actionClaim.enabled, code-default false). Migrator-only awareness (added via migrateClaudeMd content-sniff; also emitted by the template so a fresh init self-matches), not a universal user-invokable capability needing Codex/Gemini template-shadow parity (same classification as the Playwright Profile Registry / cartographer sections above).
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
      'Threadline Single-Negotiator',                     // CMT-1362 single-negotiator lease + prose-inertness + honest-acks: behavioral/operational awareness (how the per-conversation lease, G2 inert-prose, and G3 acks work) added via migrator + template, ships dark+dry-run — NOT a user-invokable capability the Codex/Gemini frameworks shadow, so no shadow-marker parity (like 'Multi-Machine Session Pool', 'The Threadline hub topic', 'ContextWedgeSentinel'). Spec: docs/specs/THREADLINE-SINGLE-NEGOTIATOR-SPEC.md
      'Threadline Canonical History (audit what I said',  // CMT-1362 Phase 2 canonical-history + conversation-discipline: behavioral/operational awareness (read-back the canonical per-thread log + symmetry/divergence health) added via migrator + template, ships dark+dev-gated — wired exactly like its Phase-1 sibling 'Threadline Single-Negotiator' (in template + migrator, NOT in the shadow markers[]), so no shadow-marker parity. Spec: docs/specs/THREADLINE-CANONICAL-HISTORY-SPEC.md
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
      'Guard Posture — which safety systems are genuinely on', // GUARD-POSTURE-ENDPOINT-SPEC §4/§2.5: the GET /guards (+ ?scope=pool) steady-state posture READ surface + the PATCH /config one-level-deep-merge hazard (templated "### Guard Posture" + migrator, byte-identical — see PostUpdateMigrator-guardsCapabilitySection.test.ts): observability the agent READS to answer "are my guards on / why didn't the watchdog fire on machine X?" — same READ-surface class as /sessions/reap-log, /resources/summary, /providers/registry; not a framework-shadowed user-invokable capability
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
      'unlabeledCallShare',                                // token-audit-completeness addendum sniff key: the migrateClaudeMd branch appends the per-model breakdown + usageCoverage addendum to the already-tracked Per-Feature LLM Metrics surface ('/metrics/features', tracked above) — an addendum to a READ surface, like '/corrections' for Preferences; the literal is a REAL response field also emitted by the updated templates.ts base section so a fresh init self-matches and is never double-patched
      '/sessions/resume-queue',                            // reap-notify spec: Mid-Work Resume Queue read surface + levers (migrator "Mid-Work Resume Queue & Per-Topic Reap Notices" section; templates.ts carries the parity bullets inside the Reap-Log section) — observability the agent READS to answer "did my interrupted work come back? / is a restart queued?" plus the cancel/requeue/resume/drain levers; same READ-surface class as /resources/summary and /sessions/reap-log, not a framework-shadowed user-invokable capability
      '/green-pr-automerge',                               // green-pr-automerge-enforcement: the "Green-PR Auto-Merge (Phase 7 becomes machinery)" migrator section — the watcher status read + the hold/rollback/enable levers. Migrator-only (existing dev agents learn it on update); off fleet-wide (deliberate-fleet-default) + repo-gated, so a fresh fleet init has nothing to surface — same migrator-only class as the maintainer-env Release Readiness surface
      'mergeStrategy',                                     // mergerunner-auto-arm-handoff: the UPDATED-COPY content-sniff for the SAME already-tracked "Green-PR Auto-Merge (Phase 7 becomes machinery)" migrator section ('/green-pr-automerge' above). The migrateClaudeMd branch is `else if (!content.includes('mergeStrategy'))` — it detects an OLD copy of the green-pr section (route string present, the new `mergeStrategy` marker absent) and REPLACES the body with the updated content (mergeStrategy:'auto'|'admin', disarm-reach, armed states). Not a new capability section — a re-sniff of the existing migrator-only section, like '/cutover-readiness/import-dryrun' for Cutover Readiness or '/corrections' for Preferences. No template/shadow parity (the parent section is dark, repo-gated, migrator-only).
      '/state/resolve-conflict',                           // alternate (content-sniff) check for "One Memory (replicated stores)" — the migrateClaudeMd branch sniffs on the unique /state/resolve-conflict route AND the section name; the section itself is tracked as a featureSection above (like '/mandate/evaluate' for Coordination Mandate)
      'pool.machines[].emptyState',                        // WS4.2 (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.2, F7): the migrateClaudeMd branch inserts the per-machine empty-state bullet (online — no active sessions / offline since / unreachable) INTO the already-tracked "Multi-Machine Session Pool (active-active" section for agents that predate it — a sub-line of that section (allowlisted at 'Multi-Machine Session Pool (active-active' above), like '/corrections' for Preferences. The parent section ships DARK + is migrator-tracked (not framework-shadowed), so no new featureSections entry / shadow-marker parity is required; ALSO emitted by the template directly so a fresh init self-matches and is never double-patched
      'Live Credential Re-pointing (move a pool account',   // live-credential-repointing-rebalancer §4 (WS5.2, CMT-1372): the /credentials/* manual levers + the zero-touch default-flip awareness, emitted by BOTH templates.ts generateClaudeMd (new agents) AND migrateClaudeMd (existing agents). Ships DARK behind subscriptionPool.credentialRepointing.enabled and is CLAUDE-credential-specific (it re-points the Claude credential STORE that claude-code sessions read — a Codex/Gemini-framework agent has no such store to steer), so NO framework-shadow parity applies — same dark, migrator-tracked, not-framework-shadowed class as 'Multi-Machine Session Pool (active-active' / '/green-pr-automerge'. Discoverable via GET /credentials/locations + GET /capabilities.
      'The Agent Carries the Loop',                          // agent-owned-followthrough C1+C2: owner⟂blockedOn commitment model + probe + the user-is-never-status-pinged behavior, emitted by BOTH templates.ts generateClaudeMd (new agents) AND migrateClaudeMd (existing agents). Behavioral/dark — ships dark-on-fleet / live-in-dryRun-on-dev (commitments.agentOwnedFollowthrough), no framework-shadowed user-invokable route; same template+migrator, behavioral, not-framework-shadowed class as 'Live Credential Re-pointing'. Constitution: "The Agent Carries the Loop".
      'Self-Unblock Before Escalating',                     // self-unblock-before-escalating spec (CMT-1519): a constitutional BEHAVIORAL standard (exhaust self-unblock paths within permissions before escalating; the rung ladder + floor), emitted by BOTH templates.ts generateClaudeMd (new agents) AND migrateClaudeMd (existing agents). Ships DARK (extends the monitoring.blockerLedger.* dev-gate); its /blockers/self-unblock-runs route is a dark-by-default READ surface, not a user-invokable capability the Codex/Gemini frameworks shadow — same behavioral-standard class as 'Cross-Agent Communication Discipline (anti-confabulation)' / 'Threadline Single-Negotiator', so template+migrator parity but NO shadow-marker parity.
      'Live-User-Channel Proof Before Done',                 // live-user-channel-proof-standard spec (CMT-1568): a constitutional BEHAVIORAL standard (a user-facing feature isn't "done" until a user-role session proved it live through the real channel — Telegram AND Slack — before the operator tests), emitted by BOTH templates.ts generateClaudeMd (new agents) AND migrateClaudeMd (existing agents). Its enforcement (the completion gate + harness) ships dark/dev-gated; the section itself is behavioral awareness, not a user-invokable capability the Codex/Gemini frameworks shadow — same template+migrator, behavioral, not-framework-shadowed class as 'Self-Unblock Before Escalating' / 'The Agent Carries the Loop'. Constitution: "Live-User-Channel Proof Before Done".
      'Sender-Rejection Notices',                           // silent-loss-refusal-conservation §2.E: the "message not delivered — sender not recognized" awareness section, emitted by BOTH templates.ts generateClaudeMd (new agents) AND migrateClaudeMd (existing agents). Always-on behavioral awareness (a no-silent-loss reachability floor may not be dark), not a user-invokable route the Codex/Gemini frameworks shadow — same template+migrator, behavioral, not-framework-shadowed class as 'Self-Unblock Before Escalating' / 'Live-User-Channel Proof Before Done'. Discoverable via logs/mesh-rejections.jsonl + the notice itself.
      'Cross-Machine Account Follow-Me (WS5.2',             // ws52-account-follow-me-security PR1: cross-machine account/quota sharing awareness, emitted by BOTH templates.ts generateClaudeMd (new agents) AND migrateClaudeMd (existing agents). Ships DARK on the fleet (dev-gated multiMachine.accountFollowMe) and is CLAUDE-credential-specific (re-mint per machine; the metadata kind + the credential-share verb only matter to an agent serving from a Claude subscription store — a Codex/Gemini-framework agent has no such cross-machine login to share), so NO framework-shadow parity applies — same dark, template+migrator, not-framework-shadowed class as 'Live Credential Re-pointing (move a pool account' / 'Multi-Machine Session Pool (active-active'.
      'Scope-Accretion Completion Discipline',              // autonomous-scope-accretion-completion.md §4: work an autonomous run itself creates joins its completion bar (the server-side git-truth sweep at the evaluate-completion chokepoint + the ratification paths + the PIN override lever), emitted by BOTH templates.ts generateClaudeMd (new agents, via the shared SCOPE_ACCRETION_CLAUDEMD_SECTION) AND migrateClaudeMd (existing agents). Behavioral completion-discipline awareness tied to the Claude autonomous stop-hook loop (the guarantee FIRES only for an engine whose loop consults the evaluate-completion chokepoint — spec R16; Codex's loop-driver ships self-gated dark, gemini/pi have no completion loop), so NO framework-shadow parity applies — same template+migrator, behavioral, not-framework-shadowed class as 'Live-User-Channel Proof Before Done' / 'Self-Unblock Before Escalating'.
      'loadBearingGap',                                     // g3-dark-but-load-bearing-guards §6: the migrateClaudeMd content-sniff key for the "#### Dark-but-Load-Bearing Guards (G3)" addendum (loadBearingGap/loadBearingSoaking/loadBearingAccepted vocabulary + the /guards/:key/accept-fallback route). generateClaudeMd (new agents) emits the same vocabulary as a bullet in the already-tracked "Guard Posture — which safety systems are genuinely on" section, while migrateClaudeMd APPENDS the H4 addendum on this new marker (existing agents already carry the base section, which is content-sniffed and never re-edited in place). Behavioral READ-surface awareness (GET /guards classification + one PIN-gated suppress route), not a universal user-invokable capability the Codex/Gemini frameworks shadow — same template+migrator, not-framework-shadowed class as the cartographer / 'serves a cached snapshot' sections above.
      'Mesh Self-Healing',                                  // U4.2 stale-owner release + U4.4 lease hand-back (docs/specs/u4-2-stale-owner-release.md §5 + u4-4-lease-handback.md §5): the mesh-reconciler awareness section, emitted by BOTH templates.ts generateClaudeMd (via the shared MESH_SELF_HEALING_CLAUDEMD_SECTION constant — the literal heading text lives in PostUpdateMigrator.ts, like the Playwright/Dynamic-MCP constants) AND migrateClaudeMd, PLUS a migrateFrameworkShadowCapabilities marker ('### Mesh Self-Healing: stale-owner release + lease hand-back') so Codex/Gemini agents learn the two proactive triggers + the human-always-wins latch rule. Ships dark/dry-run (U4.2 dev-gated, U4.4 hard-dark action-bearing); a single-machine agent is a strict no-op.
      'Write Admission',                                    // standby-write reconciliation (docs/specs/standby-write-reconciliation.md §7 migration parity): the "### Write Admission" awareness section (ownership-scoped write admission + typed 409 write-refused + the GET /write-admission read surface + logs/write-admission.jsonl audit), emitted by BOTH templates.ts generateClaudeMd (via the shared WRITE_ADMISSION_CLAUDEMD_SECTION constant — the literal heading text lives in PostUpdateMigrator.ts, like the Mesh Self-Healing / Playwright constants) AND migrateClaudeMd. Ships dev-gated dark + dry-run FIRST (route 503s on the fleet; the legacy standby guard keeps enforcing while dry); a single-machine agent is a strict no-op. Behavioral READ-surface awareness ("a 409 write-refused naming another machine means re-send to the owner — never auto-move the topic"), not a universal user-invokable capability the Codex/Gemini frameworks shadow — same dark, template+migrator, not-framework-shadowed class as 'Mesh Self-Healing' / 'Multi-Machine Session Pool (active-active'.
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
