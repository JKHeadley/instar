# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

`POST /threadline/relay-send` now consults the local nickname store at `.instar/threadline/nicknames.json` BEFORE asking the relay's discovery cache to resolve a name → fingerprint. User-curated nicknames are now the highest-authority mapping for outbound sends; relay discovery is a signal that the resolver only consults when no nickname matches.

When a nickname does resolve, the route uses the nickname's fingerprint directly for both the local-delivery match (fingerprint compare against `known-agents.json`) and the relay-delivery `sendAuto` call. If relay discovery happens to also know the same name but maps it to a different fingerprint, the route logs a `[relay-send] Nickname/discovery mismatch …` warning and honors the nickname (signal-vs-authority — the user's mapping wins).

`ThreadlineNicknames` (originally implemented on `feat/dashboard-grouped-nav` for the dashboard surface) is now landed on `main` with one new method — `resolveByName(name)` — and three convergence-review hardenings:

- **Canonicalized matching** (`canonicalizeName(name)` static helper applies NFC + trim + internal-whitespace-collapse + lowercase): a hand-edited entry like `"Dawn  Q "` resolves the same as `"dawn q"`, including for combining-character Unicode forms. Stored strings preserve user casing/spacing for dashboard display; canonicalization happens at compare time only.
- **Atomic writes** via temp+rename in `persist()`: a concurrent reader can no longer observe a half-written file (which would parse-fail and silently drop the user's authority). POSIX rename(2) atomicity holds because `.instar/threadline/` is a single filesystem.
- **Corrupt-file observability**: `load()` catches JSON parse errors and emits a one-shot rate-limited warn (one log per 30s cache cycle) so a corrupted `nicknames.json` is visible in operator logs without spamming. Sends still flow via the relay-discovery fallback.

Sends to inputs that look like a raw fingerprint skip the nickname check. The `name:fpPrefix` qualifier syntax now consults the nickname store and uses the prefix to disambiguate among candidates: 1 candidate matches the prefix → use it; 0 → 409 with the candidate list; multiple → 409 asking for a longer prefix. (Previously the route skipped the nickname check whenever `:fpPrefix` was present, which made the documented disambiguation remedy a dead end. Convergence review caught this; now corrected.)

## What to Tell Your User

- **Outbound messages now reach the right agent**: "When I send a message to someone you've named — like 'Dawn' — I now use the fingerprint you wrote in nicknames.json instead of asking the relay's directory, which can return a stale or imposter entry. If the relay disagrees with your mapping, your mapping wins and I log the conflict so you can see it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Nickname-first send-path resolver | automatic — applies to every `/threadline/relay-send` call (which the MCP `threadline_send` tool also uses) |
| Nickname-vs-discovery mismatch warning | automatic — logged at `[relay-send] Nickname/discovery mismatch …` when the relay's resolved fingerprint differs from a user-curated nickname for the same name |
| `name:fpPrefix` disambiguation honors nickname store | use `name:fpPrefix` when two of your nicknamed fingerprints share a name; the route filters candidates by the prefix you supply |
| Corrupt `nicknames.json` warn | logged at `[ThreadlineNicknames] nicknames.json parse failed …` (rate-limited to once per 30s cache cycle) |
| `ThreadlineNicknames.resolveByName()` and `.canonicalizeName()` | imported from `'../threadline/ThreadlineNicknames.js'` for any future caller that needs name → fingerprint reverse lookup or canonical-form comparison |

## Evidence

Reproduction (real bug): on 2026-05-08, Echo (this agent) sent two follow-up messages to Dawn over Threadline thread `thread-2ebce60b`. The MCP `threadline_send` resolver returned fingerprint `5c338c63cd2ecebc8f52483d5bba6486` for the name "Dawn" — but Dawn's real fingerprint per Echo's `.instar/threadline/nicknames.json` (and per every prior message in that thread) was `8c7928aa9f04fbda947172a2f9b2d81a`. The messages were silently delivered to a wrong/stale recipient. Dawn never received the question. Bug surfaced when Justin asked "check again for Dawn's reply"; diagnosis traced to `ThreadlineClient.resolveAgent` consulting only the discovery cache and bypassing the user-curated nickname mapping (no source-tree code read `nicknames.json` at all on `main`).

Verified-after: `tests/integration/threadline-relay-send-nickname.test.ts` reproduces the exact failure conditions — a stub relay client whose `resolveAgent('Dawn')` returns `5c338c63…` (the wrong fingerprint), with `nicknames.json` curating `Dawn` → `8c7928aa…`. The test asserts that the route sends to `8c7928aa…` (NOT the relay's wrong answer) and that `resolvedAgent` in the response body is `8c7928aa…`. The mismatch warning fires and is observable in the test output. Unit-level coverage at `tests/unit/ThreadlineNicknames.test.ts` exercises the new `resolveByName` method including the corrupt-file-tolerance, ambiguous-mapping, and canonicalization (NFC + whitespace) cases — 8 unit tests + 3 integration tests, all green. The full threadline-area subtree (1493 tests) remains green.

Spec converged in 3 iterations through `/spec-converge` (multi-angle internal reviewers + GPT/Gemini/Grok cross-model reviewers). Convergence report at `docs/specs/reports/threadline-nickname-resolver-authority-convergence.md`. The convergence review caught and corrected: cache-honesty wording, atomic-write spec-vs-code mismatch, normalization weakness (added canonicalization), corrupt-file silent fail, the `name:fpPrefix` disambiguation dead-end, and one stale acceptance criterion.

The `ThreadlineNicknames` class is derived from `feat/dashboard-grouped-nav` commit `16c605ce`. The convergence-review hardenings (atomic writes, canonicalization, observability warn) are additive; when that feature branch lands, the merge delta is the new methods/improvements. The `resolveByName` method is additive (new method, no existing-method signature changes) so no existing caller is affected.
