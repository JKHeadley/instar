# Side-effects review: SybilProtection "wrong IP" test no longer fails for a whole epoch

## Change
`tests/unit/threadline/relay/SybilProtection.test.ts` ("rejects solution for wrong IP"): challenge difficulty 8 -> 16 bits. Test only; `src/threadline/relay/SybilProtection.ts` is unchanged.

## Evidence
2026-11-02 21:57 PST: the test failed on `main` (and in PR #2640's verify) on every run (4/4 locally): `expected true to be false`. At difficulty 8 a nonce found for 127.0.0.1 also gives >= 8 leading zero bits for 10.0.0.1 with probability 1/256; the hash includes the epoch, so the outcome is fixed for an entire epoch. With 16 bits: 16/16 passed, three runs, ~26 ms.

## 1. Over-block
None.

## 2. Under-block
Still probabilistic, at ~1/65,536 per epoch instead of 1/256.

## 3. Level-of-abstraction fit
The test chose too low a difficulty for the property it asserts.

## 4. Signal vs authority
Test only.

## 5. Interactions
None.

## 6. External surfaces
None.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
No operator surface.

## 7. Multi-machine posture
Not applicable.

## 8. Rollback cost
Revert.
