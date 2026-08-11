# External review pass 33 — reviewer's verbatim final answer — **UNSOUND, load-bearing 5 (3 DESIGN, 2 PRECISION)**

**The first COMPLETED reading under the filter-safe brief**, and the first in the series to leave the
tree verifiably clean: it declined to run the destructive coverage measurer, said so, and `git status`
was clean afterwards. It also stated its exclusions beside its count, as article 89 requires.

Its central result: **the guard evaluated the PRE-FORMAT source.** A payload whose only content
characters sat in a link destination was SENT, went on the wire as an anchor tag, and reached a reader
as one zero-width space. Verified by execution before repair.

Run against `573a6c3f4`. Exploration logs are NOT kept; only the final answer block.

---

```text
## FINDINGS

1. **DESIGN — the runtime guard evaluates pre-format source, not the reader-visible outbound representation.**

   Both formatter-equipped funnels call `assertTelegramPayloadVisible(method, params)` before transforming the message, then send `sendParams.outgoingParams`: [TelegramAdapter.ts:5707](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:5707), [TelegramAdapter.ts:5718](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:5718), [TelegramAdapter.ts:5733](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:5733), [TelegramLifeline.ts:2901](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/lifeline/TelegramLifeline.ts:2901), [TelegramLifeline.ts:2920](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/lifeline/TelegramLifeline.ts:2920).

   The formatter’s default mode converts Markdown into Telegram HTML [TelegramAdapter.ts:5853](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:5853). In particular, link destinations become HTML attributes while only the label remains displayed [TelegramMarkdownFormatter.ts:320](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramMarkdownFormatter.ts:320), and formatting delimiters become tags [TelegramMarkdownFormatter.ts:342](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramMarkdownFormatter.ts:342).

   Therefore, inputs whose category-positive characters occur only in formatting syntax or a link destination, while the rendered body/label contains only blank or ignorable characters, are approved by the raw-codepoint predicate [invisible-payload.ts:64](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:64) and can reach the network after those positive characters cease to be reader-visible. The reasoning “the source contains a visible codepoint, therefore the reader receives content” does not survive the representation change. Existing positive-path tests assert unchanged ordinary text, not this boundary [telegram-send-funnel-invisible-payload.test.ts:97](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:97).

2. **DESIGN — bare-identifier syntax plus independent import text does not prove a call resolves to the imported function.**

   The parser records only a callee’s spelling and whether its syntax is a bare identifier [lint-telegram-send-funnel-guarded.mjs:147](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:147). `hasLiveGuardCall` then checks those two properties [lint-telegram-send-funnel-guarded.mjs:179](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:179), while `importsSharedGuard` is a separate source-text regular expression [lint-telegram-send-funnel-guarded.mjs:196](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:196). They are joined only as two booleans [lint-telegram-send-funnel-guarded.mjs:232](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:232).

   A same-spelled identifier can be locally bound or lexically shadow the import; conversely, import-shaped text can occur without a live import. The check performs neither TypeScript symbol resolution nor any binding relationship between the import and call. Thus the comment’s central claim—“only a bare identifier can resolve to the module import” and together they prove the actual call [lint-telegram-send-funnel-guarded.mjs:188](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:188)—is false.

   This is distinct from the honestly disclosed path-level limitation [telegram-egress-invisible-payload-guard.md:446](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/telegram-egress-invisible-payload-guard.md:446): even the narrower file-level claim that the imported guard is called is unsupported.

3. **DESIGN — “closed-world method classification” covers only direct literal shapes, not every method a sender calls.**

   The call collector retains only string and no-substitution-template arguments [lint-telegram-send-funnel-guarded.mjs:168](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:168). Classification examines calls whose final callee name is `apiCall` or `api`, then takes the first collected literal [lint-telegram-send-funnel-guarded.mjs:281](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:281).

   Method values carried through variables, enums, expressions, computed templates, differently named wrappers, or a newly shaped URL are not classified. A new reader-visible method can consequently reach an existing funnel without appearing in either declared set; the runtime guard silently returns for an unknown method [invisible-payload.ts:257](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:257). A wholly new sender may also fail initial population discovery because that stage requires the source to contain an already-known body method [lint-telegram-send-funnel-guarded.mjs:225](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:225).

   The six-sender shrink ratchet detects disappearance of an existing sender, not an omitted new shape. Therefore the specification’s “every method a sender calls” claim [telegram-egress-invisible-payload-guard.md:155](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/telegram-egress-invisible-payload-guard.md:155) is stronger than the implementation.

4. **PRECISION — the window-10 behavioral suite violates its own reason-specific assertion rule.**

   The test file says refusals must be matched against their specific reason [window10-guards-behaviour.test.ts:24](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/window10-guards-behaviour.test.ts:24). Its contiguity case clears the entire verdict archive, recreates only passes 30 and 32, and expects the pass-31 contiguity message [window10-guards-behaviour.test.ts:499](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/window10-guards-behaviour.test.ts:499).

   The copied tree still cites many earlier passes. The citation arm therefore reports those missing verdicts first, and the expected pass-31 message is absent. This reproduces in isolation: **51 passed, 1 failed**. The fixture’s assumption no longer constructs the claimed “otherwise contiguous archive.”

5. **PRECISION — the all-marks predicate repair left its governing account and diagnostic stale.**

   Runtime now admits `M` and subtracts `Default_Ignorable` [invisible-payload.ts:60](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:60), but the function’s “precise claim” still lists only letters, numbers, punctuation, and symbols [invisible-payload.ts:99](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:99). The multi-machine account similarly says only L/N/P/S membership matters and explicitly dismisses `Default_Ignorable` drift [telegram-egress-invisible-payload-guard.md:288](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/telegram-egress-invisible-payload-guard.md:288).

   The acceptance inventory still claims eight non-printing controls including a lone combining mark and five positive controls [telegram-egress-invisible-payload-guard.md:426](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/telegram-egress-invisible-payload-guard.md:426), while the actual fixtures now contain seven non-printing cases and ten positives, including Mn, Mc, and Me marks [telegram-send-funnel-invisible-payload.test.ts:270](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:270). The refusal text also describes every rejected value as whitespace or zero-width marks despite rejecting controls, private-use, unassigned, and blank-glyph inputs [invisible-payload.ts:281](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:281).

## REGRESSION-CHECK

The concrete regressions from the last repairs are Findings 4 and 5: the archive-control fixture is stale, and the widened `M` predicate was not propagated through its specification, counts, or diagnostic.

The exact bare-property-access shape from pass 32 is closed: `hasLiveGuardCall` now rejects non-identifier callees. The parser also correctly excludes string/comment call decoys. What remains is not that old shape; it is the unsupported leap from identifier syntax to symbol identity.

The pass-31 coverage-script repairs are present: each mutation restores in `finally`, signal handlers restore touched files, errored runs are excluded from the denominator, and an all-error run exits non-zero [measure-refusal-arm-coverage.mjs:52](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/measure-refusal-arm-coverage.mjs:52), [measure-refusal-arm-coverage.mjs:91](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/measure-refusal-arm-coverage.mjs:91). The stale reader-facing ratio was struck.

Verification at exact commit `1ba2dbc2d`:

- `npm run lint`: exit 0; it reported 6 Telegram senders, 89 standards articles, and 7 swept enforcement gaps.
- The requested funnel and population-parity files: **74/74 passed**.
- Five focused relevant files: **129 passed, 7 failed**. One is Finding 4; six route tests could not open a listening socket in this sandbox (`listen EPERM`) and are environmental setup failures.
- The full suite was attempted with cache disabled. It was already non-green from the same socket/process/home-directory sandbox restrictions and stopped making progress, so I terminated it after sustained inactivity. I do not claim a completed full-suite result.

## FRESH-ATTACK-REPORT

No bypass implementation or payload was constructed.

This reading added three analytical angles that the prior record had not reached:

- It followed the guarded value across the formatter boundary, distinguishing source-codepoint visibility from Telegram-rendered visibility.
- It treated identifier binding as a semantic fact, rather than assuming AST callee shape proves import identity.
- It followed method values as data, rather than varying only quote syntax around direct literals.

That is what this reading can see that the previous thirty-two could not. Pass 32 correctly discovered that “real call expression” was insufficient, but stopped one abstraction layer early at “bare identifier.” Earlier Unicode reviews studied which source codepoints count; they did not ask whether a later transform changes which codepoints a reader receives.

## MY-ACCOUNT-CHECK

The author’s highest-confidence claim is refuted. Bare-identifier syntax plus an import-shaped match asks a better syntactic question, but still does not answer whether the call resolves to the imported guard.

The supplied checkout also does not satisfy the frozen-tree account:

- Current HEAD is `573a6c3f4e181b5010fc67750549fbb51b0d8ce1`, not `1ba2dbc2d`.
- The only tracked difference is the added `pass33-question.md`; substantive reviewed files are byte-identical.
- The branch has no stored upstream, so `local == remote` is not verifiable from this checkout.
- The working tree was not clean at entry: `data/registry.db-shm` and `data/registry.db-wal` were already untracked.

I reviewed the exact target in an isolated checkout. I did **not** run the expensive coverage measurer; I reasoned from its code and existing behavioral test, as the brief permits. Tests created the same two SQLite sidecars in the isolated checkout; I removed those explicit temporary files, and the isolated target checkout finished clean.

I did not modify the supplied worktree. Final `git status --short --untracked-files=all` there is unchanged:

```text
?? data/registry.db-shm
?? data/registry.db-wal
```

The pass-32 account is accurate in one important respect: [pass32-verdict.md:1](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/reports/window10-external-passes/pass32-verdict.md:1) is an abort record, not a verdict.

## MAGNITUDE-METRIC

**5 load-bearing root findings: 3 DESIGN, 2 PRECISION.**

Exclusions beside that number: the already-declared path-level semantic bypass is not recounted; binding variants are one root; indirect method-expression variants are one root; predicate documentation/count/diagnostic drift is one root; sandbox-only socket/process/home failures are excluded; the HEAD mismatch and pre-existing SQLite sidecars are account facts rather than product findings; CMT-1246, CMT-1248, non-Telegram adapters, and exact repairs that held are excluded. No mutation-coverage ratio or arm count is claimed because the measurer was not run.

## TRAJECTORY

For completed passes 25–31, the archived trajectory was `1 → 4 → 7 → 6 → 6 → 5 → 4` [pass31-verdict.md:112](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/reports/window10-external-passes/pass31-verdict.md:112).

Including the non-verdict explicitly, the sequence is:

`1 → 4 → 7 → 6 → 6 → 5 → 4 → [pass 32 aborted] → 5`

The count has risen from the last completed reading. More importantly, three current roots concern the core guard or the check presented as its assurance, not peripheral prose alone.

## CONVERGENCE

Not converged.

The exact pass-32 instance was narrowed, but its replacement still asserts symbol identity without resolving symbols. The closed-world claim remains open to unobserved value shapes, the runtime guard is placed on the wrong side of a representation-changing transform, and a reason-specific guard test is red in isolation. A green lint chain cannot establish convergence while those reasoning links are absent.

## COHERENCE

The tree has substantial local coherence: raw invisible inputs are refused on the tested adapter and lifeline paths; ordinary controls deliver; the shared predicate’s new mark treatment passes its fixtures; refusal recording and restoration logic are present; and the mechanical standards/gap checks are green.

Its assurance story is not coherent end-to-end. “Reader-visible” is decided before reader-facing formatting, syntactic spelling is described as import resolution, a direct-literal recognizer is described as closed-world classification, and the suite’s own specific-reason discipline currently fails. The documentation then describes the superseded predicate rather than the executable one.

The filter-safe brief improved the review process without reducing rigor: all fresh gaps above are stated as code claims and input-shape classes, with no working bypass authored.

## VERDICT

**UNSOUND.**

The repairs improve the tree, but the central claim under review is still false: the send-funnel lint does not establish a call to the imported guard. Independently, the runtime check can approve content before a formatter removes its reader-visible evidence. Those are load-bearing design failures, so the tree does not yet support its declared guarantee.
```
