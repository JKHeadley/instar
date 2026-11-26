# Side-Effects Review — voice transcription setup recipe, and transcription reading a key setup stored

**Tier 2 by risk** (a credential is stored and read by every voice-note path; audio goes to an outside provider on a key the agent obtained; a user-facing reply changes), with second-pass review. Spec: `docs/specs/recommended-services.md` (catalog row `voice-transcription`; Yes; No). ELI16: `docs/specs/recommended-services-voice-recipe.eli16.md`. Proven live, then marked available in the same change.

**Size:** 7 source files, 5 test files (2 new); about 120 lines of source. **Effort:** no spec rounds; 1 commit attempt expected.

## Summary

- `VoiceTranscription.ts`: `VOICE_TRANSCRIPTION_SECRET` (`voice_transcription_key`); `registerStoredTranscriptionKey(reader)` (one module-level reader, set by the server); `providerForKey` (`gsk_` → Groq, `sk-` → OpenAI, anything else → none); `providerSettings`; `resolveTranscriptionProvider` falls back to the stored key after the environment, and for an explicit provider whose env key is missing it uses the stored key only if the stored key is for that same provider. `ResolveOptions.storedKey` lets tests and the recipe's check pass their own.
- `recipes.ts`: `voice-v1` (service `voice-transcription`, secret `voice_transcription_key`). Brief: whose account (both good; the person's own via one Secret Drop, or the agent's own), what's known about Groq and OpenAI, the key route, the check. `verify`: the stored key (or, with none, a key already in the server's environment) → provider → `GET {base}/models` with the key; pass only when the provider answers 200 and lists its transcription model, for the key transcription will actually use (an environment key first, then the stored one); 401/403 fail; other status or no answer unknown; no key anywhere fail+absent. `stop`: removes only setup's own stored key.
- `routes.ts`: registers the vault reader once, before the recommended-services routes (`SecretStore.get(VOICE_TRANSCRIPTION_SECRET)`, an unreadable vault reads as none).
- `server.ts` (Slack) and `BaileysBackend.ts` (WhatsApp): their own provider tables keep the environment first, then fall back to the shared resolver with an empty environment (so only the stored key can answer there).
- `TelegramAdapter.ts`: the reply to an unreadable voice note says the agent can set transcription up with one yes, instead of naming environment variables.
- `catalog.ts`: `voice-transcription` → `setupRecipe: 'voice-v1'` after the live proof.

## Decision-point inventory

- `resolveTranscriptionProvider` order — modify — environment, then the stored key; deterministic.
- `providerForKey` — add — fixed published prefixes.
- `voice-v1.verify` — add — the provider's own answer.

## 1. Over-block

- A key with an unrecognised shape (a proxy, an Azure OpenAI key, a future prefix) is never used from the vault and fails the check with a plain reason. Environment keys are unaffected (they keep working by name). Recorded: the recipe handles the two providers the catalog names.
- An explicit `voiceProvider: openai` with a stored Groq key: transcription stays unavailable (never silently another vendor), and the check still passes on the Groq key. The setup session is told nothing of the explicit setting. Rare (explicit settings are hand-made); recorded.

## 2. Under-block

- The key is checked by listing models, not by transcribing audio; a key with model access but no audio scope would pass and then fail on the first note, which the reply reports. The live proof transcribed a real voice note.
- Slack and WhatsApp read the stored key only through the fallback; their own explicit-provider settings still consult only the environment first, matching their previous behaviour.

## 3. Level-of-abstraction fit

One reader registered at the shared resolver means every caller gets the stored key with no per-caller wiring and no key copied into `process.env` (which would leak into every child process the server spawns, including sessions). The two older copies of the provider table are left in place and only gain the fallback, to keep this change small.

## 4. Signal vs authority compliance

- [x] No — no block/allow surface over content. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No heuristic at a competing-signals point.

## 5. Interactions

- **Environment wins:** a person's own `GROQ_API_KEY`/`OPENAI_API_KEY` always answers first; the recipe's check counts it as working (so setup records "already working" and a switch-off leaves it).
- **Switch-off:** removes the stored key; the next voice note finds none and gets the plain reply.
- **Offers:** the row becomes available, so it joins the next offer list (at most weekly).
- **Sessions:** the key is never put in the environment, so spawned sessions cannot see it.

## 6. External surfaces

- Voice-note audio goes to Groq or OpenAI on a stored key, as it already did on an environment key.
- The Telegram reply text for an unreadable voice note.
- The confirm page answers for `voice-transcription` on every agent.
- **Operator surface (Mobile-Complete):** yes/no on the confirm page; the key through Secret Drop; nothing API-only.

## 6b. Operator-surface quality

The unreadable-voice reply leads with what is true ("I can't read voice notes yet") and the one thing the person can do (ask), with no command or setting named.

## 7. Multi-machine posture

- The stored key is **per machine by design** (`machine-local-justification: physical-credential-locality`): each machine's vault, each machine's yes, as for the other key recipes. A second machine needs its own setup (or the cross-machine secret sync, where on).
- The choice replicates through the existing ledger.

## 8. Rollback cost

A revert removes the recipe and the fallback; agents that stored a key stop transcribing until a key is in the environment again (the reply then names environment variables, as before). The stored key stays in the vault, unused.

## Live proof (2026-11-08 00:33–00:38Z, throwaway `recsvc-bw-agent`, built from this branch, `provingRecipes` incl. `voice-v1`; real Telegram test group; Echo as the person)

| Step | Evidence |
|---|---|
| The person asked for voice transcription → the agent explained what leaves, cost, account, and sent the yes page | msg 123, `voice-explained-msg123.json` |
| Yes with the PIN | `voice-yes-response.json` (00:34:35Z) |
| Setup topic; one decision asked (whose account), Groq recommended, both offered | msgs 124–125 |
| "My own Groq account" → one Secret Drop link, "never in chat" | msg 129 |
| Key submitted through the drop (value over stdin; a real Groq key Echo created on console.groq.com with its own Google login) | `voice-drop-submit-response.json` |
| Check passed: "Groq accepted the key and offers whisper-large-v3" (00:36:34Z); the agent told the person voice notes work and invited one | `voice-row-after-pass.json`, msg 131 |
| A real spoken voice note (3 s, Opus) sent as the person → server log `Transcribed voice (3s): " This is a voice note test. The magic word is pineapple."`, no transcription key in the server's environment → the agent replied "the magic word is pineapple" | `voice-server-transcribed.txt`, msg 134, `voice-note-understood-msg134.json` |
| No with switch-off → key removed from the vault, row stopped | `voice-no-switchoff-response.json`, `voice-row-after-switch-off.json` |

## Class-Closure Declaration

- `unbounded-self-action` → closure `n/a` (negative declaration). Reason: no new self-triggered action; the check runs on the existing bounded setup schedule, and transcription runs once per voice note the person sends.

## Found problems, triaged

- The proof's Groq key belongs to Echo's own test account; it is deleted after the proof (cleanup list in the run file).

## Second-pass review

Independent read (reviewer subagent, 2026-11-08), tests run: no leak path for the stored key (never in the environment, argv, a log line or a message; spawned sessions cannot see it); the environment always answers first in all three resolvers; an explicit provider is never answered by the other vendor; an unreadable vault is safe; the check has no hang path.

Concur with the review. Notes taken: the check now tests the key transcription actually uses (a stored key next to a working environment key no longer reports a failure); the ELI16 says the plain-words reply is Telegram's (Slack and WhatsApp write that wording only to the server log, never to the person); a misplaced comment moved back. Recorded, no change: the app's provider label now also shows a stored key (correct); each voice note builds one `SecretStore` (one keychain read, acceptable); the module-level reader is last-registration-wins per process (one server per process in production); an explicit `voiceProvider` setting is invisible to the check.
