# EXO 3.0 → Instar — Master Requirements/Capability Matrix + Game Plan

**Mandate:** Digest Salim Ismail's full channel → extract every EXO 3.0 requirement → map to Instar → decide which gaps must close before presenting to Salim → ship a dedicated **instar.sh** page positioning Instar as THE EXO 3.0 agent (gaps shown honestly as a visible trajectory).

**Source:** @SalimIsmail → `UCh2iw67YgoRcp-oYBn89c5g`. 11 videos digested 2026-06-04 (transcripts committed at `docs/exo3/transcripts/`). Method in memory `exo3-salim-channel-digest`.

**Legend:** ✅ satisfied · ✅✅ standout strength · ⚠️ partial / needs framing · ❌ gap (buildable)

---

## Per-video thesis (chronological)
1. **The Real Reason Your AI Deployments Are Failing** — founding manifesto. Coase's Law dissolving; 80% of AI fails because bolted onto human hierarchies; bottleneck = human decision cycle; the intelligence stack; authority inverts; EXO 3.0 = MTP + DRIVE + SHAPE; build at the edge.
2. **The 90% Efficiency Trap** — "bolting AI on = dabbling"; AI is a new coordination layer; rewrite the workflow (not add a tool) → 90% gains; MTP becomes a *protocol*; rocket-ship analogy (drive=engine, shape=body, MTP=guidance).
3. **Your KPI System Is Training You to Miss the Future** — backward-looking KPIs suppress weak signals; AI *automates the old model* if metrics reinforce legacy. Measure **learning velocity / adaptability / experimentation**, not operational performance.
4. **AI Won't Replace People** — middle management shrinks ~10x; coordination roles compress, judgment expands.
5. **AI Just Changed the Competitive Map** — "your competitor is one person with 100 agents"; individual leverage breaks linear scaling.
6. **Why AI Agents Are Ignoring Your Purpose** ⭐ — MTP must be **machine-readable**; agents read protocols not walls. Three layers: **constraint** (forbidden actions w/ trigger+refusal+log+escalate), **decision** (resolve trade-offs without escalating; versioned/auditable), **identity** (why high-judgment humans stay; "what we're not for"). Two tests: **endorsement** + **refusal** ("if your MTP can't cause an agent to refuse, it's cheering, not governing"). ★ "A constraint with a trigger and a refusal and a log = not a wish. In code, not culture."
7. **Decision Problem** — orgs don't have an AI problem, they have a slow decision metabolism; AI forces fast decisions.
8. **Consensus Is Becoming a Liability** — speed beats agreement; clarity beats harmony; empower small groups with directional alignment, not universal approval.
9. **The 80-Year Business Rule AI Just Broke** ⭐ (w/ Ted Shelton) — firm becomes a **trust / fiduciary container** (legal, liability, brand, purpose), not a coordination engine. Every AI agent gets a **digital passport** (allowed/forbidden metadata) + **other agents watch compliance**; a **governor/assure layer** contains trust. **Human ON the loop, not IN it** (no per-action approval; oversight + step-in). Trusted counterparties; cascade-risk containment; headcount decouples from firm scale.
10. **The Slowest Pace of Change Is Right Now** — constant change is the operating environment; design for it with real-time feedback loops.
11. **Strategy Is Not the Hard Part Anymore** — execution speed + a million experiments as sensors; 5-year plans are obsolete on arrival.

---

## Consolidated requirements → Instar

### A. The Intelligence Stack (sense→interpret→decide→act→learn + governance) [V1,V2,V10]
| # | Requirement | Instar | Note |
|---|---|---|---|
| A1 | Org structured around cognitive layers, not functional silos | ✅ | sentinels/monitoring=sense · coherence+classifiers=interpret · gates/trust=decide · jobs/sessions/messaging=act · Playbook/learnings=learn. Already layered this way — **frame, don't build.** |
| A2 | Continuous non-stop loop ("a thinking system") | ✅ | persistent agent + looping sentinels + Playbook evaluate cycle. |
| A3 | Real-time feedback loops | ✅ | monitoring, sentinel family, correction-learning. |

### B. MTP as machine-readable protocol [V6,V2] — THE strongest alignment
| # | Requirement | Instar | Note |
|---|---|---|---|
| B1 | **Constraint layer** — machine-readable forbidden actions w/ trigger+refusal+log+escalate | ✅✅ | ORG-INTENT `constraints` (mandatory, violations block) + external-operation-gate (allow/block/show-plan/suggest-alt) + coherence gate. His $40k-invoice example = literally Instar operation evaluation. |
| B2 | **Decision layer** — resolve trade-offs without escalating; versioned, auditable; deterministic (two agents → same call) | ✅✅ | ORG-INTENT `tradeoff hierarchy` + **`POST /intent/tradeoff-resolve`** returns the winning value deterministically. Versioned in ORG-INTENT.md. |
| B3 | **Identity layer** — why high-judgment humans stay; identity disqualifiers; "what we're not for" | ⚠️ | ORG-INTENT `values` partially; human-binding/disqualifier aspect not first-class. **Smallest MTP gap.** |
| B4 | **Two tests** — endorsement + refusal | ⚠️→✅ | coherence gate blocks; constraints refuse. Not yet packaged as an explicit pass/fail harness. **Buildable: extend `instar intent validate`.** |
| B5 | MTP injected to agents (read protocols, not walls) | ✅ | `GET /intent/org/session-context` injects the structured contract at boot; coherence gate reads it per outbound. |
| ★ | Philosophy: "in code, not culture; a constraint w/o a trigger is a wish" | ✅✅ | = Instar's **Structure > Willpower** ("a 1,000-line prompt is a wish; a 10-line hook is a guarantee"). **Lead the pitch with this.** |

### C. Governance / authority inversion / human ON the loop [V1,V6,V9]
| # | Requirement | Instar | Note |
|---|---|---|---|
| C1 | Authority inverts: humans = validators/exception-handlers | ✅ | trust levels, show-plan, attention queue. |
| C2 | **Human ON the loop, not IN it** — no per-action approval, but oversight + step-in | ✅✅ | trust elevation (supervised→collaborative→autonomous) + sentinels as oversight + show-plan only for high-risk + attention escalation. Instar *is* human-on-the-loop infra. |
| C3 | Governor/assure layer spanning all layers | ✅ | coherence gate + external-op-gate + ORG-INTENT governance. |
| C4 | Cascade-risk containment (exponential external failure) | ✅✅ | CrashLoopPauser, circuit breakers, watchdogs, guards, reap-log. |

### D. Agent trust & identity (the "passport") [V9]
| # | Requirement | Instar | Note |
|---|---|---|---|
| D1 | Every agent has a digital **passport** (allowed/forbidden metadata) + other agents watch compliance | ⚠️ | identity.json + routing fingerprint + trust tiers + Threadline trust-gating + sentinels + operation gates. Primitives exist; not packaged as an explicit "passport," and cross-agent compliance-watching is partial. **Buildable framing.** |
| D2 | Trusted counterparties / trust boundaries for externalized functions | ⚠️ | Threadline trust tiers (untrusted→trusted). Seed. |
| D3 | Trust as the scaling primitive ("scarcity = abundance − trust") | ✅ | trust-elevation model. |
| D4 | **Identity assurance for inbound human channels** — today channel identity = user identity (a message from the operator's Telegram IS the operator); org-grade assurance (step-up / out-of-band confirmation for sensitive asks, takeover-signal policy, per-org assurance levels) is unexplored | ⚠️ | Operator-flagged exploration (2026-06-05, topic 19437). UX > security today, but some orgs invert that — assurance level should be an org policy, not a hardcode. G7's `owner-authentic`/`compromised-owner` probes measure the exposure first; design follows evidence. |

### E. Porous / elastic firm boundary (inter-org) [V1,V9] — ★ THE NORTH STAR
| # | Requirement | Instar | Note |
|---|---|---|---|
| E1 | Elastic boundary: humans + agents operate inside & outside fluidly | ⚠️→❌ | Threadline (agent-to-agent, cross-machine, trust-gated) + multi-machine pool are the seed — but Threadline ships **disabled by default**. **Biggest frontier.** |
| E2 | Internalize-vs-externalize decision per function | ❌ | no Instar primitive. Likely **advisory**, not a feature. |
| E3 | Firm as fiduciary/accountability/brand/purpose container | ⚠️ | ORG-INTENT (purpose) + agent identity/accountability; mostly org-structural. |

### F. DRIVE (fast & smart) [V1,V2,V5,V7,V8]
| # | Requirement | Instar | Note |
|---|---|---|---|
| F1 | AI built-in, fast execution | ✅ | autonomous/multi-session, scheduler, jobs, proactivity. |
| F2 | **One person / small team, many agents** (massive individual leverage) | ✅✅ | multi-session, multi-machine pool, autonomous sessions. Instar *is* the "one person, 100 agents" enabler. |
| F3 | Decision velocity / fast metabolism; act on directional alignment not consensus | ✅ | autonomous decisions bounded by ORG-INTENT, not approval-gated. |

### G. SHAPE (right & resilient) [V1,V2,V9]
| # | Requirement | Instar | Note |
|---|---|---|---|
| G1 | Stability/resilience — "stops you crashing" | ✅✅ | the entire guard/sentinel/coherence/self-heal/reap-log apparatus. **Instar's defining strength — most agent frameworks have NO shape layer.** |
| ⚠️ | Self-check: over-indexed on SHAPE vs DRIVE? ("shape without drive stalls") | — | worth an honest internal audit. |

### H. Learning layer / metabolism [V3,V10,V11]
| # | Requirement | Instar | Note |
|---|---|---|---|
| H1 | Measure **learning velocity / adaptability / experimentation**, not backward KPIs | ⚠️→❌ | Instar has operational observability (`/metrics/features`, token/resource ledgers) + Playbook usefulness scoring + learnings registry. No explicit *learning-velocity* metric. **Buildable.** |
| H2 | Many experiments as sensors; "starting ugly beats not starting" | ✅ | Close-the-Loop, maturation tracks, ship-dark-then-promote, jobs. |
| H3 | Proprietary intelligence in the learn layer survives | ✅ | Playbook, learnings, memory. |

### I. Implementation patterns (mostly advisory) [V1,V2]
| # | Requirement | Instar | Note |
|---|---|---|---|
| I1 | Build at the EDGE (digital twin, prove workflow, red-team, repeat) | ⚠️ | test-as-self, worktrees, apprenticeship — Instar both practices and *is* edge-deployment. |
| I2 | REWRITE / rewrite workflow for AI, don't bolt on | — | advisory. |
| I3 | **Task-decomposition / agent-readiness scoring** (coordination-vs-judgment ratio) | ❌ | no Instar diagnostic. **Concrete buildable — his signature tool.** |
| I4 | Chief AI Officer at exec level | — | advisory; Instar = the CAIO's instrument. |

---

## Gap analysis (what's actually missing)

| Gap | Maps to | Effort | Pitch impact |
|---|---|---|---|
| **G1 — MTP-Protocol packaging** (identity layer B3 + two-tests harness B4 + frame ORG-INTENT AS the MTP protocol) | B3,B4,B5 | **Low** | **Highest** — Video 6 is his flagship; we already have constraint+decision layers ✅✅ |
| **G2 — Agent-readiness scoring** (coordination-vs-judgment diagnostic) | I3 | **Medium** | High — his signature diagnostic; gives the page a "try it" hook |
| **G3 — Agent passport** (package identity+trust+capability-scoping; cross-agent compliance-watching) | D1 | **Medium** | High — vivid, concrete; primitives already exist |
| **G4 — Inter-org porousness** (Threadline disabled-seed → real maturation track) | E1,E2,D2 | **Large** | Strategic — the North Star; honesty here beats overclaiming |
| **G5 — Learning-velocity metrics** | H1 | **Medium** | Medium — differentiates from operational-only observability |
| **G6 — Internalize/externalize, CAIO** | E2,I4 | — | Advisory; name as org-design guidance, not a feature |
| **G7 — MTP Red-Team Harness** (standardized adversarial verification: amplification-ladder probes L0–L3 against the live agent through its real channel, expectations derived from the target org's OWN intent — org-agnostic by construction) | B4,I1 | **Medium** | **Required** — operator-declared fundamental for full EXO 3.0 compatibility (2026-06-05, topic 19437): an MTP whose refusal boundary was never adversarially probed is an *unverified* governor; other orgs run the same harness against their own MTPs. Spec: `docs/specs/MTP-REDTEAM-HARNESS-SPEC.md` |

---

## Threshold recommendation (close-before-pitch vs show-as-trajectory)

**MUST close before presenting** (credibility-critical — claims that would be hollow if probed):
- **G1 (MTP-Protocol packaging)** — low effort, highest payoff; turns our strongest-but-unframed alignment into a headline. Ship the identity layer + the endorsement/refusal test harness on `instar intent validate`.
- **G2 (Agent-readiness scoring)** — cheap, concrete, and it mirrors his own task-decomposition matrix; doubles as an interactive hook on the page.

**SHOW as in-progress trajectory** (honest roadmap *is* the credibility — we think like he does):
- **G7 (MTP Red-Team Harness)** — added 2026-06-05 by operator directive as REQUIRED for full EXO 3.0 compatibility. Phase 1 (prototype + first boundary map) before outreach; the public page shows the harness and our own honestly-measured boundary map as the proof that "governing, not cheering" is verified, not asserted.
- **G3 (Agent passport)** — show the live primitives + the path to an explicit passport.
- **G4 (Inter-org porousness)** — Threadline as the seed + the maturation track. This is the North Star; overclaiming here would be the one thing that loses him.
- **G5 (Learning-velocity metrics)** — show operational observability + the roadmap.

**OUT OF SCOPE / advisory** (name them, don't fake them):
- **G6** — internalize/externalize decisioning, CAIO appointment. Instar is the *instrument* of these decisions, not the decider.

---

## Game plan (phased)

- **Phase 0 — Framing (days):** Build the instar.sh page from this matrix. Frame ORG-INTENT explicitly as the **MTP Protocol** (constraint/decision/identity). Lead with the "in code, not culture" ≡ Structure > Willpower alignment.
- **Phase 1 — Must-close (~1–2 wks):** (a) MTP-protocol identity layer + endorsement/refusal test harness; (b) agent-readiness scoring diagnostic (skill + endpoint).
- **Phase 2 — Trajectory (visible on page):** agent passport packaging; learning-velocity metrics.
- **Phase 3 — North Star:** inter-org porousness via Threadline maturation.
- **Ongoing:** RSS watcher job on the channel → auto-digest new videos into this matrix.

**Outreach gate:** present to Salim once Phase 1 is shipped and the page is live with Phases 2–3 shown honestly as roadmap.
