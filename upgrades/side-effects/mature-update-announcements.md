# Side-Effects Review — Maturity-aware, silent-by-default user update announcements

**Version / slug:** `mature-update-announcements`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `3 independent adversarial reviewers (design / correctness / integration) — internal convergence`

## Summary of the change

Stops the post-update notifier from overselling unfinished features (the trigger:
infancy-stage Gemini CLI support narrated as "just got more reliable"). User-facing
update announcements become OPT-IN + maturity-tagged, authored in the release's
upgrade guide (`user_announcement` front-matter). Touches: `src/core/upgradeAnnouncement.ts`
(new pure helper), `src/core/UpgradeNotifyManager.ts` (silent-by-default compose),
`src/core/UpgradeGuideProcessor.ts` (hoist/merge blocks to byte 0), `src/core/AutoUpdater.ts`
+ `src/commands/server.ts` (Fork 3: suppress patch-level restart narration, preserve
handshake verification), `scripts/analyze-release.js` (draft block + forgot-block advisory),
`src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (agent-awareness guidance).
Decision points touched: the post-update *announce/skip* decision and the *restart-narrate/suppress*
decision.

## Decision-point inventory

- `UpgradeNotifyManager.buildPrompt announce-vs-skip` — **modify** — was "always compose, lead with the biggest feature"; now composes only from `audience: user` entries, skips entirely when there are none.
- `AutoUpdater restart-narration` — **modify** — was "narrate on every active-session restart"; now suppresses the bare narration for patch-only bumps (deferral warnings unchanged).
- `analyze-release forgot-block advisory` — **add** — a non-blocking author-facing warning when a user-relevant release carries no announcement block.
- `UpgradeGuideProcessor block hoist` — **add** — assembles a merged front-matter block at byte 0 (no decision authority; pure data-flow plumbing).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The "block" surface here is the announce/skip decision. Silent-by-default means a
*genuinely user-ready* feature is "over-blocked" (not announced) if the release author
forgets to add a `user_announcement` block. This is the one real over-block risk and was
raised by the design reviewer. Mitigations: (a) `analyze-release --draft-guide` scaffolds
the block for every feature/enhancement, so the author is structurally prompted to promote
the user-facing ones; (b) the main-path forgot-block advisory fires when a user-relevant
release has no block at all. The fail-safe direction is deliberate: silence (recoverable
with a follow-up note) is preferable to today's failure of a misleading announcement.

## 2. Under-block

**What failure modes does this still miss?**

An author can still *mislabel* maturity — mark an experimental feature `stable, audience: user` —
and the system will compose a confident message. The forgot-block advisory only catches total
absence of the block, not a wrong maturity inside it. This is accepted: maturity is a human
judgment authored with the release notes (the Body-and-Mind "author decides" layer); we
deliberately did NOT add a brittle headline→rollout-stage map in CI to police it (it would be
fragile and is the wrong layer). The restart-suppression "under-block": a patch bump that is
secretly disruptive gets no narration — but the deferral warnings and the failed-restart
escalation still fire, so a genuinely stuck restart is still surfaced.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The announce decision is authored at release time (in the upgrade guide), not improvised
by a throwaway notify session — that was the core design move. The notify-side helper
(`upgradeAnnouncement.ts`) is a pure renderer/parser (a low-level primitive). The forgot-block
guard lives in the release analyzer (the only layer with the "brand-new feature" signal and the
author's attention) — during convergence we *moved* the coherence check there and removed an
orphaned TS function that would have been a parallel implementation. The hoist lives in the
processor (the layer that already assembles the pending guide). No re-implementation of an
existing primitive; no gate running parallel to a smarter one.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — the brittle pieces are signals; the only authorities are deterministic, fully-enumerable policy.

The forgot-block advisory is a **signal** (a non-blocking `log()` line; the author decides). The
announce/skip decision is a deterministic policy over a fully-enumerable input ("are there
`audience: user` entries?") — not brittle pattern-matching. The restart-suppression decision is
deterministic over `crossesBreaking(prev, next)` (a pure semver observation that fails safe to
"narrate" on malformed input). No LLM-free brittle check holds blocking authority. All three
adversarial reviewers independently affirmed signal-vs-authority compliance.

## 5. Interactions

- **Shadowing:** the announcement front-matter is hoisted to byte 0 *above* the existing
  `# Instar Upgrade Guide` header and `<!-- bump: -->` marker. Verified the bump-marker regex,
  the publish-gate validator (`validateGuideContent` uses `includes`, no first-line requirement),
  `assemble-next-md.mjs`, and `check-upgrade-guide.js` all tolerate leading front-matter.
- **Double-fire:** the notify session's Step-1 send and the AutoUpdater restart narration are
  distinct topics/paths; no overlap. The handshake is written once per version (existing dedup
  guard unchanged).
- **Races:** none introduced — the processor assembly is single-pass synchronous; no shared
  mutable state added.
- **Feedback loops:** none.

## 6. External surfaces

- **Other agents:** the CLAUDE.md template + `migrateClaudeMd` change is the only agent-visible
  surface; it adds guidance, removes nothing.
- **Users:** fewer/quieter update messages (the intended UX change). Patch-level "restarting…"
  messages disappear; deferral warnings remain.
- **External systems (Telegram):** the post-update topic receives fewer messages; format of any
  message that DOES send is unchanged except for the experimental/preview badges.
- **Persistent state:** none. No new files/columns/ledgers. The handshake file is written exactly
  as before (only its `deferredNotification` may now be empty for patch bumps; the server skips
  empty emits and still clears the file).
- **Timing:** none beyond the existing restart timing.

## 7. Rollback cost

**Pure code change — revert the commit, ship as next patch.** No persistent state, no data
migration, no agent-state repair. The `migrateClaudeMd` addition is idempotent and additive
(reverting simply stops adding the section to new updates; already-patched CLAUDE.md files keep a
harmless guidance paragraph). No user-visible regression during the rollback window — worst case
reverts to the prior (louder, less honest) announcement behavior.

## Conclusion

The review (three independent adversarial passes — design, correctness, integration) returned a
unanimous SHIP-WITH-MINOR-FIXES with no blockers. Three findings were acted on before commit:
(1) added the required `migrateClaudeMd` migration parity for the maturity-honesty guidance;
(2) added the author-facing forgot-block advisory to mitigate the silent-by-default over-block
risk; (3) removed the orphaned `announcementCoherenceWarnings` TS helper (un-wired dead code) and
relocated the coherence concern to the release analyzer where the signal actually exists — keeping
`upgradeAnnouncement.ts` focused on the notify path. A correctness reviewer's serialize↔parse
round-trip gap was closed with an explicit unit test. The change is clear to ship.

---

## Second-pass review (if required)

**Reviewer:** internal multi-reviewer convergence (design / correctness / integration)
**Independent read of the artifact: concur**

All three reviewers concurred the design is sound (signal-vs-authority + Body-and-Mind compliant,
correct level of abstraction) and the implementation is correct and alive end-to-end. The minor
fixes they raised are incorporated above; no residual concerns block the ship.

---

## Evidence pointers

- Affected-set test run: 11 files / 134 tests green (unit helper, compose branches, processor
  hoist + no-op, analyze-release round-trip + forgot-block advisory, migration parity, AutoUpdater
  Fork-3 patch-suppression + minor-narrates, e2e upgrade-guide lifecycle).
- Spec: `docs/specs/mature-update-announcements.md` (`review-convergence: internal-multi-reviewer-2026-06-02`, `approved: true`).
- ELI16: `docs/specs/mature-update-announcements.eli16.md`.
