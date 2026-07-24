# Side-effects review: UX-first enforcement increment 1

- Adds a separate pull-request workflow and path allowlist; it reads the base-ref diff and PR body only.
- A missing or shallow UX declaration is a deterministic violation; unexpected tool failure is a distinct fail-open internal error with a loud annotation.
- Adds three pure assertions with no network, subprocess, or LLM dependency and wires them into the real messaging E2E scenario.
- `assertTimely` and content-sniff/ownership annotation work remain explicitly deferred to Increment 2.
- Rollback is removing the workflow/script/helper imports; no durable migration is required.
