---
title: "Hook always-overwrite amendment — ELI16"
slug: "hook-always-overwrite-eli16"
parent: "hook-always-overwrite.md"
---

# Hook always-overwrite amendment — explained simply

## What this fixes

When Instar ships a built-in hook script (the bits of code that fire when a Claude Code session starts, when a tool is used, when a stop happens, etc.), the rule is: the canonical version Instar ships ALWAYS wins. On every `instar update`, every built-in hook gets re-rendered from the canonical source, overwriting whatever was on disk.

This rule has a name: **Migration Parity §4**. It was written after a real incident — `hook-event-reporter.js` was install-if-missing, so agents whose host environment was ESM got stuck with a broken CJS `require('http')` version forever. The fix at the time was: built-in hooks always overwrite, no install-if-missing wedge.

The Hook primitive that shipped in PR #253 (a few days ago) accidentally resurrected the wedge in a more subtle form: it added a stamp comment to the rendered hook (`# x-instar-stamp: <hash>`), and if the rendered file was edited by a user (stamp still matches the canonical hash but body differs), the parity rule REFUSED to overwrite. The intent was protective — "don't clobber the user's edit." The effect was the same broken-template-stuck-forever pattern §4 was written to prevent.

## What changed

Three small changes:

1. The `ParityRule` interface gained an optional `alwaysOverwrite` flag.
2. The Hook parity rule sets `alwaysOverwrite: true`.
3. When the parity sentinel sees a user-edited canonical hook, it still calls `remediate()` (which now overwrites), and emits a new audit event `parity:user-edit-overwritten` so the operator has a paper trail. Any edit a user made can still be recovered from git history.

The detection of "user edited this" stays — that's the signal. The decision to overwrite anyway is the authority, and §4 is that authority for built-in hooks.

## Why this is the right shape

This is the **signal vs authority** pattern in action. The stamp comment is brittle, low-context detection — it flags that something changed. Whether to overwrite isn't its decision; that decision belongs to the higher-context Migration Parity policy. For built-in hooks (§4), overwrite. For built-in skills (§5), refuse and let `PostUpdateMigrator` decide. The `alwaysOverwrite` field lets each rule express its policy declaratively.

## What changes for agents and users

For deployed Instar agents: on the next `instar update` after this lands, any user-edited built-in hook gets re-rendered from canonical. If the user wanted a different behavior, they can put their version in `.claude/hooks/custom/` (which is never touched) or fork the canonical source in `.instar/hooks/canonical/`.

For Justin: this is the structural fix for the second of two critical backtracks the audit surfaced. The first (Conversational-action inlining a catalog into AGENT.md) was fixed in PR #256 pre-merge. This one was already on main, so it ships as an amendment.

## What this is NOT

Not a change to skill behavior. Skills are governed by Migration Parity §5 (refuse-on-conflict is correct, dedicated migrations override). Not a change to custom hooks. Not a change to the parity rule's verify() behavior — drift detection is unchanged. Just the remediate() decision for canonical hooks.
