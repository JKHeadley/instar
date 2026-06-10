---
name: autonomous
description: Enter autonomous development mode with STRUCTURAL enforcement. Uses a stop hook to prevent premature exit. Generates stop conditions and confirms with user before starting. Work independently for a specified duration with progress reporting.
user_invocable: true
---

# Autonomous Mode (Structurally Enforced)

You are entering **autonomous development mode**. This mode uses a **stop hook** that PREVENTS you from exiting until all tasks are genuinely complete. This is not optional — the hook structurally enforces continuous work.

---

## Step 1: Generate Stop Conditions (MANDATORY)

Before activating the stop hook, you MUST:

1. **Analyze the goal** and break it into specific, verifiable tasks
2. **Present the task list** to the user with clear completion criteria
3. **Propose a measurable `completion_condition`** synthesized from those tasks — an
   artifact-grounded end-state an INDEPENDENT judge can verify from what you SURFACE
   (a commit SHA, a file's content, a CI run id, a test-count delta). This is the
   PRIMARY completion mechanism. Only fall back to a self-declared promise when no
   verifiable condition can be expressed — and then record `completion_mode:
   promise-fallback` + a one-line `promise_fallback_reason:`.
4. **Wait for user confirmation** before activating the hook
5. **Define the completion promise** — retained as the fallback token (only TRUE when
   ALL tasks are done)

**Example interaction:**

```
User: /autonomous --duration=8h --goal="Complete Slack feature parity"

Agent: Here's my task breakdown for autonomous mode:

TASKS (all must be complete before I can exit):
1. [ ] Implement job-specific Slack channels
2. [ ] Build full PresenceProxy Slack integration
3. [ ] Update dashboard HTML with platform badges
4. [ ] Implement Slack Lifeline process
5. [ ] Add platform dropdown to new session UI
...

Completion promise: "ALL_TASKS_COMPLETE"
Duration: 8 hours
Emergency stop: "stop everything" via messaging

Shall I proceed? (The stop hook will prevent me from exiting until all tasks are done)
```

**The user must confirm before the hook activates.** This is the safety gate.

---

## Step 2: Activate the Stop Hook

After user confirmation:

**2a. Add the stop hook to settings.json** (dynamically — it's removed when the session ends):

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
hooks = s.setdefault('hooks', {}).setdefault('Stop', [])
# The stop hook ships ONLY in the skill dir — register THAT path. (A legacy bug
# registered '.instar/hooks/instar/autonomous-stop-hook.sh', where the file is
# never deployed, so the hook silently failed every Stop and the loop never
# re-engaged.) Self-heal: drop any prior autonomous-stop-hook entry (incl. the
# legacy wrong path), then add exactly one correct-path entry.
correct = 'bash \${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh'
before = json.dumps(hooks)
hooks[:] = [e for e in hooks if not any('autonomous-stop-hook' in str(h.get('command','')) for h in e.get('hooks', []))]
hooks.append({'matcher': '', 'hooks': [{'type': 'command', 'command': correct, 'timeout': 10000}]})
if json.dumps(hooks) != before:
    with open('.claude/settings.json', 'w') as f:
        json.dump(s, f, indent=2)
    print('Stop hook registered (correct skill path)')
"
```

**2b. Write the state file DIRECTLY** (do NOT shell out to bash — the session ID env var is only available inside Claude Code):

Use the **Write tool** to create the **per-topic** state file `.instar/autonomous/<topicId>.local.md`,
where `<topicId>` is the `report_topic` value you set below (the Telegram topic id you already know
in-context). For example, if `report_topic` is `19437`, write `.instar/autonomous/19437.local.md`.

**WHY PER-TOPIC (setup-race hardening):** the stop hook reads this per-topic file **directly**
(`.instar/autonomous/<topicId>.local.md`) — it is the canonical state path, keyed on topic so
multiple topics run concurrent autonomous jobs without collision. Writing the per-topic path here
closes a boot-window race: two autonomous sessions starting near-simultaneously must NOT both write
the single legacy file `.instar/autonomous-state.local.md` (the hook still migrates that legacy file
for in-flight older jobs, but new jobs write the per-topic file from the start so there is nothing to
collide on). If you somehow have no `report_topic`, fall back to `.instar/autonomous-state.local.md`
(one-at-a-time, back-compat only).

Write this content:

<!-- COMPLETION_CONDITION_DEFAULT — the Write-tool template defaults to a verifiable
     completion_condition (judged by an INDEPENDENT model), NOT the self-declared
     promise. The promise is the recorded fallback. Spec: AUTONOMOUS-COMPLETION-DISCIPLINE.md -->

```markdown
---
active: true
iteration: 1
session_id: {VALUE OF $CLAUDE_CODE_SESSION_ID — get via: echo $CLAUDE_CODE_SESSION_ID}
goal: "YOUR GOAL"
duration: "8h"
duration_seconds: 28800
started_at: "{ISO timestamp}"
end_at: "{ISO timestamp + duration}"
report_topic: "TOPIC_ID"
report_interval: "30m"
last_report_at: ""
level_up: true
completion_condition: "<measurable, artifact-grounded end-state synthesized from the task list>"
completion_mode: condition         # "condition" (default) | "promise-fallback"
promise_fallback_reason: ""         # one line, REQUIRED iff completion_mode == promise-fallback
completion_promise: "ALL_TASKS_COMPLETE"   # retained as the fallback token
hard_blocker_nonce: "{a random per-run token — get via: openssl rand -hex 8}"
---

# Autonomous Session

## Goal
{goal text}

## Tasks
{numbered task list}

## Instructions
{autonomous instructions}
```

**`completion_condition` is the PRIMARY field — the default path.** It is judged each
turn by an INDEPENDENT model against what you SURFACE in your output (it cannot grade
its own homework, and it is fail-safe — evaluator-unreachable ⇒ keep working, never a
false "done"). Synthesize it from the task list, and prefer an **artifact-grounded**
end-state the judge can verify from the surfaced transcript — a commit SHA you show, a
file whose content you show, a CI run id, a concrete test-count delta — over an
unverifiable prose claim like "tests pass". `duration_seconds` is REQUIRED (a bounded
run; the duration is the hard backstop) — never set a truly-unbounded run.

**The self-declared promise is the RECORDED fallback, not the default.** Only fall back
to it when a verifiable condition genuinely cannot be expressed (rare — a purely
exploratory run with no testable end-state). When you do, set
`completion_mode: promise-fallback` and a one-line `promise_fallback_reason:` — so
"I chose the rationalizable path" is a logged, operator-visible fact, not an invisible
default.

**`hard_blocker_nonce` authenticates an honest `(a)` exit.** Write a fresh random token
(`openssl rand -hex 8`). The stop hook accepts a `<hard-blocker nonce="...">` terminal
marker ONLY when its nonce matches this — so incidental `<hard-blocker>` prose (e.g.
quoting this skill) can never trip an exit. See "Legitimate Stop Conditions" below.

**CRITICAL**: To capture the session ID correctly, run this FIRST:
```bash
echo $CLAUDE_CODE_SESSION_ID
```
Then include the output in the `session_id:` field. This ensures session isolation works.

**WHY NOT bash script?** Running `bash setup-autonomous.sh` creates a subprocess that does NOT inherit `CLAUDE_CODE_SESSION_ID`. The state file ends up with an empty session_id, which causes the hook to leak into all sessions. Always write the state file from within Claude Code's context.

**SESSION ISOLATION**: The stop hook checks `session_id` — it only blocks the session that activated autonomous mode. Other sessions on the same machine pass through unaffected.

**From this point, you CANNOT exit THIS session** unless:
- You output `<promise>ALL_TASKS_COMPLETE</promise>` (genuinely true)
- Duration expires
- Emergency stop is triggered

**2c. On completion/exit**: Remove the stop hook from settings.json:

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
s['hooks']['Stop'] = [h for h in s.get('hooks',{}).get('Stop',[]) if 'autonomous-stop-hook' not in str(h)]
with open('.claude/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
print('Stop hook removed')
"
```

---

## Step 3: Work Until Done

The stop hook will catch every attempt to exit and feed your task list back. Each iteration you will:

1. Read the task list
2. Pick the next incomplete task
3. Implement it fully (not stub, not wire — IMPLEMENT)
4. Verify it works (compile, test where practical)
5. Move to next task
6. Send progress reports at the configured interval

### The Defer-to-Future-Self Trap

**This is the #1 failure mode.** It looks like:

| What you think | What's actually happening |
|----------------|--------------------------|
| "This is Phase 2 work" | You don't feel like doing it right now |
| "Parked for follow-up" | You're avoiding the hard part |
| "Future improvement" | Your future self has no advantage over you |
| "Remaining work" | Work you're choosing not to do |
| "Deferred" | Abdication disguised as planning |

**The test:** Can you do this task right now with the tools and knowledge you have?
- **Yes** → Do it. Not later. Now.
- **No** → Document exactly WHY (missing dependency, needs external access, etc.)

**"Phase 2" is only valid when the current phase genuinely cannot contain the work** — not when you're tired, not when it's complex, not when it's 2 AM.

---

## Legitimate Stop Conditions (the ONLY valid reasons to exit)

<!-- LEGITIMATE_STOP_CONDITIONS -->

You are in a **pre-approved autonomous session.** The operator already said "go" and is not waiting at the keyboard. In this mode there are **exactly three** legitimate reasons to stop — and nothing else qualifies:

| # | Legitimate stop | What it actually looks like |
|---|-----------------|------------------------------|
| **(a)** | **A genuine HARD external blocker you cannot resolve yourself** | A credential that does not exist and you cannot obtain; a service that is down with no fallback; data that does not exist yet; an action a safety rule actually prohibits. The test: you have *exhausted* what you can do — not "I'd prefer a human to confirm." |
| **(b)** | **Duration expiry** | The session clock genuinely ran out (`end_at` passed). Verify with `/session/clock` — never *estimate* that time is up. |
| **(c)** | **The completion condition / promise is genuinely met** | Every task done, the `--completion-condition` judge confirms, OR the completion promise is *true*. The bar is the FULL feature — not a partial one that "feels like enough." |

**Everything else is NOT a stop. Decisions are cheap.** In autonomous mode, a design decision is reversible, the change ships dark (disabled by default, behind a flag), and a wrong call can be undone or redone later. So you **make the call using your best judgment and keep going.** You do not stop to ask, to confirm, or to "get a steer."

### NON-stops (recognize and reject these urges)

These are the rationalizations that end a pre-approved session early. Every one of them is a **continue**, not a stop:

| The urge to stop | Why it is NOT a stop |
|------------------|----------------------|
| "This decision needs your steer / your opinion" | The decision is **pre-approved, reversible, and dark-shipped.** Make the call with best judgment and keep going. A wrong decision is cheap to undo. |
| "This is a clean milestone / a good stopping point" | A milestone is a place to **report progress**, not exit. The hook checks the task list, not your sense of a tidy break. |
| "It's late / it's 2 AM" | You do not get tired. The clock is the only time authority, and it hasn't expired. |
| "I'll let you decide between A and B" | If both A and B are reversible and dark-shipped, **pick one** (state which and why) and continue. Offering a menu is deferral. |
| "I've done a lot — this is a natural off-ramp" | Volume of work is not completion. The bar is the **full** completion condition. |
| An "off-ramp with no reply" — quietly winding down and going silent | Silence is the worst exit: the operator sees a stalled session. Keep working and keep reporting at the interval. |
| "The operator might have an opinion on this" | They pre-approved the session precisely so you would **act** on their behalf. Use the org-intent / your judgment; act; report what you decided. |

**The principle (operator's own words):** *"Decisions are not that critical. They can always be undone or redone. This is also why we ship safely in dark mode so we can test and iterate. So decisions are not critical and autonomous mode should use its best judgment."* When you catch yourself reaching for any NON-stop above, name it, make the decision, and keep going. The ONLY exits are (a), (b), (c).

**If you genuinely hit (a):** report the hard blocker clearly (what you tried, why you are stuck, what you'd need), then continue with any *other* in-scope work that the blocker does not gate — a blocker on one task is not a stop for the whole session.

**`(a)` reporting prose is DISTINCT from the terminal `<hard-blocker>` marker.** Routine "I'm blocked on this one task but continuing elsewhere" reporting is plain prose — do NOT use the marker tag for it. The nonce'd `<hard-blocker>` marker is emitted ONLY when you actually intend to TERMINATE the WHOLE run because a genuine, agent-unresolvable external blocker gates everything left. To terminate on `(a)`, emit — in your FINAL turn — exactly:

```
<hard-blocker nonce="THE_VALUE_OF_hard_blocker_nonce">
  what I tried: <concrete steps>
  why I am stuck: <the real, external reason>
  what I would need to proceed: <a genuinely external, agent-unresolvable residual>
</hard-blocker>
```

The hook then asks the independent P13 judge to classify the blocker **external vs buildable**: if "what I would need" is something you could build, derive, or fetch yourself (a derivable standard, a buildable artifact, a credential in your own vault), the judge classifies it **buildable** and you are re-fed to keep working — the honest exit is for a genuinely external residual ONLY (a credential that does not exist, a down service, missing data, a prohibited action). A clean `(a)` exit writes a durable record, raises an /ack-able Attention item, and sends one Telegram so the blocker re-surfaces until you acknowledge it. A malformed/partial/nonce-mismatched marker is ignored (you keep working) — the safe direction.

---

## Step 4: Completion

**Preferred: a verifiable completion CONDITION (independent judge, like /goal).**
Pass `--completion-condition "<measurable end-state>"` when starting (e.g. "all tests in
test/auth pass and `npm test` exits 0"). Each turn, an INDEPENDENT model judges the condition
against what you've SURFACED in the conversation — so *run the real checks and show the
evidence in your output*. When the judge confirms it, the hook exits automatically. You do not
self-declare done. If the judge can't be reached, the run keeps going (fail-safe). This mirrors
the framework `/goal` feature and is harder to fool than a self-declared promise.

**Legacy fallback: self-declared promise.** If no condition is set, when ALL tasks are
genuinely done:

1. Verify every task is complete (re-read the list)
2. Run `npx tsc --noEmit` — zero errors
3. Run relevant tests
4. Write learnings to MEMORY.md
5. Send final report via messaging
6. Output: `<promise>ALL_TASKS_COMPLETE</promise>`

The stop hook detects the promise and allows exit.

---

## Emergency Stop

The user can always stop autonomous mode:

1. **Via messaging**: Send "stop everything" or "emergency stop" — the MessageSentinel intercepts
2. **Via file**: `touch .instar/autonomous-emergency-stop` — the stop hook checks for this (this flag is
   global, so it halts EVERY topic's autonomous job at once)
3. **Via cancel**: `/cancel-autonomous` — removes this topic's state file

The stop hook checks for emergency stop on EVERY iteration. User safety is never compromised.

### /cancel-autonomous

To manually cancel THIS topic's job, remove its per-topic state file (substitute the topic id):
```bash
rm -f .instar/autonomous/<topicId>.local.md
```
(Older one-at-a-time jobs may still live at the legacy `.instar/autonomous-state.local.md` — remove
that instead if the per-topic file is absent.)

---

## Progress Reporting

Send reports to the user's messaging platform at the configured interval.

**How to send:**
```bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh TOPIC_ID
AUTONOMOUS PROGRESS (iteration N, Xh elapsed / Yh total)

Completed:
- [task 1] ✅
- [task 2] ✅

Working on:
- [current task]

Remaining:
- [task 3]
- [task 4]

Issues: none
EOF
```

---

## Anti-Patterns (Structurally Enforced)

These aren't just warnings — the stop hook WILL catch you if you try to exit without completing them:

### The "Beautiful Summary" Exit
Writing a comprehensive report of what you did and what's "remaining" then trying to exit. **The hook will block you and feed the remaining tasks back.**

### The "Phase 2" Labeling
Calling incomplete work "Phase 2" and trying to exit. **The hook doesn't care about phases — it cares about the task list.**

### The "Good Stopping Point" Exit
Finding a natural break and trying to exit early. **The hook checks the task list, not your feelings about stopping.** A milestone is a place to report, not exit (see Legitimate Stop Conditions — it's a NON-stop).

### The "It's 2 AM" Exit
Feeling tired (as an AI) and deferring. **You don't get tired. The hook knows this.** Only the session clock decides time — and it must actually have expired.

### The "This Needs Your Steer" Exit
Hitting a design decision and trying to exit to ask the operator's opinion. **The session is pre-approved — the decision is reversible and dark-shipped.** Make the call with best judgment, state what you chose and why, and keep going. Asking for a steer on a reversible decision is the #1 way a pre-approved autonomous session dies early (see Legitimate Stop Conditions — "needs your steer" is a NON-stop).

### The "Quiet Off-Ramp" Exit
Winding down and going silent without a reply, as if the session naturally ended. **Silence is the worst exit — the operator sees a stalled agent.** Keep working and keep reporting at the interval until a real (a)/(b)/(c) stop.

---

## Hook Configuration

The stop hook is at `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`.

It reads state from the per-topic file `.instar/autonomous/<topicId>.local.md` (resolving the topic
from the tmux session), and migrates the legacy single file `.instar/autonomous-state.local.md` into
the per-topic path on first run for any in-flight older job. It then:
- Blocks exit if tasks are incomplete
- Feeds the task list + goal back as the next prompt
- Increments the iteration counter
- Checks for emergency stop signals
- Checks for duration expiry
- Checks for completion promise in `<promise>` tags
- Includes time remaining in the system message

**This is structural enforcement, not willpower.** You cannot talk your way out of the loop.
