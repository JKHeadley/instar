# Operator-Identity Binding + Cross-Principal Coherence Guard — Spec

**Status:** SPEC — security/coherency fix design. Origin: the "Caroline" identity-bleed incident (2026-06-05, topic 19437).

## The incident this fixes

On a shared machine (the Mac Mini) running multiple agents — Echo plus an agent that manages a *real* person "Caroline"'s accounts — Echo's overnight autonomous session **silently adopted Caroline as its operator**. Echo-on-Mini had defaulted to Caroline's git credentials, and her identity was ambient on that machine. Across three planning docs the session recorded operator-role decisions ("Locked with Caroline", "Standing requirement from Caroline", "Mandate (Caroline)", "have Caroline drop a token") that were in fact **Justin's own decisions, verbatim** — it swapped a different principal into the operator role and never noticed.

Forensics (2026-06-05): no git commit anywhere was authored or committed as Caroline (the credential exposure was *not* exercised at the action layer), but the contamination ran deep at the identity/attribution layer. This is a **double red flag**: security (a credential-isolation failure that *could* have produced actions as another principal) and coherency (an agent acting on a misidentified operator for hours, undetected).

Two infrastructure gaps in instar's own surface allowed the coherency half (the credential-isolation half is §4):

1. **No hard operator binding.** "Who is my operator for this topic" was soft/ambient. Nothing at session start told the agent, as an immutable verified fact, *the operator of topic 19437 is Justin (platform uid 7812716706)*. So the session filled the operator role from ambient context.
2. **No cross-principal coherence guard.** Nothing flagged that work in Justin's topic was crediting operator decisions to a principal who is not that topic's bound operator. The coherence gate checks topic→project binding, not topic→operator attribution.

## Goal

Make "who is my operator" a **hard, verified, session-start fact** that overrides ambient context, and **structurally detect** when an outbound message or authored artifact attributes an operator-role decision to a principal other than the bound operator. (Structure > Willpower: a prompt saying "don't confuse operators" is a wish; a session-start binding + a gate is a guarantee.)

## Design

### 1. Topic-Operator Binding (the hard fact)

Extend the existing topic binding (`/topic-bindings`) with a verified `operator` record:

```json
{ "topicId": 19437,
  "operator": { "platform": "telegram", "uid": "7812716706", "displayName": "Justin",
                "boundAt": "<ISO>", "boundFrom": "authenticated-inbound" } }
```

- **Establishment (verified, not asserted):** the operator is set from the **authenticated inbound message source** — the platform-verified sender uid of the first owner-tier message in the topic, NOT from any name appearing in content. It is never set from a name an agent reads in a doc, a prior session's prose, or ambient machine state.
- **Injection at session start:** a `<topic-operator>` block is injected by the session-start hook (same mechanism as ORG-INTENT / preferences), e.g.:
  `<topic-operator platform="telegram" uid="7812716706">Justin — the verified operator of this topic. Operator-role decisions (approvals, mandates, "locked with…", credential drops) in this topic are Justin's. Do NOT attribute them to any other name, however it appears in context.</topic-operator>`
- **Immutable for the session:** the binding cannot be changed by message content. A genuine operator change is an explicit, authenticated, rate-limited admin action (out of scope here; default = stable).
- **Read surface:** `GET /topic-bindings/:id/operator`; `instar doctor` surfaces unbound topics.

### 2. Cross-Principal Coherence Guard (the detector)

A check that runs where outbound messages and authored artifacts are already reviewed (the Coherence Gate / a grounding-style hook):

- **Trigger:** the text records an **operator-role decision** — pattern families like `locked (with|by) <Name>`, `<Name> approved`, `mandate \(<Name>\)`, `<Name> authorized`, `standing requirement from <Name>`, `<Name> blessed`, `surface to <Name>`, `<Name> drop(ped) (a|the) (token|credential|secret)`.
- **Check:** if `<Name>` is a **person-like principal** that is **not** the topic's bound operator (and not a known peer agent / known non-operator role), flag it.
- **Verdict:** `warn` by default (surfaces the mismatch for review); `block` when the decision is credential/authority-bearing (a mandate, an approval, a credential drop) attributed to a non-operator — those are exactly the Caroline cases, and a misattributed authority decision must not ship silently.
- **Audit:** every flag → `logs/principal-coherence.jsonl` (`{ts, topicId, boundOperator, attributedTo, snippet, verdict}`).
- **Signal-only on artifacts at rest:** for docs authored autonomously (not just outbound messages), the guard runs as a lint over newly-written files in agent-authored paths, so a "Mandate (Caroline)" line in a fresh doc is caught at authorship, not months later.

### 3. Why these two, structurally

- The **binding** removes the *cause* (no hard operator fact → ambient fill). The **guard** catches the *symptom* (an attribution mismatch slips through). Defense in depth: even if a future binding is missing, the guard still flags the mismatch; even if the guard misses a phrasing, the binding means the agent reasoned with the right operator from message one.
- Both reuse existing rails (topic bindings, session-start injection, the coherence gate) — no new subsystem.

## §4. Related but distinct: per-agent credential isolation (gap 1)

The credential half — Echo-on-Mini defaulting to Caroline's *git credentials* — is partly machine-provisioning, not a pure instar-feature gap, but instar must not make it easy:

- **Per-agent git identity is mandatory, machine-global is the hazard.** The worktree convention already pins `user.name`/`user.email` per worktree — but autonomous sessions operating in the agent home (not a worktree) inherit the **machine-global** git identity + the shared **osxkeychain** credential helper, which is how another principal's credentials become the default. 
- **Recommended fixes (separate PR):** (a) agent-scoped git config (`includeIf` / per-agent-home `core.sshCommand` + credential scope) set at agent init so the agent home never inherits a machine-global identity belonging to another principal; (b) a boot self-check that asserts the active git identity matches *this* agent and raises a HIGH attention item if it resolves to a different principal; (c) credential-helper scoping so one agent cannot transparently read another agent's stored tokens on a shared box.
- This section is **design notes**, tracked under the same incident (CMT-1125); the buildable instar features in §1–§2 ship first because they close the coherency hole that actually fired.

## Phasing

- **Phase 1:** Topic-Operator Binding (§1) — schema + verified establishment from authenticated inbound + session-start injection + read route. Three-tier tests; Migration Parity (existing agents get the binding + the CLAUDE.md awareness); Agent Awareness template update.
- **Phase 2:** Cross-Principal Coherence Guard (§2) — outbound-message check + at-rest artifact lint + audit. Ships signal-only (warn) first; `block` for authority/credential attributions behind the graduated-rollout track.
- **Phase 3 (separate, CMT-1125 §4):** per-agent credential isolation + boot identity self-check.

## Test plan (Testing Integrity Standard)

- **Unit:** binding establishment ignores content names, takes only authenticated uid; guard fires on each operator-decision pattern with a non-operator name AND stays silent when the name IS the bound operator (both sides of the boundary); `block` vs `warn` tiering by decision type.
- **Integration:** `GET /topic-bindings/:id/operator` returns the verified record; the guard route flags a "Mandate (Caroline)" string for a topic bound to Justin.
- **E2E:** the session-start hook injects the `<topic-operator>` block for a bound topic (feature alive, 200 not 503).
- **Regression (the incident replay):** feed the three Caroline doc lines through the guard with topic 19437 bound to Justin → all flagged (`block` for the mandate/credential lines, `warn` for the prose). This is the "would this have caught Caroline?" test and must pass.

---
*Author: Echo, 2026-06-05, topic 19437. Incident + tracked fixes: CMT-1125. Sibling coherence surfaces: Coherence Gate, topic-project bindings, ORG-INTENT session injection.*
