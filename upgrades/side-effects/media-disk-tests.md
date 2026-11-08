# Side effects: media tests no longer read the machine's disk

**What changed:** `AppConversationService` takes an optional `mediaDiskSpace`, passed to the media store's existing `diskSpace` reader. Three test files now give the store a disk with room: `tests/unit/app-media-store.test.ts`, `tests/unit/app-voice-transcript-event.test.ts` and `tests/unit/app-voice-transcription.test.ts`. A new test checks both sides of the floor: a voice note is taken with room and refused below it.
**Why:** the store refuses uploads below max(5% of the volume, 2 GB). These tests read the real disk, so on a machine near that line every PR's Local Verify failed 28 tests that had nothing to do with it (PR 2922, 2026-11-07).
**Proof:** with the store's real reader forced to report a full disk, all 89 tests in the three files pass; they also pass on the real disk.
**Behaviour:** none in production. Without `mediaDiskSpace` the store reads the real disk exactly as before.
**Rollback:** revert; nothing else reads the new option.
