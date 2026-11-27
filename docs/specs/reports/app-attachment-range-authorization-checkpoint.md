# Attachment range authorization checkpoint

The server change remains staged and the feature is off by default. This checkpoint records the focused result for the corrected exact-content route. The attachment feature design remains a draft.

## Current access precedes file size

After an asynchronous attachment record read, the exact-content route rechecks signed owner admission, live conversation access, the media and browse settings, and the same selected attachment reference and message index. Only then can an authorized unsatisfiable range receive `416` with a `Content-Range` size. The route checks authorization and exact record and descriptor custody again before sending verified bytes. The selected attachment can be purged even when another message refers to the same blob.

The three new held-read cases revoke the signed owner, tombstone the conversation, or purge the selected reference before the awaited record returns. Each receives its ordinary denial without a size header or blob open. The authorized cases still receive the exact bytes for a valid range and the correct size for an unsatisfiable range.

## Verification

The normal enforcing integration runner admitted one filtered run of `tests/integration/mobile-native-conversations-gaps.test.ts` for the signed attachment browse and exact content cases. It passed 13 selected cases with exit 0. Thirteen unrelated cases were excluded by the name filter. The run used approximately 30 minutes waiting for normal admission and 3.67 seconds executing tests. An earlier baseline attempt ended during admission and ran zero tests, so this record does not claim a failing baseline test execution.

The tested route SHA-256 is `29aaee6cde271ac738355265318738d1276698e404381a45fe370962b8111f31`. The tested integration file SHA-256 is `33919d2cfd5b4f0836e4288f27fb999a8e734e852d017b5f6368732388385454`. Native TypeScript and diff whitespace had passed for the correction before this run.

The earlier real AgentServer lifecycle check exercised default-off behavior and exact byte delivery with opt-in. It predates this range correction. The current runtime still needs an approved design and fresh scope-covering review trace before a normal runtime commit, plus the applicable later verification before enabling. There is no browser, complete verification, publication, or activation claim.
