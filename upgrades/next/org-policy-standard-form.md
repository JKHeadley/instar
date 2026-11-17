<!-- bump: patch -->
## What Changed

An organization's published AI policy is now accepted only in one standard form: the headings Purpose, Never, Ask first and Normally, in that order, with each rule on its own `- ` line. `POST /org/draft` rewrites a loose draft into that form and returns it as `policyMarkdown`, or refuses with `policy-not-standard` and a plain reason (a line outside the four sections, a character nobody can see, a comment marker or code fence). The agent, the instar.sh/join page and the Mac app read the policy with the same strict reader (`src/core/OrgPolicyGrammar.ts`), refuse anything else, and refuse names with hidden characters. The join page and the Mac app also check the policy against its signed fingerprint before showing it. This closes SEC-078 (the join screen and the agent could read the same policy differently) and SEC-077 (invisible characters could ride into the rules file).

## What to Tell Your User

If you set up your organization's AI policy, the agent now writes it in one standard layout before you read it back, so what you approve, what colleagues see when they join, and what their agents follow are always exactly the same text. If a line doesn't fit under Purpose, Never, Ask first or Normally, the agent asks where it belongs instead of guessing.

## Summary of New Capabilities

- `/org/draft` returns the standard policy text (`policyMarkdown`) and refuses non-standard drafts with `policy-not-standard`.
- One strict policy reader shared by the agent, the join page and the Mac app; 51 shared test cases (`tests/fixtures/org-policy-vectors.json`).
- Hidden characters, comment markers and code fences are refused in policies, and hidden characters and comment markers in organization names.

## Evidence

The two security repros are refused: 76 unit tests, the org integration and e2e tests, and the Mac app's Swift tests (51 of 51 shared cases) pass. An independent security review concurred after three rounds. A policy that hid rules inside an HTML comment, found in round one, is now refused, and every standard case is checked through the agent's rules-file reader.
