# Matching a session's account to its engine: the plain version

Each conversation runs on an engine, Claude or Codex, and on an account for that engine. On 28 November, Justin's Windows App conversation was set to Codex, but it restarted labelled with a Claude account and no Codex sign-in. So it sat at a Codex sign-in screen, even though a signed-in Codex account was ready on that machine. There was also no way to say "move this one conversation onto that exact account". The only move picked a replacement of the same kind as the account being left, which here meant another Claude account.

This change fixes both problems:
1. When a conversation is started with an account from the other engine, that account is now ignored, a note is logged, and the normal choice for the right engine is made instead.
2. The account-move route now looks at the engine the conversation actually runs. It also takes an optional exact target account. The target must be for the same engine, active, and not at its limit; otherwise the move is refused with a clear reason. It works even when the account being left isn't at its limit, which is exactly the case for a wrong or stale account.

Nothing changes for conversations whose accounts already match. When the account list isn't available, the start behaves exactly as before.
