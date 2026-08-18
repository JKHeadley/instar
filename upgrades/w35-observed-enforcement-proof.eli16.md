# Standards enforcement measurement: run the proof instead of trusting its paperwork

The one-line version: the standards coverage tool used to trust a protected JSON record that *said* a guard had been tested; it now runs the declared clean and mutated checks itself and gives credit only when the real test output proves the guard noticed the mutation.

## What was wrong

The W3.4 measurement correctly moved authority away from the candidate branch, but its protected record still contained self-declared facts such as `landed: true`, `testsRun: 3`, `failureKind: assertion`, and output hashes. The reader checked that those fields were shaped correctly and then promoted the cited guard. Nothing in that path actually launched the observer, changed the subject, or read an assertion failure. A record wrapped around a genuine test and a record wrapped around `expect(true).toBe(true)` therefore received the same ratchet credit.

## What changes

The protected record is now only a plan: it names a pinned Node test entry, the protected files needed to run it, the independent subject, and one exact text replacement with its expected after-hash. The measurement tool copies those protected bytes into three independently materialized pristine temporary workspaces. It launches the real clean test in the first, lands the mutation only in the second and launches the same test there, then launches the unchanged test once more in the third. This final pristine confirmation must reset to passing, so a hollow observer cannot use a marker elsewhere on the machine to manufacture one failing run. Each bounded child exit is authenticated by the H1 in-memory receipt authority after the process has actually exited. Every declared workspace input must also byte-match the candidate tree before old protected proof carries forward. The resulting live artifact contains the observed test counts, exit codes, output hashes, mutation fact, and deciding assertion line. A JSON author cannot fill those facts in anymore.

## How failure is represented

If the observer executes but survives the mutation, or its apparent discrimination does not reset in the pristine confirmation, that is `NOT-PROVEN`: the tool looked and the guard did not bite reliably. If required protected bytes or authenticated execution are unavailable, or a child exceeds its time bound, that is `UNKNOWN`: the tool could not finish looking. Timeout kills the observer process group and severs captured output pipes, so a descendant cannot keep the verifier waiting. Only a clean passing run followed by the same tests failing through an assertion and then passing pristine again earns the declared strength.

## Safeguards and current state

Five decisive controls execute through the real boundary. A bare `expect(true)` record and an observer that merely checks the subject's type both survive a real true-to-false mutation and remain unverified. A host-global marker observer manufactures a failure on the mutated run but also fails the pristine confirmation, so it remains NOT-PROVEN. A real observer of the value passes clean, fails the mutated run by assertion, and passes pristine again. A descendant that retains inherited output pipes cannot defeat the timeout and remains UNKNOWN. Additional tests prove that changed imported helpers block proof carry-forward and looked-at mutation defects are NOT-PROVEN rather than UNKNOWN. The live headline remains 0/88 because protected main has no new execution plans; that is honest-and-empty, not a claim that no guards exist. Independent J7 certification of the shared H1 receipt foundation and independent judgement of this follow-up remain required before the result can be called machine-verified.

The existing `scripts/standards-coverage.mjs` command remains executable; this change does not alter how callers launch the coverage entry point.
