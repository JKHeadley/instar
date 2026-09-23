# Side-Effects Review — Closed Google page classes, outcome mapping and the credential-action floor (Increment 7)

**Version / slug:** `passkey-inc7-page-classes`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (a page classifier that decides what the repair browser may act on)`

## Summary of the change

Increment 7 of the approved spec `docs/specs/agent-held-google-passkey.md` (§3.6 "Closed page classes"
+ its outcome mapping and the "credential-affecting actions have a structural floor" rule; §11 rows
for `credential-rejected`, the risk page and the Workspace refusal). Nothing here mints, stores or
uses a passkey; it teaches the existing repair browser and driver WHICH Google pages exist and WHAT
may be done on each, ahead of the enrollment (§3.7) and cold-proof (§3.8) increments that will drive
them.

- **`GooglePasskeyPageClasses.ts`** (new): the closed set of twelve classes; a PURE, self-contained
  `classifyGooglePasskeyPage(facts, origins)` over REDACTED structural facts only (exact origin,
  sign-in route on every Google route generation, bounded element ids, exact lower-cased control
  labels, role/landmark booleans — never prose, values, query strings or the email); `null` for an
  unmatched page; `PAGE_CLASS_PROVENANCE` tags each predicate `measured` (from the 2026-09-20
  prototype notes) or `documented` (Google's long-stable routes/ids not yet visited);
  `TERMINAL_GOOGLE_PAGE_CLASSES` (the six no-action classes); `mapPasskeySignInOutcome` — `security`
  first (a different identity signed in), `unknown` on transport error / risk / throttle / unmatched,
  `credential-rejected` only from the not-recognised page (recorded `removed-on-google` while the
  cell's Google-side removal is pending/attested/verified), `ready` only with identity match AND the
  observed assertion AND a single-credential authenticator, else `failed`.
- **`ChromeCdpReloginBrowser.snapshot`**: extracts the structural facts in-page — RENDERED elements
  only (`getClientRects().length > 0`, the same visibility test the real click applies; Google keeps
  hidden dialogs/menus in the DOM), buttons listed before links so truncation can never drop the
  prompt's own control — and runs the SAME serialised classifier BEFORE the parent prose/selector
  chain; a structural match wins, `null` falls through unchanged. New snapshot bit `hasNotNow`. `click` gains the exact-label targets
  (`passkey-continue`, `try-another-way`, `create-passkey`, dialog-scoped `create-passkey-confirm`,
  `not-now`); the email fill also reaches Google's real identifier field
  (`input[type="text"]#identifierId`, measured); `fillSecret('backup-code')` targets `#backupCodePin`.
- **`AnthropicReloginBrowserDriver`**: the request carries `intent: 'sign-in' | 'enroll'` (absent ⇒
  sign-in) and an optional `secretRefs.backupCode`; `allowedActions` computes the list for the new
  classes — a credential-CREATING control ("Create a passkey", its confirm, a backup-code submission)
  appears ONLY on its exact class AND only under `enroll`; a sign-in drive can decline the speedbump
  (`click-not-now`) but never mint; the passkey prompt offers `click-passkey-continue` to the
  `google-passkey` method and `click-try-another-way` to the password family, nothing to anyone else.
  `drive()` maps `google-risk-challenge` to the existing operator-only `captcha` outcome and every
  terminal passkey page to the existing `passkey-refused` refusal before any supervision; `perform`
  re-checks method/intent so even a mis-chosen action cannot act. The Google ACCOUNT origin
  (`myaccount.google.com`, where the passkey settings classes live) is admitted to the drive's origin
  allowlist ONLY under `intent: 'enroll'` — a sign-in repair that lands there is still refused
  `unexpected-origin` before any class logic, exactly as before this increment.
- **`OriginPolicy.accountOrigin`** (optional): `myaccount.google.com` in production, the fixture's
  other origin in tests; it is in the RP family, so the credential is removed before any document
  there loads — classification there never coexists with the key.
- **Fixture**: redacted page-class pages on both fixture origins, each carrying the structure of one
  class plus prose the parent chain would misread, plus `/parent-chain` (no structural class).
- Docs: the features page gains the page-class section.

**Not in this increment:** the enrollment worker and cold-proof worker that DRIVE these classes
(§3.7/§3.8), the Google-side passkey-list snapshot/diff (§3.7 "capture `googleCreatedAt`"), backup-code
consumption bookkeeping (§3.7 — the floor here only refuses the fill outside an enroll drive), and
the Rung-1 live re-check of the `documented` predicates (§14 FD9). <!-- tracked: CMT-544 -->

## Decision-point inventory

- `classifyGooglePasskeyPage` — add — deterministic structural match; unmatched ⇒ null ⇒ parent chain ⇒ `unknown`.
- `allowedActions` for the new classes — add — structure × admitted method × intent; supervisor chooses or declines.
- `drive()` terminal mapping — add — closed allowlist of classes to existing outcomes.
- `mapPasskeySignInOutcome` — add — fixed precedence; `ready` is a conjunction.

---

## 1. Over-block

- A Google page that changed shape (route or control label) classifies `null` → the parent chain →
  usually `unknown` → the driver waits and eventually returns `provider-transient`. That is the
  intended safe direction; the cost is one failed proof/repair, never a wrong action.
- `google-passkey-challenge` requires the exact `Continue` label; a localisation would make the
  prompt `unknown`. Accepted for now (Rung 1 runs in English; the live step revisits).
- **The one mis-read that is NOT the safe direction** (second-pass finding): `credential-not-recognized`
  feeds `credential-rejected`, which COUNTS toward pool-wide suspension (§2), and canaries run this same
  classifier, so a false rejection would corroborate itself. The predicate is therefore deliberately
  conservative: a prompt that still offers `Continue` is ALWAYS the challenge (a live-region
  announcement never flips it); a rejection needs the prompt's action GONE plus a visible alert plus the
  page's own recovery control (`Try another way` ⇒ not-recognised; `Try again later` ⇒ throttled); alert
  without either control ⇒ `null` ⇒ `unknown`. Both rejection classes are `documented` provenance
  (the prototype never reached them) and are on the Rung-1 gate list (§14 FD9) before any unattended
  use — a wrong guess there costs a proof marked `unknown`, never a suspension.
- Hidden DOM (a `display:none` dialog, an off-screen "Not now") is ignored by construction — only
  rendered controls, dialogs and alerts enter the facts — so a hidden confirm dialog cannot turn the
  create page into `create-confirm`.
- The account-origin alert without an admin-help link stays `google-passkey-list` (never assumed to
  be the Workspace refusal).

## 2. Under-block

- `documented` predicates (create-confirm, throttled, not-recognised, backup-code) have not been seen
  live; a wrong predicate can only produce `null`/`unknown`, never an action on the wrong page, because
  every credential action needs the exact class AND the enroll intent AND the supervisor's choice.
- The classifier reads exact control labels from DOM text; a page that renders the label as an image
  or via CSS would not match (⇒ unknown).
- The risk page is matched by route or widget; a risk interstitial with neither is `unknown` and the
  drive still stops with no action (the driver only waits on `unknown`).

## 3. Level-of-abstraction fit

Same shape as the parent driver: the browser produces closed state, `allowedActions` computes the
list from structure, the Tier-1 supervisor chooses. The classifier is a pure module the browser
serialises; nothing about passkeys leaks into the orchestrator or the runtime.

## 4. Signal vs authority compliance

The structural class is a SIGNAL that narrows the allowed list; it never grants an action on its own
(the supervisor must still choose and can decline). The only authority added is restrictive: terminal
classes end the drive with existing refusal outcomes. The supervisor cannot add a credential action
(verified by the "picks an action it was not offered" test).

## 4b. Judgment-point check (Judgment Within Floors standard)

One judgment point remains where it was: the Tier-1 supervisor choosing from the structural list. The
floor is the list; this increment narrows it for the new classes and adds no new judgment.

## 5. Interactions

- Ordering with the parent chain is the whole point: structural first, prose second; proven through
  real Chrome on every fixture page. Honest scope of that proof: the identifier, passkey-prompt,
  backup-code and reCAPTCHA fixtures carry prose/inputs the parent chain would genuinely MISCLASSIFY
  (`totp`, `account-chooser`, `password`); the TOTP fixture would read `totp` under either layer and the
  speedbump/settings fixtures would read `unknown` under the parent — on those pages the test proves
  the structural class is the one reported (not vacuous: structural ≠ parent verdict on every page),
  not a prose misread.
- `allowedActions` for `password`/`totp`/`email` etc. is unchanged; `google-totp-entry` reuses the
  parent's TOTP rule so a passkey drive never fills a TOTP.
- `passkey-refused` already exists in the store's failure allowlist and `BrowserRepairResult`
  (increment 4) — no new failure class, no schema change.
- The credential-removal policy (increment 3) is untouched; `accountOrigin` is an additive optional
  field read only by the classifier.

## 6. External surfaces

- No new routes, no config, no notices. Snapshot shape gains one optional boolean; the browser port's
  `click`/`fillSecret` unions widen (additive; the in-repo implementations are updated).
- Google is never contacted by this increment; the fixture is local.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

None added. The features page explains the classes in plain words and states the provenance honesty.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN and stateless: a pure function inside each machine's browser. No replication,
no state, nothing to strand on transfer.

## 8. Rollback cost

Pure code. Reverting restores the prose-only chain; nothing persisted changes shape.

---

## Conclusion

The repair browser now recognises the closed set of Google passkey pages by structure before prose,
records the honest outcome for each, and can only ever be asked to mint on the exact page, in an
enrollment drive, at the supervisor's choice — with unmatched pages falling to `unknown` and no
action. Clear to ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-23 — **Concur with the review**, with should-fix
items; all actioned and re-verified before commit. The reviewer confirmed: the credential floor holds
end to end (allowedActions → drive's un-offered-action refusal → perform's intent re-check; absent
intent ⇒ no mint), no body prose enters the facts, the parent chain is byte-identical apart from the
structural seed, the classifier is self-contained, `security` precedes everything and `ready` is the
full conjunction, and only the two existing failure classes are used.

1. **Hidden DOM counted** — `hasDialog`/labels matched `display:none` elements (Google keeps hidden
   dialogs in the DOM), so a real speedbump could read `create-confirm`. FIXED: rendered-only facts
   (`getClientRects().length > 0`), buttons listed before links, cap raised; fixture prompt now carries
   a hidden dialog + hidden "Not now" that must not count (tested through real Chrome).
2. **Alert ⇒ rejection was not the safe direction** — any live region on the prompt would have produced
   `credential-rejected`, which feeds suspension, and canaries would corroborate it. FIXED: Continue
   present ⇒ always the challenge; rejection needs action-gone + visible alert + the page's recovery
   control; alert alone ⇒ unknown (tested both ways); §1 now states the hazard and the Rung-1 gate.
3. **Account-origin classes unreachable in the driver** — `myaccount.google.com` was not an allowed
   origin, so the artifact's "every terminal class ⇒ passkey-refused" was proved on an origin those
   classes cannot occur on. FIXED: the account origin is admitted ONLY under `intent: 'enroll'`
   (a sign-in drive is still refused `unexpected-origin` there — tested); driver tests now place the
   account-origin classes on their real origin.
4. (minor) Fixture-honesty — the TOTP fixture reads `totp` under either layer and the settings pages
   read `unknown` under the parent; the artifact and the test comments now say exactly which pages
   prove a prose MISREAD versus structural-precedence only.
5. (note) `Try again later` as a control label is `documented` provenance — on the Rung-1 gate list;
   a mismatch now yields `unknown`, not a rejection (fix 2).
6. (note) `mapPasskeySignInOutcome` is a definition in this increment (its caller is the cold-proof
   worker, §3.8); added the reviewer's requested assertion that a rejection page beats a matching
   identity read.
7. (note) Dialog-scoped confirm matches `Continue`/`Create` in ANY visible dialog — under enroll, a
   stray consent dialog could absorb one wasted click (never a credential action). Accepted; the
   enrollment worker's step logging (§3.7) will make it visible.

---

## Evidence pointers

- `tests/unit/google-passkey-page-classes.test.ts` — 14: every class on every route generation, id
  required not route alone, restriction-first (CAPTCHA/risk beats all), the prompt's alert split,
  speedbump + confirm, the account-origin shapes (list/create/confirm/done/blocked and the
  alert-without-admin-link case), exact-origin refusals (look-alike host, wrong origin per route,
  empty account origin, data: `null` origin), serialised-function parity, the terminal set; outcome
  mapping precedence (`security` first, `ready` conjunction, rejected vs removed-on-google, unknown
  vs failed).
- `tests/unit/anthropic-relogin-driver-page-classes.test.ts` — 12: the allowed-action floor per class
  × method × intent, every class covered, and driving: passkey sign-in through the prompt, password
  drive steps past it, risk ⇒ operator-only, every terminal class ⇒ `passkey-refused` with no
  supervision (account-origin classes on `myaccount.google.com` under enroll), a SIGN-IN drive on the
  account origin ⇒ `unexpected-origin`, sign-in declines the speedbump, a supervisor picking an
  un-offered create action is refused, an enroll drive creates/confirms on the account origin and the
  backup code never reaches supervision.
- `tests/integration/passkey-page-classes-fixture.test.ts` — real headless Chrome against the local
  fixture: structural-before-prose on every holder-origin and account-origin page, fall-through to
  the parent chain, the new clicks by exact label with real pointer input (dialog-scoped confirm
  refuses without a dialog), and the identifier fill reaching `#identifierId`.
- Existing `tests/unit/anthropic-relogin-browser-driver.test.ts`, `…-passkey-method.test.ts`,
  `tests/integration/passkey-browser-fixture.test.ts`, `tests/integration/chrome-cdp-relogin-browser.test.ts`
  green (the parent chain is unchanged for pages with no structural class).

---

## Class-Closure Declaration (display-only mirror)

- No agent-authored-artifact defect — not applicable.
- `unbounded-self-action` — not applicable (a pure classifier and a per-step allowed-action list; no
  self-triggered loop, timer, or emit is added).
