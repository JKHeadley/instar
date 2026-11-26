# Side-Effects Review — Passkey-capable repair browser (Increment 3)

**Version / slug:** `passkey-inc3-browser`
**Date:** `2026-09-22`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (browser drives credential-bearing sign-ins)`

## Summary of the change

Increment 3 of the approved spec `docs/specs/agent-held-google-passkey.md` (§3.5 browser foundation,
§3.1 in-browser credential lifetime, §2 fixture):

- **`src/core/PasskeyBrowserPolicy.ts` (new).** Pure rules for WHERE the passkey may be present:
  the credential is added only while the top-level frame is on the holder origin and no other frame
  is on a different relying-party-family origin; it is removed at request time before any top-level
  navigation away from the holder origin, and before any frame's document request to another
  RP-family origin; unrelated-origin frames are allowed. Parameterised by an `OriginPolicy` so the
  same code runs against the local fixture; production uses the Google policy.
- **`src/core/ChromeCdpReloginBrowser.ts` (extended).** A `passkeyMode` option: CDP over the
  debugging pipe (no TCP port, no `DevToolsActivePort`), `--disable-extensions`,
  `--disable-component-extensions-with-background-pages`, prerendering off; every page/iframe target
  auto-attached (paused at creation) and PREPARED — Page/Runtime/Network enabled, service workers
  bypassed, `Fetch` interception for Document requests, `WebAuthn.enable` + a virtual authenticator,
  the loaded credential added — before it is resumed; a `Fetch.requestPaused` handler that removes the
  credential everywhere before continuing a document request the policy forbids, and fails the
  request closed if removal fails. New port methods: `addCredential`, `removeCredential`,
  `hasCredential`, `observedAssertion` (from `WebAuthn.credentialAsserted`), `exportCredentials`,
  `credentialCount(s)`, `readSignedInIdentityMatches` (boolean only), `sawNavigationBeforeAttach`,
  `clickSelector`, `runInPage`. Clicks now use REAL pointer events (`Input.dispatchMouseEvent`) in
  BOTH modes, including the existing `chooseExpectedAccount`, `click` and the submit step of
  `fillAndSubmit`; fills read the value back before submitting. The legacy TCP path is otherwise
  unchanged and remains the default (`passkeyMode` is off unless a caller sets it).
- **`src/core/PasskeyWebAuthnFixture.ts` (new).** Two local HTTP origins on `localhost` that stand in
  for accounts.google.com and another google.com subdomain, with pages that create and assert
  resident credentials. Used by the integration suite now and by the Chrome-version self-check later.

No caller constructs the browser in passkey mode yet (`server.ts` still uses the default), so there is
no production behaviour change from passkey mode itself. The real-click change does reach the
existing repair path.

## Decision-point inventory

- `mustRemoveCredentialBefore` / `mayAddCredential` — add — invariants over origins (spec §10 rows "Credential-affecting browser actions" / all-frames rule).
- `Fetch.requestPaused` handler — add — applies the policy; fail-closed on removal error.
- Real-click substitution in existing repair actions — modify — no decision change; input mechanics only.

---

## 1. Over-block

- In passkey mode, a document request whose URL cannot be parsed removes the credential (fail closed).
- Real clicks need a visible, non-zero-size element; a hidden button that `element.click()` used to
  reach now raises `browser-element-not-found`. The existing integration test (real Chrome) still
  passes, and Google's list items REQUIRE real clicks (measured 2026-09-21), so this is the right
  trade.
- Fills now refuse to submit when the value did not stick (read-back length check). Before, an empty
  submit cost a failed attempt on the account.

## 2. Under-block

- A same-origin (holder) frame can still request an assertion — by design; that is the sign-in page.
- Prerendering is disabled by feature flag; if Chrome renames the feature, prerender targets would be
  auto-attached like any other target and prepared before running, so the interception still holds,
  but the flag itself would be inert. The fixture suite would not notice a rename; noted for the
  Chrome-version gate increment. <!-- tracked: CMT-544 -->
- `sawNavigationBeforeAttach` observes from `Page.enable` onward, so it can confirm a breach it saw
  but not prove absence. The load-bearing guarantee is Chrome's `waitForDebuggerOnStart` pause
  (a target cannot navigate until it is resumed), which the popup tests exercise directly.
- `readSignedInIdentityMatches` is a generic structural reader (attributes, then exact-text leaf
  elements). The closed `google-account-identity` page class with its fixture lands with the
  enrollment increment; until then it is used only by tests.

## 3. Level-of-abstraction fit

The policy is a pure module; the browser applies it at the one place every document request passes
(Fetch interception at the Request stage). The port grows only by the methods the spec names.

## 4. Signal vs authority compliance

Origin rules are deterministic invariants over URLs, not content detectors, and they can only remove
or refuse — never act on the account. The supervisor is untouched.

## 4b. Judgment-point check (Judgment Within Floors standard)

Invariants (spec §10). No competing signals.

## 5. Interactions

- The existing repair driver is unaffected except that its clicks are now real pointer events and
  fills read back; the existing driver unit tests (15) and the real-Chrome integration test pass.
- In passkey mode, `Runtime.evaluate` and clicks target the MAIN page session; popups are prepared and
  resumed but not driven (no spec step drives a popup).
- `close()` clears the in-memory credential first, then closes the browser.

## 6. External surfaces

None: no route, no notice, no config. Chrome launch flags change only in passkey mode.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

A browser session is machine-local by nature (it drives this machine's Chrome and profile). The
credential material it holds in memory comes from the machine-local store (Increment 2) and never
leaves the process. No state is written by this increment.

## 8. Rollback cost

Pure code. Reverting restores the TCP-only browser and script clicks. No persistent state.

---

## Conclusion

The browser can now hold a passkey safely: attached before any navigation, removed before any
document request that could reach another relying-party origin, and driven with real input. Every
spec-named case is covered by a real-Chrome test against the fixture, and the three load-bearing
behaviours were mutation-checked (removal, add-time origin check, popup loading). Clear to ship after
the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-22 20:33 PDT — **Concern raised**, then fixed
and re-verified (round 2 below).

Round 1 findings (verbatim substance):

1. **`addCredential` ignored other page targets' origins.** The origin walk covered only the main
   target's tree plus iframe targets; popups (`type:'page'`) were never inspected, yet the add then
   loaded the credential into EVERY prepared authenticator. A popup that had earlier moved to
   `myaccount.google.com` (removal fired correctly then) would be re-armed by a later add on the
   holder-origin main page. Spec §3.1 is per-target.
2. **Removal was gated on an in-memory flag, and prepare/remove could interleave.** The sweep skipped
   sessions without an `authenticatorId`; a popup mid-`prepareSession` could be skipped, then read
   `this.credential` before the null write and load it. That target then held the key while
   `hasCredential()` was false, and the request-time hook's flag check short-circuited — its own
   forbidden first navigation would be continued WITHOUT removal.
3. Minor: `topLevel` fell OPEN when `Page.getFrameTree` had failed (a top-level move to a non-RP
   origin kept the key); `sawNavigationBeforeAttach` is a weak diagnostic, not the spec's proof;
   `runInPage`/`clickSelector` were public arbitrary-evaluate surfaces restricted only by a comment.

Confirmed OK by the reviewer: `continueRequest` strictly after `removeCredential` resolves,
timeout/non-"gone" errors → `failRequest`; pipe framing/close handling; real clicks in both modes
with the `form.requestSubmit()` fallback and read-back gate; the mutation claims are credible against
the listed tests; no material is logged (`exportCredentials` is the only egress).

**Fixes (all in `src/core/ChromeCdpReloginBrowser.ts`):**

- (1) `addCredential` now walks EVERY page target: the main target must satisfy `mayAddCredential`;
  every secondary target (popup) must have no frame on another RP-family origin
  (`mayAddSecondaryTarget` — blank/paused, holder-origin, or outside the RP family all pass). A popup
  on another RP-family origin vetoes the add with `passkey-origin-not-allowed`.
- (2) One credential lock (`withCredentialLock`) serialises add, remove and the prepare-time load; in
  `prepareSession` the authenticator becomes visible to removal AND receives the credential in the
  same locked step, so a concurrent removal runs entirely before (credential null ⇒ nothing loaded)
  or entirely after (the target is in its sweep). Removal no longer trusts the flag: it sweeps every
  id this browser EVER loaded (`knownCredentialIds`) from every authenticator, and the request-time
  hook runs whenever any id is known.
- (3) Unknown frame identity (no session record / no frame tree) is treated as TOP-LEVEL — the
  stricter rule; over-remove, never under-remove. `runInPage` / `clickSelector` are refused under the
  production Google policy (`*-fixture-only`), so the arbitrary-evaluate surface exists only against
  the local fixture. `sawNavigationBeforeAttach` is documented as a diagnostic.

**Evidence added:** `tests/unit/chrome-cdp-passkey-credential-race.test.ts` (7 tests against a
scripted CDP `send`, no Chrome): the exact skip-mid-prepare interleave (a later session keeps the
sweep busy while the popup finishes preparing) → no authenticator holds the key; a popup attached
before the removal is swept; a popup on another RP-family origin vetoes the re-add and stops vetoing
once back on the holder origin; an unrelated-origin popup does not veto; unknown frame identity
removes on a non-RP top-level move; a known subframe on an unrelated origin keeps the key; the
fixture-only refusal under the Google policy. Mutation checks: with the lock removed the interleave
test fails (`[0,0,1]`); with the secondary-target veto removed the popup-veto test fails; with the
fail-open `topLevel` restored the unknown-identity test fails. Real-Chrome: a new fixture test opens
a popup, moves it (by window name) to the other RP-family origin, sees `[0,0]`, gets the re-add
refused, moves it back, and sees `[1,1]`.

**Round 2:** the reviewer's two gaps are closed by structure (per-target check; lock + by-id sweep),
each with a test that fails when its fix is removed. Concur.

---

## Evidence pointers

- `tests/unit/passkey-browser-policy.test.ts` — 20 tests, production and fixture policies.
- `tests/unit/chrome-cdp-passkey-credential-race.test.ts` — 7 scripted-CDP tests for the second-pass
  findings (interleave, popup veto, unknown frame identity, fixture-only surfaces).
- `tests/integration/passkey-browser-fixture.test.ts` — 11 real-Chrome tests: pipe transport, mint →
  export → re-inject → assert (portability), add refused off the holder origin, removal on top-level
  move / 302 redirect / RP-family iframe, unrelated iframe keeps it, popup auto-attach with both
  authenticators loaded, popup-on-other-origin vetoes a re-add until it returns, identity read, real
  clicks. Mutation checks: with request-time removal
  disabled the three removal tests fail; with the add-time origin check disabled the refusal test
  fails; with new-target loading disabled the popup test fails.
- `tests/integration/chrome-cdp-relogin-browser.test.ts` (existing, real Chrome, TCP mode) and
  `tests/unit/anthropic-relogin-browser-driver.test.ts` pass unchanged.

---

## Class-Closure Declaration (display-only mirror)

- `unbounded-self-action` — closure: **n/a** — reason: one-shot user-driven action, not a
  self-triggered loop: `ChromeCdpReloginBrowser.open()` spawns exactly one Chrome process per
  operator-approved repair episode (the orchestrator bounds attempts); the browser never restarts,
  retries or respawns itself.
- No agent-authored-artifact defect — not applicable. New capability from an approved spec; no
  self-triggered controller is added.

## Post-review follow-up (CI ratchet)

- `no-silent-fallbacks` counted the two pure-parse catches in `PasskeyBrowserPolicy` (`originOf` → null,
  `isRpFamilyOrigin` → false). Neither hides a decision: null/false are the STRICT branches (removal on an
  unparseable URL; "not in the family" on an unparseable origin). Annotated `@silent-fallback-ok` with that
  reason rather than raising the baseline. No behaviour change.
