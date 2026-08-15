<!-- internal-only -->

## What Changed

Extracted `tests/helpers/geminiEnvRefusal.ts` and its two call sites
(`tests/e2e/gemini-cli-alive-lifecycle.test.ts`,
`tests/e2e/gemini-setup-narrative-lifecycle.test.ts`) plus its unit test out of the
blocked `echo/authorship-provenance` branch and onto main on their own.

The two live-gemini E2Es gate on `haveGemini = !!detectGeminiPath()` — whether the
BINARY IS INSTALLED. An installed-but-uncredentialed CLI exits 41 before processing
the prompt, so the assertion downstream can neither pass nor meaningfully fail. CI is
green only because no gemini binary exists there; the box that HAS gemini is the one
that goes red.

## Evidence

- A full unit+integration+e2e run on a current checkout (3070 files) produced
  **exactly 2 failures — both of these files**, both on
  `Gemini CLI exited 41 — you must specify the GEMINI_API_KEY environment variable`.
- The helper is ABSENT from main (404 via the contents API, against a control showing
  7 files DO exist in `tests/helpers/`), and the failing test on main references it 0
  times — so the fix genuinely never landed.
- Main has not modified either e2e file since the authorship branch's base, so this
  reverts nothing; the diff is +37/-6 against main.
- `tsc --noEmit` exit 0 via the real binary.

## Why it is separate

Out-of-charter work absorbed into a large blocked change becomes hostage to that
change's gate. The Zero-Failure Standard was satisfied on a branch and NOT on main,
which is the only place it counts.
