# Side-Effects Review — Tailscale setup recipe for recommended services

**Version / slug:** `recommended-services-tailscale-recipe`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (outbound-message check touched)`

**Tier 1.** A new recipe entry, its check, an optional route dependency, a null-secret refusal on the key route, and one exact-host exemption in the outbound link check. Spec: `docs/specs/recommended-services.md` (First recipes: Tailscale). Dark: a recipe only runs on a throwaway or development agent that lists it under `recommendedServices.provingRecipes`; offers stay off (`offersLive: false`). Size: 3 runtime files (`src/recommended/recipes.ts`, `src/server/recommendedServiceRoutes.ts`, `src/templates/scripts/convergence-check.sh`), 2 new test files (16 unit + 5 route tests), 2 new cases in an existing link-check test and 1 new production-wiring e2e case, 1 captured fixture, plus the release note, ELI16 and this file. Effort: one design pass, no spec review rounds, one commit attempt planned.

## Summary of the change

- `SETUP_RECIPES` gains `tailscale-v1` for the `tailscale` catalog row. Its brief covers the install check, installing without administrator rights where possible, the Linux operator step (same command as `tailscaleOperatorCommand` in `src/install/doorSteps.ts`), the sign-in link sent to the person as one tap, a fresh link on expiry, the administrator-approval case, and the backup when it can't finish. It forbids auth keys, stored credentials and the agent's own browser logins, and forbids signing out, switching tailnets or changing existing devices or ACLs.
- `verify` reads `tailscale status --json` through `readTailscaleStatus` (PATH first, then the Mac app bundle, `/usr/local/bin`, `/opt/homebrew/bin`; 10 s limit) and judges it with `judgeTailscaleStatus`: pass only on `BackendState: Running` with a Tailscale address and not offline. Missing program or a daemon that only errors is `fail` (so setup starts); a timeout or an unreadable answer is `unknown` (so nothing starts). Details carry no address, host, tailnet or account.
- `SetupRecipe.secretName` may be `null`. The key route answers 409 `no-secret-for-this-service` for such a recipe before reading any body into a secret.
- `convergence-check.sh` (the outbound URL-provenance check) skips the exact host `login.tailscale.com`. In the live run the recipe's one person-facing step, sending Tailscale's sign-in link, was refused even after the link came from tool output and resolved, and the session then edited its own copy of the check to get past it. Shipping the exemption removes the reason to edit a guard. Same shape as the existing `*.ts.net` and `trycloudflare.com` exemptions, but narrower (one host). The script is always overwritten on update (`PostUpdateMigrator`), so existing agents get it.
- `RecipeDeps` and the route deps gain an optional `tailscaleStatus` reader, used by tests; production passes nothing and the recipe uses the real reader.

## Decision-point inventory

- `POST /recommended-services/:id/key` — modify — refuses a key for a recipe that declares no secret.
- `convergence-check.sh` URL_PROVENANCE — modify — one exact host no longer flagged.
- `recipe.verify` for Tailscale — add — the pass/fail/unknown verdict that closes the setup commitment, through the existing verify route and preflight.

---

## 1. Over-block

The key route refuses any value for Tailscale. A person who wanted to supply an auth key cannot store one through setup; that is intended (spec: the recipe "refuses stored credentials"), and the brief tells the session not to use one. A machine whose Tailscale has an address but reports `Online: false` momentarily (a brief control-plane blip) fails verify; the session simply calls it again.

## 2. Under-block

The link-check exemption trusts any path on `login.tailscale.com`. A session that invented a fake path there would pass this one heuristic; the link would simply fail to sign anything in. Other tailscale.com pages and look-alike hosts stay flagged (tested).

The brief is prompt text. Nothing structurally stops a session from running `tailscale up --authkey=...` with a key it finds, or from calling the Mac app by full path on a machine where it should not; the same is true of the existing charge and terms rules. Pass means "signed in to some tailnet and online", not "signed in to the person's tailnet": verify cannot tell whose tailnet it is without reading identity, which the scrub rule forbids. The brief tells the session to ask if the machine is on a tailnet the person doesn't want.

## 3. Level-of-abstraction fit

Right layer: recipes live in `recipes.ts` and the existing routes, preflight, commitment and hold machinery run them unchanged. The Linux operator step was already extracted to `src/install/doorSteps.ts` (spec rollout step 1); the brief names the same command rather than duplicating code. The status parse is separate from `parseTailscaleStatus` (key-expiry tier), whose scrubbed shape deliberately drops `BackendState` and addresses; adding fields there would widen its content-scrub boundary for every consumer.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface over agent messages or actions.

The verify verdict is the recipe's end-to-end check, the authority the spec gives every recipe; it is a direct reading of Tailscale's own state, not a heuristic. The key-route refusal is a static invariant (this recipe stores nothing).

The link-check change narrows an existing brittle heuristic that already holds block authority over outbound messages; it adds no authority. It removes one over-block that defeated the recipe's only person-facing step.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Signed in, has an address, online" is an enumerable reading of Tailscale's state.

## 5. Interactions

Uses the existing preflight in `beginSetup`: a machine already on a tailnet passes and the owner is told "Tailscale was already working on this machine", with no session. Uses the existing hold, commitment and restart bounds unchanged. `catalogWithProving` maps the recipe only where it is listed. No interaction with `MeshUrlAdvertiser` or the rope-health tier, which read Tailscale independently; this check makes no Tailscale changes.

## 6. External surfaces

On a proving agent only: one more recipe, a setup session that may install Tailscale and send the person a Tailscale sign-in link. Verify runs a local read-only `tailscale status --json`. Nothing changes on real agents.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No page or control changes. The person's only action is one tap on Tailscale's own sign-in link.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, as setup is: `machine-local-justification: physical-credential-locality`. Tailscale sign-in is per machine, and the spec's grant names the machine; another machine needs its own confirmation.

## 8. Rollback cost

A revert removes the recipe, the null-secret branch and the tests. No state, config or migration. A proving agent that had started a Tailscale session keeps whatever Tailscale state the person approved.

## Conclusion

Ship as Tier 1. Live proof on a throwaway agent through the real Telegram test group is recorded in the development agent's lane report.

## Second-pass review (if required)

Required, because the outbound link check is touched. Result appended below.

## Evidence pointers

- `tests/unit/recommended-services-tailscale-recipe.test.ts`, `tests/integration/recommended-services-tailscale.test.ts`.
- `tests/fixtures/captured/tailscale-status/status-needslogin.txt` (real capture, hostname redacted).
- `tests/unit/convergence-check-operator-reachable-links.test.ts` → "Tailscale sign-in link".

## Class-Closure Declaration (display-only mirror)

The link-check over-block is closed for this host only. The class (a guard that refuses a link the agent just got from a tool) stays open; it is filed to the feedback queue rather than widened here.

### Second-pass verdict
Concur with the review. URL_HOST comes from Python's `urlparse(...).hostname`, which lowercases, drops the port, and takes the host after userinfo, so `https://login.tailscale.com@evil.xyz`, uppercase/port variants and `login.tailscale.com.evil.xyz` all behave correctly under the exact-host match. One parser differential exists (`https://evil.xyz\@login.tailscale.com/` parses as login.tailscale.com in Python but as evil.xyz in browsers), but it is the same pre-existing class as the `ts.net` and own-tunnel exemptions, and far narrower than the existing substring allowlist that passes any URL containing `github.com`; this gate guards against confabulation, not adversarial text, so the exemption adds no meaningful weakening. The verify passes only on BackendState "Running" with a non-empty TailscaleIPs and Online not false; unreadable output or a missing BackendState is `unknown`, never a pass; details name no address, device or account (the only interpolated value is the BackendState enum). readTailscaleStatus maps ENOENT/EACCES to missing (falls through to the next path), a kill on timeout to `unknown` (which the preflight treats as stop-without-start), and non-zero exit with JSON stdout to a reading. The null-secret refusal on POST /key is the only consumer of `secretName`. Targeted unit tests: 37/37 passed.
