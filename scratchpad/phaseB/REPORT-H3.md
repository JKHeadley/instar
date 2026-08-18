# H3 — hardened verification-core conformance repair

## 2026-08-18 05:57:55 -0700 (PDT)

Subject: PR #1924, starting head `3f47621dbeb3eca0f26523f713ad4c2120f13cf1`.

### Fault 1 — corrected authority-location claim

H3 corrects the documentation rather than changing the trusted core. The HMAC key is generated on the main instrument thread by `crypto.randomBytes(32)`, then its buffer ownership is transferred to the Worker over `MessagePort`. The Worker holds and uses it, zeroes it on close, and no key file is written. Moving key generation merely to preserve the earlier inaccurate sentence would have changed trusted-core behavior outside H3's boundary.

### Fault 2 — standalone post-pinning rejection fixtures

Each fixture pins a legitimate observer session as setup, submits one attacked candidate, verifies the existing authority returns false, verifies the candidate is not in the live authenticated-event set, and emits an UNKNOWN verdict. `authenticatedEvents` counts attacked candidates, not the legitimate setup event.

```text
H3_DUPLICATE_READY setupPinned=true candidateEvents=1 authenticatedEvents=0 verdict=UNKNOWN
H3_UNSIGNED_EVENT setupPinned=true candidateEvents=1 authenticatedEvents=0 verdict=UNKNOWN
H3_REPLAYED_EVENT setupPinned=true setupSequence2=true candidateEvents=1 authenticatedEvents=0 verdict=UNKNOWN
H3_OUT_OF_ORDER_EVENT setupPinned=true attemptedSequence=3 expectedSequence=2 authenticatedEvents=0 verdict=UNKNOWN
H3_IDENTITY_MISMATCH setupPinned=true mismatchedField=guardId authenticatedEvents=0 verdict=UNKNOWN
```

Focused verification:

```text
$ node --test scratchpad/phaseB/authenticated-execution-receipt.test.mjs scratchpad/phaseB/fix-verifier.test.mjs
tests 24
pass 24
fail 0
exit 0
```

Repository gates:

```text
$ npx tsc --noEmit
exit 0
$ npm run lint
exit 0
```

Boundary verification: only the authority test file and this report were changed. The signing algorithm, sequence and identity checks, receipt binding, `authenticated-execution-receipt.mjs`, and `fix-verifier.mjs` are unchanged.

State: BUILT WITH HAND EVIDENCE; independent re-judgement pending. Pull request only; no merge.
