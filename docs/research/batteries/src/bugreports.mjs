// Frozen bug reports for the 20 rebuilt bug-fix tasks (work-quality battery, WQ-001..WQ-020).
// Written 2026-10-26 from each fix's commit message and PR notes, keeping ONLY what a reporter
// could have observed before the fix: the symptom, the evidence, and the expected behaviour.
// Root cause, the mechanism of the fix and the fix's own file list are deliberately left out.
// Keyed by the fix commit's short SHA; gen.mjs resolves the full SHA and the pre-fix parent.
export const reports = {
  '8897858e2': {
    title: 'Claude login permanently reported missing on a machine where it works',
    body: `On a 4-machine pool with 8 subscription accounts, two Claude Code accounts are flagged "missing local login / owner re-login required" and excluded from capacity. The flag was set at 2026-08-25T03:29:54Z and has not changed in about 37 hours. On the affected machine both logins are present, unexpired, have refresh tokens and work when used directly. Signing in again does not clear the flag. The four accounts that are never flagged all have an email address used by no other pool row; the two flagged ones are the Claude accounts whose Google email also backs a Codex subscription in the same pool.\n\nExpected: a working Claude login is recognised as present, and the flag clears once the login is verified.`,
  },
  '0afa2e4ee': {
    title: 'Linux `instar autostart install` says the agent will start automatically, but it never starts on a headless host',
    body: `On a Linux server nobody logs into, \`instar autostart install\` completes, enables and starts a service, and prints "Your agent will start automatically when you log in." After a reboot the agent is not running. It comes up when someone connects over SSH and stops when they disconnect. On some machines the install also prints a stray "Failed to look up user <x>" line from loginctl.\n\nExpected: on Linux the install either makes the agent start at boot, or tells the operator plainly that it will start only at login (and what that means on an unattended machine), and does not print internal tool errors.`,
  },
  '91d264591': {
    title: 'Test-runner and spawn limiters misbehave on ordinary Linux machines (tmpfs /tmp, Docker, ZFS)',
    body: `On the first non-CI Linux host (WSL2, Ubuntu 26.04, where /tmp is tmpfs), 30 tests fail across three limiter test files. Watching the limiters directly: the host test-runner bound admits runs without taking a slot while reporting itself present, and the host spawn cap stops reclaiming holders from dead processes until it fills up. The same happens with a Docker container's overlay root and a ZFS root. On macOS everything works.\n\nExpected: both host-wide limiters work on normal local Linux filesystems (tmpfs, overlay, devtmpfs, zfs), while still refusing to trust a genuinely shared network volume.`,
  },
  '2156e2bb1': {
    title: 'Emergency stop says "Session terminated" but the session keeps running; tone-gate overrides are recorded as orphans',
    body: `Two separate reports.\n\n(1) Triggering an emergency stop on a running session: the route answers \`killed: true\`, the server log prints "killed session", and the person is told "Session terminated." The tmux session is still alive and still working afterwards.\n\n(2) When an agent re-sends a message with \`telegram-reply.sh --tone-decision-ref <ref>\` after a tone-gate advisory, using a machine-prefixed ref such as \`d-m_03b30f-<uuid>\`, the override is recorded as an orphan outcome that matches no decision, so the gate's decision never gets graded.\n\nExpected: an emergency stop either really ends the session or says truthfully that it did not; a valid decision ref reaches the server unchanged.`,
  },
  '960cc3b7e': {
    title: '`instar worktree create` commits as an unattributed address, forcing a human approval on release PRs',
    body: `Every worktree created with \`instar worktree create\` commits as \`<agent>@instar.local\`, an address linked to no GitHub account. On the W25 release PR, GitHub's "require extra approval for unattributed changes" rule fired, so a human approval became a required step in the release chain. Nobody configured that address; the agent repo and the agent config both have a real commit identity available. Existing agents' CLAUDE.md still describes the old behaviour after updating.\n\nExpected: worktree commits use an identity someone actually configured, and if none is configured the command says so instead of making one up. Updated agents' instructions describe the real behaviour.`,
  },
  'd8709b6b8': {
    title: 'Two agents in the same OpenClaw room can end up on the same Threadline thread',
    body: `Intermittent e2e failure (Scenario 8, run 32674712573): \`expected 'openclaw-room-a-mt6h30po' not to be 'openclaw-room-a-mt6h30po'\`. Two different agents resolving a thread in the same room at nearly the same moment received the identical thread id, and their conversations were then mapped onto one thread. The failure is rare and seems to get more frequent on faster machines. A unit test named "different agents get different threads for same room" passes, but it contains a short sleep between the two calls.\n\nExpected: two different agents never share a thread in a room, however close together they arrive, and one agent re-entering the same room keeps its existing thread.`,
  },
  '24fed659c': {
    title: 'A session that exits on its own leaves no reason, no reap-log row and no clue why',
    body: `On 2026-08-22 every interactive Codex session died about 18 seconds after spawn. Each one was recorded only as \`status: completed\` with no ended reason, nothing appeared in \`GET /sessions/reap-log\`, and nothing in the logs said what had been on screen. Sessions that are killed by the reaper, an operator or terminateSession all get a reason and a reap-log row; a session whose process ends by itself gets neither. The cause had to be found by hand-spawning a session and watching the pane.\n\nExpected: a session that exits by itself is recorded with a reason (and whether it died during startup), a reap-log entry, and enough of the last screen output to debug it, without leaking credentials.`,
  },
  'd36a7ff71': {
    title: 'Interactive Codex sessions die about 18 seconds after spawn',
    body: `With Codex CLI 0.147, every interactive Codex session Instar spawns dies roughly 18 seconds in. Watching the pane: Codex opens on an "Update available!" menu whose highlighted default is "1. Update now (runs npm install -g @openai/codex)". Shortly after, the user's first message and Enter arrive, the update runs and Codex exits. On the test machine this really upgraded Codex from 0.147.0 to 0.149.0. Claude Code sessions are unaffected.\n\nExpected: Instar never types the first message into a menu, Codex sessions start usable, and a session parked on a menu is reported rather than silently stalled.`,
  },
  '2806a3ecb': {
    title: 'Exactly-once ingress ledger fills with claims that never complete after a topic moves machines',
    body: `After topic 29723 transferred machines at 2026-08-18T06:01:01Z, the ingress ledger on the machine that no longer owns the topic shows \`telegram:29723:47566\` abandoned four minutes after the handover and \`telegram:29723:47828\` still \`processing\` three days later. Both messages were in fact delivered and answered by the owning machine. The stuck entries only appear on the non-owner.\n\nExpected: a machine that only relays a message to its owner does not leave an open claim behind, and delivery through the relay keeps working exactly as before.`,
  },
  '27ca302e9': {
    title: 'Rerouted interactive job sessions are reaped as successful after about 15 seconds',
    body: `On a live 3-machine fleet, 31 of 31 rerouted interactive sessions were killed between 15 and 41 seconds after starting, and every one was recorded as \`completed\`. That includes 25 scheduled jobs that reported "success, 0 failures" while doing about 16 seconds of work each. The completion marker the session is asked to print appears in the pane before the model has done anything.\n\nExpected: a rerouted session is treated as complete only after the model actually finishes and prints its completion marker; anything else must not be recorded as success.`,
  },
  '13644bdfa': {
    title: 'Cross-machine "Set up" sign-in returns a bare 408 while the sign-in is still in progress',
    body: `Tapping "Set up" on the Subscriptions grid for an account held on another machine: any sign-in that takes longer than about 30 seconds returns HTTP 408 to the dashboard, while the server keeps working on it and later reaches a real outcome (login did not start / cannot resolve email / reused) that the operator never sees. The same happens on the follow-me submit-code and cancel actions. Submit-code is the worst case: the verification code is single-use, so after a 408 the operator cannot tell whether their one attempt was spent.\n\nExpected: the operator gets the sign-in's real outcome; no outer timeout fires before the work it wraps is allowed to finish.`,
  },
  '73004eeb7': {
    title: 'A re-delivered inbound message looks identical to a fresh instruction',
    body: `When Instar's no-loss recovery re-injects an inbound Telegram message that was claimed but never replied to, the session receives exactly the same text as the original delivery. Verified on 2026-08-20: the two injected payload files for nonce dAdM7ghJNCcFdO4I (09:45:01 and 10:10:02) have the same md5. As a result a superseded, 21-hour-old instruction was read and acted on as if it were current. Long messages (delivered as a reference line plus a file) are affected the same way.\n\nExpected: a re-delivered message is visibly marked as a re-delivery, without breaking anything that parses the \`[telegram:N]\` tag, and fresh messages are unchanged.`,
  },
  '180069d14': {
    title: '`telegram-reply.sh` prints "Sent" for messages the server suppressed as duplicates',
    body: `When an agent sends the same text to the same topic twice within the duplicate window, the user receives only the first copy (expected), but for the second send \`telegram-reply.sh\` prints "Sent N chars" and exits 0. The agent believes the reply went out and moves on; there is no error, no retry and no log line. The server's response body for that request says the send was suppressed. Deployed agents keep the old script after updating.\n\nExpected: the relay script reports a suppressed duplicate as not sent (non-zero exit), never reports a real send as suppressed, and existing agents receive the corrected script on update.`,
  },
  '56964af52': {
    title: 'Any caller can create a "verified" topic operator through the manual API',
    body: `\`POST /topic-operator\` with any non-blank \`uid\` in its body stores a record with the same \`authenticated-inbound\` provenance as an operator bound from a real authorized Telegram message. Reading the store afterwards, there is no way to tell the manually asserted uid from a genuinely authenticated one, and downstream readers (session-context injection, outbound review, replication to other machines) treat it as the verified operator. Older records carry no evidence at all and are treated the same way.\n\nExpected: only an operator established from an authenticated inbound message counts as verified; manual assertions and evidence-less records stay inspectable but grant no authority, and an authorized message re-establishes a legacy topic.`,
  },
  '03b6c2a3f': {
    title: 'Codex enrollment loops forever, re-running `codex login` against the real account',
    body: `A Codex subscription enrollment kept running for hours: 33 device codes for one sign-in between 01:00Z and 09:21Z on 2026-08-16, still running when found. Each round re-ran \`codex login\` against the operator's real Codex account, and an earlier enrollment had signed the operator out of their own Codex. The operator approved the device code at the provider, Codex reported success, but the enrollment record stayed pending and was driven again. Each re-drive also destroyed the visible login pane.\n\nExpected: a Codex enrollment logs in only into its own isolated home, notices when the login has succeeded, and stops re-asking.`,
  },
  'c1493b623': {
    title: 'Running the test suite creates real private GitHub repositories on the operator\'s account',
    body: `The operator's GitHub account owns 378 repositories, 377 of them auto-generated and empty: instar-codex-only-test-* (126), instar-default-test-* (126) and instar-both-test-* (125), created between 2026-06-14 and 2026-08-15. Three new ones appear every time tests/unit/init-claude-gating.test.ts runs. The tests clean up their temporary home directories afterwards, but the repositories stay. At least seven test files run the init path.\n\nExpected: no test run ever creates a GitHub repository, including tests written in future; a real \`instar init\` (including one in someone's own CI automation) still sets up its backup. Existing repositories are the account owner's to delete.`,
  },
  '14d2d85c1': {
    title: 'Following a Codex account to another machine runs the Claude sign-in flow and loops',
    body: `Starting a cross-machine follow-me for a Codex account that is held only on a peer machine: the receiving machine treats it as an Anthropic / Claude Code account, starts the Claude url-code-paste sign-in, and writes into a \`~/.claude-followme-*\` home that Codex never reads. The login never finishes and the follow-me is re-driven on a cadence indefinitely. Verified live: the laptop recorded codex-sagemindai as anthropic/claude-code under ~/.claude-followme-codex-sagemindai while the Mini holds it as openai/codex-cli; the server log loops started-login → HELD (missing-completed-email).\n\nExpected: a follow-me keeps the account's real provider and framework, uses a home that framework reads, and stops rather than looping when machines disagree about what kind of account it is.`,
  },
  '73adf0edb': {
    title: 'Operator replies are held by the tone gate under load even though spawn slots are reserved for them',
    body: `During a live operator demo, outbound replies to the operator were refused (held) 12 times in about 15 minutes because the outbound tone gate could not get a spawn slot. At the same time the host spawn limiter reported interactive priority enabled with 2 slots reserved for synchronous operator reviews and 0 of them in use. Background calls were occupying the general slots until they timed out.\n\nExpected: an ordinary conversational reply to the operator can use the reserved interactive slots, so it is not held behind background work.`,
  },
  '205a61915': {
    title: 'Standards-registry tests fail in a checkout whose generated registry asset is out of date',
    body: `In a checkout where the packed standards-registry asset was generated at 17:59 from a docs/STANDARDS-REGISTRY.md that has since changed (three hours newer), the tests standards-registry-asset, standards-enforcement-auditor and standards-coverage-route fail with 8 assertions. Deleting and regenerating the asset by hand makes all 77 tests pass. The test setup regenerates the asset only when it is missing, never when it is older than its source.\n\nExpected: the test setup regenerates the asset whenever it is stale, without regenerating needlessly on every run.`,
  },
  'ab26b7ca3': {
    title: 'URL-logging lint misses a credentialed URL split across a string concatenation',
    body: `The lint that forbids logging a URL with embedded credentials (added after \`instar join\` logged a clone URL carrying a live GitHub token on 2026-05-27) flags \`"https://user:tok@github.com/x.git"\` but does not flag \`"https://user:" + "tok@github.com/x.git"\`. Both build the same string and leak the same token. Splitting a long literal like this is ordinary tidying a formatter may do, so the lint can be disarmed by accident.\n\nExpected: a credentialed URL built from adjacent string literals is flagged the same as a single literal, without new false positives on code that joins a literal with a variable.`,
  },
};
