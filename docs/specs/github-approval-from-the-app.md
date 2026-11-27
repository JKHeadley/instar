---
title: Approve a code-owner pull request from the owner's phone, verified on GitHub
slug: github-approval-from-the-app
eli16-overview: github-approval-from-the-app.eli16.md
status: converged
author: echo
created: 2026-11-19
tier: 2
parent-principle: "Mobile-Complete Operator Actions"
operator-request: "Justin, 2026-11-19 09:51 PST, topic 134088: the Needs-you flow for a code-owner approval (\"Pull request #3478 needs your approval on GitHub\") is a \"wild goose chase where clicks don't match instructions\""
review-convergence: "2026-11-19T18:23:07.329Z"
review-iterations: 6
review-completed-at: "2026-11-19T18:23:07.329Z"
review-report: "docs/specs/reports/github-approval-from-the-app-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 1
contested-then-cleared: 2
approved: true
approved-by: "echo, after reading the convergence report (6 rounds, codex-cli each round): its own converged spec, not a constitution or protected-list amendment (2.0 Rule 82); it narrows an existing standing practice (recording the owner's GitHub approval on their yes) to a Face ID tap. Two accepted residuals are named in the report, and the switch stays off unless the live race proof passes."
---

# Approve a code-owner pull request from the owner's phone, verified on GitHub

## Problem

Some pull requests change a file only the repository owner may approve (the paths `.github/CODEOWNERS`
assigns to an owner: today `docs/STANDARDS-REGISTRY.md` and `.github/CODEOWNERS`). GitHub refuses to
merge them until the owner records an approving review at the pull request's current head. The merge
watcher (`GreenPrAutoMerger`) lists them as `code-owner-review` snapshot entries; the console's
Needs-you list and the phone apps (`GET /needs`, `GET /mobile/needs`) show each as "Pull request #N
needs your approval on GitHub".

On 2026-11-19 the owner followed that row and hit three dead ends:

1. The phone app said to approve on the phone, but no route records the approval: the row only opens
   the console's Development page.
2. The Development page said "waiting for your code-owner review on GitHub" with no link, and
   "GitHub links are off: the repository name comes from the Pace read, which did not answer". The
   repository name came only from `GET /throughput/series` (`pace.repo`), a slow read that timed out,
   although the merge watcher has the repository name in its own configuration.
3. The row carries no title or summary, so the owner cannot tell what they are approving.

A standing practice records the approval today (agent memory `code-owner-approval-on-justins-yes`;
PR 3200 review 5914459250, PR 3219 review 5923414721): on the owner's yes in chat, the agent records the
owner's approving review in the owner's own signed-in GitHub browser profile (Playwright Profile
Registry profile `justin-github`, account service `github`, identity `JKHeadley`, vault references for
username, password and TOTP secret) and checks with the GitHub API that the review is APPROVED at the
head. It runs from a scratch script on a chat yes, which is not proof a person decided (memory
`operator-session-is-not-human-proof`). This spec replaces the chat yes with a Face ID tap on the
owner's phone and productizes the script.

## What already exists

- **Merge watcher** (`src/monitoring/GreenPrAutoMerger.ts`): lists the agent's own open PRs every 10
  minutes on the lease holder; a PR touching a code-owned path without the owner's approval becomes a
  snapshot entry `{pr, headRefName, headRefOid, kind: 'code-owner-review'}`. Its repository is
  `cfg.repo` (`JKHeadley/instar`, `src/commands/server.ts`). The listing already has each PR's `title`;
  `codeOwnedPaths()` already returns the touched code-owned `files`. `applyHold(pr, reason)` puts the
  `[HOLD: …]` marker on a PR so nothing merges it.
- **`GET /green-pr-automerge`**: the watcher snapshot the console and `/needs` read.
- **Needs-you list** (`dashboard/console/needs-model.js` source `shipping-approvals`, served by
  `src/server/needsRoutes.ts`; `toItem()` copies a fixed field set into `NeedItem`).
- **Development page** (`dashboard/console/development-model.js` `buildShipping`, `development.js`):
  GitHub links only when `pace.repo` is known.
- **Owner phone actions** (`src/server/mobilePermissionsRoutes.ts`): the write gate (owner's paired
  phone, device signature over method, path and raw body, local TLS, presence key);
  `POST /mobile/permissions/challenge {action, target}` issues a single-use challenge bound to the
  device, Host and one exact action line; the action route verifies the Face ID presence signature over
  that line and audits to `state/mobile-permission-actions.jsonl`. `DEVICE_ALLOWLIST`
  (`mobilePairingRoutes.ts`) admits each device route with `ownerOnly` and a rate bucket.
- **Playwright Profile Registry** (`.instar/state/playwright-profiles.json`; `danglingRefs` reports
  vault references that do not exist) and **SecretStore** (the encrypted vault the server reads).

## Design

### Part A — the row carries what the owner needs (no Pace dependency)

The GitHub link opens the pull request's current changes. The tap is bound to the head the row
showed (stored with the challenge), so if the pull request moved after the row was drawn, the
changes the owner opens are newer than the row and the approval is refused as `head-changed`: the
owner can never approve a version other than the one both the row and the link showed.

1. `GreenPrAutoMerger` adds to each `code-owner-review` snapshot entry `title` (the listed PR title;
   GitHub caps titles at 256 characters, carried whole) and `ownerFiles` (every code-owned path
   `codeOwnedPaths()` returned). It exposes its configured repository as a read-only `repo` getter.
2. `GET /green-pr-automerge` adds `repo` and `ownerApproval: {available, reason}` (Part B's
   availability, cached, no network call).
3. `buildShipping` prefers the watcher's own `repo`, then `opts.repo` (Pace). Links and the approval
   both use the watcher's repository, so the link the owner opens and the repository written to are the
   same. The "GitHub links are off" note appears only when neither names one, and then says the merge
   watcher did not name a repository. A `needs` row's sub line reads `waiting for your approval on
   GitHub: <title>` when the title is known.
4. The `shipping-approvals` Needs-you rows from `code-owner-review` entries add flat fields: `pr`,
   `githubUrl` (`https://github.com/<repo>/pull/<n>/files`, only when the repo matches
   `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`), `prTitle`, `prSummary` (`Changes <every ownerFile, comma
   separated>`), `headSha` (the snapshot's `headRefOid`) and `approveAvailable`. Rows built from
   `refused:approval-required` episodes carry `pr` and `githubUrl` only (they have no snapshot head), so
   no approve button is offered on them. `needsRoutes.ts toItem()` copies the six fields through,
   validated (URL pattern above, sha `^[0-9a-f]{40}$`, text through the existing `clean()`, title at
   most 256 characters, summary at most 400 with "and N more" when cut). A reader that does not know
   them ignores them.

### Part B — record the approval on the owner's Face ID tap

**Service** `src/core/GithubOwnerApproval.ts`, built in routes.ts from the live config, the watcher
(`repo`, the snapshot, `applyHold`), the Playwright Profile Registry and the SecretStore.

`availability()` (cached 60 s, no network) is true only when all hold, else false with a plain reason:
`github.ownerApproval.enabled === true` (default false, so the fleet is dark; no config migration is
needed because absent means off); the watcher names a repository; exactly one registry profile matches
(`github.ownerApproval.profileId` when set, else the only profile with an account `service: 'github'`
and `owner: 'operator'`); its `userDataDir` exists on this machine; its account has an identity (the owner's GitHub login,
which is also the sign-in name) and a password and a TOTP secret in the vault: the account's typed
`vaultBindings.password` / `vaultBindings.totp` when set, else the one vault reference whose name
contains `password` / `totp`, each present in the vault; the identity appears as `@<identity>` (any case) in the repository checkout's `.github/CODEOWNERS`; and
`playwright-core` loads from `github.ownerApproval.playwrightCoreDir` (a pinned install the agent
owns; no search of caches).

`precheck({pr, headSha?})` (used at challenge time and again at approve time): `pr` is a positive
integer and `headSha` is 40 hex; available; a live `gh api repos/<repo>/pulls/<n>` read (failure → 502
`github-unreachable`) shows it open (else 409 `pr-not-open`) and at that head (else 409 `head-changed`
with `currentHead` and `prTitle`); it is the agent's own PR by the watcher's own ownership read (the
`holdEligible` check `applyHold` uses: author, branch namespace, not a fork), else 409 `not-agent-pr`,
so a HOLD can always be applied to it; and it waits for the owner, judged live, not from the watcher's
snapshot (which only the lease holder refreshes): its changed files (`gh api --paginate
repos/<repo>/pulls/<n>/files`) include a file whose owners, under the CODEOWNERS file read at the PR's
base commit (GitHub's own search order: `.github/CODEOWNERS`, then `CODEOWNERS`, then
`docs/CODEOWNERS`, each `gh api repos/<repo>/contents/<path>?ref=<base sha>`) with GitHub's
last-matching-rule-wins order, include the owner's login, else 409 `not-awaiting-owner-review`. The
reader handles literal paths, `dir/` prefixes and `*` within one segment; a CODEOWNERS file with any
other syntax (`**`, `?`, `[`, `!`, escapes) is refused as a whole (409 `codeowners-unreadable`), never
guessed. The local checkout's CODEOWNERS is used only for availability (is the owner a code owner at
all).

`start({pr, headSha, deviceId})` after the proof:

1. `precheck` again with the head.
2. A per-profile lock file next to the profile (`<userDataDir>.approval.lock`, exclusive create,
   holder pid, a lock whose pid is not alive is taken over) → 409 `approval-in-progress` when held. One
   browser profile can be open by one process. (The host-wide `PlaywrightSeatLease` guards the browser
   MCP's default profile, a different directory, so it is not the right lock here.)
3. Read the reviews (`gh api --paginate repos/<repo>/pulls/<n>/reviews`). The owner's state is their
   latest review whose `user.login` equals the identity (any case), ordered by `submitted_at` then id,
   among APPROVED / CHANGES_REQUESTED / DISMISSED. Latest is APPROVED at `headSha` → done,
   `{approved: true, already: true, reviewId, commitId}` without opening the browser. The ids of the
   owner's existing reviews are kept.
4. Run the approver script with a 120-second deadline, as its own process group (the whole group,
   Chrome included, is killed at the deadline); secrets are written to its stdin only.
5. Verify, always, whatever the script reported or if it timed out: re-read the reviews. A NEW owner
   review (id not seen in step 3) that is the owner's latest and APPROVED at `headSha` → approved. A new
   approving owner review at another commit → `approved-at-other-head`: the service immediately calls
   the watcher's `applyHold(pr, 'owner approval landed on a newer head than the one approved')` so
   nothing merges it (retried once on failure), and the answer tells the owner in plain words, with
   `held: false` and "open it on GitHub now" when the hold could not be applied. The owner is looking at
   the phone at that moment, so the answer is the notice; the audit row records it too. (Later pushes
   are covered by the repository's own rule: the live `main` ruleset has `dismiss_stale_reviews_on_push:
   true`, so the hold only has to cover the click-time race.) Otherwise → `approval-not-recorded`
   with the script's outcome word (`signed-out`, `device-verification`, `reauth-required`,
   `profile-busy`, `head-changed`, `timeout`, `error`).
6. Every attempt appends one row to `logs/github-owner-approvals.jsonl` (rotated with the existing
   `maybeRotateJsonl`) `{at, pr, headSha, deviceId, outcome, reviewId?, commitId?}`; never a secret,
   never page text.

Each attempt gets an id. Before the script runs, the attempt `{id, pr, headSha, baseline review ids,
state: 'running'}` is written to `state/github-owner-approval-runs.json` (every attempt by id, with a
latest-per-PR index; finished ones kept 1 hour; an attempt never settled within its hour ends as
`failed`/`unsettled` with an audit row, never dropped silently). The approver's process id is written
synchronously before the script is given its input on stdin, so no submission can happen before the
attempt names its worker. The 202 carries the attempt id. A read of a `running` attempt that no live
worker in this process owns (the server restarted mid-run) is reconciled against GitHub with its
baseline before it is answered: a new owner approval at its head → `approved`; a new one elsewhere →
the HOLD path; otherwise `failed` with outcome `interrupted`. The approver's process-group id is written to the attempt as soon as it starts; before a later read
reconciles an attempt that no live worker owns, that group is killed (SIGKILL), so an approver left by
a dead server can never click after its verdict, and a new tap first settles every such attempt (409 `approval-unsettled` while one cannot yet be
settled, so a new run's baseline never absorbs an earlier run's approval). A pid is never trusted
alone: the kill happens only while that process is still the approver script, and the lock records
the holder's pid with its start time. When
every verification read fails, the attempt stays `running` with outcome `verification-pending` and is
settled by the next read the same way (HOLD included), within its 1-hour lifetime. The service never
forwards the script's test-only inputs (`holdBeforeSubmitMs`, `headless`); only the live proof sets
them. The last-used TOTP step starts at the current step when the server starts.
A HOLD set after `approved-at-other-head`
stays until it is released through the watcher's existing hold release (the agent that owns the PR);
precheck does not refuse a held PR, so the owner can approve the new head, and the answer says the PR
stays on hold until then. After every run that reached the script, the service records the current
30-second TOTP step as used (whatever the script reported), so the next run waits for a fresh code.

**Approver script** `scripts/github-owner-approve.mjs` (the package's `files` already includes
`scripts`): reads one JSON object on stdin `{repo, pr, headSha, expectedLogin, userDataDir, playwrightCoreDir,
password, totpSecret, notBeforeStep, ghPath}` (the sign-in name is `expectedLogin`); loads `playwright-core` from `playwrightCoreDir`;
`chromium.launchPersistentContext(userDataDir, {channel: 'chrome', headless: true})` (lock error →
`profile-busy`); opens `https://github.com/<repo>/pull/<pr>/files`. If GitHub shows the sign-in page,
it signs in with the username and password; on the two-factor app page it types an RFC 6238 code
computed in-process from the secret, at a 30-second step after `notBeforeStep` (the service remembers
the last step it used, so two runs never send the same code; the script prints the step it used); a device
verification (emailed code) page → `device-verification`; a sudo page → `reauth-required`; no
authenticator-code field on the two-factor app page (passkey or security key only) →
`2fa-method-unavailable`. If the review dialog shows pending review comments the owner left
unsubmitted, it stops with `pending-review` rather than publish them with the approval. It reads
the signed-in login from the page (`meta[name="user-login"]`) and stops with `wrong-account` unless it
equals the identity. Immediately before the final click it re-reads the head with the agent's own `gh`
(`ghPath api repos/<repo>/pulls/<n> --jq .head.sha`) and stops with `head-changed` if it differs; if
the review form carries a head field (`head_sha`, `commit_oid`, `expected_head_oid`) that differs, it
also stops. It opens the review dialog, checks Approve and clicks the dialog's own submit button
(matched by `/submit review/i` scoped to the dialog). It prints exactly one JSON line `{outcome, step?}` (`step` is the TOTP time-step number it used,
never the code). It
never prints, logs or passes on argv a secret or a TOTP code, never writes page HTML to disk, and closes
the browser in `finally`.

**Routes** (owner's phone only; there is no console approval route, see Security)

- `POST /mobile/permissions/challenge {action: 'github-approval', target: '<n>', headSha}`: the write
  gate, then `precheck` (so a refusal costs no Face ID); the signed action line is
  `github-approval <n>` (the app's contract, commit e418f4f). The head is required here and stored with
  the issued challenge.
- `POST /mobile/github/approvals/:pr/approve {headSha, challenge, presenceSig}`: the write gate,
  `buildAction('github-approval', :pr)`, the presence proof over `github-approval <n>`, then `start`.
  The approve's `headSha` must equal the head stored with the consumed challenge (else 409
  `head-changed`): Face ID signs only `github-approval <n>`, so the challenge carries the head the
  owner was shown when they tapped. The device signature over the raw body proves the app sent it. The route waits up to 25 seconds (under the app's 30-second client
  wait and the server's 30-second request limit): finished → 200 `{approved: true, already, reviewId,
  commitId, verifiedAt}` or the refusal's status; still running → 202 `{state: 'running', attemptId, pr,
  headSha}`.
  Audited through `finish()` as event `github-approval`.
- `GET /mobile/github/approvals/:pr[?attempt=<attemptId>]`: that attempt (every attempt is kept by id
  for an hour, so a later attempt never hides an earlier one's answer), else the latest for the PR, `{state: 'none' | 'running' |
  'approved' | 'failed', outcome?, headSha?}` plus the finished run's full answer body (the same fields
  and plain `detail` the approve route would have returned, including `held` for
  `approved-at-other-head`), so a result that arrives after the 202 reaches the owner in full.
- Both are added to `DEVICE_ALLOWLIST` (`ownerOnly: true`, bucket `github-approvals`) and to the
  owner-only allowlist guards (`tests/unit/mobile-session-terminal.test.ts`,
  `tests/integration/team-access-status-table.test.ts`).
- The console's Development `needs` rows and Needs-you row show "Open on GitHub" (the files link) and,
  when `approveAvailable`, the line "Approve it with Face ID in the Instar app". The phone app work
  (button, Face ID, polling) is owned by the app build session that set the contract above; the agent
  side ships the routes and fields it codes against.

**Awareness**: `src/data/awareness/github-owner-approval.md` tells agents that a code-owner PR waiting
for the owner is approved by the owner's Face ID tap in the app (the row carries the link), and that the
hand-run chat-yes script is replaced.

## Decision points touched

- **Only the owner's phone, with Face ID over `github-approval <n>` and the device signature over the head, can start an approval.** — invariant; basis: irreversible-consequence; evidence: an approving review is a durable record on GitHub under the owner's name that unlocks a merge of a protected path; a local session can read the dashboard PIN and token off disk (reference "Owner-approved sensitive actions"), so a PIN is not proof a person decided.
- **Only the agent's own PRs whose live changed files are owned by the owner under the base commit's CODEOWNERS can be approved this way.** — invariant; basis: enumerable-domain; evidence: CODEOWNERS (last matching rule wins) lists exactly the paths that need the owner; the agent's own PRs are exactly those the watcher can HOLD; any other PR is outside what the owner is asked.
- **The approval is refused when the live PR head, or the head stored with the challenge, differs from the approve's head.** — invariant; basis: irreversible-consequence; evidence: approving a newer head records the owner's approval of code they never saw.
- **Success means GitHub's reviews API shows a new owner review, latest and APPROVED at that head; never the script's own report.** — invariant; basis: external-constraint; evidence: branch protection reads GitHub's review record; on 2026-11-16 (PR 3219) the script printed "submitted" and nothing was recorded.
- **An approval landing on another head puts a HOLD on the PR at once.** — invariant; basis: irreversible-consequence; evidence: a merge of unseen code cannot be undone from the phone; the HOLD marker is the watcher's existing stop.
- **An approval already recorded at that head is answered without opening the browser.** — invariant; basis: enumerable-domain; evidence: the owner's latest review state is one of a fixed set of GitHub states.
- **One approval at a time per machine.** — invariant; basis: external-constraint; evidence: Chrome locks a profile directory while it is open.
- **The approver script gets 120 seconds before its process group is stopped.** — judgment-candidate; floor: step 5 re-reads GitHub whatever happens, so the deadline bounds only the wait, never what the owner is told; arbiter: the GitHub reviews read.
- **The approve route answers within 25 seconds of the request (the GitHub reads before the run share a 10-second deadline), then 202 and the phone reads the result.** — invariant; basis: external-constraint; evidence: the app's owner-presence client waits 30 s (`OwnerPresenceViews.swift`) and the server's request limit is 30 s (`requestTimeout`).
- **Availability needs the switch, one GitHub operator profile on this machine whose identity is a code owner, its three non-dangling vault references, and a loadable playwright-core.** — invariant; basis: enumerable-domain; evidence: each is a precondition the script cannot run without; no surface offers a button that cannot work.

## Multi-machine posture

- Part A rows: the existing `shipping-approvals` posture (`machine-local`, the watcher's lease-holder
  snapshot, declared in `NEED_SOURCE_POSTURE`); the head and whether the PR waits for the owner are
  re-read live before any approval, so a stale snapshot can never cause a wrong approval, only a 409
  with the current head, and the profile machine can approve whichever machine holds the merge lease.
- Part B approval: machine-local-justification: physical-credential-locality — the owner's signed-in
  GitHub browser profile is a directory on one disk. A machine without it answers `available: false`
  with reason `no GitHub sign-in for the owner on this machine`; its rows carry `approveAvailable:
  false` and still carry the GitHub link. Discovery: the phone reads `/mobile/needs` from the machine
  it is paired through, which today is the Studio, also the profile machine and normally the merge
  lease holder. When the lease is elsewhere, the Studio's rows come from its own older snapshot; a
  row it does show is approvable (the precheck is live), and a PR it does not yet list is still
  reachable through the GitHub link on the lease holder's row. Routing the approval to another machine
  is not built: there is one profile machine. The run state and audit stay on that machine with the action.

## Security

- The phone tap is the only approval path. There is no console PIN route: a local agent session can
  read the PIN, so a PIN approval would let an agent record the owner's approval of a constitution
  change, which CODEOWNERS exists to stop. The console offers the GitHub link, where the owner, signed
  in as themselves, can approve directly.
- The gate stops accidents and replays, not a hijacked agent: the agent already holds the vault
  credentials. That is the existing standing grant; this spec narrows its sanctioned use to the owner's
  device-signed Face ID tap.
- Secrets are read from the vault in the server and written to the script's stdin; never argv, never
  env, never a log. Only an outcome word comes back.
- `pr` and `headSha` are validated before any process runs; the repository comes from the watcher's
  configuration, never from the request.

- Why the click-time race cannot reach a merge before the HOLD: a new head is not mergeable until its own checks pass on it (local verify, about 45 minutes, or the CI floor, many minutes), while the HOLD is applied within seconds of the verification read. The live race proof (Acceptance 8b) gates the switch regardless.

## What it does not change

- CODEOWNERS, branch protection, safe-merge, the merge watcher's merge decisions, the approval record.
- No background work: an approval runs only on a tap.

## Acceptance

1. A `code-owner-review` row in `GET /needs` carries `pr`, `githubUrl`, `prTitle`, `prSummary`,
   `headSha`, `approveAvailable` with the Pace read failing; an episode-only row carries no `headSha`.
2. The Development page builds the GitHub link from the watcher's repository with Pace failing.
3. The phone routes refuse a bearer call, a member phone, a bad presence signature, a PR not touching an
   owner path (409, including when a later CODEOWNERS rule gives the path another owner), a PR not the
   agent's own (409), an unreadable CODEOWNERS (409), a changed head (409 at challenge, at approve, and between the two), a challenge
   without a head (400), an unavailable service (503); and
   answer 200 `already: true` without running the script when GitHub already shows the owner's approval
   at that head.
4. With a fake approver: a new approval verifies 200; "submitted" with nothing recorded → 502
   `approval-not-recorded`; a pre-existing old approval at another commit is not reported as
   `approved-at-other-head`; a new approval at another commit → 409 and `applyHold` called (retried once; `held: false` when it fails); a slow run
   → 202 then `GET` reads `approved`; a slow wrong-head run with both HOLD attempts failing → `GET`
   reads `failed` with `held: false` and the plain instruction.
5. No secret value appears in argv, env, stdout handling, the audit log or a response.
6. Wiring: the service built in routes.ts gets the real watcher, registry and SecretStore; an e2e
   lifecycle test shows the routes alive (503 when the switch is off, 409 for a PR not waiting).
7. Both routes are in `DEVICE_ALLOWLIST` as owner-only and in both owner-only guard lists.
8. Live, on a throwaway repository only (never a real instar PR): (a) the script records an approval
   with the owner's profile on a pull request opened for the proof, and the GitHub API shows it at the
   head; (b) the head is advanced AFTER the script's final head check and before the submit click (a
   test-only `holdBeforeSubmitMs` input pauses there for the push), and the newer commit must not
   receive the approval (GitHub refuses the stale form, or the review lands on the old commit). On Echo the switch is turned on (with a pinned playwright-core) only when both pass; if (b)
   fails, the switch stays off and the rows ship with the GitHub link alone.

## Maturation plan

- **test-agent-live:** the unit, integration and e2e cases in Acceptance 1 to 7 with a fake approver, then the live proof in Acceptance 8 on a throwaway repository with the owner's real profile: an approval recorded at the head, and a head pushed during the pause after the final check that does not receive it.
- **dev-agent-live:** Echo on the Studio, switched on only when both live proofs pass, with a pinned playwright-core; the owner approves real code-owner pull requests from the app for 7 days.
- **fleet:** stays off by preference: it acts in the owner's GitHub account and needs that owner's GitHub profile on the machine, so a fleet default would do nothing for agents without one.
- **graduation criterion:** over the 7 days, at least one approval recorded and verified at its head, zero `approved-at-other-head`, and no operator-found defect in the app flow.
- **dark-window:** off on every agent until the dev-agent rung passes; off by preference after it.
- **ladder:** github-owner-approval

## Rollback

Set `github.ownerApproval.enabled: false` (the default): availability turns false, rows show
`approveAvailable: false`, the routes answer 503. Part A is additive fields; reverting the PR removes
them with no stored state to repair.

## Open questions

*(none)*
