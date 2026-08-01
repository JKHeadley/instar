# The UX gate could not see the file that tells agents what they can do — ELI16

Instar has a rule with real teeth: if your pull request touches anything a user
will actually see, you must write a short "UX Impact" note explaining who sees
it, what changes for them, and quote a real line from your own change to prove
you are describing something that exists. A CI check called the UX-impact gate
enforces this, and it decides whether your PR counts as "user-facing" by
checking your changed files against a hard-coded list of paths.

That list had a hole in it, and the hole was the most important file of all.

Instar's Agent Awareness Standard says, in the project's own words: *"Every
feature added to Instar MUST include a corresponding update to the CLAUDE.md
template (`src/scaffold/templates.ts`). An agent that doesn't know about a
capability effectively doesn't have it."* That one file generates the
instructions every single agent reads at startup — it is how an agent learns
what it is capable of and what to tell people. If anything in this codebase is
user-facing, it is that.

The gate's list did not contain it. It contained `src/templates/` — a
different directory, holding hook and helper scripts — and stopped there. The
two folder names differ by one word and by everything that matters.

The consequence was quiet and precise. If a pull request changed *only* that
file — adding a whole new capability description that every agent would start
telling users about — the gate looked at the changed files, found nothing on
its list, printed "UX lint: out of scope", and waved it through with no UX note
required at all. The one change guaranteed to alter what users are told was the
one change the user-facing gate ignored.

This was not a hypothetical. Commit `e29259c49` in this repo touches
`src/scaffold/templates.ts` and zero listed paths; running the shipping gate
against it prints exactly that "out of scope" message and exits successfully.

The fix adds that one file to the list. Deliberately one file, not the whole
`src/scaffold/` folder: the standard names a specific file, and quietly
widening a gate to cover more than anyone agreed to is its own kind of bug.

Two smaller things came along with it. A change to agent-visible text can no
longer claim the "this is just a refactor" exemption, because rewriting what
every agent says is not a refactor. And the gate's error message was rewritten,
because it had been lying by omission: it said your note must "quote a concrete
string from the diff", while it was actually only searching the listed paths.
An author who correctly quoted a real added line from an unlisted file was told
their quote wasn't in the diff — which was, on its face, untrue. It now names
the paths it actually searched, so the next person sees the real reason in
seconds instead of concluding the check is broken.

The honest limit: this closes one hole in one list. A list of paths standing in
for the idea of "user-facing" is still a stand-in, and stand-ins drift. What
this change does not do is give that list an owner or a reason to be re-read.
