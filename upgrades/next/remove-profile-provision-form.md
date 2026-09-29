# The Subscriptions tab no longer shows the "Create a dedicated sign-in profile" form

## What Changed

The Subscriptions dashboard tab had a "Dedicated browser profiles" section with a
"Create a dedicated sign-in profile" form. It only created an empty Chrome profile
folder and a registry row naming a Google account. It never signed anything in.
The agent now creates, signs in and repairs these profiles itself (the
/subscription-signin skill and the agent-run sign-in repair), so the form is removed.

- `dashboard/index.html` / `dashboard/subscriptions.js`: the section, its CSS, the
  form renderer, its click handler and its URL entry are gone.
- The server route `POST /playwright-profiles/provision` and the whole Playwright
  profile registry are unchanged. The sign-in repair still reads the registry.
- The CLAUDE.md template (registry table row and the Playwright Profile Registry
  section) now tells the agent to create the profile itself
  (`POST /playwright-profiles` + `/accounts`), then sign it in with
  /subscription-signin; the provision route is noted as the one-call, PIN-scoped
  equivalent with no dashboard form.
- Existing agents: `migrateClaudeMd` rewrites the old "Remote/phone-complete
  provisioning" bullet (either shipped wording), and a new skill migration drops the
  "Phone-first alternative: the Subscriptions dashboard's profile provisioning."
  sentence from an installed /subscription-signin skill. Both are idempotent and
  keep local edits.

## Evidence

- `tests/integration/subscriptions-tab.test.ts`: the controller no longer renders the
  form (even when handed a legacy container), makes no provision call, and
  `dashboard/index.html` has no `subProfileProvision` container.
- `tests/integration/playwright-profile-routes.test.ts`: the provision route tests
  are unchanged and green.
- `tests/unit/PostUpdateMigrator-profileFormRemoved.test.ts`: both old CLAUDE.md
  bullet wordings are rewritten once and then left alone; a current CLAUDE.md is
  untouched; the skill sentence is dropped with local edits kept, idempotent.

## What to Tell Your User

The Subscriptions page no longer has the "Create a dedicated sign-in profile" form.
You never needed it: when an account needs its own browser profile, I set it up and
sign it in myself, and only send you a secure link if a password or approval is
truly needed.

## Summary of New Capabilities

- None new. An unused dashboard form was removed; the agent-side profile setup is
  unchanged.
