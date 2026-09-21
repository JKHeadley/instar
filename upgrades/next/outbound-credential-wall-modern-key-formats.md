# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The outbound live-credential wall — the one check that stops a message carrying an
API key or token from being sent, and the one check that cannot be overridden — did
not recognise the key formats providers issue today. Modern OpenAI keys
(`sk-proj-`, `sk-svcacct-`, `sk-admin-`, `sk-None-`), OpenRouter keys (`sk-or-v1-`)
and GitHub fine-grained tokens (`github_pat_`) all passed it, and the LLM review
behind the wall passed them too. Two prefix-anchored patterns in the shared secret
list now cover them, and the same list's durable-output redaction redacts them.

The wall also now strips invisible interleave characters (zero-width and other
format characters, the combining grapheme joiner, variation selectors) before
matching, scanning both the raw and the stripped text. Two send paths that skipped
the whole outbound authority — proxy/system-template Telegram replies and
Agent-Health-lane attention items — now still run the credential wall; their skip
continues to bypass tone judgment only. Eight hand-kept copies of credential
patterns across the codebase were brought up to the same shapes.

The new falsifiable timing fixture found two pre-existing quadratic patterns in the
shared list (`jwt` and `url-embedded-credential`); `url-embedded-credential` runs on
every outbound message as part of the wall and could stall the server for minutes on
a large pasted blob. Both are capped, with no change in what they detect.

## What to Tell Your User

If I ever try to send you a message containing one of today's API keys or access
tokens — the current OpenAI and OpenRouter key formats, or GitHub's newer
fine-grained tokens — it is now stopped before it reaches you, the same way older key
formats already were. I'll refer to the key by name instead. Nothing changes for any
normal message.

## Summary of New Capabilities

- The non-overridable outbound credential wall covers modern OpenAI, OpenRouter and GitHub fine-grained key formats.
- Invisible-character interleaving no longer hides a key from the wall.
- Proxy replies and Agent-Health-lane attention items are covered by the wall.
- Durable-output redaction covers the same formats.
- Two latent event-loop stalls in the shared secret-pattern list removed.

## Evidence

- Unit `tests/unit/outbound-credential-wall-modern-formats.test.ts` (65 passing): every modern issued shape refused (generated at test time, nothing committed); no regression on older shapes; drift guard mapping every messaging pattern type to a wall kind or a stated exemption; cross-file ratchet over the eight copies; no false positives on prose, bare prefixes and kebab slugs; invisible-character strip across nine classes plus the separated-key regression guard; oversize still fails closed; scrubber offsets stay valid; per-pattern linear-time budget on a 64 KB unbroken run with interior word boundaries (no exemptions); capped `jwt`/`url` detection equivalence.
- Integration `tests/integration/telegram-reply-advisory-migration.test.ts` (18 passing): modern keys refused on a normal reply, on a proxy reply, and in a laned attention item; a clean proxy reply still sends.
- E2E `tests/e2e/tone-gate-advisory-migration-alive.test.ts` (12 passing): modern keys refused on the real boot.
- Measured: over ~366 MB of real text (Telegram history, repo, logs, state stores) the new patterns match zero strings through the full shipped pipeline. `url-embedded-credential` went from 2.4 s at 64 KB to 157 ms for a full megabyte.
- Independent second-pass review: concur (both nuances raised were acted on before commit).
