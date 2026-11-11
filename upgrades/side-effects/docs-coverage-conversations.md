# Side-Effects Review — developer docs for the Conversations graph modules (docs-coverage repair)

**Version / slug:** `docs-coverage-conversations`
**Date:** `2026-11-11`
**Author:** `Echo (Opus documentation helper, fix/docs-coverage-conversations-1111)`
**Second-pass reviewer:** fresh native Opus 5.5 independent reviewer; CONCUR with a medium membership wording correction, applied by root before commit.
**Tier:** 1 (documentation only)

## Summary of the change

The advisory Actions docs-coverage check (`node scripts/docs-coverage.mjs --check`) was red on main `59aedce47` (1.3.1735). About 99 new modules — mostly the Conversations graph from PR 3013 — shipped with no docs, which pulled class coverage under its floor.

This change adds two developer architecture pages:

- `site/src/content/docs/architecture/conversations-custody.md` — intake, owner intent and policy, commit, replication, the graph witness, source inventory, live delegation, custody profile and bootstrap, transfer, and local file safety. It also covers the app conversation store, pins and effort headers beside the graph.
- `site/src/content/docs/architecture/conversations-recovery-privacy.md` — membership, recovering pending writes, transfer from the recovery side, permanent member loss, owner control recovery, retiring old roles, and erasure.

Both pages are written from each module's header comment, its exports and the wiring in `src/commands/server.ts` and `src/server/ConversationGraphDefault.ts`. They cross-link at shared boundaries (transfer, witness storage, erasure fences, owner policy). They state the limits the code itself states, for example: no rollback detection when every authority copy is rolled back, "separate copy" means a different enrolled identity and not separate hardware, the frame cache and flush memo are lost on restart, and erasure does not reach platform transcripts or phone downloads. They separate the Conversations graph witness from Threadline identity witnessing.

The manual Architecture sidebar in `site/astro.config.mjs` links to both pages, so they are discoverable. No installed-agent runtime source, test, config default, migration, hook, scanner, threshold or exemption changed.

## Metrics

| | Overall | Class | Result |
|---|---|---|---|
| Before (main `59aedce47`, clean worktree) | 54% (780 documented + 970 partial / 2364) | 50% (418 documented / 1207) | red: below 55% / 55% |
| After (this change, same unchanged script) | 57% (827 + 1023 / 2364) | 56% (465 / 1207) | green |

Floors are unchanged (overall 55%, class 55%). No `INSTAR_DOCS_COVERAGE_*` override was set.

## Decision-point inventory

None. Docs only; no runtime decision point is added, removed or changed.

## 1. Over-block

None. Nothing that runs is changed, so nothing new can be refused.

## 2. Under-block

None in runtime. For the gate: the pages pass because they name modules in two distinct doc files, which is the scanner's existing rule. Each mention sits in a sentence that describes the module's real role. Nothing was added only to raise the number. Modules outside the Conversations graph area stay undocumented (see "Remaining gaps").

## 3. Level-of-abstraction fit

The content is developer-level, so it lives in `architecture/` next to `durable-conversation-identity.md` and `multi-machine-session-pool.md`. Operator guides were not touched and gained no class names.

## 4. Signal vs authority compliance

Not applicable. No signal or authority code changed. The pages say plainly that structure checks, observations and frontier data grant no authority. That matches the source comments.

## 4b. Judgment-point check

Not applicable. No judgment point is added.

## 5. Interactions

The pages link to existing pages that exist on main: `durable-conversation-identity`, `multi-machine-session-pool`, `machine-identity-recovery`, and `reference/threadline-internals`. Each new page links to the other, and the manual Architecture sidebar links to both. Root ran the actual Astro site build successfully and checked both generated HTML routes and both sidebar links. The reviewer did not run that build.

## 6. External surfaces

The public docs site gains two pages once it is published. They describe config keys and module behavior that already ship. They do not announce a feature, and they say the read and corrections switches are off by default.

## 7. Multi-machine posture

No runtime effect. The pages describe existing multi-machine behavior as the code states it. They promise no failover, fsync or crypto guarantee beyond what the source already claims.

## 8. Rollback cost

Remove the four new documentation/release files and restore the two Architecture sidebar entries in `site/astro.config.mjs`. No installed-agent runtime depends on them. The gate would go red again.

## Migration / awareness

No migration is needed: no installed-agent files, hooks, config defaults, skills or CLAUDE.md template sections changed. The Conversations graph is dark for read by default, so no template change is needed for agent awareness.

## ELI16

Instar has an automatic checker that counts how many of its code modules are explained somewhere in the documentation website. If too few are explained, this advisory online check fails. The project uses a separate required verification step for merge approval. A big feature called the Conversations graph recently landed. It adds about a hundred new modules. They store how conversations relate to each other, keep encrypted copies among the enrolled graph members, and handle what happens when a machine is lost or someone asks for content to be deleted. None of those modules had docs yet, so the share of explained modules fell from about 55% to 50%, and the checker went red for everyone.

This repair does not lower the bar, add exceptions, or change how the checker counts. It adds two real pages that a developer can read to understand that code. The first explains how a conversation record is written, checked by a "witness", copied among graph members, and moved when the set of machines changes. The second explains recovery after a crash, removing a machine that is gone for good, getting the owner back in control, and deleting captured content. Both pages are taken from the code's own comments, and they also say what the code does not guarantee. The checker passes with the same rules as before, because the modules are now actually explained.

## Remaining gaps

Undocumented class entries outside this area are left as they were. That includes other `core/` modules (for example `InteractiveLoginExpiredRecovery`), plus the `monitoring`, `scheduler`, `messaging`, `users` (for example `MemoryPrivacyRecovery`), `security`, `lifeline`, `threadline`, `remediation` and `identity` groups the report lists. They are unrelated to the Conversations graph, and covering them here would be off-topic for these two pages. Of the 100 graph, app-conversation, pin, PIN-generation and effort-header modules, 45 are now DOCUMENTED (named on both pages) and 55 are PARTIAL (named on one page only, where the other page has nothing real to add). None are left undocumented. Class coverage passes with about one point of headroom.

## Conclusion

A Tier 1 docs-only repair that turns the advisory docs-coverage check green under unchanged rules. No runtime behavior changes.

## Second-pass review (if required)

Fresh native Opus 5.5 review concurred. It independently checked about 25 specific claims using selected module headers, exports and server wiring, not every module end to end; it ran zero tests. F1 (medium): distinguish candidate enrolled identities from the owner-signed membership and document genesisMembers plus later pairing exclusion; root applied this exact correction after checking ConversationGraphDefault.ts and the config type. F2 (low): distinguish missing external config fields from missing runtime prerequisites/secrets; root corrected the degradation statement against server.ts. The reviewer did not approve the capped Threadline design or any gate exception. Root separately verified docs coverage and the actual site build; hosted CI remains pending at this checkpoint.

## Evidence pointers

- Before: `node scripts/docs-coverage.mjs --check` on a clean worktree at `59aedce475ce9dde8b5dee27ab2ba34d40791312` → exit 1, "overall 54% < 55%", "class 50% < 55%".
- After: the same command with the two pages added → "✅ docs-coverage check passed.", overall 57%, class 56%.
- `git diff --check` clean.
- Not done yet at this checkpoint: write-trace, commit, and the full hosted CI run. No Vitest or full suite was run; none is needed for docs-only changes, and none is claimed.

Root follow-up before independent review: corrected the custody introduction to enrolled graph members (not every installed machine); corrected the ELI16 in the same way; added the two manual sidebar links. Site build and independent review remain pending.

## Merge-policy clarification

Root verified the live main rules after the initial review: the required test status is `instar/local-verify`, together with applicable code-owner review. Actions Docs Coverage is advisory. Calling it a required merge gate in the original checkpoint was incorrect. This documentation improvement is separate maintenance and must not hold Threadline history PR #3078 after that PR passes its actual required verification. Source pages, sidebar and coverage floors are unchanged by this clarification.
