# Side-Effects Review — Secret Drop signed submissions: unambiguous, versioned encoding

**Version / slug:** `secret-drop-signed-submit-v2`
**Date:** `2026-11-16`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 2 source files + 1 test file + 3 docs. `src/server/SecretDrop.ts`:
- **New encoding.** `canonicalSubmitMessageV2` is domain-tagged JSON over the token and the declared `[name, value]` pairs sorted by name. It is unambiguous.
- **Signer.** `buildSignedSubmission` signs the trimmed values (what the receiver stores). It uses v1 when no value spans a line, since v1 is unambiguous there and older receivers can verify it. Otherwise it uses v2 and marks the submission `_sigv: "2"`.
- **Verifier.** `submitWithReason` verifies v2 when marked. Unmarked (v1) submissions are accepted only for an encoding whose values contain no line break; both the trimmed and the as-sent form are tried. Any other version is refused. Every refusal returns before the one-time token is consumed.
- **Compatibility.** `submit()` keeps its signature and delegates to `submitWithReason`.

`src/server/routes.ts`: the submit route answers an outdated or unknown signature format with a 400 and a plain, per-case message instead of the generic 410.

Class of problem: two different value sets could share one signed encoding. Found by the standing security review (reproduced offline).

## Decision-point inventory

- Signed-submit verification — modify — versioned, deterministic; v1 restricted to its unambiguous subset.

---

## 1. Over-block

A multi-line value signed by an older sender (v1) is now refused with "update Instar on the sending machine and send it again". This is unavoidable: that format cannot prove which multi-line values were signed. The link stays valid for a retry. Single-line values from older senders are unaffected.

## 2. Under-block

v1 stays accepted for break-free values until it is retired; that subset is unambiguous (shown in the second-pass review). `_sigv` is not signed, and needs no signature: v1 and v2 bytes cannot overlap (hex token first vs `[`), and stripping the marker routes to v1, which refuses multi-line values (tested). Existing and unchanged: a declared field literally named `_sig` or `_sigv` collides with the signature fields and fails closed.

## 3. Level-of-abstraction fit

Signer and verifier stay in one module, so they share both encodings.

## 4. Signal vs authority compliance

- [x] Deterministic cryptographic check; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- **Older receivers:** a new sender's single-line submission is still v1 and verifies on them. A multi-line one is v2, which an older receiver refuses (as it should). No in-tree code signs submissions today; the signer is exported for peer senders.
- **Older senders:** single-line values verify (also when they signed untrimmed values, which previously failed).
- **Token:** never consumed by a refused submit.

## 6. External surfaces

The submit route returns 400 (with `reason`) for the two signature-format refusals; other failures keep their 410. The 400 is only reachable after a correct CSRF token.

## 6b. Operator-surface quality

The sender gets a plain message that says what to do.

## 7. Multi-machine posture

Machine-local BY DESIGN: verification happens on the receiving machine; the signer runs on the sending one. Mixed versions are handled as in §5.

## 8. Rollback cost

Pure code change: revert and ship a patch. No migration; v2-signed multi-line submissions would again be refused by a reverted receiver.

---

## Conclusion

Closes the ambiguity, keeps older peers working wherever that is safe, and tells the sender what to do otherwise. The second pass concurs. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff before this artifact)
**Independent read of the artifact: concur.** v2 is injective (lone surrogates are escaped; the sort order is shared; the name set cannot differ for an accepted signer). The v1 break-free subset is unambiguous, even with `=` or a newline in a field name. There is no downgrade path. No token is burned on refusal, and the 400 is not reachable without CSRF.

Its notes are applied:
- The signer now uses v1 for single-line values, so new senders still reach older receivers.
- An unreachable line is removed.
- The refusal message is specific to each case.
- Tests now cover a stripped version marker and the v1 form older receivers verify.

Noted and left unchanged: field names `_sig`/`_sigv`/`__proto__` (they fail closed; this predates the change); the trust check answering 403 before the CSRF check on that route (separate, pre-existing).

---

## Evidence pointers

- `tests/unit/SecretDrop.test.ts`: 9 new tests covering colliding v1 bytes vs distinct v2 bytes; a v2 signature not verifying another value map; v1 multi-line refused with a reason; v2 multi-line round trip; v1 untrimmed signer; trimmed signing; unknown version; the v1 form for single-line values; a stripped marker. 49/49.
- The pre-change acceptance of an altered value map is shown by the private offline repro (2026-11-16).
- Related unit files (mobile secrets writes, console secrets, recommended-services Bitwarden recipe, capabilities, tier classifier): 305/305.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in a signed encoding, closed by the tests above).
