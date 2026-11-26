# Side-Effects Review — convergence-check: keep operator links openable

**Version / slug:** `convergence-check-operator-reachable-links`
**Date:** `2026-10-20`
**Author:** `Echo`
**Second-pass reviewer:** `required — outbound-messaging block/allow surface`

## Summary of the change

Two URL guards in `src/templates/scripts/convergence-check.sh`, the shipped
pre-message quality gate every agent runs before sending an external message.
Both target one failure: **the operator receives a link they cannot open.**

1. **`CLAUDE_LINK` (new check, blocking).** Refuses an outbound message
   containing a `claude.ai` / `claude.com` URL. Those are private to whichever
   Claude account published them; handing one to the operator asks them to sign
   in to an account they may not hold in order to read work their own agent
   produced. `claude.ai` is already in the well-known-domain allowlist that
   `URL_PROVENANCE` consults, so provenance explicitly does **not** catch this.

2. **`*.ts.net` trust (allowlist widening, unblocking).** Tailscale Funnel hosts
   join `*.trycloudflare.com` as trusted ingress in `URL_PROVENANCE`. Both are
   agent-controlled ingress on the agent's own infrastructure, not confabulated
   domains.

Also added: `tests/unit/convergence-check-operator-reachable-links.test.ts`
(16 cases) executing the real shipped template.

Origin: both guards were applied by hand to a deployed agent on 2026-10-20 and
silently lost ~95 minutes later when `PostUpdateMigrator` re-deployed this
template over them (always-overwrite by design, per the Migration Parity
Standard). The operator's standing instruction stopped being enforced and
nothing said so. The test is the part that makes this stick.

## Decision-point inventory

- `convergence-check.sh` → `CLAUDE_LINK` — **add** — deterministic URL-scheme
  match; blocks the send (exit 2) and returns the message to the agent to revise.
- `convergence-check.sh` → `URL_PROVENANCE` familiar-host allowlist — **modify**
  — widens what is trusted; strictly reduces blocking.
- `grounding-before-messaging.sh` — **pass-through** — the hook that invokes this
  script is unchanged. (Note: the script exits **1**; the *hook* converts that to
  the PreToolUse `exit 2` block. Correct at system level, but the authority lives
  in the hook, not here.)
- `PostUpdateMigrator.getConvergenceCheckInline()` — **known divergent, NOT
  updated** — the fallback written to disk when `loadTemplate()` returns null. It
  is already stale (missing checks 8 and 9) and does not get these guards.
  Deliberately out of scope: repairing fallback drift is its own change, and
  bundling it here would hide which fix caused which effect. An agent that hits
  the fallback silently loses the operator's rule. <!-- tracked: topic-127504 -->
- `src/core/ConvergenceChecker.ts` (`SAFE_DOMAINS`) — **known divergent, NOT
  updated** — a TS port still listing `claude.ai` as safe and lacking `ts.net`.
  Consumed only by `SendGateway`, as warnings, and `SendGateway` has no importers
  anywhere in the tree, so it is not a live block path today. If it is ever wired,
  the two paths will disagree. <!-- tracked: topic-127504 -->

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Concrete and real:

- **The operator asks about a Claude link they sent.** "What's at
  `https://claude.ai/code/artifact/abc`?" — a reply quoting that URL back is
  blocked. The agent must describe the link rather than echo it.
- **Discussing Claude's own product surfaces.** A message citing
  `https://claude.ai/settings` as a place for the operator to click is blocked,
  even though that is the operator's own account and a legitimate instruction.
- **Research output.** If the agent is researching Claude itself and cites a
  `claude.ai` URL as a source, the citation is refused.

- **Public `claude.com` pages.** `https://claude.com/pricing` is blocked, and for
  that class the script's own stated rationale — "private to whichever account
  published it" — is simply false. This is different in kind from the three
  above: those are real costs with a correct reason; this is the reason not
  applying to the host it matches. Narrowing to path shapes (`/code/`, `/chat/`,
  `/share/`) would drop this class while keeping the guard's whole point. Not
  done here because the operator's instruction was domain-level and emphatic;
  recorded as a known cost to revisit if it bites. <!-- tracked: topic-127504 -->

This is a genuine cost and I am not arguing it away. Two things make it
acceptable rather than merely tolerable:

- The operator stated this as a standing, emphatic protocol ("never ever ever"),
  which makes the strict reading the requested one, not an over-reach.
- The block is **non-destructive and immediate**: the message is handed back to
  the agent with the reason, not dropped. The workaround (name the destination
  instead of pasting the URL) costs one sentence.

`docs.anthropic.com` and `anthropic.com` are untouched — only `claude.ai` /
`claude.com` match, so Anthropic documentation links still send normally.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Shortened or redirected links.** A `bit.ly` or similar that resolves to a
  claude.ai artifact passes. The check is a string match, not a resolver.
- **A link delivered as prose.** "claude dot ai slash code slash artifact slash
  abc" is not matched. Low-probability but not impossible.

- **Other login-walled hosts.** The root problem is "a link the operator cannot
  open"; this fixes exactly one instance of it. A Notion page, a private Figma, a
  Google Doc restricted to the wrong account would all reproduce the same failure
  and are not covered. Naming that honestly rather than implying the class is
  closed.
- **Non-conversational egress.** Only messages that route through
  `grounding-before-messaging.sh` are inspected. A link delivered by another path
  is unaffected.

**Closed during second-pass review** (these WERE under-blocks and are now fixed,
each pinned by a test): a scheme-less `claude.ai/code/artifact/abc` — the most
likely real case, because chat clients auto-link it; a bare `https://claude.ai`
with no trailing slash; and `https://claude.ai?q=1`. Removing the scheme anchor
to catch these introduced an over-match on `notclaude.ai`, so a leading boundary
class was added and both look-alike shapes (`notclaude.ai`, `claude.ai.evil.com`)
are now pinned as must-NOT-match.

---

## 3. Level-of-abstraction fit

Is this the right layer?

`convergence-check.sh` is the existing deterministic pre-send gate and already
owns `URL_PROVENANCE`, which is the same concern (is this URL one the operator
can trust and reach). Putting a URL rule beside the other URL rules is the
narrow, obvious placement.

The arguable alternative is the **tone gate** (the LLM authority) rather than a
deterministic script. Rejected: whether a URL's host is `claude.ai` is a
decidable fact, not a judgment. Spending an LLM call — and inheriting its
failure-open/fail-closed behavior — on a string match would be worse on every
axis. The constitution's own framing ("an LLM gate must not string-match")
applies in reverse here: a string match must not be an LLM gate.

No smarter gate already covers this. `URL_PROVENANCE` structurally cannot,
because `claude.ai` sits in its trusted allowlist.

**The narrower option for the `ts.net` half, and why it was not taken.** Eight
lines above, the script already reads the agent's *own* tunnel host from config
and trusts only that host plus its parent domain. The equivalent for tailnets —
trust only `*.<own-tailnet>.ts.net` — is the tighter design, and the second-pass
reviewer is right that a tailnet host (`<machine-nickname>.<tailnet>.ts.net`) has
exactly the shape this check's stated threat model calls plausible-confabulation.
It is not taken here because the own-tailnet name has no config source today:
discovering it means shelling out to `tailscale status --json` on every outbound
message, in a hot-path gate that is currently pure text processing. That is a
real cost for a real but small risk, and bundling a tailnet-discovery mechanism
into this fix would widen the blast radius well past the bug. The broad suffix
trust is therefore a **deliberate, documented scope decision**, pinned by a test
that asserts a stranger's tailnet passes so no later reader mistakes the
look-alike control for tighter coverage than exists. <!-- tracked: topic-127504 -->

---

## 4. Signal vs authority compliance

**Reference: `docs/signal-vs-authority.md`.**

`CLAUDE_LINK` holds blocking authority — the hook turns this script's non-zero
exit into a PreToolUse block. So this section is load-bearing and the first draft
got its argument wrong.

**What the first draft argued, and why it was wrong.** It claimed the principle
only forbids *heuristic* blockers, and that a decidable predicate (does this text
contain a URL with host `claude.ai`) is therefore exempt. The second-pass
reviewer refuted this and is correct: the doc grounds the rule in
**indistinguishability**, not decidability. Its own worked example — a literal
match on the token `test` — is perfectly decidable about what it matches, and was
*still* reworked into a signal. Decidability of detection was never the exempting
property. Section 1 of this very artifact concedes three classes of legitimate
`claude.ai` mention the detector cannot tell from the failure mode. "My predicate
is decidable" is true of every regex, so accepting it would license the next
genuinely brittle blocker.

**The argument that actually holds**, on two grounds:

1. **Scope.** The principle governs *judgment* decisions — blocking on what a
   message **means** or what the agent's **intent** appears to be.
   `CLAUDE_LINK` blocks on a syntactic property of the text: the presence of a
   URL with a particular host. No meaning is inferred, no intent is attributed.
   That is what places it outside the principle's domain — not decidability.
2. **Asymmetric cost.** A false pass is silent and discovered late: the operator
   receives an unopenable link and may never mention it (which is exactly how
   this bug survived). A false block is immediate, reasoned, non-destructive, and
   costs one rewritten sentence. The cheap-failure direction is the blocking one.

**Why the existing authority was not fed instead.** The doc's prescribed
alternative is to feed a signal into the authority that already owns the decision
point — here, the tone gate, which already runs on every outbound message and
already has an advisory/override lane. The first draft dismissed this against a
strawman ("spending an LLM call on a string match"), which was not the option on
the table: a signal into an already-running gate costs no additional call. The
real reasons to keep it deterministic are narrower and should be stated as such:
the tone gate is an LLM authority that can fail closed under provider trouble or
fail open on a paraphrase, and this particular rule is one the operator stated as
an absolute. A rule whose whole value is that it never lets one through is a poor
fit for a probabilistic gate. **This is a genuine trade, not a free win** — the
cost is that Section 1's legitimate cases get a hard block where the tone gate's
advisory lane would have let the agent override with a stated reason.

**Precedent in the same file, which the first draft did not cite.** Check 9 is
annotated SIGNAL-ONLY and explicitly says it never touches the exit code, citing
this principle. Check 8 chose blocking and says "narrow by design (this blocks
the send)". Both shapes exist here; this change follows check 8, and the
syntactic-vs-judgment line above is why.

**The `ts.net` half moves strictly toward signal** — it removes blocking
authority from a case that was being wrongly refused.

## 5. Interactions

- **Shadowing:** none. `claude.ai` passes `URL_PROVENANCE` (allowlisted), so the
  two checks cannot shadow each other — that non-overlap is precisely why the new
  check is needed.
- **Double-fire:** both can append to `ISSUES` in one run, which is correct and
  already the script's accumulate-then-report design. Observed in practice during
  verification: a message containing both a claude.ai link and a fabricated host
  reported both issues.
- **Ordering:** `CLAUDE_LINK` is numbered `6b`, after `URL_PROVENANCE` (6) and
  before `TEMPORAL` (7). No check depends on another's result.
- **Race with cleanup:** none — pure function of stdin.
- **Known adjacent false-positive, unrelated to this change:** `SETTLING` matches
  the substring `there (is|are) no`, which fires on prose like "there are no
  categories". Encountered while writing this up. **Not fixed here** — out of this
  change's blast radius, and bundling it would violate the one-fix-per-artifact
  rule. <!-- tracked: topic-127504 -->

---

## 6. External surfaces

- **Visible to the operator:** yes, and that is the point — a previously-sent
  class of unusable link now cannot be sent.
- **Visible to other agents:** no. This is the agent's own pre-send gate.
- **Timing / runtime dependence:** the two halves differ, and treating them as one
  was an error in the first draft.
  - `CLAUDE_LINK` has none — a pure `grep` over the message text.
  - The `ts.net` trust depends on **python3**, which the script shells out to in
    order to extract a hostname. With no python3 the hostname is empty, the
    `ts.net` skip cannot fire, and a Funnel link is flagged as an unfamiliar
    domain — i.e. the guard silently reverts to the exact behaviour this change
    repairs. The direction is fail-closed, which is the safe one, but it is a
    dependency and not "no runtime dependence".
- **Behavior change for every agent on update:** yes. This template is
  always-overwrite, so the next `PostUpdateMigrator` run deploys it fleet-wide.
  That is the intended delivery path and the reason a hand-patch was insufficient.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.**

`convergence-check.sh` is a pre-send gate evaluated in the process that is
sending, on whichever machine that is. There is no state to replicate, no merged
read, and no cross-machine ordering concern — the predicate is a pure function of
the outbound message text.

The template is distributed per-machine by `PostUpdateMigrator`, so a multi-machine
agent converges on the same gate only as each machine updates. During a rolling
update one machine may enforce `CLAUDE_LINK` while another does not. The failure
mode of that skew is benign and self-correcting: a stale machine permits a link it
should refuse, which is exactly today's behavior everywhere.

Relevant and worth naming: the `*.ts.net` half is what makes a **multi-machine**
agent able to hand over a link at all when one machine's Cloudflare tunnel is
down — the sibling-node trust already in `URL_PROVENANCE` covers tunnel-parent
subdomains but had no concept of a tailnet.

---

## 8. Rollback cost

**Low, and reversible without data migration.**

- **Back-out:** revert this commit; the next migrator run restores the prior
  template. No state, no schema, no agent repair.
- **Hot-fix not required:** the worst failure is an over-block, which returns the
  message to the agent with a stated reason rather than dropping it. No silent
  loss.
- **Partial rollback is available:** the two guards are independent blocks and
  either can be removed alone.
- **Emergency path for an operator who hits a bad over-block:** the message is
  never lost; rephrasing to name the destination instead of pasting the URL sends
  immediately.

---

## Verification performed

- 16 unit cases against the **real shipped template**, all passing.
- **Canary (must-fail) check:** with the fix reverted via `git stash`, exactly 5
  of 9 fail — the two `CLAUDE_LINK` detection cases, the `www.` variant, and both
  `*.ts.net` trust cases. The 4 that still pass are guard-independent by design
  (bash syntax, a prose non-trigger, and two negative controls that must keep
  blocking). This proves the tests detect the regression rather than merely
  passing alongside it.
- Template restored byte-identical after the canary (`cmp`).
- Negative controls retained: a fabricated host and a look-alike suffix
  (`evil-notts.net`) must both still be refused, so the allowlist widening is
  shown not to have weakened the guard.

---

## Second-pass review — concerns raised, change sound to ship

**Reviewer:** independent reviewer subagent
**Date:** 2026-10-20

**Concern raised:** §4's signal-vs-authority argument did not do the work the
artifact asked of it — "decidable predicate" is not the test
`docs/signal-vs-authority.md` applies, and the alternative the doc actually
prescribes (feed the detection into the already-running tone gate as a signal)
was rejected in §3 against a strawman. Separately, §1 missed a material
over-block that contradicts the rationale written into the script comment, and
§6's "no runtime dependence" is false for half the change.

The reviewer verified empirically rather than reading prose: ran all tests,
independently reproduced the must-fail canary (exactly 5 of 9 failing, `cmp`
clean after restore), and probed 15 regex edge cases against the real script.
It confirmed the anchoring is correct in both directions —
`https://evil-ts.net/thing` and `https://ts.net.attacker.com/x` are both refused,
and host extraction defeats the `https://x.ts.net@evil.com/` userinfo trick.

### Author response — what changed as a result

| Reviewer finding | Severity | Response |
|---|---|---|
| §4 rests on "decidable", which is not the doc's test | 1 | **§4 rewritten** onto scope (syntactic vs judgment) + asymmetric cost; strawman removed; check 8 / check 9 precedents now cited; the tone-gate trade stated as a trade |
| `claude.com/pricing` blocked, rationale false for that class | 2 | **Added to §1** as a known cost of a different kind, with the path-narrowing option named |
| §6 "no runtime dependence" false — `ts.net` needs python3 | 2 | **§6 corrected**; the two halves now described separately, fail-closed direction stated |
| Scheme-less + trailing-slash + query under-blocks | 3 | **Fixed in code**, not just documented. Required adding a leading boundary class to avoid a new `notclaude.ai` over-match. 7 new tests |
| `*.ts.net` trusts every tailnet, narrower option exists | 3 | **Documented as a deliberate scope decision in §3** with the cost of the narrow version (subprocess per message in a hot-path gate), and **pinned by a test** asserting a stranger's tailnet passes |
| Two divergent copies unlisted | 4 | **Added to the inventory**, both tracked |
| Missing tests: anthropic docs, boundary, tailnet scope | — | **All three added** |
| Inventory says "exit 2"; script exits 1 | nit | **Corrected** |

Test count 9 → 16, all passing.

**Not taken:** narrowing `CLAUDE_LINK` to path shapes, and narrowing `ts.net` to
the agent's own tailnet. Both are better designs; both widen this change past the
bug it fixes. Recorded above with their costs rather than silently dropped.

---

## Addendum, 2026-10-22 — why this had to be re-applied four times

This fix was originally written on a feature branch that never merged. The guards
therefore existed only in that branch's copy of the template, while the shipped
template in `main` never had them.

`PostUpdateMigrator` always overwrites built-in scripts from the shipped template
(deliberately — it is what stops agents getting stuck on a broken hook). So every
update overwrote the deployed `convergence-check.sh` with a version that had never
contained the fix, and the guard "disappeared" again. Four times.

Each time the symptom was the same and misleading: a verified, working Tailscale
link to the operator refused as an "unfamiliar domain", with the agent unable to
hand over a link it had just loaded successfully from outside. On the fourth
occurrence this blocked delivery of a working prototype URL.

**The lesson is about where a fix lives, not what it does.** A correct fix on an
unmerged branch is indistinguishable from no fix at all for every machine running
the shipped template — and because the local copy *did* carry it, the branch looked
healthy. This PR exists to put the guards where the migrator reads from.

No behaviour change versus the original review: the same two guards, the same
tests, now in `main` where they survive an update.

### Over-block found by CI, 2026-10-22 — and the review question it answers

The first version of `CLAUDE_LINK` matched **every** path on `claude.ai` /
`claude.com`. An existing regression test in `tests/unit/convergence-check.test.ts`
("passes claude.com OAuth login URLs") caught it immediately: the Claude
subscription **OAuth login link lives on claude.com**, and the agent legitimately
hands it to the operator during account enrolment. Blocking it would have broken
enrolment to prevent a problem that does not exist on that path — the operator
signing in is the entire point of the link.

This is question 1 of this review (over-block) being answered by the test suite
rather than by me. The original review asserted the rule was safe because the
operator "may not have access to the account that owns the page"; that reasoning
is correct for an artifact page and plainly wrong for a sign-in page, and I did not
separate the two.

The rule now subtracts the auth family (`/oauth`, `/login`, `/signin`, `/sign-in`,
`/auth`, `/api`) and flags only if a non-auth `claude.*` URL remains — so a message
carrying both a sign-in link and an artifact link is still flagged for the artifact.
Three tests pin this: the OAuth URL passes, a login URL passes, and the mixed case
still blocks.
