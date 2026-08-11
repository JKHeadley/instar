# Window 12 — decision package

**Supersedes `window12-ratification-package.md`.** For the operator. **Nothing here has been applied; the
registry is untouched.** I find and frame; you rule.

Every item below is grouped and tiered so it can be ruled on as a unit. Where a ruling has a cost, the
cost of the direction NOT chosen is stated with it — you are ruling on tradeoffs, not accepting
recommendations.

---

## Header — the honest state

**NOT converged.** Fifteen reviews. **153 family-lens findings** (90 Building, 63 The Substrate) plus
**31 cross-cutting axis findings**, none applied.

*(Two corrections to my own earlier reporting, made here rather than carried: I told you "127 findings"
— the derived figure is 153 + 31. And I told you "5 enforcement mechanisms" — I had sampled the list with
`head -5`; there are **9**. Both came from summarising instead of counting, which is the thing this
window exists to catch.)*

**Why it did not converge, which is the finding under the findings.** Five lenses were run per family.
Each found a class the other four structurally could not see, and the yield did not decay — Building went
2 → 14 → 23 → 11 → **40**. That is evidence about how the registry was BUILT: article-by-article against
real incidents, never audited along any single consistent axis. A sixth lens would very likely find a
sixth class.

**So the method going forward is deliberate axis-auditing** — choosing the axis, running it to
exhaustion, and ratifying its output — rather than adding articles or hunting findings opportunistically.
The three axes chosen deliberately produced the most ratifiable material in this document.

---

## 1. Two verified contradictions — READY TO RULE

Both survived a lens whose only instruction was to REFUTE them. **The refutation framing leads
deliberately:** of six alleged contradictions raised this window, four were killed by verification, and
two of those had already reached you as real before the rule was in place.

### 1a. Emergency stop versus blocking authority — CONFIRMED

> *Structure Decides Alone Only on an Exact Match* (The Substrate): structure may decide **alone** on an
> exact whole-message match; the literal-match floor **always** stops.
> *Signal vs. Authority* (Interaction): only a full-context intelligent gate has blocking authority; a
> cheap matcher **may flag, never veto**.

**Ordinary case:** you send exactly the stop word while the model gate is unavailable. One requires the
deterministic floor to stop by itself; the other forbids deterministic blocking authority.

**To rule:** which governs, and whether the winner states it explicitly.
**Cost either way:** rule for the floor and a cheap matcher holds veto power somewhere; rule for the gate
and an emergency stop can fail to stop during exactly the outage it is most needed in.

### 1b. The precedence residual — CONFIRMED, at its surviving width

**Refuted first:** "the registry has no precedence mechanism" is FALSE — status precedence applies to
every family, a cross-family tradeoff exists ("the user wins"), and all four alleged collisions are
locally resolvable. The originally proposed interim was also **unsafe**: it would have frozen the live
channel during a gate outage.

**What survives:** no uniform fallback for a genuinely novel collision where both scopes apply, neither
article is pending, neither names the other, no governing/exception/composition/tradeoff clause settles
it, and the obligations cannot be jointly satisfied.

**To rule:** whether to name the residual, and whether the corrected interim (preserve every deciding
mechanism; escalate ONLY on the residual) is the right shape.

Full framing: `docs/proposals/precedence-gap-for-novel-collisions.md`.

---

## 2. The 57 silent failure directions — SEVEN GROUPS, READY TO RULE

**The measurement:** 82 articles depend on machinery (a gate, lint, sentinel, reviewer, model call, hook,
job). **25 state which direction they fail when it is absent. 57 are silent** — and an unstated direction
becomes whatever the implementation happens to do, discovered during the incident.

**One ruling instead of 57.** Each group carries the cost of the direction not chosen.

| # | group | default | cost of the OTHER direction |
|---|---|---|---|
| 1 | Change and release integrity | **FAIL-CLOSED** | fail-open ships unverified evolution into the installed base |
| 2 | Runtime state, identity, authority | **FAIL-CLOSED** (non-mutating route preserved) | fail-open mutates state whose ownership could not be established |
| 3 | Consequential judgment and autonomous action | **FAIL-CLOSED** | fail-open executes a consequential decision with its supervision absent |
| 4 | Workflow completion, admission, graduation | **FAIL-CLOSED** (blocks closure, not work) | fail-open declares done, admits more, or graduates unverified |
| 5 | Reachability and requested communication | **FAIL-OPEN** (record the degrade) | fail-closed silences the agent during the outage the user needs it |
| 6 | Outbound attention and unsolicited content | **FAIL-CLOSED** (direct replies preserved) | fail-open floods attention surfaces when routing is blind |
| 7 | Advisory observation, monitoring, learning | **FAIL-OPEN and LOUD** | fail-closed stops service for the loss of a non-authoritative signal |

**Note the asymmetry, because it is the substance of the ruling:** groups 5 and 7 fail OPEN and the rest
fail CLOSED. Reachability and advisory observation are the two interests where refusing does more harm
than proceeding — which is the same judgment already ratified in the "user wins" tradeoff, generalised.

**Undecided (1), deliberately not guessed:** *Signal vs. Authority* — its protected interest is preventing
low-context detectors from exercising judgment they cannot do. Whether its own absence should fail open or
closed depends on 1a above, so it is held rather than answered.

Source: `docs/specs/reports/window12-laptop/axis-silent-direction.out`.

---

## 3. Paperwork-gates → behaviour checks — NINE MECHANISMS, TIERED

**The measurement:** 25 articles whose stated enforcement detects a well-formed DECLARATION but not a
BREACH. **15 are mechanisable; 10 are not.**

Nine proposed mechanisms cover the 15, each tiered — extend an existing surface (T1) before a lint over
artefacts (T2), before a runtime record, before a periodic audit:

| # | mechanism | tier |
|---|---|---|
| 1 | Executable guard-proof matrix | T1 — extend Standards Enforcement Coverage + fingerprints |
| 2 | Operator-action journey suite | T1 — extend the operator-surface gate + dashboard test family |
| 3 | User-outcome contract and canary registry | T1 — extend `LiveTestGate`, `RealChannelDriver`, UX-liveness watchdog |
| 4 | Executable canonical-contract graph | T1 — strengthen migration/canonical-pipeline manifests with mutation testing |
| 5 | Two-node state-surface contract | T2 — integration tests over real artefacts and state adapters |
| 6 | Deferral and maturation lifecycle reconciler | T1 — join commitment/action registries + `FeatureRollout` |
| 7 | Escalation causal-chain gate | T1 — enforce at the attention/notification creation chokepoint |
| 8 | Blocking-outcome provenance funnel | T1 — evolve `lint-blocking-decisions-declared.mjs` into a funnel |
| 9 | Repeating-work primitive and sustained-pressure harness | T1 — extend the self-action registry |

**The 10 declared NOT mechanisable are the protective half.** An obligation requiring judgment cannot be
linted, and saying so is what stops someone building a paperwork gate for it and calling it enforced —
which is the very defect being fixed. A proposal claiming all 25 were mechanisable would have been worse
than none.

**To rule:** which mechanisms to authorise, and whether the 10 are accepted as judgment-bound.

Source: `docs/specs/reports/window12-laptop/axis-behavior-gates.out`.

---

## 4. Provenance — retire, re-earn, or reclassify

**The measurement:** of the articles carrying an `Earned from`, **46 LIVE / 29 SUPERSEDED / 14 unstated
or generic.**

### 4a. 29 SUPERSEDED — retire candidates

The originating failure can no longer happen, and each entry names WHAT now prevents it. These articles
are not wrong; they are **paid for**. Carrying them costs attention and creates conflicts with newer
rules — very likely part of why every lens keeps finding real classes.

**To rule:** retire, or keep with the provenance updated to say the incident is closed and what other work
the article still does.

### 4b. The 14 unstated — disposition, with ZERO retirements

All 14 are doing real work: **5 reconstructed** from quoted evidence in the registry itself, **4 KEEP and
RE-EARN** (real work, provenance lost — proposed evidence named), **5 KEEP AS PRINCIPLE** (never
incident-derived; they are stated values, and labelling a principle as incident-earned is itself the
finding).

### 4c. 9 articles whose provenance does RHETORICAL work

The sharpest output in this section: articles asserting empirical recurrence — "recurring" — while naming
no occurrence. An article that says "recurring" without a single instance borrows the authority of an
incident it never had. **This is a quiet route by which a constitution drifts**, and it is invisible to
every other lens.

**To rule:** whether an incident-shaped claim without an instance must be reworded or evidenced.

Sources: `axis-earned-from.out`, `axis-unstated-incidents.out`.

---

## 5. The guard — root defect CLOSED

The peeling stopped, and it stopped for a reason worth recording. Every repair from pass 39 to 46 was
right in intent and wrong in SHAPE, one level deeper each time: wrong representation → mutable reference →
re-read → wrong field → wrong field TYPE → alternatives-as-and.

**The root:** `RichText` is a **UNION** — a bare `string`, an `array` of RichText, or one of 22 wrapper
interfaces, and the same union serves input and output. The **bare-string arm is invisible to any
key-based walk**: in `{"text": ["hello", {...}]}` the literal is an array ELEMENT, under no key. Every
version returned early on it, including the one built "from the spec" — I had the type NAMES right and the
type SHAPE wrong. Collecting at the union arm is what makes the walk the grammar rather than a sweep of
field names.

Closed this window: method-in-parameter dispatch, DNS-root-dot hosts, escaped duplicate JSON keys,
test-environment roots, mutable body references, a second read introduced by the line meant to fix the
first, multi-field methods, structured content checked as a string, alternatives-as-simultaneous, a
phantom field that opened the unreadable-body waiver, and a caveat I had invented and written into the
source.

**Remaining, named honestly:** structured content inspected only in its JSON-body representation; the
lint's `fetch.call`/`fetch.apply` receiver check; the token-root `method` fallback described more broadly
than it is; leaf/no-leaf for invisible tables versus visible media; normalized host spellings in the lint.

**Status: NOT merged, no clean pair.** Pass 47 returned 6 (3 DESIGN, 3 PRECISION). Pass 46 returned the
window's only **zero-PRECISION** reading — no false claim in any comment, spec, lint output or test —
after a day in which inaccurate claims were the characteristic failure.

---

## 6. The process finding

The standing rule — *a cross-family or high-confidence finding gets a cross-cutting verification lens
BEFORE it is reported up* — **caught two overstatements of mine, and both times the wrong version was the
more quotable one.**

Then it was implemented one level earlier: the obligation-conflict axis was given the verification step as
a MANDATORY part of its brief. It discarded **12 of its own candidates** and reported 2. Moving
verification into the brief converted my correction loop into the reviewer's own discard pile — cheaper,
because a candidate discarded before it is written never costs a correction.

Two failures in the opposite direction are worth keeping beside it: I nearly reported a real bypass as a
hallucination because the field postdates my knowledge, and separately I **invented a caveat** and wrote
it into the source — claiming a limitation that did not exist. A fabricated caveat is not the safe
direction to be wrong in: it tells the next reader the guard is weaker than it is.

**All three have one remedy, now demonstrated rather than argued: verify before reporting, most of all
when confident — and equally when doubting.**
