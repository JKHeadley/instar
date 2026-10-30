# Standards family delta review — Building and The Substrate: the single-provider floor and the deferral-to-the-cadence gravity well

## Scope and operator authority

This review covers two edits to existing articles in `docs/STANDARDS-REGISTRY.md`. No article is added, removed, moved or renamed.

1. **Building — *Framework-Agnostic — and Framework-Optimizing*.** Under "The floor — works everywhere", a new paragraph, "One provider is enough": an agent with exactly one AI provider is fully functional; a second provider is an optimization, never a requirement; every feature that uses a second provider must declare its single-provider behaviour (a working path on the agent's own provider, or the behaviour that existed before the feature), and may never be silently absent for a capability the agent needs. The paragraph names this as an UNENFORCED SUB-OBLIGATION with the countdown `2026-12-21`, tracked as `STD-SUBCOUNTDOWN-single-provider-floor`, and names the guard to build: a single-provider boot test per supported provider that exercises every feature, plus a declaration lint.
2. **The Substrate — *Name the Gravity Wells*.** A fifth named well, the **deferral-to-the-cadence** trap: tying ready, cheap work to the next scheduled meeting, check-in or review when it could start now. The tell is a due date equal to the next recurring slot with no named external wait; a cadence is a ceiling, never a due date. It is cross-referenced to *Deferral = Deletion*. The article's Earned-from gains one sentence citing 2026-10-14 and 2026-10-26 (topic 95267) and the structural guard filed as feedback `fb-72a0a193-ec3`; the text says the well is named, not guarded.

The authority is the operator (Justin), in Telegram topic 95267 on 2026-10-26: "we should ALWAYS have a functional floor that allows an Instar agent to be fully functional with only a single AI provider (claude, codex, etc)", and "Why do we keep purposefully delaying tasks and stretching them out? This feels like a general AI pitfall/gravity well that Instar should be aware of." Both edits reach the registry only through his code-owner approval of the pull request.

## The delta, measured rather than described

- `git diff origin/main -- docs/STANDARDS-REGISTRY.md`: 4 insertions, 2 deletions, in the two articles above only.
- Family populations are unchanged: Building 43, The Substrate 27, total 93. No tree relation, tracked id, family membership or existing enforcement claim changed; the hierarchy block is unchanged.
- The sub-obligation countdown total rises from 38 to 39; the new id matches the lint's declaration form.

## Enforcement classification

Neither edit claims enforcement. The single-provider floor is stated as an unenforced sub-obligation inside an article whose existing guard covers only the session launch/inject/resume surface, with a dated countdown that turns CI red if it passes unbuilt or un-redated. The gravity well joins a judgment-bound list; the text says it is named, not guarded, and points to the filed feedback item for the structural guard. The family reference-resolution floors (Building 34/40, The Substrate 16/26) are carried forward unchanged.

## Checks run on the candidate

`generate-standards-hierarchy.mjs --check`, `lint-registry-insertion-placement.mjs` (93 articles, 82 placed), `lint-registry-tree-parentage.mjs` (41 relations, all bidirectional), `lint-documented-only-countdown.mjs` (4 article + 39 sub-obligation countdowns, all unexpired), `lint-no-duplicate-definitions.mjs`, `lint-single-governing-obligation.mjs`, `lint-standard-code-backreference.mjs` and `lint-framework-list-completeness.mjs` are clean. The registry-related unit tests pass apart from the area-audit currency assertion this record satisfies.

## Areas attested

| Family | areaSha256 | Verdict |
|---|---|---|
| Building | `baba2157f5a9566a8ca825131c875e5ac4f4808211363ccb889abcb189e55595` | accepted |
| The Substrate | `d48659d1b19c4425d5475987c65f20d2bcc3f5839c9691c4eb87654a8448cb76` | accepted |

## Independent acceptance

An independent verifier re-derived the claims from the repository rather than from this report: the two-edit scope and per-family counts from the diff against `origin/main`; the lint results; the countdown total (38 on `origin/main`, 39 here); that the new text claims no guard that does not exist and does not contradict the REPL-pool floor or `STD-SUBCOUNTDOWN-engine-parity-offsurface`; that "sentinels routed to Codex on a Claude agent" is a real dependency (the provider-fallback default policy in `IntelligenceRouter.ts`); that `gpt-6-luna` is a real second-provider dependency (`JevCascade.ts`); and that the Jev integrations fall back to their pre-Jev behaviour or stay inert without a TypeSafe key (`JevSignalShadow` detector fallback and `disabled-no-key`, the memory picker's pinned-only fallback, and the dark-gate entries for the correction, circles and review-flag shadows).

It raised one finding, resolved before acceptance: the new well was joined to the list with a period and a lowercase "the"; it now continues the semicolon-separated list ("; and the **deferral-to-the-cadence** trap").

Reviewers: `echo:claude-code`, `independent-verifier:claude-code`.

## Later wording edit

After this review, the Building text gained one attribution clause saying the single-provider floor mirrors Instar 2.0 Rule 118 and that the master wording governs. No obligation changed, so the verdict stands. The Building hash above is the one for the final text.
