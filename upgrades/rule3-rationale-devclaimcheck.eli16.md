# ELI16 — the missing rationale that was blocking old pull requests

There is a rule in this repo (Rule 3.1) that says: if your code looks at some outside system
to figure out what state it's in, you have to write a short paragraph explaining *why it's OK*
to detect it that way. Four questions: how much damage does a wrong answer do, how often does
this run, how likely is the outside thing to change shape on you, and what happens when it
fails.

A pre-commit check enforces that rule. But it only inspects the files you are committing
*right now*. So a file that slipped into `main` without ever tripping the check is never
looked at again.

That's what happened to `src/commands/devClaimCheck.ts`. It arrived in June, it reads GitHub
by running `gh` and parsing the JSON that comes back — textbook state detection — and it has
no rationale at all.

**Why that stopped being merely untidy.** Merging `main` into an older branch stages *every
file in main*. Git then treats you as the author of all of it, so the check inspects the whole
thing, finds this file, and refuses your commit — for a violation you did not write and cannot
see in your own diff. Anyone trying to bring an old pull request up to date walks into it. It
blocked me last night.

**The change is one comment.** It adds the rationale that should have been there in June.

The one part worth reading is the "what happens when it fails" answer, because it is not
flattering. If `gh` genuinely breaks — missing, not logged in, no network — the tool says so
out loud and tells you it only managed to scan the specs. Good. But if `gh` returns *nothing
at all*, that empty result quietly becomes "zero pull requests claim these files", with no
warning. A check that could not run ends up looking exactly like a check that ran and found
everything clear.

That path is narrow, and this change does not fix it. It writes it down instead of leaving it
unmentioned, and it is tracked separately. A rationale that only lists reassuring facts is
worth very little — the point of the rule is to surface the part someone should worry about.

No behaviour changes. Nothing runs differently.


## Correction after opening: this was TWO files, not one

The first version of this change covered only `devClaimCheck.ts` and claimed that unblocked merging
`main` into an older branch. **That claim was false**, and an A/B test caught it: branching from a
pre-#813 `main` commit and staging a merge of current `main` flagged **two** files —
`devCiFailures.ts` as well. Fixing one of two blockers unblocks nothing.

`devCiFailures.ts` now carries its own rationale and registry row. It is marked **🔵 Exempt** rather
than Partial, because unlike its sibling every failure path is loud: a non-zero `gh` exit rejects
with captured stderr, and its `JSON.parse(stdout)` carries no `|| 'null'` default, so empty output
throws rather than degrading into a successful-looking empty result.

**How the check nearly fooled me.** My first A/B run reported the fixed side PASSING — but the merge
had failed (a ref I had not fetched), so nothing was staged and the checker exited 0 over an empty
file list. A vacuous pass is indistinguishable from a real one unless you assert the check had input.
The re-run prints staged counts: 7,499 files / 905 `src/*.ts` on the failing side, and refuses to
read 0 staged files as a pass.
