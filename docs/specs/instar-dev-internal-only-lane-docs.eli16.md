# ELI16 — instar-dev internal-only release-note lane docs

Some Instar development changes are internal-only: tests, docs, or scripts with no shipped runtime behavior. PR #765 added a release-note shortcut for that case: a fragment can include `<!-- internal-only -->` and omit the two sections that normally explain user-facing impact. The assembler fills those sections with a standard "None — internal" message, but only when every fragment in the release is internal-only. The pre-push gate rejects the marker if the PR also changes runtime `src/*.ts` files.

This change teaches that rule to the `/instar-dev` skill itself. It adds a short section explaining when to use the marker, what sections it can omit, what the assembler fills, and what the gate rejects.

Because existing agents already have their own deployed copy of the skill, changing the bundled file is not enough. This also adds a post-update migration that updates deployed stock copies of the instar-dev skill. The migration only rewrites copies that still look like the stock skill and do not already contain the new marker phrase, so customized local workflows are left alone.
