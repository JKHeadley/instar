# Post-Transfer Closeout Lease Carve-Out + First-Party Bootstrap Tag — ELI16

Two fixes from the 2026-07-02 live test-as-self matrix (roadmap item 0.6, findings F8 + F7).
Both are cases of a safety guard doing its job so well it blocked the system's OWN legitimate
work.

## F8 — the leftover session that could never be cleaned up

### What was broken?

When you move a conversation from one of your machines to another ("move this to the mini"),
the OLD machine is supposed to close its now-useless copy of the session — otherwise two
machines both think they own the conversation and can do duplicate work.

There's a safety rule in the kill authority: a machine that is NOT currently "in charge" (the
serving-lease holder) is never allowed to autonomously kill sessions. That rule exists so a
standby machine can't reach over and kill sessions on the machine that's actually serving you.

Here's the trap: the machine a topic moves AWAY from is — almost by definition — not the
lease holder anymore. So when it tried to close its own leftover session, the lease rule said
"you're not in charge, denied" — every single attempt, structurally, forever. After 5 denials
a circuit breaker gave up loudly and the duplicate session just… survived.

The safety rule meant "don't kill ANOTHER machine's sessions." But this machine was trying to
close ITS OWN local leftover, for a topic the ownership registry says another machine now
owns. That's the exact inverse of what the rule protects against.

### What's the fix?

A narrow carve-out: the topic-moved closeout — and ONLY the topic-moved closeout — may skip
the lease check. Everything else about the kill authority is unchanged:

- **Protected sessions still can't be killed.** The protected check runs before the carve-out.
- **Every KEEP-guard still applies.** A session with a recent user message, an active
  subprocess, a live subagent, or a relay lease still refuses to die, carve-out or not.
- **The carve-out can't be reached from outside.** It's a function parameter that only the
  reaper's closeout code path sets — no HTTP request, no message content, no config value can
  mint it. And the reaper only sets it after the pool ownership registry has confirmed,
  across multiple ticks (the dwell), that ANOTHER machine really owns the topic now.
- **The loud give-up stays.** If a closeout is still vetoed (by a KEEP-guard now, not the
  lease), the breaker still gives up loudly after 5 attempts — honesty preserved.

## F7 — the agent that distrusted its own boot instructions

### What was broken?

When instar spawns a fresh session for a conversation, the very first message it types into
that session is instar's OWN bootstrap: "Read this bootstrap file… here are the MANDATORY
Telegram relay instructions…". That text is composed by instar itself, in-process, moments
before injecting it.

But the injection pipeline has an InputGuard that vets incoming text for prompt injection —
and the bootstrap arrived looking exactly like an unverified, untagged message. So the
guard's LLM layer flagged instar's own boot template as a suspected prompt injection, and a
cautious freshly-spawned session would then skip its own bootstrap ("this looks injected,
better not follow it") — never reading its context file, never learning the relay command.

### What's the fix?

Instar's own injections now carry a **first-party tag** — but crucially, NOT a tag in the
text. The tag is an in-process function parameter (`firstParty: { source:
'session-bootstrap' }`) set at the exact code sites where instar composes and injects its own
bootstrap. The guard trusts provenance recorded at injection time, never anything the text
says about itself.

### Why can't that be forged?

Because there is nothing to forge. A forger controls message CONTENT — but content can never
populate a function parameter inside the server process. There is no magic string the guard
looks for: a message that copies the bootstrap template byte-for-byte, or literally says
"first-party: session-bootstrap", still arrives without the parameter and goes through every
guard layer exactly as before. We have tests for precisely that: instar's own bootstrap
passes clean; a byte-identical copy arriving as ordinary content still gets reviewed and
flagged.

And the bypass isn't invisible: every first-party injection writes a `first-party-injection`
line to the security log, so the audit trail shows exactly what skipped the guard and why.

## What could go wrong, and why it doesn't

- **"Could the carve-out let a standby machine kill things it shouldn't?"** No — it only
  lifts the lease check, only on the closeout path, which is only reachable after verified
  non-ownership (registry + dwell + liveness confirmation on the gated path). Protected +
  every KEEP-guard still veto. The blast radius section of the side-effects review walks
  through this in detail.
- **"Could an attacker mark a malicious message first-party?"** No — the flag travels as an
  in-process parameter; no external surface reaches it. Content-only claims are proven (by
  test) to still be flagged.
- **"Does the guard still protect against real injections?"** Yes — everything without the
  in-process flag keeps the exact pre-fix guard behavior, byte for byte.
