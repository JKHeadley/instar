## What Changed

The build guard that stops a switched-off feature from claiming a graduation condition it can
never check now covers a second kind of feature document it previously skipped.

Some features graduate alongside a bigger parent feature rather than on their own. The guard
treated those as out of scope. They are not: such a feature still states its own condition and
still names an address to read it from, so a missing address parks it for exactly the same
reason. Three feature documents sat outside the guard; all three are now covered.

## Summary of New Capabilities

None. No endpoint, config key, or behaviour is added. This widens the scope of an existing
build-time check and reports its two counts separately, so a future narrowing shows up as a
number dropping rather than as silence.

Widening it forces no new work on anyone. The guard already carries an escape hatch — a list
of accepted exceptions, each requiring a written reason, each deleted automatically once its
address starts working. A feature whose parent was genuinely abandoned needs a declaration,
not a fix.

## Evidence

Nothing was broken when this was written: all eight covered addresses currently work, and the
accepted-exception list is empty. This closes a hole in the guard rather than repairing a
fault.

The guard was proved to actually bite by breaking one of the newly-covered documents on
purpose — the check refused, and named which kind of document had failed — then restoring it
byte-for-byte and confirming it passed again. The tests were proved the same way, by narrowing
the check back and watching exactly the two new tests fail.

## What to Tell Your User

Nothing changes in how your agent behaves. A safety check that runs when the project is built
now looks at a few more files than it used to.
