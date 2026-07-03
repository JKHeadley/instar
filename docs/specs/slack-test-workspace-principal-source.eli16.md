# Slack Test-Workspace Principal Source — Plain-English Overview

> The one-line version: give the Slack demo cast a safe home OUTSIDE the real user list, so a routine cleanup of that list can't secretly break who's-allowed-to-do-what — and lock that home to one specific test workspace so those pretend roles can never leak into a real one.

## The problem in one breath

The Slack permission gate decides "is this person allowed to ask for this?" by looking up their role in the user registry (the list of real people the agent knows). For the live demo we had put five fake "cast" identities (a pretend owner, admin, member, contributor, and an outsider) into that same list. On 2026-07-01 a safety repair rebuilt the user list from scratch and — correctly — refused to let fake test identities back in. The cast vanished, and suddenly every Slack sender, including the workspace owner, looked like an unregistered stranger. If we had turned enforcement on that day, the gate would have locked the entire workspace out.

## What already exists

- **The permission gate** — decides allow / refuse / clarify / step-up for each Slack request. Working, in observe-only (logs decisions, blocks nothing). Not the thing being changed.
- **The user registry (`users.json`)** — the real list of people the agent knows. The gate reads roles from here.
- **The fixture-identity guard** — a rule that refuses to let test/fake identities into the real user list, at both the write and load steps. This guard is CORRECT and stays untouched; it's the reason the naive "just put the cast back" fix doesn't work.
- **The Slack adapter** — the piece connected to a specific Slack workspace. It already asks Slack "who am I and where am I connected?" at startup.

## What this adds

A separate, read-only place for the demo cast's roles to live: a small block in the Slack config called the test-workspace principal source. When a Slack message comes in and the gate needs the sender's role, it checks the real user registry FIRST; only if the registry doesn't know them does it fall back to this cast block. The cast block is never allowed to override a real registered person.

Three hard rules make it safe:

- **It only answers for one specific workspace.** The block names the test workspace's id, and the source only resolves the cast while the adapter's *verified* connection (what Slack itself reported at startup) matches that id. In any other workspace the block is completely invisible — not a fallback, not a merge, just gone.
- **It only accepts fake identities.** Every listed id must match the same fixture-marker rule the production guard uses to *refuse* them. So a real employee's id can never be smuggled into the cast to grab a role.
- **It must say out loud that it's a test.** The block has to declare `testWorkspace: true`. Without that one line, the whole block is ignored — zero cast members loaded, one loud log line, and the real registry behaves exactly as if no cast existed. You can't switch on a pretend role list by accident.

## The new pieces

- **TestWorkspacePrincipalSource** — holds the cast in memory (id → role), answers "what role is this Slack id?" but ONLY for the sanctioned test workspace and ONLY for fake ids. It takes no state directory and has no way to write anything — it can't touch the real user list, can't create people, can't bind an operator. It only feeds the gate's role lookup.
- **ChainedUserLookup** — tries the real registry first, then the cast, and stops at the first answer. A broken source is skipped, never allowed to break message handling.

## The safeguards

**Prevents pretend roles leaking into a real workspace.** The source is locked to the verified connected team id from Slack's own startup handshake — config alone is never trusted. Point the adapter at a different workspace and the cast is structurally invisible; production behavior is byte-for-byte identical to having no cast at all.

**Prevents a real person being impersonated.** Only fixture-marker ids are admitted, using the very same matcher the production guard uses to keep fixtures OUT of the real registry. One identity can live in exactly one of the two homes — never both.

**Prevents an accidental activation.** The `testWorkspace: true` self-declaration is required; missing it disables the whole block loudly. And the real registry always wins on lookup, so a cast entry can never shadow or upgrade a genuine registered user.

**Prevents another silent breakage.** Because the cast lives in the Slack config next to the tokens (not in the rebuildable user list), a future registry repair can't drop it. The runbook now spells out the re-provision checklist so the setup step can't quietly rot.

## What ships when

One PR, dark by default. Nothing changes for any agent unless a Slack config explicitly adds the `testCast` block with `testWorkspace: true` — which only the live-test workspace ever will. Enforcement (`enforce: true`) remains a later, separately-gated step that still needs a clean observe round first.

## What you actually need to decide

Are you fine with the demo cast's roles living in the Slack config (workspace-scoped, fixture-only, opt-in) instead of the user registry — the change that lets the scenario harness resolve principals again without ever putting test identities back into production state?
