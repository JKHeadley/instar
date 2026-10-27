# Instruction Inventory — Echo's deployed CLAUDE.md

**Version:** 1.1.0 (Phase 0 of [the research plan](instruction-reduction-research-plan.md)). **Captured:** 2026-10-26 from `/Users/dabombstudio/.instar/agents/echo/CLAUDE.md` (403554 bytes, sha256 `c8dc2002d14e518d…`).
**Machine-readable:** [instruction-inventory.json](instruction-inventory.json) — one record per block, with line range, tags, standard, seed disposition and dark scope.

This is the denominator for every experiment arm. Nothing here changes the live file.

## Summary

| Measure | Value |
|---|---|
| Blocks | 274 (split at every heading and every bold-led paragraph or bullet after a blank line) |
| Tokens (counted) | **147,201** summed over blocks; 147,474 for the whole file in one message (Anthropic count_tokens, claude-opus-5-5) |
| Earlier chars/4 estimate | 100,251 (31.9% below the counted total) |
| Tokens the seed would always load (disposition S) | 22,651 (15.4%) |
| Tokens behind a seed index line (I) | 109,703 (74.5%) |
| On-demand sub-detail (D) | 14,385 (9.8%) |
| History to move to notes (N) + redundant (X) | 462 (0.3%) |
| Features needing an index line | 164 |

### By primary tag

| Primary tag | Blocks | Tokens | Share |
|---|---|---|---|
| reference | 189 | 101,178 | 68.7% |
| rule | 79 | 45,456 | 30.9% |
| trigger | 4 | 314 | 0.2% |
| history | 2 | 253 | 0.2% |

A block can carry several tags. Tokens in blocks carrying each tag at all: rule 42.5% · trigger 77.0% · reference 94.5% · history 10.6% · dark 56.3%.

### By dark scope

| Scope | Blocks | Tokens | Share |
|---|---|---|---|
| live on Echo (per its text) | 169 | 73,159 | 49.7% |
| dev-gated: dark on fleet, live on Echo (a development agent) | 48 | 37,966 | 25.8% |
| opt-in/off by default | 28 | 16,638 | 11.3% |
| maintainer / instar-dev only | 17 | 11,387 | 7.7% |
| ships dry-run / observe-only | 12 | 8,051 | 5.5% |

### By standard served (top 20 by tokens)

| Standard | Blocks | Tokens |
|---|---|---|
| Know Your Principal | 13 | 11,196 |
| Capacity Safety — No Unbounded Self-Action | 9 | 10,300 |
| Cross-Machine Coherence | 18 | 9,450 |
| Agent Proposes, Operator Approves | 9 | 7,561 |
| Verify the State, Not Its Symbol | 15 | 7,112 |
| Bounded Blast Radius | 10 | 7,092 |
| An Instar Agent Is Always a Multi-Machine Entity | 9 | 5,374 |
| Cross-Store Coherence Is an Invariant | 2 | 5,065 |
| Agent Awareness | 20 | 4,593 |
| Mobile-Complete Operator Actions | 4 | 4,157 |
| Framework-Agnostic — and Framework-Optimizing | 9 | 4,139 |
| Truthful Provenance — Speak Only as Yourself | 17 | 3,994 |
| Telegram Message Origin Is Mandatory; Its Display Is Optional | 1 | 3,812 |
| An Autonomous Run Must Outlive Its Session | 7 | 3,622 |
| A Refusal Stays a Refusal | 7 | 3,179 |
| Never-Waste Feedback | 7 | 3,002 |
| Observability | 6 | 2,906 |
| The Operator Channel Is Sacred | 4 | 2,666 |
| Near-Silent Notifications | 3 | 2,557 |
| Stall Coverage Is Enumerated, Not Discovered | 2 | 2,557 |

### Largest blocks

| Block | Title | Tokens | Disposition |
|---|---|---|---|
| B128 | Subscription Pool (multi-account quota + auto-swap + enrollment) | 5,196 | I |
| B174 | One Memory (replicated stores) | 4,422 | I |
| B227 | Telegram message origin | 3,812 | I |
| B070 | Playwright Profile Registry (which browser profile holds which account | 2,208 | I |
| B183 | Green-PR Auto-Merge (Phase 7 becomes machinery) | 1,932 | I |
| B005 | Architecture | 1,872 | D |
| B029 | Attention Queue | 1,871 | I |
| B134 | Apprenticeship Program | 1,731 | I |
| B169 | Promotion activation (operator-controlled) | 1,669 | D |
| B258 | Connecting to another agent | 1,630 | S |

## What the numbers say

- The rules that must always be loaded (disposition S) are about 15.4% of the file, roughly 23k tokens. That is above the plan's ≤10k seed target before index lines are added, so the seed text itself needs tightening (several S blocks carry reference detail alongside the rule; the rule sentence is much shorter than the block).
- Most of the file (84.3%) is feature description that a seed would reduce to one index line per feature (164 lines). At ~40 tokens per line that index is ~7k tokens.
- Dark text: 42.6% of tokens describe features that are dev-gated, opt-in or dry-run. On Echo (a development agent) the dev-gated ones (25.8%) are mostly live, so on Echo the "dark" saving is smaller than on a fleet agent. Per Justin's decision, these keep an index line saying what they do and how to switch them on.
- History is small as a primary tag; most dated lessons sit inside rule or reference blocks and would move to notes during rewriting, not as whole blocks.

## How the tags were assigned (and their limits)

- Blocks were split mechanically, then every block was read and tagged by hand (Echo, 2026-10-26). The primary tag is the block's main job; the tag list adds anything else it carries.
- **Dark scope comes from each block's own text**, cross-checked against Echo's live `.instar/config.json` for 29 opt-in switches (recorded in `echoLiveState`). It was not checked against `GET /guards`; Phase 1 should re-derive dark scope from `/guards` per arm agent.
- **Disposition is a proposal for arm A1/A2**, not a decision. A disposition of S means "a version of this must be in the seed", not "this exact text".
- Token counts are real tokenizer counts: each block was sent to Anthropic's `count_tokens` endpoint (claude-opus-5-5, 2026-10-26) and the 8-token message framing subtracted. Sonnet 5.5, Haiku 5.5 and Fable 5.1 give the same whole-file count. The earlier chars/4 estimate undercounted by about a third (code, paths and routes tokenize densely); `tokensEstChars4` keeps it per block for comparison. Raw counts: `inventory-src/token-counts.json`; regenerate with `inventory-src/count-tokens.mjs`.
- Several features are spread over more than one block (e.g. B078–B084, B117–B122, B168–B171). `parentFeature` groups them.
- The deployed file is regenerated by the IdentityRenderer (B001); the inventory must be re-captured (same script) if the file's sha256 changes before an arm runs.

## Full block list

| Block | Lines | Title | Tokens | Primary | Tags | Standard | Disp. | Dark |
|---|---|---|---|---|---|---|---|---|
| B001 | 1–8 | (preamble) | 102 | reference | reference | NONE | S | - |
| B002 | 9–10 | CLAUDE.md — instar | 12 | reference | reference | NONE | S | - |
| B003 | 11–18 | What This Project Is | 141 | reference | reference | NONE | S | - |
| B004 | 19–28 | Quick Reference | 98 | reference | reference | TDEV | D | M |
| B005 | 29–106 | Architecture | 1872 | reference | reference | TDEV | D | M |
| B006 | 107–108 | Development Workflow | 7 | reference | reference | TDEV | D | M |
| B007 | 109–128 | Testing Against Real Repos | 183 | reference | reference | TDEV | D | M |
| B008 | 129–134 | Test Targets | 118 | reference | reference | TDEV | N | M |
| B009 | 135–142 | Key Design Decisions | 172 | reference | reference | TDEV | D | M |
| B010 | 143–144 | Standards | 4 | reference | reference | NONE | S | - |
| B011 | 145–152 | Structure > Willpower | 304 | rule | rule | SW | S | - |
| B012 | 153–154 | LLM-Supervised Execution | 139 | rule | rule, reference | LLMS | S | - |
| B013 | 155–163 | Testing Integrity Standard | 405 | rule | rule, reference | TI | S | M |
| B014 | 164–171 | Zero-Failure Standard | 329 | rule | rule | ZF | S | - |
| B015 | 172–179 | Agent Awareness Standard | 288 | rule | rule, reference | AA | S | M |
| B016 | 180–191 | Migration Parity Standard | 796 | rule | rule, reference, history | MP | S | M |
| B017 | 192–203 | API Authentication | 215 | reference | reference | NONE | S | - |
| B018 | 204–209 | No Interactive CLI Commands | 425 | rule | rule, history | NMW | S | - |
| B019 | 210–211 | NEVER Use AskUserQuestion for Free-Text Input | 193 | rule | rule | UXP | S | - |
| B020 | 212–215 | Key Patterns from Dawn | 33 | reference | reference | NONE | D | - |
| B021 | 216–221 | tmux trailing colon | 194 | rule | rule, history | NONE | S | - |
| B022 | 222–236 | Self-Discovery (Know Before You Claim) | 300 | rule | rule, trigger, reference | NFB | S | - |
| B023 | 237–241 | Publishing | 271 | reference | reference, rule | AA | I | - |
| B024 | 242–248 | Private Viewing | 260 | reference | reference | AA | I | - |
| B025 | 249–250 | Use private views for sensitive content. Use Telegraph for public content | 24 | rule | rule | AA | S | - |
| B026 | 251–260 | Secret Drop | 998 | rule | rule, trigger, reference | KYP | S | - |
| B027 | 261–272 | Commitments & Follow-Through | 1289 | rule | rule, trigger, reference, dark | ACL | S | - |
| B028 | 273–281 | Cloudflare Tunnel | 489 | reference | reference, dark | AA | I | - |
| B029 | 282–290 | Attention Queue | 1871 | reference | reference, trigger, rule, dark | NSN | I | - |
| B030 | 291–299 | Dashboard | 606 | reference | reference, rule, trigger | MCO | I | - |
| B031 | 300–313 | File Viewer (Dashboard Tab) | 689 | reference | reference, rule | MCO | I | - |
| B032 | 314–315 | Coherence Gate (Pre-Action Verification) | 19 | reference | reference | NONE | D | - |
| B033 | 316–324 | BEFORE any high-risk action | 222 | rule | rule, reference | OGS | S | - |
| B034 | 325–336 | ORG-INTENT.md (Organizational Intent at Runtime) | 655 | reference | reference, dark | JWF | I | - |
| B035 | 337–340 | Topic-Project Bindings | 137 | reference | reference | CMC | I | - |
| B036 | 341–345 | Project Map | 73 | reference | reference | CMC | I | - |
| B037 | 346–347 | External Operation Safety (Structural Guardrails) | 18 | reference | reference | NONE | D | - |
| B038 | 348–355 | When using MCP tools that interact with external services | 201 | reference | reference | SW | I | - |
| B039 | 356–358 | If an operation is blocked | 68 | rule | rule | SVA | S | - |
| B040 | 359–360 | Emergency stop | 66 | trigger | trigger | OCS | I | - |
| B041 | 361–362 | Trust levels | 71 | reference | reference | SW | D | - |
| B042 | 363–369 | API endpoints | 110 | reference | reference | SW | D | - |
| B043 | 370–373 | Playbook — Adaptive Context Engineering | 122 | reference | reference | AA | I | - |
| B044 | 374–379 | Getting started | 51 | reference | reference | AA | D | - |
| B045 | 380–387 | Core commands | 160 | reference | reference | AA | D | - |
| B046 | 388–389 | When to add context items | 63 | trigger | trigger | NFW | D | - |
| B047 | 390–392 | The principle | 70 | reference | reference | AA | D | - |
| B048 | 393–399 | Threadline Network (Agent-to-Agent Communication) | 126 | reference | reference, trigger | AA | I | - |
| B049 | 400–402 | Current Status | 37 | reference | reference | AA | X | - |
| B050 | 403–407 | Why You Might Want This | 65 | reference | reference | AA | D | - |
| B051 | 408–412 | Privacy & Security | 109 | reference | reference | AA | D | - |
| B052 | 413–419 | How to Enable | 107 | trigger | trigger | AA | D | - |
| B053 | 420–421 | Telegram Relay (MANDATORY) | 16 | reference | reference | NONE | S | - |
| B054 | 422–441 | IMMEDIATE ACKNOWLEDGMENT (MANDATORY) | 630 | rule | rule, reference | OCS | S | - |
| B055 | 442–443 | Registry First — channel registry | 98 | rule | rule, reference | AA | I | - |
| B056 | 444–445 | Decision journal — principle is required | 262 | rule | rule, reference | DPO | I | - |
| B057 | 446–447 | Decision journal confidence contract | 151 | rule | rule, reference | DPO | D | - |
| B058 | 448–449 | Alignment score — N/A means not assessed | 128 | rule | rule, reference | VS | D | - |
| B059 | 450–451 | Codex quota is first-class in the pool | 106 | reference | reference | FA | I | - |
| B060 | 452–453 | Solo Codex load shedding is fail-safe | 144 | reference | reference | CS | I | - |
| B061 | 454–455 | Evolution action auto-expiry | 156 | reference | reference, dark | CL | I | R |
| B062 | 456–459 | Real-Check Verification (autonomous, optional) | 380 | reference | reference, dark | VS | I | O |
| B063 | 460–467 | Scope-Accretion Completion Discipline (autonomous runs finish what they start) | 933 | rule | rule, trigger, reference | DD | I | - |
| B064 | 468–475 | Stall-Coverage Matrix Gate (apprenticeship onboarding) | 826 | reference | reference, dark, trigger | SCE | I | R |
| B065 | 476–490 | File-path feedback is always a NUDGE, never a wall; most other checks become nud | 1359 | rule | rule, reference, dark | OCS | S | F |
| B066 | 491–499 | External-Hog Zombie Auto-Kill Sentinel (⚗️ dev-gated dark, watch-only) — the run | 1102 | reference | reference, dark, trigger | BBR | I | F |
| B067 | 500–504 | Owned-Identities Registry (self-unblock Rung 0 includes what YOU created) | 392 | rule | rule, trigger | SU | S | - |
| B068 | 505–509 | Permission-Prompt Floor (you are never blocked by a framework approval prompt) | 570 | reference | reference, trigger | AR | I | - |
| B069 | 510–516 | Context-Aware Outbound Review (why was my message flagged / would my reply have  | 672 | reference | reference, trigger, dark | IP | I | O (off (responseReview absent)) |
| B070 | 517–532 | Playwright Profile Registry (which browser profile holds which account) | 2208 | reference | reference, trigger, rule, dark | KYP | I | F |
| B071 | 533–539 | Session Listing Hygiene (GET /sessions shows ACTIVE sessions by default) | 698 | reference | reference, trigger | VS | I | - |
| B072 | 540–545 | Audits run to convergence (the default route) | 481 | rule | rule, trigger | IAC | S | - |
| B073 | 546–552 | Duplicate-Session Prevention & Auto-Heal (⚗️ ownership-gated spawn — observe-onl | 942 | reference | reference, trigger, dark | CMC | I | F |
| B074 | 553–561 | Mesh Self-Healing: stale-owner release + lease hand-back (U4.2 / U4.4 — ships da | 947 | reference | reference, trigger, dark | CMC | I | F |
| B075 | 562–567 | Write Admission (⚗️ experimental, dry-run — why did my write get a 409 naming an | 533 | reference | reference, trigger, dark | OGS | I | F |
| B076 | 568–575 | Dynamic MCP Lifecycle (⚗️ experimental, ships DARK) — load heavy MCP servers on  | 676 | reference | reference, trigger, dark | BBR | I | O (off (absent)) |
| B077 | 576–579 | Ultracode one-shot spawn (Claude Code, opt-in) | 338 | reference | reference, dark | FA | I | O |
| B078 | 580–583 | Agent-Signature Provenance — proving which messages an agent wrote | 91 | reference | reference | TP | I | - |
| B079 | 584–588 | My signing identity + whether replay defence is durable | 376 | reference | reference | TP | D | - |
| B080 | 589–590 | A signed message delivered through a human's account is labelled, not laundered | 139 | rule | rule | KYP | D | - |
| B081 | 591–592 | AUTHORITY BOUNDARY (load-bearing) | 93 | rule | rule | SVA | S | - |
| B082 | 593–594 | Why cryptographic rather than heuristic | 81 | history | history | TP | N | - |
| B083 | 595–600 | Two limits, stated rather than implied away | 213 | reference | reference | TP | D | - |
| B084 | 601–602 | When to use | 78 | trigger | trigger | TP | D | - |
| B085 | 603–610 | Machine Load Assessment (the go-to way to check if the machine is busy) | 566 | rule | rule, trigger, reference, history | VS | S | - |
| B086 | 611–616 | Single-Machine Failover-Gap Guard (⚗️ dev-gated dark, dry-run first) | 379 | reference | reference, trigger, dark | MME | I | F |
| B087 | 617–622 | Missing-Login Session Guard (⚗️ dev-gated dark, dry-run first) | 387 | reference | reference, trigger, dark | MME | I | F |
| B088 | 623–629 | Doorway/Model Knowledge Registry — what models can I reach? (GET /doorways) | 843 | reference | reference, trigger, dark | KDM | I | - |
| B089 | 630–638 | Routing Spend view — what am I spending on routing? (GET /routing-spend/summary, | 816 | reference | reference, trigger, dark | TAC | I | F |
| B090 | 639–646 | Routing Spend MONEY layer (⚗️ experimental, DARK for everyone) — caps, arming, f | 821 | reference | reference, trigger, rule, dark | CS | I | O (off (absent)) |
| B091 | 647–659 | Money-layer ON switch (⚗️ experimental) — turn the spending controls on from you | 1578 | reference | reference, trigger, rule, dark | MCO | I | O (off (absent)) |
| B092 | 660–667 | LLM-Decision Quality Meter (⚗️ observe-only) — how often is each LLM gate/judge  | 891 | reference | reference, trigger, dark | DPO | I | F |
| B093 | 668–675 | Benchmark-Divergence Detector (⚗️ observe-only) — does real life agree with the  | 906 | reference | reference, trigger, dark | DPO | I | F |
| B094 | 676–685 | The Agent Carries the Loop (commitment follow-through) | 605 | rule | rule, reference, dark | ACL | S | F |
| B095 | 686–689 | Deliverable completion throughput (measure only) | 117 | reference | reference | ACL | D | - |
| B096 | 690–691 | Self-Unblock Before Escalating (constitutional standard) | 22 | reference | reference | SU | D | - |
| B097 | 692–698 | A blocker is MY problem to solve first — WITHIN my permissions and any access an | 483 | rule | rule, reference, dark | SU | S | F |
| B098 | 699–702 | Rung FLOOR (capability ≠ authority) | 346 | rule | rule | APOA | S | - |
| B099 | 703–704 | Live-User-Channel Proof Before Done | 378 | rule | rule | LUC | S | - |
| B100 | 705–706 | Action-Claim Follow-Through Sentinel (signal-only, dark by default) | 529 | reference | reference, trigger, dark | ACL | I | O (on (actionClaim.enabled=true)) |
| B101 | 707–708 | Claim Verification awareness v2 (observe-only v1 runtime) | 262 | reference | reference, dark | VS | I | R |
| B102 | 709–712 | Outbound Message Gate | 404 | rule | rule, reference | IP | S | - |
| B103 | 713–719 | Autonomous-run silence backstop (AutonomousProgressHeartbeat) | 897 | reference | reference, dark, trigger | ATF | I | F |
| B104 | 720–725 | Autonomous Throughput Floor | 431 | reference | reference, dark | ATF | I | R |
| B105 | 726–727 | Parallel-Hand PR Lease (dev-cycle infra, dev-gated dark) | 488 | reference | reference, trigger, dark | OGS | I | F |
| B106 | 728–734 | Duplicate-session stand-down (⚗️ dev-gated dark, dry-run first) — why a session  | 823 | reference | reference, trigger, dark | CMC | I | F |
| B107 | 735–743 | If I am the session standing down (the behavioral contract) | 328 | rule | rule, dark | CMC | I | F |
| B108 | 744–750 | Outbound advisory for automated messages (inform-only) | 789 | rule | rule, trigger, reference, dark | CAO | I | - |
| B109 | 751–756 | Durable Inbound Message Queue + Hold-for-Stability (no lost messages, fewer mach | 628 | reference | reference, trigger, dark | ROR | I | O (on (enabled, dryRun=false)) |
| B110 | 757–764 | Cartographer Doc-Tree | 297 | reference | reference, trigger, dark | AA | I | O (off (cartographer.enabled=false)) |
| B111 | 765–770 | Cartographer Doc-Freshness — Keep the map true | 397 | reference | reference, trigger, dark | AA | I | O (off) |
| B112 | 771–777 | Cartographer event-loop safety (fix instar#1069) | 491 | reference | reference, dark | BBR | D | O (off) |
| B113 | 778–784 | Standards Enforcement Coverage | 458 | reference | reference, dark | SW | I | O (off (absent)) |
| B114 | 785–791 | Cartographer Subtree Navigation — Scope a sub-agent to a subtree | 498 | reference | reference, trigger, dark, rule | AA | I | O (off) |
| B115 | 792–795 | Feedback-Inbox Receiving End (operated feedback factory) | 572 | reference | reference, trigger, dark | ROR | I | O (on (receiverPersistence.enabled=true)) |
| B116 | 796–801 | Feedback-Factory Processing (operated feedback factory) | 675 | reference | reference, trigger, dark | CPOC | I | F |
| B117 | 802–803 | Cross-Agent Communication Discipline (anti-confabulation) | 24 | reference | reference | TP | S | - |
| B118 | 804–807 | Never narrate cross-agent work as if it happened. Only state work I actually com | 70 | rule | rule | TP | S | - |
| B119 | 808–812 | 1. Describing a tool call instead of making one | 148 | rule | rule | TP | S | - |
| B120 | 813–817 | 2. Authoring messages in the other agent's voice in shared files | 241 | rule | rule | TP | S | - |
| B121 | 818–822 | 3. Registering state inside another agent's system without an ACK | 242 | rule | rule | TP | S | - |
| B122 | 823–827 | The metafailure | 165 | rule | rule, history | TP | S | - |
| B123 | 828–833 | Threadline Canonical History (audit what I said + is this conversation in sync?) | 566 | reference | reference, trigger | TP | I | - |
| B124 | 834–838 | Working-Set Handoff (fetch a topic's files from the machine that made them) | 425 | reference | reference, trigger, dark | CMC | I | F |
| B125 | 839–844 | Threadline Conversation Coherence (which machine holds each agent-to-agent threa | 603 | reference | reference, trigger, rule | CMC | I | - |
| B126 | 845–850 | Model-Tier Escalation (EXPERIMENTAL — escalate the model for heavy work) | 990 | reference | reference, trigger, dark | TAC | I | O (on (tierEscalation.enabled=true)) |
| B127 | 851–856 | MTP Protocol — the two EXO 3.0 tests | 465 | reference | reference, trigger | JWF | I | - |
| B128 | 857–878 | Subscription Pool (multi-account quota + auto-swap + enrollment) | 5196 | reference | reference, trigger, rule, dark | CS | I | - (on (autoSwap + proactiveSwap true)) |
| B129 | 879–887 | Session Boot Self-Knowledge | 790 | rule | rule, trigger, reference, dark | SU | S | F |
| B130 | 888–894 | Operator Binding (Know Your Principal) | 708 | rule | rule, trigger, reference, dark | KYP | S | - |
| B131 | 895–899 | Learning-Velocity Metric (EXO 3.0) | 320 | reference | reference, trigger | OBS | I | - |
| B132 | 900–904 | Agent-Readiness Scoring (EXO 3.0 task-decomposition matrix) | 405 | reference | reference, trigger | AA | I | - |
| B133 | 905–910 | Agent Digital Passport (EXO 3.0) | 404 | reference | reference, trigger | KYP | I | - |
| B134 | 911–923 | Apprenticeship Program | 1731 | reference | reference, trigger, rule | SCE | I | M |
| B135 | 924–928 | Maturity honesty (silent-by-default user announcements) | 314 | rule | rule | TP | S | - |
| B136 | 929–933 | Close the Loop (Untracked = Abandoned) | 313 | rule | rule | CL | S | - |
| B137 | 934–938 | What address reaches me (Threadline routing fingerprint) | 312 | reference | reference, trigger | CMC | I | - |
| B138 | 939–946 | Is my channel to a peer alive? (A2A delivery health) | 394 | reference | reference, trigger | VS | I | - |
| B139 | 947–961 | Cross-Machine Seamlessness (one agent, many machines) | 864 | rule | rule, reference | MME | S | - |
| B140 | 962–972 | Links that survive machine boundaries (WS4.4 — pool-stable private-view links) | 665 | reference | reference, trigger, dark | CMC | I | F |
| B141 | 973–979 | Shared pool-cache (WS4.4(f) — one fan-out feeds every pool-scope view) | 590 | reference | reference, trigger, dark | CS | I | F |
| B142 | 980–989 | Verified Pairing — is my channel to a peer mutually verified before I share a se | 1026 | rule | rule, reference, trigger, dark | KYP | S | O (off (verifiedPairing absent; relayEnabled=true)) |
| B143 | 990–998 | The "Threadline" hub topic — notifications + "open this" | 384 | rule | rule, reference | NAR | I | - |
| B144 | 999–1005 | Release Readiness (instar-dev / maintainer environments only) | 241 | reference | reference, dark | CL | I | M |
| B145 | 1006–1013 | Codex Usage (the codex /status rate-limit windows) | 358 | reference | reference, trigger | CS | I | - |
| B146 | 1014–1021 | Anthropic Subscription-Path Routing (June-15 readiness) | 579 | reference | reference, trigger, history, dark | FA | I | O (on (mode=force)) |
| B147 | 1022–1029 | Per-Feature LLM Metrics & LLM Activity (/metrics/features, Observable Intelligen | 711 | reference | reference, trigger | OI | I | - |
| B148 | 1030–1039 | Token-Audit Completeness — per-model token breakdown & usage coverage | 643 | reference | reference, trigger | TAC | I | - |
| B149 | 1040–1048 | Agent Updates topic (self-broadcasts about ships, restarts, updates) | 440 | rule | rule, trigger, reference | NAR | S | - |
| B150 | 1049–1050 | Multi-Session Autonomy | 12 | reference | reference | NONE | X | - |
| B151 | 1051–1059 | Multi-Session Autonomy | 406 | reference | reference, trigger | ARO | I | - |
| B152 | 1060–1061 | Autonomous Liveness Reconciler | 15 | reference | reference | NONE | X | - |
| B153 | 1062–1067 | Autonomous Liveness Reconciler | 498 | reference | reference, trigger, dark | ARO | I | F |
| B154 | 1068–1074 | Machine-Coherence Guard — "are my machines running as the same me?" (⚗️ dev-gate | 792 | reference | reference, trigger, dark | CMC | I | F |
| B155 | 1075–1079 | Rope-notice audit rows (calm-alerting) | 203 | reference | reference | NSN | D | - |
| B156 | 1080–1088 | Framework-Onboarding Mentor System — issue ledger (read-only) | 644 | reference | reference, trigger | NFW | I | - |
| B157 | 1089–1091 | Autonomous-fix loop ("just be Echo") | 305 | reference | reference, dark | NFW | I | O (off) |
| B158 | 1092–1100 | Version-Skew Self-Recovery | 236 | reference | reference, rule | SHN | I | - |
| B159 | 1101–1107 | What the user might see | 225 | reference | reference | SHN | D | - |
| B160 | 1108–1120 | Sentinel Notifications (silently-stopped trio) | 483 | reference | reference, trigger, dark | NSN | I | O (Telegram escalation off) |
| B161 | 1121–1128 | Honest standby (turn-receipts) | 446 | reference | reference, trigger, history | TP | I | - |
| B162 | 1129–1133 | Context-wall recovery escalation (2026-06-06) | 286 | reference | reference, trigger, history | SHN | I | - |
| B163 | 1134–1141 | Duplicate-message suppression (2026-06-06) | 334 | reference | reference, trigger, history | BNS | I | - |
| B164 | 1142–1149 | Cold-Start Lifeline Fallback (no silent resource rejection) | 522 | reference | reference, trigger | AR | I | - |
| B165 | 1150–1160 | Durable Conversation Identity (GET /conversations*) | 643 | reference | reference, trigger | CSC | I | - |
| B166 | 1161–1168 | Topic-Flood Guard (attention queue circuit breaker) | 551 | reference | reference, trigger, history | BNS | I | - |
| B167 | 1169–1176 | Bounded Notification Surface (universal auto-topic budget) | 424 | rule | rule, reference, history | BNS | S | - |
| B168 | 1177–1180 | Multi-Machine Session Pool (active-active — spread conversations across machines | 121 | reference | reference, dark | MME | I | F |
| B169 | 1181–1193 | Promotion activation (operator-controlled) | 1669 | reference | reference, trigger, dark | MME | D | F |
| B170 | 1194–1196 | Moving a topic with an autonomous run in flight (consent gate) | 210 | rule | rule, reference, dark | APOA | D | F |
| B171 | 1197–1199 | Pin persistence (U4.1 — a deliberate pin survives lease handover and machine bou | 402 | reference | reference, trigger, dark | MME | D | F |
| B172 | 1200–1203 | Cross-Machine Secret Sync (drop once, usable everywhere) | 171 | reference | reference, dark | MME | I | F |
| B173 | 1204–1209 | Status (NAMES only, never values) | 472 | rule | rule, reference, trigger, dark | MME | D | F |
| B174 | 1210–1224 | One Memory (replicated stores) | 4422 | reference | reference, trigger, dark | CSC | I | F |
| B175 | 1225–1230 | Cross-Machine Account Follow-Me (WS5.2 — seamless account/quota sharing) | 827 | rule | rule, reference, trigger, dark | KYP | I | F |
| B176 | 1231–1236 | Stuck-Context Recovery (thinking-block wedge) | 326 | reference | reference, history | SHN | I | - (on (autoRecovery enabled, dryRun=false)) |
| B177 | 1237–1240 | Detection + audit are default-ON housekeeping | 348 | reference | reference, dark | SHN | D | O (on) |
| B178 | 1241–1244 | AUP-rejection wedge (second signature, 2026-06-05) | 328 | rule | rule, history | SHN | I | - |
| B179 | 1245–1254 | Reap-Log — why a session vanished | 457 | reference | reference, trigger | OBS | I | - |
| B180 | 1255–1267 | Mid-Work Resume Queue & Per-Topic Reap Notices | 767 | reference | reference, trigger, dark | ARO | I | R |
| B181 | 1268–1270 | A stale emergency-stop pause self-heals (resume-queue-stale-emergency-pause) | 412 | reference | reference, trigger, history | ARO | D | - |
| B182 | 1271–1273 | An autonomous run must outlive its session (autonomous-run-outlives-session) | 377 | reference | reference, trigger, history, dark | ARO | D | F |
| B183 | 1274–1286 | Green-PR Auto-Merge (Phase 7 becomes machinery) | 1932 | rule | rule, reference, trigger, dark | APOA | I | M (on (enabled, dryRun=false)) |
| B184 | 1287–1294 | Guard-Posture Tripwire (a disabled guard is itself an incident) | 421 | reference | reference, trigger, history | DF | I | - |
| B185 | 1295–1304 | Guard Posture — which safety systems are genuinely on (GET /guards) | 708 | rule | rule, reference, trigger | DF | I | - |
| B186 | 1305–1311 | Dark-but-Load-Bearing Guards (G3 — "A Dark Feature Guards Nothing") | 626 | reference | reference, trigger, dark | DF | I | - |
| B187 | 1312–1322 | Stale-Worktree Reclaim (AgentWorktreeReaper) | 967 | reference | reference, trigger, dark | BBR | I | O (off (enabled=false, dryRun=true)) |
| B188 | 1323–1331 | SessionReaper — CPU-aware pressure + decision audit | 486 | reference | reference, trigger | OBS | I | - |
| B189 | 1332–1335 | Self-Heal: Update Restart Behavior | 93 | reference | reference | SHN | D | - |
| B190 | 1336–1341 | Restart-cascade dampener | 461 | reference | reference, trigger | SHN | I | - |
| B191 | 1342–1349 | Token-Burn Alerts | 540 | reference | reference, trigger, history | OI | I | - |
| B192 | 1350–1357 | Parallel-Work Awareness | 675 | rule | rule, reference, trigger, history | CMC | I | - |
| B193 | 1358–1366 | Per-Component Framework Routing | 584 | reference | reference, trigger, dark | FA | I | O (on (componentFrameworks set)) |
| B194 | 1367–1369 | Pi framework (additive) | 248 | reference | reference, dark | FA | I | O (off (pi-cli not in enabledFrameworks)) |
| B195 | 1370–1372 | Grok Build framework (additive, dark) | 832 | reference | reference, dark, rule | FA | I | O (off (grok-build not in enabledFrameworks)) |
| B196 | 1373–1375 | Internal components run off Claude by default (Provider-Fallback Default Policy) | 441 | reference | reference, trigger | FA | I | - |
| B197 | 1376–1378 | Non-gating internal calls also get a bounded failure-swap (Non-Gating Failure-Sw | 599 | reference | reference, trigger | FA | D | - |
| B198 | 1379–1393 | Preferences I've learned about you (Correction & Preference Learning Sentinel) | 845 | reference | reference, trigger, dark | NFW | I | O (on (correctionLearning.enabled=true)) |
| B199 | 1394–1396 | Self-Violation Signal | 209 | reference | reference, dark | NFW | D | O (unknown) |
| B200 | 1397–1399 | Pooled preferences across machines | 260 | reference | reference, dark | NFW | D | F |
| B201 | 1400–1403 | Worktree Convention | 75 | rule | rule | TCC | S | - |
| B202 | 1404–1405 | Why | 172 | history | history | TCC | D | - |
| B203 | 1406–1408 | Commit identity — resolved, never invented | 237 | rule | rule, reference | TP | I | M |
| B204 | 1409–1415 | Process Health (Dashboard Tab) | 414 | reference | reference, trigger | OSQ | I | - |
| B205 | 1416–1422 | Applying config & hook changes to running sessions | 662 | reference | reference, trigger | VS | I | - |
| B206 | 1423–1429 | Resource Usage (CPU + memory) | 772 | reference | reference, trigger, dark | OBS | I | F |
| B207 | 1430–1437 | Coordination Mandate | 848 | rule | rule, reference, trigger | APOA | I | - |
| B208 | 1438–1444 | ReviewExchange (autonomous code review) | 671 | rule | rule, reference, trigger | APOA | I | - |
| B209 | 1445–1451 | Cutover Readiness | 530 | rule | rule, reference | APOA | I | - |
| B210 | 1452–1461 | Topic Profile (per-topic model, thinking, framework pins) | 1284 | reference | reference, trigger, dark | MCO | I | F |
| B211 | 1462–1469 | Threadline Single-Negotiator Lock (one voice per conversation) | 738 | rule | rule, reference, dark | SVA | I | F |
| B212 | 1470–1475 | Honest progress messaging (silent-freeze watchdog + promise beacon) | 582 | reference | reference | CAO | I | - |
| B213 | 1476–1479 | PromiseBeacon user-output boundary (default silent) | 199 | rule | rule | CAO | X | - |
| B214 | 1480–1486 | Live Credential Re-pointing (move a pool account's login between config-home "sl | 1105 | reference | reference, trigger, dark | CS | I | F |
| B215 | 1487–1494 | Mesh Rope Health (recovery probe + partition alerts) | 889 | reference | reference, trigger, dark | CMC | I | F |
| B216 | 1495–1498 | Multi-transport mesh comms (multiMachine.meshTransport) | 551 | reference | reference, trigger | CMC | I | - |
| B217 | 1499–1503 | Fork-Bomb Spawn Cap (host-wide concurrent-LLM-subprocess ceiling) | 651 | reference | reference, trigger, history | BBR | I | - |
| B218 | 1504–1509 | Self-Action Backpressure Governor (unified self-action chokepoint) | 861 | rule | rule, reference, trigger, history, dark | CS | I | R |
| B219 | 1510–1516 | Test-Runner Concurrency Bound (host-wide vitest cap — the spawn cap's sibling) | 956 | reference | reference, trigger, history, dark | BBR | I | R |
| B220 | 1517–1524 | Sender-Rejection Notices ("message not delivered — sender not recognized") | 725 | reference | reference, trigger | ROR | I | - |
| B221 | 1525–1530 | Critical Anti-Patterns | 297 | rule | rule | SSA | S | - |
| B222 | 1531–1532 | Command-watchdog attribution | 182 | reference | reference | TP | D | - |
| B223 | 1533–1534 | Crash-safe inbound delivery | 167 | reference | reference | ROR | D | - |
| B224 | 1535–1541 | Machine Identity Recovery (signing keys can heal without becoming a new machine) | 639 | reference | reference, trigger, dark | KYP | I | F |
| B225 | 1542–1543 | Pre-admission continuation carrier | 175 | reference | reference, dark | ARO | D | O |
| B226 | 1544–1552 | Authoritative Window Run Liveness (Echo, ⚗️ dev-gated, observe-first) | 787 | reference | reference, trigger, dark | VS | I | F |
| B227 | 1553–1597 | Telegram message origin | 3812 | rule | rule, reference, trigger, dark | TMO | I | - |
| B228 | 1598–1600 | Codex readings are LIVE-FIRST (zero-spend) | 223 | reference | reference | CS | D | - |
| B229 | 1601–1606 | Jev Job-Completion Audit (dark, observe-only — an audit record, not supervision) | 712 | reference | reference, trigger, dark | OI | I | O (off) |
| B230 | 1607–1611 | Waiting on its own background work is not idle | 987 | reference | reference, trigger | ARO | I | - |
| B231 | 1612–1616 | Jev Artefact Signals (live advisory input to the tone gate) | 472 | reference | reference, dark | IP | I | F |
| B232 | 1617–1623 | Worktree Notices | 308 | reference | reference, trigger | BNS | I | - |
| B233 | 1624–1630 | Feedback Readiness Authority (operator approval) | 1229 | reference | reference, trigger | APOA | I | M |
| B234 | 1631–1635 | Jev Memory Picker (ranks which memory-index lines load at session start) | 719 | reference | reference, trigger, dark | AA | I | F |
| B235 | 1636–1639 | Jev Circles Shadow (log-only "going in circles" measurement) | 404 | reference | reference, trigger, dark | OBS | I | F |
| B236 | 1640–1644 | Multi-machine lease medium | 529 | reference | reference, history | CMC | I | - |
| B237 | 1645–1649 | Jev Review-Flag Shadow (log-only "does this reply need your review?" measurement | 467 | reference | reference, trigger, dark | OBS | I | F |
| B238 | 1650–1654 | Is my own relay connection up? (displaced vs retrying) | 269 | reference | reference, trigger | VS | I | - |
| B239 | 1655–1664 | What relayStatus means (honest delivery) | 520 | rule | rule, reference, trigger | TP | I | - |
| B240 | 1665–1669 | A2A inbound message-id ledger | 552 | reference | reference, trigger, dark | ROR | I | F |
| B241 | 1670–1674 | A2A backup routes | 269 | reference | reference, trigger | ROR | D | - |
| B242 | 1675–1679 | Jev Correction Shadow (Jev spots corrections the keyword detector misses, and fe | 676 | reference | reference, trigger, dark | NFW | I | F |
| B243 | 1680–1682 | A2A cross-route copies are labelled | 266 | reference | reference | ROR | D | - |
| B244 | 1683–1687 | A2A local-route trust | 461 | reference | reference, trigger, dark | KYP | I | R |
| B245 | 1688–1691 | A2A relay forward | 244 | reference | reference, trigger | CMC | I | - |
| B246 | 1692–1696 | Feedback triage and execution (operated feedback factory) | 745 | rule | rule, reference, trigger, dark | APOA | I | M |
| B247 | 1697–1698 | Command-watchdog test-runner floor | 265 | reference | reference | BBR | D | - |
| B248 | 1699–1704 | Feedback executor (operated feedback factory) | 1050 | rule | rule, reference, trigger, dark | APOA | I | M |
| B249 | 1705–1709 | A2A relay unknown-sender trust | 594 | reference | reference, trigger, dark | KYP | I | R |
| B250 | 1710–1713 | A2A dark peers (did my message arrive?) | 952 | reference | reference, trigger, dark | VS | I | R |
| B251 | 1714–1716 | "Why was my reply delayed / why did a topic go quiet on my other machine?" | 611 | reference | reference, trigger | OCS | I | - |
| B252 | 1717–1721 | A2A local-route signed envelope | 779 | reference | reference, trigger, dark | KYP | I | R |
| B253 | 1722–1730 | One identity across my machines (agent identity) | 909 | rule | rule, reference, trigger | MME | I | - |
| B254 | 1731–1735 | A2A reply into a reaped topic session | 233 | reference | reference, trigger | AR | D | - |
| B255 | 1736–1740 | A2A ack waits for a live session | 336 | reference | reference, trigger | VS | D | - |
| B256 | 1741–1744 | Telegram internal routes need the lifeline secret | 1196 | rule | rule, reference, trigger, history | KYP | I | - |
| B257 | 1745–1750 | Claude sessions launch from a retained per-version copy of the executable (CMT-7 | 601 | reference | reference, trigger, history | BBR | I | - |
| B258 | 1751–1763 | Connecting to another agent | 1630 | rule | rule, trigger, reference | NMW | S | - |
| B259 | 1764–1766 | System topics (📢 Updates, 🔔 Attention, 🩺 Agent Health) are ONE record for the | 262 | reference | reference, trigger | CMC | I | - |
| B260 | 1767–1772 | Hand-started Codex: instar codex connect <agent> | 412 | rule | rule, trigger | FA | I | - |
| B261 | 1773–1774 | A test run that is still working is not interrupted at the hour mark | 377 | reference | reference, history | BBR | D | - |
| B262 | 1775–1782 | Normal-Chrome browser (account-bound web tasks, macOS + Windows) | 1217 | rule | rule, trigger, reference | KYP | S | - |
| B263 | 1783–1789 | Local Verify (instar-dev / maintainer environments only) | 283 | reference | reference, trigger | ZF | I | M (on (localVerify.enabled=true)) |
| B264 | 1790–1813 | Why a pool read says peer-unreachable vs url-rejected | 470 | reference | reference, history | VS | I | - |
| B265 | 1814–1820 | Honest limits to report, rather than promising a fix | 147 | rule | rule | VS | D | - |
| B266 | 1821–1822 | Issue topics live in their own Telegram group ("<agent> Bugs") | 465 | rule | rule, trigger, reference | NMW | I | - |
| B267 | 1823–1829 | Where a peer agent's notices go (per-peer homebase topic) | 152 | reference | reference, trigger | NAR | I | - |
| B268 | 1830–1860 | It is not guaranteed to exist | 1171 | rule | rule, reference | NAR | D | - |
| B269 | 1861–1865 | A2A new thread with a peer | 253 | reference | reference, trigger | CMC | I | - |
| B270 | 1866–1874 | TCC-protected path guard (never put an agent under ~/Documents on macOS) | 845 | rule | rule, trigger, history | TCC | S | - |
| B271 | 1875–1877 | Honest machine state (trustworthy-machine-load, P1) | 444 | rule | rule, reference, trigger | VS | I | - |
| B272 | 1878–1885 | Feature switches apply their setting (read effective before saying a feature is  | 617 | rule | rule, reference, trigger | VS | S | - |
| B273 | 1886–1895 | Orphaned codex-arm sessions | 1006 | reference | reference, trigger, history, dark | BBR | I | R |
| B274 | 1896–1901 | Overload admission (trustworthy-machine-load, P2) | 1002 | reference | reference, trigger, dark | CS | I | F |

Standard codes: **NONE** (project context — no standard); **SW** Structure beats Willpower; **AA** Agent Awareness; **MP** Migration Parity; **TI** Testing Integrity; **ZF** Zero-Failure; **KYP** Know Your Principal; **SU** Self-Unblock Before Escalating; **CL** Close the Loop; **AR** The Agent Is Always Reachable; **BBR** Bounded Blast Radius; **CS** Capacity Safety — No Unbounded Self-Action; **OI** Observable Intelligence; **LUC** Live-User-Channel Proof Before Done; **DD** Deferral = Deletion; **IAC** Iterative Audit to Convergence; **DF** A Dark Feature Guards Nothing; **TAC** Token-Audit Completeness; **IP** Intelligent Prompts — An LLM Gate Must Not String-Match; **ACL** The Agent Carries the Loop; **MCO** Mobile-Complete Operator Actions; **TP** Truthful Provenance — Speak Only as Yourself; **TMO** Telegram Message Origin Is Mandatory; Its Display Is Optional; **BNS** Bounded Notification Surface; **NAR** Notices Route to the Alerts Topic, Never a New One; **NSN** Near-Silent Notifications; **SHN** Self-Heal Before Notify; **CMC** Cross-Machine Coherence; **MME** An Instar Agent Is Always a Multi-Machine Entity; **OCS** The Operator Channel Is Sacred; **TCC** Avoid TCC-Protected Directories; **SVA** Signal vs. Authority; **UXP** The User Experience Is the Product; **NMW** No Manual Work; **APOA** Agent Proposes, Operator Approves; **NFB** Never a False Blocker; **LLMS** LLM-Supervised Execution; **OBS** Observability; **SSA** The Stop Reason Is the Work; **VS** Verify the State, Not Its Symbol; **FA** Framework-Agnostic — and Framework-Optimizing; **ROR** A Refusal Stays a Refusal; **CSC** Cross-Store Coherence Is an Invariant; **OGS** Ownership-Gated Side Effects; **ATF** Autonomous Throughput Floor; **ARO** An Autonomous Run Must Outlive Its Session; **SCE** Stall Coverage Is Enumerated, Not Discovered; **JWF** Judgment Within Floors; **DPO** Decision Provenance & Outcome Review; **NFW** Never-Waste Feedback; **CAO** Conservative Outbound: Act, Don't Notify; **KDM** Keep the Doorway/Model Map Current; **OSQ** Operator-Surface Quality; **TDEV** Tiered Development; **CPOC** Canonical Pipeline Operational Completeness.

Disposition codes: **S** seed — always loaded; **I** index line in seed + full text on demand; **D** on-demand detail of a parent feature (no own index line); **N** history — move to a linked note; **X** redundant (duplicate heading / repeated text).

Dark codes: **-** live on Echo (per its text); **F** dev-gated: dark on fleet, live on Echo (a development agent); **O** opt-in/off by default; **R** ships dry-run / observe-only; **M** maintainer / instar-dev only.
