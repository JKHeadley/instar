# The AI-Employee Roadmap — apprenticeship as the proving ground

**Status:** program roadmap (living document). **Owner:** the instar development
agent + operator. **Origin:** operator directive 2026-07-18 (topic 29723).

## The goal, stated plainly

Instar's top-level goal is an agent that works as a **fully engaged, fully
empowered AI employee** for its organization. Concretely, an AI employee:

1. **Operates across multiple machines (3–4)** as ONE coherent identity —
   conversations, memory, credentials, and work follow the person being served,
   not the box the agent happens to run on.
2. **Has full first-class chat-platform citizenship** — today Telegram, next
   **Slack as the primary workplace surface** — with behaviors matching a human
   coworker: responds in threads, respects channels, DMs appropriately, never
   floods, is reachable, and is honest about what it's doing.
3. **Serves multiple principals seamlessly** — every staff member of the
   organization gets the same agent, with per-principal identity resolution,
   permissions, preferences, and operator-binding (Know Your Principal) — no
   identity bleed, no confused authority.

## The method: prove it on the apprentice first

The apprenticeship program (docs/specs/APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC.md
and successors) exists to develop and de-risk exactly these capabilities on a
**prototype agent under observation** — the mentee — before the production
agent carries them for real users. The mentor experiences the mentee **through
the same user channels a human would use** (this is structural: mentor→mentee
communication rides user channels — Telegram now, Slack next — never
side-channels), so every UX incoherence is discovered by an agent, not by a
human user.

The ladder, mapped onto the three employee capabilities:

### Capability A — multi-machine coherence
- **A1 (now):** mentee runs on one machine; mentor exercises cross-machine
  reach-through (remote-hands, working-set fetch) between its own machines.
- **A2:** mentee joins a second machine; the multi-machine test plan
  (lease, transfer, duplicate-session prevention, owner-dark honesty) runs as
  the mentee's own workstream, with defects filed to the framework-issues
  ledger and fixed upstream in instar.
- **A3:** sustained two-machine operation with zero duplicate-session
  incidents and verified conversation-coherent transfers over a full week.
- **A4:** third/fourth machine; quota-aware placement and account follow-me
  proven under real load.
- **Exit bar:** the stall-coverage matrix + duplicate-session reconciler +
  transfer consent gates all live (not dark) on the mentee, with a clean
  incident ledger over the soak window.

### Capability B — first-class Slack citizenship
- **B1:** mentee reachable on Slack (adapter live, identity resolution,
  formatting parity with Telegram — the SlackMrkdwnFormatter path).
- **B2:** human-employee behaviors verified by the user-role live-test harness
  (Live-User-Channel Proof Before Done): threads, channel etiquette,
  DM-vs-channel judgment, silence discipline, honest liveness.
- **B3:** mentor directs the mentee primarily over Slack (the dogfooding
  surface shifts), Telegram becomes secondary.
- **Exit bar:** the full risk-category scenario matrix (happy-path, parity,
  lifecycle, permission, failure/rollback, concurrency, idempotency,
  regression) passes on the REAL Slack surface, live, before any production
  agent inherits the configuration.

### Capability C — multi-principal service
- **C1:** two registered principals with distinct permissions and
  operator-bindings on the mentee; per-principal preference isolation.
- **C2:** cross-principal coherence guards (the principal-coherence observer,
  credential scoping, per-topic verified-operator bindings) graduated from
  observe-only to enforcing on the mentee.
- **C3:** sustained two-principal operation — parallel topics, conflicting
  priorities, per-principal tone — with zero identity-bleed incidents.
- **Exit bar:** an incident-free multi-week soak serving two real principals,
  with the guards live and the audit trails clean.

## Sequencing and the graduation moment

Capabilities are developed in parallel workstreams on the mentee (the parallel
multi-topic direction of the mentee is itself the stress test for capability A
and the throughput model), but **graduation is serial and evidence-gated**:
each capability's exit bar is a recorded, artifact-backed acceptance — never a
vibe. When all three bars are green on the prototype, the production agent's
upgrade is a **configuration inheritance + staged enable**, not a rebuild: the
same instar version, the same guards (already graduated from dark to live on
the mentee), the same test harnesses re-run against the production surfaces.

The apprenticeship's defect discipline is the engine the whole way: every
failure gets the three root-gap questions (what infrastructure is lacking; is
a sentinel failing or missing; what standard would have prevented it), and the
answers land as instar standards and code — so the production agent inherits a
platform hardened by the prototype's tuition, not a list of workarounds.

## What this document is not

Not a schedule (the drive sessions own sequencing day to day), not a spec
(each capability's machinery has its own converged specs), and not
organization-specific (the operating organization's agent names, staffing, and
rollout order live with the operator, outside this repo).
