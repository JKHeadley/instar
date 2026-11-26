# Side-Effects Review — The cold proof (Increment 10)

**Version / slug:** `passkey-inc10-cold-proof`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (a browser-driving proof whose verdict feeds the cell health table and writes pool-wide pauses)`

## Summary of the change

Increment 10 of the approved spec `docs/specs/agent-held-google-passkey.md` (§3.8 the cold proof,
§3.6 outcome mapping, §5.1 admission before a pool-wide action, §4 throttle safety, §2 risk budget,
§13 one browser seat). This is the first increment that DRIVES A BROWSER with a passkey: the
operator-triggered proof of one cell on THIS machine. Nothing enrolls yet (no real cell holds a
credential), so in production the route can only answer 404 / 409 `no-credential` until enrollment
lands; the full path is exercised against the local WebAuthn fixture with real headless Chrome.

- **`PasskeyColdProof.ts`** (new) — `runPasskeyColdProof(deps, input)`: open the cell's proof-only
  profile ON `about:blank` (never the sign-in URL first — a stale cookie from a failed prior sign-out
  must not be presented to Google before the clear; second-pass) → `clearBrowsingData()` → navigate
  to the sign-in URL → the page MUST be a signed-out class
  (`google-account-identity` / `email` / `account-chooser` / `google-passkey-challenge` /
  `provider-choice`) or the proof is `unknown` (`not-signed-out`; a risk page here is
  `risk-page-before-sign-in`) and the credential is NEVER added → add the ONE stored credential to the
  virtual authenticator, record `singleCredential` from the live count → drive at most `maxSteps`
  (default 10, cap 20) steps: a risk / CAPTCHA page stops with `riskPage`; `google-passkey-throttled`
  stops with `throttled`; any terminal class stops; the identity read is POST-SIGN-IN ONLY — it runs
  solely on a page that carries NO closed or parent sign-in class (`unknown`, which is what the
  signed-in landing page is) AND only after `observedAssertion` is already true for the stored id,
  and a `match` / `other` there stops (`signed-in` / `different-identity`); it never runs on a
  sign-in page (Google's passkey prompt shows the typed identifier as an account chip) nor on a
  terminal / risk page (an admin address on a refusal page is not a signed-in identity) and there is
  no post-loop read (second-pass blocking finding); otherwise the action is the FIRST of
  the parent driver's `allowedActions(snapshot, {loginMethod:'google-passkey', intent:'sign-in'})`
  (or a Tier-1 supervisor's choice from that list — an unoffered choice stops the proof); the closed
  action set the proof can perform is `fill-email` / `click-passkey-continue` / `click-not-now` /
  `click-next` / `choose-expected-account` / `wait` → `finally`: remove the credential (only if it
  was added), navigate to the sign-out URL + clear again, close. Outcome =
  `mapPasskeySignInOutcome({finalPageClass, signedInIdentity, observedAssertion, singleCredential,
  transportError, googleSideRemoval})`. Every log line is states only (page classes, action names,
  verdicts) — never the email, never a URL with a query, never a credential; the result object
  carries the same.
- **`GooglePasskeyPageClasses.mapPasskeySignInOutcome`** — one ordering fix: the identity match is
  consulted BEFORE the "unmatched page ⇒ unknown" rule, because the signed-in landing page has no
  closed class (it is not a sign-in page). `security` (mismatch) still wins first, transport still
  forces `unknown`, the not-recognised page still maps first, and the risk classes — the closed
  `google-risk-challenge`, the parent driver's `captcha` (second-pass should-fix: it was missing, so a
  CAPTCHA wearing no Google route mapped to `failed`), and `google-passkey-throttled` — map to
  `unknown` before the identity read (a match read on any risk page cannot become `ready`).
- **`ChromeCdpReloginBrowser`** — three additions the proof needs: `readSignedInIdentity(expected)`
  → `'match' | 'other' | 'none'` — `match` when the expected identity is DECLARED on an element
  (`data-email` / `data-identifier` / `aria-label`, how Google's account chip carries it) or is the
  exact text of a leaf element; `other` ONLY when a different identity is DECLARED and the expected
  one is absent (incidental email text can never produce `other`, because `other` becomes `security`
  — second-pass); the caller decides WHEN the read is a signed-in read; `navigateTo(url)` (main page `Page.navigate` + a readiness
  poll bounded by the operation timeout — request-time credential removal on a top-level move still
  applies); `clearBrowsingData()` (cookies + cache + `Storage.clearDataForOrigin('*')`, tolerant of
  an older Chrome refusing the wildcard — the sign-out check that follows is the authority).
- **`PasskeyWebAuthnFixture`** — a REAL sign-in flow under `?flow=proof`: identifier (Next carries
  the typed identifier) → `pk/presend?flow=proof`, which shows the typed identifier as a `data-email`
  account chip exactly like the real prompt (second-pass: without it the suite could not catch a
  premature identity read) and whose Continue runs `navigator.credentials.get`
  and lands on `/proof/signed-in?who=…` (a `data-email` chip; `target=other` lands as
  `someone-else@example.com` to simulate Google signing in a different account) or, on a rejected
  assertion, on the alert state (`google-credential-not-recognized`); `/Logout`. A bug found while
  wiring: the Continue button's `onclick` embedded `JSON.stringify(landing)` (double quotes) inside a
  double-quoted HTML attribute, so Chrome never rendered a "Continue" control — the proof read every
  page as `unknown`. Fixed with `encodeURIComponent` (no quotes); the real-Chrome suite proves it.
- **Route `POST /passkeys/prove`** (PIN; body `{pin, email, targetMachineId?}`) — order: feature
  gate → PIN → `targetMachineId` other than self ⇒ 501 (the peer form is the `prove` mandate op of a
  later increment <!-- tracked: CMT-544 -->) → no proof browser factory ⇒ 503 → no active grant ⇒
  404 → no store on disk ⇒ 409 `no-credential` (it NEVER creates a store to look inside) → the store's
  `load` refuses (absent / quarantined / machine-scope / machine-id-changed) ⇒ 409 `no-credential`
  naming the reason → admission over the pool memo: `poolAdmission('prove')` + `sameAccountGap` +
  `activePauseFor` ⇒ 409 `proof-refused` with the reason and the memo age → the host-wide browser
  seat (`passkey-proof:<machineId>`) ⇒ 409 `seat-busy` naming the holder → the attempt row is written
  BEFORE the proof runs (a crash mid-proof still counts against the pool) → the proof in
  `<stateDir>/secrets/passkeys/profiles/<emailKey>-proof` (0700; the store's pseudonymous key, never
  the email on disk) → seat released in `finally` → pauses: risk ⇒ account 7 d; throttled ⇒ account
  24 h + machine 1 h → `health.recordOutcome(origin:'operator')` → audit row (states) → 200 with the
  proof result, the pauses written, the cell record, any transition, and `admissionInputs` naming the
  suspension / lease-holder inputs this build does not publish yet (same wording as
  `GET /passkeys/admission`).
- **`passkeyLiveRows`** (routes) — the SECOND-PASS-CLASS finding the integration tests caught while
  building: the admission rows for the gap / pause / rate-limit checks came from the pool memo, which
  is memoised for up to five minutes and therefore could not see an attempt or a pause THIS machine
  wrote after the memo was built. Now this machine's rows are read LIVE from its own ledger and only
  the PEERS' rows come from the memo. Applied to both `POST /passkeys/prove` and
  `GET /passkeys/admission`.
- **Seams** — `ctx.passkeyProofBrowser(profileDir)` (server.ts fills it with a real
  `ChromeCdpReloginBrowser` in passkey mode, headless, 30 s launch / 20 s operation timeouts; tests
  inject a scripted fake or the fixture-policy browser) and `ctx.passkeyProofUrls` (test-only override
  of the accounts.google.com sign-in / sign-out URLs; production has no config key for it).
- Registry / docs: `WriteDomainRegistry` row for `/passkeys/prove` (machine-local); `CapabilityIndex`
  reason; `api.md` row; the features page gains "The cold proof" and its not-yet list shrinks.

## Decision-point inventory

- `runPasskeyColdProof` signed-out precondition — add — a warm session ⇒ `unknown`, credential never added.
- `runPasskeyColdProof` step loop stop rules — add — risk / throttled / terminal / signed-in identity / no action.
- `mapPasskeySignInOutcome` ordering — modify — identity match before the unmatched-page rule.
- Route admission (`poolAdmission` + gap + pause over LIVE local rows) — add / modify — refuses before a browser opens.
- Pauses on risk / throttled — add — written on the local ledger, read pool-wide.

---

## 1. Over-block

- A proof whose sign-in page is not one of the five signed-out classes is `unknown` even if the
  profile is in fact signed out (e.g. Google shows an unclassified interstitial): one `unknown` per
  such run, three ⇒ `unverified` (§4). The restrictive direction; the page-class provenance re-check
  (§14 FD9) is where a new interstitial gets a class.
- `singleCredential` is read from the live authenticator count right after `addCredential`: a
  profile whose virtual authenticator somehow already holds a key makes every proof `unknown`, never
  `ready`. Correct per §3.8 (the third condition) — and the authenticator is per browser launch, so
  it cannot accumulate across proofs.
- A partitioned peer refuses the proof (`passkey-pool-state-unavailable`) — the spec's §5.1 rule —
  so a lone dark machine blocks operator-triggered proofs on every other machine until the pool read
  path classifies it `peer-offline` (its heartbeat stops) or the operator excludes it. Named cost;
  the exclude lever already exists.
- The 6 h same-account gap is ACROSS machines only (per §4 "different machines ≥ 6 hours apart");
  an operator may re-run a proof on the same machine immediately — each run still writes an attempt
  row and pays the seat.
- The seat is the host-wide Playwright seat (§13): an interactive re-login holding it refuses the
  proof with 409 `seat-busy` and the holder's label; nothing waits. The operator retries.
- `maxSteps` defaults to 10 (cap 20): a flow needing more distinct steps is `step-budget-exhausted`
  ⇒ `failed` (a sign-in page was reached, no sign-in, no rejection). The fixture flow needs 3.

## 2. Under-block

- The proof drives ONLY the closed allowed list under `intent: 'sign-in'` — no create / confirm /
  backup-code action can ever be offered, so a proof cannot enroll or change anything on Google. The
  only credential-relevant action is Continue on the passkey prompt.
- `ready` cannot be produced by a page read alone: it needs the CDP `webAuthn.credentialAsserted`
  event for the stored id, the count, and the identity read — three independent observations.
- A signed-in identity that matches but WITHOUT an observed assertion is `unknown` (a cookie
  survived the clear?) — never `ready`, never `failed`. Tested.
- The route reads the store only through `load` (machine-scope + quarantine + machine-id guards);
  a quarantined record is `no-credential`, so a proof cannot un-quarantine anything (release is a
  later increment's operator action).
- A transport failure by itself never writes a pause (a flaky Chrome must not pause an account for a
  week); it is `unknown` and counted by the health table's three-strikes ladder. A transport error
  that lands AFTER a genuine risk / throttled page was already seen still writes that page's pause —
  the page is the evidence, the error is not (second-pass note).
- The attempt row lands before the proof, so a crash mid-proof cannot let the pool forget the run.
- What this does NOT bound: a compromised operator PIN can run proofs as often as the seat allows
  (each is one Google sign-in from this machine). The pool's rate limit applies to ENROLLMENT; the
  spec's proof cadence lives with the watcher increment.

## 3. Level-of-abstraction fit

The proof module is pure orchestration over the browser INTERFACE (`ProofBrowser`) and the existing
page-class / allowed-action floor — no policy of its own. Admission, pauses and health stay in their
modules (increments 8 and 9); the route composes them; the server owns only the browser factory. The
outcome-mapping fix belongs in `GooglePasskeyPageClasses` (the mapping's home), not in the proof.

## 4. Signal vs authority compliance

The proof is a DETECTOR: it produces one outcome that the health table (deterministic) consumes and
the admission policy (increment 4) refuses on. The only blocking authority added is the route's
refusal list, every rule of which is deterministic and named in the response (`proof-refused` with
`reason`, `seat-busy` with the holder, `no-credential` with the store's reason). No heuristic gate; no
LLM in the loop (the Tier-1 supervisor seam exists but is unused here — the deterministic first
allowed action drives the proof).

## 4b. Judgment-point check (Judgment Within Floors standard)

None added. The `supervise` seam is a future judgment point WITHIN the closed allowed list (it can
only pick among offered actions or decline); it is not wired on this increment.

## 5. Interactions

- `ChromeCdpReloginBrowser`'s request-time removal still fires on any top-level move off the holder
  origin or an RP-family frame — the proof's own `navigateTo(signOut)` is on the holder origin, and
  `removeCredential` has already run by then. A double removal is a no-op.
- `PasskeyHealthStore.recordOutcome(origin:'operator')` is the permissive provenance: an operator
  proof's `ready` reopens `breaker-open` / `unverified-stopped` (§4). That is exactly what a PIN-driven
  proof is for; the Bearer outcome route still refuses that provenance without the PIN.
- `passkeyLiveRows` changes `GET /passkeys/admission` too: it now sees this machine's rows live.
  Peers' rows still age with the memo (bounded by their own tick).
- The pool memo is read (not ticked) by the route: after a peer recovers, the memo may still say
  `partitioned` until the next 5-minute tick or a manual `POST /passkeys/pool-state/tick` (tested).
- `PlaywrightSeatLease` default file is `~/.instar/state/playwright-seat-lease.json` (host-wide) when
  no `ctx.playwrightSeatLease` is provided — the same lease the interactive re-login and the seat
  routes use, so a proof and a re-login can never share Chrome.

## 6. External surfaces

- One new PIN route; one write-domain row; docs. No config key. The proof's HTTP footprint on Google
  is one sign-in attempt from the machine's own IP, in a fresh cookie jar, ending in `/Logout`.
- Disk: `secrets/passkeys/profiles/<emailKey>-proof/` (a Chrome profile dir, 0700, under the
  passkey secrets dir that backups / working-set transfers / git already refuse). It persists between
  proofs by design (device-stable) and is cleared at the start and end of each.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The route returns the outcome, the reason, the steps as page classes + actions, the teardown result,
the pauses written and the cell's new state — enough to read a failed proof without a log. The
dashboard button for it is the grid increment. <!-- tracked: CMT-544 -->

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: a proof runs on the machine that holds the credential, in that machine's
own profile, and writes only that machine's ledger + health; peers learn of it through the pool
state (proxied-on-read). Proving a PEER's cell from here is the `prove` mandate op of a later
increment (501 now, never a silent local run against the wrong machine). The cross-machine gap and
pauses already ride the pool memo (tested: m2 is refused by the gap m1's proof opened).

## 8. Rollback cost

Pure code + one route. Reverting leaves any `-proof` profile dirs (inert, no credential inside — the
authenticator is per launch) and the attempt / pause / health rows they wrote (all bounded and
self-expiring). No migration.

---

## Conclusion

The proof reports evidence, not a claim: `ready` only from the observed assertion + one credential
+ the expected identity, everything else named; the browser is cleared and confirmed signed out
before the key is anywhere near it and signed out again after; every refusal happens before a
browser opens and names its reason; the live-rows fix closes a real gap the tests found. Clear to
ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-23 — **Concern raised (1 blocking + 2 should-fix +
3 notes)**; every blocking and should-fix item actioned and re-verified (unit + integration + the
real-Chrome fixture suite) before commit. The reviewer confirmed: `ready` requires assertion + one
credential + match and `mismatch` wins first; the credential is added only after a signed-out-class
snapshot on every path; teardown runs in `finally` on all paths with an honest `teardown.error`; the
refusal order writes nothing (store existence checked without creating one, `load` refuses
quarantined / scope mismatches, the attempt row lands after the seat and before the proof); the seat
is released in `finally`; `passkeyLiveRows` is sound (self rows stamped with the self id, peer rows
forced to the peer's id, the memo's self rows filtered before the live ledger is appended — no double
count); audit and console lines carry states only; the fixture's `?flow=proof` Continue performs a
real `navigator.credentials.get`.

1. **blocking — the identity read was not a signed-in read.** `readSignedInIdentity` ran on EVERY
   step before acting and again after the loop on terminal / risk pages, and answered `match` for the
   expected email anywhere on the page and `other` for any other email-shaped text. On real Google the
   passkey prompt shows the typed identifier as an account chip ⇒ step 1 would read `match` ⇒ stop
   before Continue ⇒ no assertion ⇒ every proof `unknown` (three ⇒ `unverified`); and an admin address
   on a Workspace refusal page or a footer contact ⇒ `other` ⇒ `security`, the terminal
   re-enrollment-only state, with no sign-in having happened. The fixture masked it (the prompt
   carried the identifier only in the URL) and the unit fake scripted `['none','none','match']`.
   **Fixed three ways:** the proof reads identity ONLY on a page with no sign-in class (`unknown`) AND
   only after `observedAssertion` is true, and never after the loop; `readSignedInIdentity` answers
   `other` only for a DECLARED (`data-email` / `data-identifier` / `aria-label`) different identity,
   never for leaf text; the fixture prompt now shows the `data-email` chip. New tests: a chip on the
   prompt does not stop the proof (read called exactly once, on the landing page); an `other` on a
   refusal page ⇒ `failed`, identity never read; an `other` on an unclassified page WITHOUT an
   assertion ⇒ `unknown`, never `security`; the real-Chrome suite proves `ready` through the chip.
2. **should-fix — `captcha` was a risk page for the proof but not for the mapper.** The proof set
   `riskPage` (⇒ 7-day pause) for the parent `captcha` class, but the mapper only mapped
   `google-risk-challenge` / `google-passkey-throttled` to `unknown`, so a CAPTCHA yielded `failed`
   (healthy → degraded) and — with the old post-loop read — a CAPTCHA after the assertion with the
   email visible could yield `ready`. **Fixed:** `captcha` maps to `unknown` before the identity read;
   tests on both the mapper and the proof (`captcha` after the assertion with a match ⇒ `unknown`,
   `riskPage: true`).
3. **should-fix — `open(signInUrl)` reached Google before the clear.** A stale session cookie from a
   prior failed sign-out was presented once before `clearBrowsingData()` (no key loaded, so not a
   credential exposure, but §3.8's "cleared before each proof" was not literal). **Fixed:** the proof
   opens on `about:blank`, clears, then navigates; asserted in the unit suite (clear precedes the
   sign-in navigation).
4. **note — the prove response did not say which admission inputs are unpublished.** **Actioned:**
   the response carries `admissionInputs: { suspension, leaseHolder: 'not-published-on-this-build',
   memoAgeMs }`, the same wording as `GET /passkeys/admission`.
5. **note — pause tests assert names, not durations.** Left as is; durations (7 d / 24 h / 1 h) are
   single literals in the route, verified by inspection and stated in the docs.
6. **note — "transport failures never write a pause" was over-stated.** Wording corrected above: a
   transport error after a genuine risk / throttled page still writes that page's pause (the right
   direction).

---

## Evidence pointers

- `tests/unit/passkey-cold-proof.test.ts` — 7: ready with the ordering guarantees (open blank → clear
  → sign-in page → confirm before add; remove + sign-out after; close last; no email in the result),
  the post-sign-in-only identity read (a chip on the prompt never stops the proof; an `other` on a
  refusal page ⇒ failed with no read; an `other` without an assertion ⇒ unknown; a CAPTCHA after the
  assertion ⇒ unknown + riskPage), warm session ⇒ unknown
  with the credential never added, match without assertion / two credentials ⇒ unknown, different
  identity ⇒ security, not-recognised ⇒ credential-rejected (removed-on-google when pending),
  throttled / risk flagged, transport failure ⇒ unknown with teardown still attempted, supervisor
  choosing an unoffered action ⇒ stop.
- `tests/integration/passkeys-cold-proof-routes.test.ts` — 5: gates (dark 503, PIN, no factory 503,
  peer 501, no grant 404, no store / absent record 409 without creating a store); ready through the
  route with the 0700 pseudonymous profile dir, teardown order, seat released, attempt row published,
  same-profile re-proof; risk ⇒ 7 d account pause, throttled ⇒ 24 h account + 1 h machine pause,
  later proofs refused `paused:*`; security / credential-rejected transitions, transport ⇒ unknown
  200 with no pause, seat-busy 409 without a browser or an attempt row; a partitioned peer refuses
  before any browser opens, recovery after a tick, and the cross-machine same-account gap naming m1.
- `tests/integration/passkey-cold-proof-fixture.test.ts` — 4 with REAL headless Chrome: ready
  (identifier → prompt → assertion → identity; no DevToolsActivePort; states-only log; the SAME
  profile proves again), security via `target=other`, credential-rejected for a foreign-RP key (and
  removed-on-google when pending), and the wired route end to end.
- `tests/e2e/passkeys-cold-proof-lifecycle.test.ts` — feature alive over HTTP through the production
  `passkeyProofBrowser` seam (409 before a credential, 200 ready after, health + pool state reflect
  it, Bearer-only refused); dark on the fleet.
- Neighbouring suites re-run green: page classes (unit + driver), pool read path, cell health.

---

## Class-Closure Declaration (display-only mirror)

- No agent-authored-artifact defect — not applicable.
- `unbounded-self-action` — not applicable (the proof runs only on an operator PIN request, one at a
  time under the host-wide seat; it never retries, respawns or schedules itself — the cadenced
  watcher is a later increment and registers there).
