# DX / API Design Review — GitHub Collaboration Monitor
**Review ID**: 20260329-153418
**Round**: 1
**Reviewer**: DX / API Design Specialist
**Date**: 2026-03-29

---

## Approval Status

**CONDITIONAL**

The spec is well-constructed and internally coherent, but there are meaningful DX gaps — particularly for the contributor side (people opening PRs) and for Echo's own ability to introspect and debug the system at runtime. These are solvable. Nothing here blocks building, but several items should be resolved before first deployment.

---

## Research Findings

Before evaluating the spec, I researched current best practices for automated PR review bots from the contributor's perspective:

**Key finding 1 — Noise kills adoption.** Research on OSS maintainers (NSF/par.nsf.gov) found that bot comments are frequently perceived as spam and ignored when they are too frequent or too low-signal. GitHub's own Copilot code review team moved from multiple single-line comments to clustered, cohesive comment blocks specifically to reduce cognitive load. The spec's current format posts a single review per PR — this is correct instinct, but the comment format itself needs to be signal-dense, not verbose.

**Key finding 2 — Transparency is non-negotiable.** The spec includes a disclosure footer ("Automated review by Echo") which matches best practice. Undisclosed bots generate disproportionate contributor backlash in open-source communities. The disclosure is necessary and the spec gets this right.

**Key finding 3 — Conversation capability matters.** CodeRabbit's key differentiator is that contributors can @-mention the bot and have it respond to their questions about its own comments. The spec handles reply threads (max 2 rounds), but does NOT address contributors asking follow-up questions about a specific comment inline. "Why did you flag this?" is a very common contributor action. This gap creates a poor experience for new contributors.

**Key finding 4 — First-time contributor onboarding effect.** AI review tools provide the most value to first-time contributors who lack direct access to project maintainers. A review that says "request-changes" with no path to resolution creates friction and may deter future contributions. The spec's recommendations need to include actionable next steps, not just verdicts.

**Key finding 5 — Review speed expectations are set quickly.** Contributors who see a review arrive within 12 hours start expecting that cadence. If Echo is paused, in digest mode, or has a failed scan cycle, there's no mechanism to set expectations with the contributor ("Review in progress, will complete within X hours"). Silence after a PR is opened feels like being ignored.

---

## Critical Issues

### 1. No contributor-facing explanation for the bot's presence

A first-time contributor opens a PR and gets a review from `@EchoOfDawn`. There's no context anywhere explaining what this bot is, what authority it has, or how to interact with it. The disclosure footer says "automated review by Echo" but links only to the GitHub profile — not to any documentation about what the bot does, what "request-changes" means from a bot, or whether human review will follow.

**Risk**: Contributors push back against or dismiss the review entirely because they don't understand the system. In open source communities, unexplained automation is consistently perceived as unwelcoming.

**Fix needed**: A bot description in the GitHub profile bio AND a first-comment template for new contributors that briefly explains the process. Something like: "I'm Echo, an automated reviewer for this repo. My review is a first pass — @JKHeadley makes final decisions. If you have questions about this review, reply here."

### 2. The `auto-integrate` criteria are not visible to contributors

The spec defines clear criteria for `auto-integrate` (trusted contributor, <100 lines, CI passing, no security paths, no new dependencies). But contributors have no way to know these criteria exist. A contributor who was previously trusted and submits a 150-line PR gets classified as `needs-review` — they don't know why their review experience changed from fast to slow.

**Risk**: Confusion about inconsistent treatment. The fast path (auto-integrate) vs. slow path (needs-review) is opaque to contributors.

**Fix needed**: Either document the criteria publicly in CONTRIBUTING.md, or have Echo's review comment for `auto-integrate` items acknowledge the fast path explicitly ("This is a small change from a trusted contributor, recommending merge.").

### 3. No actionable resolution path for `request-changes`

The review comment format ends with a **Verdict** but provides no explicit next steps. If Echo requests changes, the contributor doesn't know: Should I push new commits? Should I reply? Will Echo re-review automatically? Will @JKHeadley follow up?

**Risk**: PR stalls because the contributor doesn't know what to do next.

**Fix needed**: The Verdict section should always include one sentence on next steps. Example: "Please address the concerns above and push new commits — I'll re-review automatically. If you have questions, reply here."

### 4. Skip ledger composite keys are not documented for debugging

The skip ledger keys (`pr-{number}-{headRefOid}`, `issue-{number}-{commentCount}`) are the core dedup mechanism, but there's no described way to inspect or clear them. If a PR gets stuck (e.g., skip ledger marks it processed but Stage 2 failed silently), Echo has no described path to diagnose or reset the state.

**Risk**: Silent processing failures with no recovery path visible in the spec.

**Fix needed**: Add a debugging section describing how to inspect skip ledger state and how to force a re-scan of a specific PR by clearing its ledger entry.

---

## Recommendations

### R1 — Add a health/status endpoint or status command for the monitor itself

The spec describes the kill switch (sentinel file, jobs.json `enabled: false`) but not a way to query current system health: "Is the monitor running? When did it last scan? How many items are pending Stage 2?" This is basic operational DX.

**Suggested addition**: A `POST /jobs/github-collab-monitor/status` response that returns last scan time, items processed this cycle, Stage 2 queue depth, and audit log tail. Alternatively, this could be a Telegram command: "github monitor status."

### R2 — The vacation/digest mode API is underdeveloped

The spec mentions `POST /jobs/github-collab-monitor/config` with `digestMode: true` for vacation mode, but this endpoint doesn't appear elsewhere in the spec. It's a dangling reference. Is this a new endpoint? Does the jobs API already support this? The Telegram command path ("pause github monitor") is better documented than the API path.

**Suggested fix**: Either define the config endpoint properly (request/response schema) or standardize on Telegram commands as the primary control surface and document those exhaustively.

### R3 — Handoff note format is unspecified

"Stage 1 passes classified items to Stage 2 via handoff notes" — but the spec doesn't define what the handoff note contains. This is a critical integration point. If Stage 1 passes malformed data, Stage 2 will fail in unpredictable ways. Defining the schema here would make the system more robust and easier to debug.

**Suggested addition**: Add a `Handoff Note Schema` section with a JSON example showing what Stage 1 writes and Stage 2 expects.

### R4 — Reply-to-review detection is fragile

The spec says "if a contributor replies to Echo's review comment, the reply appears as a new issue comment event." This relies on Stage 1 correctly identifying a comment as a reply to Echo's review versus a new independent comment. The current classification prompt doesn't include logic for this distinction — all PR-related new comments get classified as `needs-review`.

This means a general discussion comment on a PR will incorrectly consume a reply-round slot against the 2-round maximum. After 2 such miscounts, Echo stops responding to legitimate questions.

**Suggested fix**: Include a classification signal for "is this comment directed at Echo?" (e.g., contains @EchoOfDawn or is a thread reply to Echo's review) vs. general PR discussion.

### R5 — Audit log schema should include contributor trust level at time of decision

The audit log records `{ prNumber, classification, recommendation, signals, rulesApplied, timestamp }` but not the trust level that was applied. This matters for forensics: if a PR was auto-integrated because the contributor was trusted, the audit log should capture that. If trust was later revoked, you want to know what trust level was in effect at decision time.

**Suggested addition**: Add `contributorTrustLevel` and `contributorTrustBasis` (e.g., "2 merged PRs, no reverts within 14 days") to the audit log schema.

### R6 — The prompt templates are functional but not tuned for DX

The Stage 2 prompt instructs Echo to produce a review "in this exact format" but the format includes `{review comment template}` as a literal placeholder reference rather than the actual template. This is a spec authoring gap — the two documents (prompt and comment format) are defined separately but need to be read together. During implementation, it's easy to miss that the Stage 2 prompt needs to include the full review comment template inline.

**Suggested fix**: Either inline the comment template into the Stage 2 prompt, or add an explicit cross-reference with the section name.

---

## Observations (Nice-to-Have)

**O1 — Consider a "first contribution" special case.** A contributor's very first PR to the repo deserves a slightly warmer review. Many OSS projects have a "first-time contributor" label and a welcome message. Echo could detect first-time contributors (no prior PRs from this author) and add a welcoming note to the review.

**O2 — The comment update policy (dismiss + re-post) has a side effect.** Dismissing a review removes it from the PR's review count, which can confuse contributors tracking review status. Most bots update the comment in-place (edit) rather than dismiss + new. Consider whether GitHub's review edit API (`PATCH /reviews/{id}`) would be cleaner than dismiss + new.

**O3 — Notification tone section is excellent.** The conversational notification format ("Hey, rolandcanyon-cmd built iMessage support...") is one of the strongest parts of the spec. This is precisely the right approach for human-facing notifications — treats Justin as a collaborator, not a ticket queue.

**O4 — Fork divergence analysis is underspecified for weekly cadence.** The weekly fork analysis is mentioned but there's no separate job config for it, no notification format, and no skip ledger strategy described. If this is genuinely a separate cadence, it should be a separate job config section.

**O5 — Consider a dry-run mode for initial testing.** Before the shadow period validation, a dry-run mode (scan and classify but post no comments, send no notifications) would let Echo validate its classification logic without affecting real contributors. This is lower friction than shadow mode (which does post comments).

---

## Scalability Assessment

**Short-term (1-10 active contributors):** The spec handles this well. The 12-hour scan cadence, skip ledger dedup, and Haiku/Opus split are appropriately sized for low activity volume.

**Medium-term (10-50 active contributors):** The `maxForksPerRun: 10` cap and `per_page=100` API calls will start to feel limiting. The rate limit pre-flight check (`<100 requests remaining`) is conservative but correct. The bigger issue is notification batching — the spec says "3+ notifications → single message" but doesn't define what happens with 20+ items, or how Justin triages a large batch.

**Long-term (50+ contributors):** The trust model will accumulate stale records over time (contributors who made 2 PRs years ago and are now trusted but inactive). There's no described mechanism for trust decay or cleanup. The audit log will grow unbounded — there's no rotation policy defined.

**Documentation debt risk:** The spec is well-structured now but the separation between prompt templates and comment format templates will create drift over time. As the review format evolves, there are two places to update (Stage 2 prompt and the comment format section) with no automatic sync mechanism.

---

## Score: 7/10

**Justification**: This is a thoughtful spec with strong operational controls (kill switch, rollback, shadow mode), correct instincts on automation safety (auto-merge off by default, security path overrides), and excellent notification design. The DX gaps are primarily on the contributor-facing side — the people opening PRs have no visibility into what Echo is, how to interact with it, or what to do when it requests changes. The debugging/introspection story for Echo itself is also underdeveloped. These are real gaps that will produce friction in practice, but none are architectural blockers. With the five critical fixes addressed, this would score 9/10.

---

*Review conducted by Echo's DX reviewer agent. Research sources: NSF study on code review bots in OSS, GitHub Copilot code review blog post, CodeRabbit documentation and community feedback, DEV Community AI PR review roundup 2025.*
