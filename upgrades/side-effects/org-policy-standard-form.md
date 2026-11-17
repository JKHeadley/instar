# Side effects: org policy standard form (SEC-077, SEC-078)

## Change
- `src/core/OrgPolicyGrammar.ts` (new): the standard form (`## Purpose|Never|Ask first|Normally`, `- ` rule lines, fixed order, one blank line between sections, no trailing newline), `readStandardPolicy` (the strict reader every reader implements), `emitPolicy`, `standardizePolicy` (draft-time rewrite of loose Markdown, refuses unplaced lines), `hiddenCharIn` (Cc/Cf/Co/Cs/Zl/Zp/Default_Ignorable, plus a combining mark with no base).
- `validateBundle` accepts a policy only in the standard form (`policy-not-standard`), and refuses hidden characters in orgName, publishedBy and keepers (`bundle-shape`).
- `/org/draft` stores and returns the standard text (`policyMarkdown`), refusing with `policy-not-standard` + plain detail.
- `OrgPackStore` applies the strict reading; `/org/status` shows the strict reading, falling back to the loose one only for display of an older pack.
- `site/src/pages/join.astro`: the strict reader (between ORG-POLICY-READER markers, run by the unit test), a SHA-256 check against `policySha256`, hidden-character check on names; the "Also in this policy" card is gone.
- Mac app (instar-ios `echo/mac-create-agent` 805ca67): `OrgPolicyStandard.swift`, same rules, same 40 cases.
- Shared cases: `tests/fixtures/org-policy-vectors.json`.

## Who is affected
- Admins: a draft that has lines outside the four sections, or invisible characters, is refused with the reason; the agent asks where the line belongs.
- Already-published packs in the old loose form (feature merged 2026-11-17 05:29Z, no pilot yet): members refuse their next update until the admin republishes (the republish produces the standard text). Joined members keep their applied rules.
- Invitation links made from an old-form pack stop opening on the join page and in the Mac app (shown as "can't be read").

## Rollback
Revert the PR; validation returns to the loose reader. Standard-form packs stay valid under the old reader (it reads them identically), so a rollback breaks nothing published after this change.

## Review round 1 (independent security review)
Found a fourth reader: OrgIntentManager strips `<!-- … -->` from ORG-INTENT.md, so a comment opened in one rule and closed in a later one hid the rules between them from the agent while every screen showed them; an unclosed code fence would do similar. The standard form now refuses `<!--`, `-->`, ```` ``` ```` and `~~~` anywhere (all three readers), generateOrgIntent neutralises comment markers as a second layer, and a unit test runs every standard case through OrgIntentManager and checks it gets every rule. Also refused now: unassigned code points and non-characters (\p{Cn}), U+2800 and U+1D159. Swift compares the markers by code point (an accent after `-->` can't hide it from one reader). 51 shared cases; 76 unit tests; Swift 51/51.

## Review round 3
An organization name containing `<!--` or `-->` is refused (isBundle, /org/draft): the name is written into the comment line at the top of ORG-INTENT.md. Reviewer concurred.

## Not covered
Look-alike letters from other alphabets (homoglyphs) are visible characters and are not refused. Members who joined before this change keep their applied rules file; no pack has been published for a pilot yet.

## Main merge (after #3294)
Merged origin/main (282d5d15e). The /org/draft conflict with #3294's draft base (keeper/version) was resolved keeping both: main's `base` logic, with the draft storing the standard text. #3294's new keeper proposals and recovery paths already go through validateBundle, so they get the standard-form check. Two #3294 test fixtures used a trailing newline and are now standard (a keeper proposal comes from a standardized draft). All org unit tests (98) and integration tests (26) pass.
