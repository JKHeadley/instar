## What Changed

The `instar/local-verify` commit status — the one required check on the instar
repository, meaning "the server ran the full suite on this exact head" — could be
written as `success` from GitHub Actions results instead. That happened whenever
the server's floor gate read anything other than "effective": one transient
failure of the ruleset-bypass settings read, or the verifier being switched off,
moved an eligible pull request onto the Actions mirror, which stamped
`success · actions-floor green` with the local verifier's name.

On 2026-10-25 at 04:08:46 UTC exactly that read failed once. At 04:09:20 the
mirror posted success on eleven heads, five of which had never passed the local
suite at that version (their latest records were `error: verifier-mismatch`).
GitHub's native auto-merge, armed on those pull requests, merged all five within
a minute. The read recovered at 04:10:19.

Now the **configured** floor decides who may say success. On a configured-local
install an eligible pull request stays on the local floor; when the local
verifier cannot vouch — a settings read failed, an operator edit is outstanding,
or the verifier is disabled — the status is `pending` with the reason named
(`local-floor held · settings-unreadable`, `… · verifier-disabled`, …). It never
copies Actions results. The Actions mirror still serves installs whose configured
floor is `actions` and pull requests that were never eligible for the local floor.

Each hold episode writes one audit row (`local-floor-held` / `local-floor-released`
in `.instar/logs/local-verify.jsonl`), raises one attention item and one
degradation report; `GET /local-verify/status` shows the reason as `floor.hold`.

If you deliberately want Actions results to stand in for the local suite, set
`monitoring.greenPrAutoMerge.floor` to `actions` — that path is unchanged.
Disabling `monitoring.localVerify.enabled` alone now holds merges (pending)
instead of silently letting Actions decide.

## Evidence

- `.instar/logs/local-verify.jsonl`: `04:08:46.421Z floor-settings state:
  settings-unreadable from: effective, rulesetRequiresCheck: true,
  classicContexts: 0, bypass: null` → eleven `status-posted … success
  actions-floor-green` rows at `04:09:20Z` (PRs 1955, 2210, 2199, 2208, 2311 among
  them) → `04:10:19Z floor-settings state: effective`.
- `gh api repos/JKHeadley/instar/commits/5aec79544aeaf1287ad75e660ef13b880784eda5/statuses`:
  `02:59:55Z failure error:verifier-mismatch` → `04:09:19Z success actions-floor
  green` → `04:10:23Z pending withdrawn`.
- `tests/unit/localVerify/floorGate.test.ts` — the incident shape (only the bypass
  read fails ⇒ `settingsReadable()` still true, floor stays local with a named
  hold); `statusProjection.test.ts` — a held local-floor PR is pending even with a
  green record and green Actions runs, Actions/ineligible unchanged, shared head;
  `StatusReconciler.test.ts` — (a) configured local + verifier disabled ⇒ pending,
  one audit + one signal per episode; (b) the incident replay with recovery; (b2)
  awaiting-edit-a is a hold; (c) configured actions unchanged. Canary: with the
  `src/localVerify` diff reverted the new tests fail; applied, 87/87 pass.
- Side-effects review: `upgrades/side-effects/lv-no-actions-floor-fallback.md`
- Plain-English overview: `docs/specs/lv-no-actions-floor-fallback.eli16.md`

## What to Tell Your User

Nothing unless they run the instar repository's merge line. For them: the
required local-verify check can no longer turn green from GitHub Actions results
on an install that has chosen the local floor. If the server's own test run
cannot vouch for a pull request — a GitHub settings read blipped, or the verifier
is switched off — the check shows as pending with the reason written in it, and
auto-merge waits. A green check means the full suite ran on that exact version,
every time.

## Summary of New Capabilities

None — this closes a gap in an existing safety rule. New observability only:
`floor.hold` on `GET /local-verify/status`, and one audit row, attention item and
degradation report per hold episode.
