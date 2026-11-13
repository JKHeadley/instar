# One secret-store test accepts Node 26's wording for a failed decrypt

<!-- bump: patch -->

## What Changed

Test-only. `tests/unit/secret-store-key-coherence.test.ts`, case "corruption of a v2 store with the MATCHING key still surfaces as a GCM auth failure (distinct from wrong-key)", matched the thrown error against `/Unsupported state|unable to authenticate/i`. That is the wording of Node 24. On Node 26 the same failure reads `error:1C800064:Provider routines::bad decrypt`, and the case failed.

The case now accepts either wording, and adds the assertion that carries its point: the error is NOT the wrong-key diagnosis ("encrypted with key id …", "NOT empty") that the case before it pins.

No production code changes. `SecretStore` does not match on this text; it lets the cipher's error through.

## What to Tell Your User

Nothing changes in the product. One automated test failed on machines with the newest version of Node because an error message was reworded there; it now passes on both.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| None (test-only) | — |

## Evidence

Justin's laptop (Node v26.13.0), 2026-11-13: the unit lane on main at c731068b7 passed 65,719 tests and failed this one; run alone three times, it failed three times with `expected [Function] to throw error matching /Unsupported state|unable to authenti…/i but got 'error:1C800064:Provider routines::bad…'`. On the Studio (Node v24.14.1) the changed file passes 11 of 11.

Not run: the changed test on Node 26. The new pattern is written from the error text the laptop printed, which the log cut after "bad"; "bad decrypt" is OpenSSL's name for reason 1C800064. If the full text differs, the case will still fail there and say so.
