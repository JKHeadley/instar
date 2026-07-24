# ELI16 — Real-Check Runner: macOS Signal-Death Portability Fix

**What is this about?** The autonomous stop hook is the guard that decides whether an
autonomous work session is allowed to say "I'm done" and stop. Part of that guard is the
"real check": a real command (like a test suite) that must actually pass before the exit is
allowed. The one unbreakable rule — the cardinal invariant — is that any problem with the
check means KEEP WORKING. A failing check must never, ever be mistaken for a passing one.

**What broke?** On macOS, a failing check could be reported as a PASS, letting the session
exit early. Our unit test caught it: a check that prints a huge amount of output and then
exits with failure code 1 came back as "completion condition met" instead of a keep-working
block.

**Why only on macOS?** The hook needs a way to put a time limit on the check command. On
Linux it uses the standard `timeout` program. Macs don't ship `timeout`, so there the hook
falls back to a tiny Perl wrapper that does the same job. The two disagreed about one
subtle case: what to report when the check command is killed by a *signal* instead of
exiting on its own. That case is routine here, because the hook caps how much output it
captures (65,536 bytes) — when the cap is reached, the pipe closes, and a command still
printing gets killed by the operating system with SIGPIPE. Unix packs "killed by signal
13" into the low bits of the status word, with the exit-code bits all zero. GNU `timeout`
translates that to exit code 141 (128+13), which is non-zero, so Linux correctly says
FAIL. The Perl wrapper did `exit($? >> 8)` — it threw away the signal bits and returned
the (zero) exit-code bits, i.e. exit 0, i.e. PASS. A killed, failing check looked like a
clean pass — only on Macs, which is exactly where instar agents actually run in
production.

**What does the fix do?** One expression in the Perl wrapper: if the child died from a
signal, report 128+signal (exactly what GNU `timeout` and every shell do); otherwise
report the child's exit code as before. Now both platforms agree: killed-by-signal is a
non-zero status, non-zero is FAIL, and FAIL means keep working. The timeout (124) and
couldn't-launch (127) paths are untouched.

**A second, smaller macOS wart, fixed in the same chain:** after capturing output, the hook
scrubs it into valid UTF-8 using `iconv -c` (the byte cap can slice a multibyte character
in half). On macOS, `iconv -c` prints the correctly-scrubbed text but then *exits with an
error* when the last character was sliced. The old code used "if iconv failed, run the
plain-ASCII fallback filter" keyed on that exit code — so on a Mac both commands ran and
their outputs were glued together, which could duplicate text. Now the fallback only runs
when iconv produced nothing at all from non-empty input.

**Is anything less safe now?** No — strictly safer. The pinned processing order
(sanitize → UTF-8 scrub → leak-scrub → clamp) is unchanged. No new code paths, no new
permissions, no behavior change on Linux for normally-exiting commands. The only behavior
change is that a check killed by a signal now counts as a failure (keep working) on macOS,
which is what the cardinal invariant always required.
