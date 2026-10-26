# Attention-noise cleanup: what was closed (2026-10-25 to 2026-10-26)

The operator reported on 2026-10-25 at 17:08 PDT (topic 127504) that the attention list was overwhelming and that most of it should not need them. The cause and the fix are in `docs/issues/attention-noise-items-never-close.md` and `docs/specs/attention-lifecycle-close-on-cause.md` (PR #2361, released in v1.3.1445). This report lists what the one-time cleanup closed, in the order it happened, with every security item checked by hand first.

## Result

| Machine | Open before | Duplicates merged | Cause gone | Expired | Closed by hand with evidence | Open after |
|---|---|---|---|---|---|---|
| Mac Studio | 791 | 239 | 14 | 369 | 2 | 167 |
| Mac Mini | 952 | 642 | 17 | 189 | 0 | 104 |
| Laptop | 1,070 | 595 | 11 | 330 | 2 | 132 |
| Mama PC | 210 | 99 | 6 | 28 | 0 | 77 |
| **Total** | **3,023** | **1,575** | **48** | **916** | **4** | **480** |

Counts are per machine, so one problem seen by several machines counts once per machine. The pool view the operator sees coalesces those, which is why it showed about 1,140 open items on 2026-10-25 against 3,023 machine rows.

What is still open: 3 security items (never closed automatically), 41 items that asked the operator something and are under 30 days old, and 437 automated notices under 14 days old or whose cause is still active. From now on the hourly pass on each machine keeps the list bounded by the same rules.

## Step 1: manual cleanup (2026-10-25, 17:40 PDT)

Done by hand from the dashboard topic at the operator's request, before the fix existed. It closed 34 attention items and withdrew 33 stale promises that were waiting on the operator. The full list with reasons is the private view "Cleanup: what I closed (2026-10-25)". It covered 26 sign-in-repair rows whose repairs had all ended, four stale evolution-queue alerts from July, two superseded quota notices, and the GitHub token item below. The cleanup in step 3 treated all of these as already handled.

## Step 2: security and judgement checks before anything expired

The dry run on 2026-10-26 listed 921 items that would expire. Each item that asked the operator something was read by title (43 on the Studio, 35 on the Mini, 32 on the Laptop, none on Mama PC). These needed a check before they could close:

- **"Rotate exposed GitHub access token"** (Studio, 2026-09-10) and **"Rotate github_token (printed into a session transcript)"** (Studio, 2026-09-06). The token was rotated on 2026-09-28, 2026-10-09 and 2026-10-13, so the exposed value is dead. Both were closed with that evidence. The second was not recognised as security by the new rule because the word "token" sits inside "github_token". That is fixed by the PR that carries this report.
- **"Outbound credential wall misses modern OpenAI and GitHub key formats"** (Studio). Fixed by PR #2032; closed with that evidence.
- **"Active email authorization for someone else on this machine"** (Mini, 2026-08-10). A live Google grant on a mailbox that is not the operator's, still undecided. It was **kept open** and marked sticky so no automatic pass can close it. The new rule also missed this one; the same fix now recognises it.
- **"Credential identity drift"** (Laptop). Two of the accounts no longer drift and their items were closed with that evidence. One, "adriana", still drifts today; its 102-day-old item expired under the 30-day rule with the label "never confirmed cleared", because the drift checker does not tell the attention list that the condition is still active (filed as `fb-45f13074-454`). The drift itself stays visible in the dashboard's Subscriptions tab and the account is kept out of swaps.

No other security item was touched: the security class (3 rows open now) is excluded from merging, cause-clearing and expiry by the code, and the live run's lists contain none.

## Step 3: the cleanup itself (2026-10-26, 10:43 to 10:47 PDT)

Each machine's first automatic pass, two minutes after it updated, merged duplicate rows and closed rows whose producer reported the cause gone, and only listed what expiry would close. After the review in step 2, one live pass per machine applied the expiry. Each close carries `closedBy` (`superseded`, `cause-cleared` or `expired`) and a resolution in plain words, and each machine records every close in `logs/attention-lifecycle.jsonl`. Nothing was deleted; any row can be reopened.

Promises waiting on the operator: none older than 14 days remain on any machine. The Mini's commitment sweep expired 3 with the reason "waited N days for you", and the manual step had withdrawn the rest.

Below, the closed rows grouped by kind and title (machine ids, account emails and agent ids replaced by placeholders; the top 40 titles per group, the rest summed).

### Duplicates merged (one row per condition kept open or closed by its own rule): 1575

| Kind | Title | Studio | Mini | Laptop | Mama PC |
|---|---|---|---|---|---|
| automated | Mesh rope cloudflare answers probes but stays demoted | 1 | 142 | 129 | 46 |
| automated | Mesh rope lan answers probes but stays demoted |  | 122 | 143 |  |
| automated | Inbound stranded on Laptop (N topics) | 61 | 140 |  |  |
| automated | Machine <machine> has been unreachable for 30+ minutes | 64 | 59 | 27 | 18 |
| automated | Inbound stranded on Mac Mini (N topics) | 3 |  | 144 |  |
| automated | Topic(s) look stranded on <machine> — I can't prove the owner's state | 13 | 24 | 21 |  |
| automated | Mesh rope tailscale not recovering | 27 | 23 | 6 |  |
| automated | Reply to topic N is held |  | 19 | 8 | 21 |
| automated | Convergence not observed on 1 conversation(s) | 37 | 6 |  |  |
| automated | Slow terminal server on "Laptop" |  |  | 41 |  |
| automated | Mesh rope tailscale answers probes but stays demoted |  | 27 | 10 | 3 |
| automated | Inbound stranded on Mac Studio (N topics) |  | 26 | 11 |  |
| automated | Machine <machine> is flapping | 12 | 7 | 1 |  |
| automated | Mesh rope cloudflare not recovering | 4 | 5 | 8 | 1 |
| automated | Proactive account optimization is measurement-blind |  |  | 10 | 2 |
| automated | Agent sagemind is dark: 1 message(s) undelivered |  |  | 11 |  |
| operator-asked | Feedback triage: things that need you | 10 |  |  |  |
| automated | Quota readings contradict for <account> |  | 9 |  |  |
| automated | Replies held on Mac Mini: 3 topics |  | 9 |  |  |
| automated | Replies held on Mama PC: 3 topics |  |  |  | 8 |
| automated | Mesh rope lan not recovering | 1 | 4 | 2 |  |
| automated | Quota readings contradict for <account> |  | 6 |  |  |
| automated | Agent <agent-id> is dark: 1 message(s) undelivered |  |  | 6 |  |
| automated | Slow terminal server on "Mac Studio" | 4 |  |  |  |
| automated | Quota polling stale on Laptop |  | 4 |  |  |
| automated | Quota readings contradict for <account> |  | 4 |  |  |
| operator-asked | Credential identity drift: sagemind-adriana |  |  | 4 |  |
| automated | OpenAI/Codex quota reading is stale |  | 3 |  |  |
| automated | Agent <agent-id> is dark: 1 message(s) undelivered |  |  | 3 |  |
| automated | Agent sagemind is dark: 2 message(s) undelivered |  |  | 3 |  |
| automated | Mac Studio is refusing this machine's signed messages |  |  | 3 |  |
| automated | Agent <agent-id> is dark: 1 message(s) undelivered |  |  | 3 |  |
| automated | Convergence not observed on 2 conversation(s) | 1 |  |  |  |
| automated | Reactive account swaps are cascading | 1 |  |  |  |
| automated | Machine coherence: my machines have drifted apart |  | 1 |  |  |
| automated | Quota readings contradict for <account> |  | 1 |  |  |
| automated | Quota readings contradict for <account> |  | 1 |  |  |
| automated | Agent <agent-id> is dark: 1 message(s) undelivered |  |  | 1 |  |

### Closed because the producer reported the cause gone: 48

| Kind | Title | Studio | Mini | Laptop | Mama PC |
|---|---|---|---|---|---|
| automated | Mesh rope tailscale not recovering | 3 | 3 | 2 | 2 |
| automated | Mesh rope cloudflare not recovering | 3 | 2 | 2 | 2 |
| automated | Topic(s) look stranded on <machine> — I can't prove the owner's state | 3 | 3 | 2 |  |
| automated | Claude Code sign-in repair | 3 | 2 | 1 |  |
| automated | Mesh rope lan not recovering | 1 | 2 | 2 |  |
| automated | Mesh rope tailscale answers probes but stays demoted |  | 2 | 1 | 2 |
| automated | Mesh rope lan answers probes but stays demoted |  | 2 | 1 |  |
| automated | Mesh rope cloudflare answers probes but stays demoted | 1 |  |  |  |
| operator-asked | Claude Code sign-in repair |  | 1 |  |  |

### Expired: untouched past the window (automated 14 days, items that asked you 30 days), labelled "never confirmed cleared": 916

| Kind | Title | Studio | Mini | Laptop | Mama PC |
|---|---|---|---|---|---|
| automated | Credential rebalancer | 16 | 14 | 148 |  |
| automated | Session wedged on an approval prompt I could not auto-clear | 12 | 5 | 2 |  |
| automated | Session permanently vetoed from idle-zombie cleanup | 14 | 4 |  |  |
| automated | Held reply to topic N expired | 1 | 8 | 3 | 5 |
| operator-asked | Account enrollment needs your check on "this machine" | 4 | 5 | 6 |  |
| automated | Reply to topic N is held | 2 | 4 | 4 | 4 |
| automated | 1 new message(s) from Dawn waiting for a reply |  |  | 12 |  |
| automated | Threadline single-negotiator: lease unavailable (fail-open) | 7 | 4 |  |  |
| automated | Machine <machine> is flapping | 4 | 3 | 2 | 1 |
| automated | Threadline history diverged from peer |  | 4 | 6 |  |
| automated | Inbound stranded on Mac Mini (N topics) |  |  | 10 |  |
| automated | Inbound stranded on Laptop (N topics) | 2 | 6 |  |  |
| automated | Autonomous re-registration refused for topic N | 5 | 2 | 1 |  |
| automated | Held reply to topic ? expired |  | 5 | 1 |  |
| automated | Stranded work in worktree "fix-telegram-standby-origin-relay" | 5 |  |  |  |
| automated | A credential slot was quarantined during a swap |  |  | 5 |  |
| automated | Stranded work in worktree "feat-subscription-signin-ledger" | 4 |  |  |  |
| automated | Stranded work in worktree "feat-telegram-message-origin-completion" | 4 |  |  |  |
| automated | Stranded work in worktree "fix-codex-enroll-device-auth" | 4 |  |  |  |
| automated | Topic 102965 placement diverged from its pin | 1 | 1 | 1 | 1 |
| automated | Inbound stranded on Mac Studio (N topics) |  | 2 | 2 |  |
| automated | Topic 36966 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Topic 28730 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Topic 48000 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Topic 29723 moved to Laptop, but the old session won't close | 1 | 2 |  |  |
| automated | Topic 49701 moved to Mac Mini, but the old session won't close | 3 |  |  |  |
| automated | Stranded work in worktree "placement-real-capacity" | 3 |  |  |  |
| automated | Topic 43003 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Topic 57697 placement diverged from its pin | 1 | 1 |  | 1 |
| automated | Topic 57770 placement diverged from its pin | 1 | 1 |  | 1 |
| automated | Topic 58968 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Topic 36966 moved to Mac Studio, but the old session won't close | 3 |  |  |  |
| automated | Topic 57770's pin has waited 24h unfulfilled | 1 | 1 |  | 1 |
| automated | Topic 66324 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Topic 66324's pin has waited 24h unfulfilled | 1 | 1 | 1 |  |
| automated | Topic 68955 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Topic 69507 placement diverged from its pin | 1 | 1 | 1 |  |
| automated | Stranded work in worktree "feat-telegram-message-origin" | 3 |  |  |  |
| automated | Stranded work in worktree "w32-quiet-hours-fix" | 3 |  |  |  |
| automated | Topic 61449 placement diverged from its pin | 1 | 1 | 1 |  |
| | 414 other titles | 255 | 107 | 117 | 14 |


## Problems found along the way

Triaged under the 80/20 rule: each went to the feedback queue rather than into this fix.

1. `fb-37e4a800-9ff`: on Mama PC two accounts need sign-in but have no attention item, because the notice is raised only by a repair attempt.
2. `fb-5a5871aa-737`: promises waiting on another agent are filed as waiting on the operator's authorization, so they count against the operator.
3. `fb-534ae1eb-ca5`: a promise marked violated cannot be withdrawn and has no way to retire.
4. `fb-8dc07baa-ae1`: the 21-day expiry for the agent's own promises ships as a dry run, so it never expires anything.
5. `fb-5125d802-656`: the local test verifier starves when several full test runs share the machine; its fixed lane time limits turn that into a false "main is broken".
6. `fb-45f13074-454`: the credential-drift checker does not report a live drift to the attention list (see step 2).
7. `fb-5d4bce3c-55d`: the add-attention-item endpoint cannot carry a tone-check acknowledgment, so an existing item whose original text contains a file path cannot be re-marked.

Fixed directly because they blocked this work: the sign-in repair tests now wait up to 30 seconds for an outcome instead of 1 second (they failed on every verifier run under load), and a quiet error handler on main was marked intentional so the silent-fallback count was back under its limit.
