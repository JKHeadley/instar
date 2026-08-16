# Side-Effects Review — topic-creation lint: rename/alias resistance

**Version / slug:** `topic-creation-lint-alias`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `peer audit — 4th of the 25 name-matching checks it classified defeatable`

## Summary of the change

`scripts/lint-no-unfunneled-topic-creation.js` guards the chokepoint the "Bounded Notification Surface" ceiling depends on: `TelegramAdapter.createForumTopic` is the ONE place forum topics are born, and the last-resort auto-topic budget lives inside it. A callsite reaching the Bot API's `createForumTopic` directly bypasses that budget — the shape of all three topic-spam incidents.

The check was three line-anchored regexes, each anchored on a NAME: the seam being spelled `apiCall`, a `method:` property key, or a fully-literal `/bot…/createForumTopic` URL. Eleven bypasses were written and run against the shipped lint first; **ten were confirmed evading**, one (a backtick literal passed straight to `apiCall`) was already caught and is claimed as nothing.

This replaces the regexes with a TypeScript-AST detector that asks a different question: not *"is the raw method invoked through a seam spelled `apiCall`?"* but *"does this file NAME the raw Bot-API method at all?"* — resolved through constants, concatenations and template literals to a fixpoint. The seam's spelling stops mattering, because the method name has to appear for the call to reach Telegram whatever the receiver is called.

## Decision-point inventory

No decision point added or removed. One is widened at its input. The allowlist, the exit contract, the `--staged` mode and the scanned extensions are unchanged.

## 1. Over-block

The dominant risk, and the reason the control tests outnumber the bypass tests: this lint blocks commits, so a widened rule that flags correct code is the more expensive failure.

Bounded by construction. Only an expression that statically resolves to *exactly* `createForumTopic`, or to a string carrying it as a URL path segment, is a violation. Four positions are excluded outright because they cannot be an invocation: a property KEY (`{ createForumTopic: 'name' }` — the real table in `src/messaging/invisible-payload.ts` is exactly this shape), a string-literal TYPE, a module specifier, and computed member access on the method name. Comments are not AST string literals and are excluded by the parser, not by a rule. Prose that merely *mentions* the method (`'createForumTopic budget exceeded'`) is not an exact match and is not flagged.

**This is where the change cost something, and it should be recorded rather than smoothed over.** The new rule surfaced ONE genuine false positive on the live tree that the regexes never could: `scripts/lib/self-action-detect.mjs` lists `'createForumTopic'` in `SELF_ACTION_VERB_TOKENS`, the vocabulary another lint builds its regex from. It is data, not a callsite — the module is imported by lint scripts, has no Telegram client and no network reach. It is allowlisted with that justification, so the allowlist grew by one entry. The alternative — excluding bare array elements from the rule — was rejected because it would reopen `const args = ['createForumTopic', p]; seam(...args)`.

Thirteen opposite-direction controls pin the boundary, and the decisive evidence is that **the real repo lints CLEAN before and after** (exit 0 both ways).

The change also *reduces* over-blocking in one place: the old regexes flagged a COMMENT mentioning `apiCall('createForumTopic', …)`, so a file documenting the pattern failed the build. A test pins both halves of that.

## 2. Under-block

Named in the header in place of the ones it closed, and pinned where cheap:

- A method name assembled at RUNTIME (`['create','Forum','Topic'].join('')`, char-codes, a name read from config or env) resolves to nothing static. Needs dataflow this does not do.
- A name imported from ANOTHER module (`import { M } from './names.js'`). Resolution is file-local.
- Computed member access on the method name (`client['createForumTopic'](p)`) — **deliberately not flagged**. The funnel method and the raw API method share a name, so `adapter['createForumTopic'](…)`, which is legitimate funnel use, is indistinguishable from it by name alone. Flagging it would break correct code.
- Shell files are checked as text, not parsed: any non-comment line naming the method is a violation, but a name assembled across shell lines (`M=create; M="${M}ForumTopic"`) escapes.

## 3. Level-of-abstraction fit

The detector sits beside the other AST lints (`lint-telegram-egress-boundary.mjs`, `lint-no-unfunneled-credential-write.js`) and follows their shape: exported detector, fixpoint binding resolution, CLI body behind a direct-invocation guard. A cheap text pre-filter over the concatenation-collapsed source keeps the parse off 1,761 of 1,803 files.

## 4. Signal vs authority compliance

The lint IS authority — it fails a commit — unchanged in kind and scope. Only what it can see is widened, plus one allowlist entry so the tree still passes clean.

## 4b. Judgment-point check (Judgment Within Floors standard)

None. Deterministic AST predicates, a bounded constant fixpoint (10 passes), and exact string comparison. No heuristic, model call, or threshold.

## 5. Interactions

Blast radius: one script, plus one allowlist entry naming a second file that is not modified. The module previously had no import guard and one `process.exit(1)` path, so importing it in a test would have killed the run the moment the tree had a violation — the guard closes that. `package.json` invocation and the husky pre-commit chain are unchanged. `scripts/lint-no-direct-destructive.js` allowlists this file by path; the path is unchanged.

## 6. External surfaces

None. No network, persisted state, credential, telemetry, or route. It reads source at lint time exactly as before — this touches the CHECK, never the topic-creation path. Runtime cost went from ~0.3s to ~1.8s on the full tree, inside the existing `npm run lint` chain.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Violation text now distinguishes a raw METHOD NAME from a raw URL, and both still name the funnel and the allowlist escape. The clean summary is unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified — build-time check, no shared state.

## 8. Rollback cost

Very low. One script, one new test file, one commit; no migration, persisted state, or config flag.

## Evidence pointers

- All eleven bypasses were RUN against the shipped lint before anything was changed. Ten evaded (exit 0), one was caught. The ten are the BYPASS cases; the eleventh is kept as a regression control and claimed as nothing.
- The evasion is proven in-suite, not asserted: the three legacy regexes are reproduced verbatim in the test file, and each bypass asserts `legacyCatches(src) === false` alongside the new detector catching it. A future reader can see the "before" without checking out the old file.
- Negative control, and it corrected my own account of the change: with the RESOLUTION layer removed (constants → empty map, concatenation and template handling disabled), **8 of the 10 bypasses are still caught and all 9 controls stay clean**. So the resolver is not what does most of the work — the QUESTION MOVE is. Resolution is specifically load-bearing for two bypasses (the split literal, and a URL whose base is a variable), and it fixes line attribution for the const-indirection cases, which the neutered version reports at the declaration rather than the callsite. Claiming the resolver as the fix would have been the more flattering and less true story.
- Real repo lints CLEAN before (exit 0) and after (exit 0, with the one allowlist entry).
- 47/47 in `tests/unit/topic-creation-lint-evasions.test.ts`: 10 bypass cases, 13 opposite-direction controls, and 4 tests that PIN the known gaps as still-open so closing one properly fails a test instead of silently overstating the check.
- Import-safety verified both modes: as a CLI it prints its clean summary and exits 0; imported, it does not run the scan.

## Class-Closure Declaration (display-only mirror)

Class: "a check defeatable by renaming or re-binding what it matches on."

**Closed for THIS lint**, for the whole seam dimension: the seam's name is no longer part of the question, so a re-bound receiver, a computed seam access, an aliased import, a namespace import, and a seam under an entirely different name all land on the same check. Also closed: split literals, template literals, local-constant indirection, multi-line arguments, quoted property keys, and a URL whose base is a variable.

**NOT closed**, and worth more than the list above:

1. **A method name assembled at runtime** — `join('')` over an array, char-codes, or a value read from config/env. This is the honest floor of a static check.
2. **A name imported from another module.** Resolution is file-local; cross-module would need a program-wide pass.
3. **Computed member access on the method name** (`client['createForumTopic'](p)`) — a deliberate refusal, not an oversight. The funnel exposes the same name, so this is ambiguous by construction and flagging it would break correct code.
4. **Shell variables assembled across lines.** `.sh` files are text-checked.
5. **The prompt's canonical example does not apply here, and pretending otherwise would be the wrong report:** `const t = adapter; t.createForumTopic(...)` is not a bypass of THIS lint — it is legitimate use of the funnel, which is what the lint wants callers to do. The analogous bypass is re-binding the raw API SEAM, which is what the tests cover.

**NOT closed repo-wide:** this is the 4th of the peer audit's ~25 defeatable checks. ~21 remain.
