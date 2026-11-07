# ELI16: why main's Docs Coverage check went red, and the fix

instar has a CI check that makes sure every CLI command is mentioned somewhere in
the docs. A new command, `instar mobile introducer`, landed with no docs, so the
check failed on main and stayed red for every PR after it.

Two things were wrong. The command really was undocumented, so this change adds
its entry to the CLI reference page. And the checker could not have recognised
it even once documented: it looked for `instar mobileIntroducer` or
`instar mobile-introducer`, but people write nested commands with a space. The
checker now also looks for the spaced form.

Nothing that users run changes. This only affects the docs check in CI.

How we know it works: running `node scripts/docs-coverage.mjs` against this tree
reports the command as documented, and the existing two forms still match the
commands they matched before, so no command that used to pass can now fail. If
the spaced form ever wrongly counted some unrelated sentence, the worst case is
one command reading as documented when it is not, which is the same kind of miss
the check already tolerates.
