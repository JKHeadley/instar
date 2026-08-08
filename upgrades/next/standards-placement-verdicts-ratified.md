## What Changed

**Four new engineering standards joined the constitution, one existing standard was widened, and — for the first time — every one of them arrived with a check that actually fires rather than a promise that someone would remember.**

Ratified 2026-08-06 after a placement review read all five proposals against all 82 existing standards under one rule: complete overlap discards, tight overlap amends an existing standard, slight overlap earns a tree node, no overlap earns a root. The rule **reduced** the five rather than rubber-stamping them — one was withdrawn as a standalone and folded into its parent, four became tree nodes, and none earned root status.

**What is new, in plain terms:**

- **A decision that can block must live where the checks can see it.** Twenty-six shipped behaviour files are shell or plain JavaScript, and twelve of them can refuse an action — while every automated check walked TypeScript only. Those twelve are now declared, capped, and may only shrink; a new one cannot appear without someone classifying it.
- **Remove what demands attention.** When a defect keeps coming back despite real effort, delete the structure that requires the effort instead of applying more of it. Four copies of a fact cannot be kept in agreement by diligence — three of them have to go, and the survivors become pointers.
- **A dispatch supplies the question and withholds the answer.** When you ask a checker to verify something, do not tell it what you expect. An expectation written into the request does not get tested; it gets adopted, and comes back wearing the authority of whatever method the checker used.
- **Recall over your own material is by meaning, not word-match.** A keyword search returning nothing means "no literal match in the words I tried", not "this does not exist" — and an agent that confuses the two re-derives what it already knew.
- **Verify the State, Not Its Symbol was widened** so it binds a check's account of *itself*: every check must state the condition it evaluates and the claim its result will be read as certifying, and answer "what input passes this while failing the claim?" before it ships.

**The guards, and what they refuse:** an undeclared blocking decision; a second definition of any standard in the constitution; a reviewer prompt that carries the marker of the withhold-the-answer protocol without its actual instructions; a search endpoint advertised for meaning while dispatching to a word-matcher; and a declared parent-child relation that dangles or is one-sided. All five were proven by deliberately introducing each violation and confirming it fired **for its own reason** — not merely that the check exited non-zero.

**One user-visible correction shipped with it.** The capability list described the plain semantic-search endpoint as "semantic search" when it is keyword-only. An agent reading its own capabilities and calling the documented search got word-matching from something named for meaning. It now says plainly what it is, and points at the endpoint that genuinely searches by meaning.

## Summary of New Capabilities

- `scripts/lint-blocking-decisions-declared.mjs` — declares the shell/JS blocking-decision population; shrink-only against a committed ceiling, with content-pinned non-blocking declarations.
- `scripts/lint-no-duplicate-definitions.mjs` — refuses a second definition of a family, article, or article ID in the registry.
- `scripts/lint-dispatch-withholds-answer.mjs` — every templated reviewer dispatch carries the complete withhold-the-answer protocol.
- `scripts/lint-recall-surface-names-match-mechanism.mjs` — an advertised recall surface cannot promise meaning while dispatching to the literal matcher.
- `scripts/lint-registry-tree-parentage.mjs` — a declared parent must exist and must name the child back.
- `PostUpdateMigrator.migrateDispatchWithholdsAnswer` — deployed agents receive the dispatch protocol in their installed reviewer templates.

## What to Tell Your User

Nothing about your agent's day-to-day behaviour changes. These are rules about how instar itself is built, and five new automated checks that hold them in place.

The one thing worth knowing: if you ever asked your agent to search its own memory and it came back with nothing, "nothing" may have meant "none of the words you used appear literally" rather than "you never told me that." Your agent now knows the difference and is pointed at the search that understands meaning.

<!-- user_announcement
audience: agent-only
maturity: stable
-->
