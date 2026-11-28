# Isolate authentication fixtures from the operator’s environment

## Scope

Two unit test files previously depended on whether a Claude sign-in token happened to be present in the process environment. The configured-key stand-in also saved its received token and arguments to a temporary file. Source inspection confirmed the fixture behavior. No operator credential was read to demonstrate it.

## Effects and limits

Vitest temporarily clears the Claude sign-in token for every case in each file. The reviewer fixture retains its existing isolation of the login directory. Each file restores its test-controlled environment after every case. The configured-key test checks that its child received the precise synthetic token and that the token is absent from its arguments before reporting success. The child no longer records raw token or argument values on disk. Failure-category, callback, key persistence and sign-in precedence expectations stay in place.

Each temporary directory created by the key test file is registered at creation and cleaned up through the filesystem executor after the case. The reviewer file already tracked its own directories. The change affects test fixtures only. Production credential selection, sign-in handling and diagnostics keep their existing contracts.

## Rollback

Revert this test change to restore the previous fixtures. No production installation or state migration is involved.

## Verification

The coordinator authorized a single grouped run of both unit files with an explicit synthetic ambient token. Vitest ran all 14 expected cases under enforcing test admission. All 14 passed, zero were pending, and the process exited successfully in 17.35 seconds including setup. Complete verification remains with the verification coordinator.
