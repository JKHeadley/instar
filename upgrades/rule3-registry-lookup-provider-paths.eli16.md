# ELI16 — the gate told authors to add a registry row that was already there

There is a registry listing every place Instar reads state from something it doesn't control.
A pre-commit gate uses it: if your file is in the registry *and* carries a rationale comment,
the gate lets it through.

For files under `src/providers/`, that lookup could never succeed.

**Why.** The gate turned `src/providers/adapters/foo/Bar.ts` into
`providers/adapters/foo/Bar.ts` and searched the registry for that string. But the registry's
provider section writes its paths relative to `src/providers/`, so the row actually says
`adapters/foo/Bar.ts`. The two never matched — 21 of the 23 provider rows are written that way.

The result: a file listed in the registry — one of them appears in **three** rows — was still
refused, with a message telling the author to add a registry entry. Adding the row again would
not have helped. That is the worst kind of gate message: it is confidently wrong about what
would fix it.

**Why nobody noticed.** The test file for this gate builds a throwaway repo, copies the script
into it, writes a registry fixture — and then runs the *original* script instead of the copy.
The script finds its registry relative to its own folder, so it read the real repo's registry
while reading the staged files from the throwaway one. Every registry fixture a test wrote was
quietly ignored, so this whole branch had no working test coverage. That is fixed here too, by
running the copy.

**How I know the fix works rather than believing it.** I wrote two tests: the provider case, and
a control using the ordinary path form that should already have worked. Before the fix the
provider one failed and the control passed. After, both pass, and the 22 tests that were already
there still pass.

Worth saying: the control failed on my first attempt too, which meant my explanation was wrong.
Chasing that disagreement is what turned up the harness defect. A control test that fails is
telling you something.

**Scope.** A registry entry still does not exempt a file on its own — a rationale or a canary is
still required. This only stops the gate from ignoring a registry row that genuinely exists.
