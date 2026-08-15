# Side-effects review — extracting the gemini environmental-refusal classifier

## The change

Moves `tests/helpers/geminiEnvRefusal.ts`, its unit test, and its two E2E call sites out of the blocked
`echo/authorship-provenance` branch and onto main on their own. No new code: the same four files,
standing alone where they can land. Test-only; no runtime surface.

## Why it is separate, which is the actual point

The two live-gemini E2Es gate on whether the BINARY IS INSTALLED. An installed-but-uncredentialed CLI
exits 41 before it processes the prompt, so the assertion downstream can neither pass nor meaningfully
fail. CI is green only because no gemini binary exists there — the box that HAS gemini is the one that
goes red. That is a Zero-Failure Standard violation on main today.

The fix was written hours ago, out-of-charter, and committed to whichever branch was checked out at the
time — a large change now blocked at an approval gate for reasons unrelated to gemini. So the standard
was satisfied on a branch and NOT on main, which is the only place it counts. **Out-of-charter work
absorbed into a blocked change becomes hostage to that change's gate.**

## Review answers

1. **Over-block.** The classifier skips ONLY on causes the CLI itself names (missing credentials, quota
   exhaustion, a version-manager miss). Everything else still fails. The rejected alternative — a live
   preflight asking "can this box reach gemini at all?" — is recorded in the helper's own header as the
   wrong trade: it would also skip on a transient failure, so a real regression would vanish silently.
   Between a false red (visible, blocks a push) and a silent skip (invisible), the silent skip is worse.
2. **Under-block.** A NEW environmental cause with different wording still fails loudly. That is the
   intended direction; the list grows only when a real cause is observed.
3. **Level-of-abstraction fit.** The classification is shared once and the tests decide what to do with
   the answer — this is the third environmental cause these files handle, which is the point at which
   two copies stop being maintainable.
4. **Signal vs authority.** Not a gate. It decides whether a test asserts or skips.
5. **Interactions.** None outside the three test files. No production import.
6. **External surfaces.** None.
7. **Multi-machine posture.** Machine-local BY DESIGN — it classifies THIS box's credential state.
8. **Rollback cost.** Revert; the two e2e files return to failing on an uncredentialed box.

## Evidence

- **The negative control is main itself, measured rather than mutated.** A full run on a current
  checkout (3073 files) produced exactly 2 failures — these two files — both on
  `Gemini CLI exited 41 — you must specify the GEMINI_API_KEY environment variable`.
- On this branch the same three files pass, 24 tests, with the E2E bodies skipping loudly:
  *"Skipping live Gemini narrative assertion: no credentials configured (the child env is key-free by
  design; OAuth creds absent)."*
- The helper is ABSENT from main (404 via the contents API, against a control showing 7 files DO exist
  in `tests/helpers/`), and the failing test on main references it 0 times — the fix genuinely never
  landed.
- Main has not modified either e2e file since the source branch's base, so this reverts nothing; the
  diff against main is +37/-6 on the e2e files plus the two new files.
- `tsc --noEmit` exit 0 via the real binary.

## Class closure — what this does NOT close

- **The live smoke assertion still never executes on this box.** It skips, correctly and loudly. Making
  it exercisable needs a credential decision that is the operator's, not a code change.
- **Only gemini.** No audit was done of other live-CLI E2Es for the same installed-vs-usable confusion.
- **The stranding pattern itself is untouched.** Nothing prevents the next out-of-charter fix from being
  committed to a branch that later blocks. That is a process observation, recorded rather than solved.
