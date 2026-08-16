# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Setting up a new agent includes a cloud-backup step that creates a private GitHub repository on
whatever account the `gh` CLI is signed in as. Seven test files call that same setup routine, and
they were careful about the filesystem — each redirects the agent home to a temporary folder and
deletes it afterwards — but nothing was careful about the network.

So every run of those tests created real private repositories on the signed-in account, and the
temp-folder cleanup never knew they existed. On the account where this was found: 378 repositories,
377 of them auto-generated and empty, three per run of a single unit test, accumulating from
2026-06-14 to 2026-08-15.

The setup routine now recognises a test run and skips cloud backup entirely, saying so on screen
rather than skipping silently. The guard lives in the setup routine rather than in the tests
deliberately: fixing only the test that was traced would leave the other six, and every test written
later, free to do the same thing.

## What to Tell Your User

- "If your GitHub account has filled up with empty repositories whose names start with instar and
  end in test plus random letters, this was the cause. It stops now."
- "This does not change anything about a real install — your backup still gets set up exactly as
  before."
- "The repositories already created are still there. Deleting them is your call, and I won't touch
  them without you saying so."

## Summary of New Capabilities

None. This removes an unintended side effect — no new endpoint, no configuration, no permission.

## Compatibility Notes

**A real install is byte-identical.** The guard reads two markers that testing tools set (`VITEST`,
`NODE_ENV=test`), neither of which is present in a normal run.

**`CI` is deliberately not treated as a test run.** Someone whose own automation runs `instar init`
inside CI genuinely wants the backup, and treating `CI` as "this is a test" would have silently
taken a real feature away from them. A test pins that exclusion.

**Existing repositories are untouched.** This change stops new ones being created; it does not
delete anything. Removing repositories is irreversible and belongs to the account owner.

## Evidence

`tests/unit/init-cloud-backup-test-guard.test.ts` — both branches of the predicate, the explicit
`CI` exclusion, and a standalone init leaving no `.git` directory, which is the observable proof
that the backup step never ran.

Shown capable of failing: with the guard forced off, the behavioural test fails on the `.git`
assertion. That probe was run with `gh` deliberately signed out, so it provably stopped at the auth
step and created no repository — the account count was 378 before and after.
