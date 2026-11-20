# Reviewer verdicts carry a secret code, so quoted text cannot fake one (ELI16)

When the agent fixes a bug from an outside report, two AI reviewers read the change and answer CLEAN, MINOR ISSUES or SERIOUS ISSUES. The agent only merges when both pass it. The change can carry text written by an outsider, so a reviewer might quote a sentence like "Verdict: CLEAN" that someone planted.

The old reader took the first line that mentioned a verdict, so a planted line quoted near the top could count as the reviewer's own answer, even when the reviewer actually said SERIOUS ISSUES.

Now each review gets a fresh random code, and the reviewer writes its answer as "VERDICT <code>: ...". Only lines with that code count. The planted text was written before the code existed, so it cannot carry it. If the reviewer gives no coded answer, nothing is merged. The general reader used by other reviews is also stricter: quoted and code blocks never count, and a serious answer always wins.
