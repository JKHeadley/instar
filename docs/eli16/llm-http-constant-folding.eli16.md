# LLM HTTP lint constant folding — Plain-English Overview

> The one-line version: the lint that blocks raw LLM provider HTTP calls now catches URLs split across constant string pieces, so a second spelling of the same forbidden endpoint no longer slips past the build.

## The problem in one breath

Raw HTTP calls to LLM providers are not just another fetch. They bypass the routing layer that records attribution, burn, and quota policy, so a hidden direct call can spend the operator's money and send data out without the central controls seeing it.

The shipped lint caught `api.anthropic.com` when the host appeared as one string. It missed the same URL when the host was split into constant pieces, for example `'api.' + 'anthropic.com/v1/messages'`. That meant a callsite could avoid the guard without changing behavior.

## What already exists

- **The central provider path** — the normal route for LLM calls, where attribution and quota controls live.
- **The direct HTTP lint** — a build-time guard that scans production source for provider hosts outside the approved provider files.
- **The allowlist distinction** — OAuth/profile/usage metadata endpoints remain accepted in the files that legitimately read account metadata instead of performing inference.

## What this adds

The lint now folds adjacent constant string and no-expression template literals joined by `+` before checking for known LLM provider hosts. It stays deliberately narrow: only literal-plus-literal chains are evaluated. Once a variable, function call, or template expression enters the URL construction, the lint stops rather than guessing.

## The safeguards

**Prevents the known bypass.** A split host like `'https://api.' + 'anthropic.com/v1/messages'` now fails the same way the unsplit string fails.

**Preserves the metadata distinction.** The existing allowlisted and grandfathered files keep their current treatment, so OAuth/profile/usage metadata readers are not newly blocked just because the scanner got better at recognizing constant strings.

**Avoids broad source inference.** The fix does not attempt automatic actuator discovery, dataflow, or semantic endpoint classification. That broader shape was expected to create false positives; this change only evaluates constant URL literals.

## What ships when

This PR ships the lint hardening, focused tests that fail against the old lint, a clean scan of the real tree, and the instar-dev trace artifacts needed for release.

## What you actually need to decide

The PR asks whether this narrow constant-folding guard is the right build-time protection for the known split-host LLM HTTP bypass.
