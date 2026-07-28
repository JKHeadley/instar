#!/bin/bash
# Build Stop Hook — Structural enforcement for the /build pipeline.
#
# Prevents premature exit during active builds. Graduated protection:
#   SMALL  (light):  3 reinforcements
#   STANDARD (medium): 5 reinforcements
#   LARGE  (heavy):  10 reinforcements
#
# Reads state from .instar/state/build/build-state.json.

STATE_FILE=".instar/state/build/build-state.json"

# No state file = no active build = allow exit
if [ ! -f "$STATE_FILE" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Read state
PHASE=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('phase','idle'))" 2>/dev/null)

# Terminal phases — allow exit
if [ "$PHASE" = "complete" ] || [ "$PHASE" = "failed" ] || [ "$PHASE" = "escalated" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# ── Session-scope ownership (BUILD-STOP-HOOK-SESSION-SCOPING-SPEC) ───────────
# build-state stamps the owning session (tmux name + Claude session UUID) at /build
# start. Only the OWNER session's Stop should be blocked; any other concurrent
# session of the same agent must approve-exit WITHOUT spending the owner's
# reinforcement budget. This closes the cross-session stop-hook leak + budget drain.
HOOK_INPUT=$(cat 2>/dev/null || echo "")
HOOK_SESSION=$(printf '%s' "$HOOK_INPUT" | python3 -c "import sys,json
try: print((json.load(sys.stdin) or {}).get('session_id','') or '')
except Exception: print('')" 2>/dev/null)

# Resolve MY tmux session name (the stable, cwd-independent owner address).
# Test seams: INSTAR_HOOK_TMUX_SESSION (if set, even empty, wins);
# INSTAR_HOOK_NO_TMUX=1 forces empty.
if [ "${INSTAR_HOOK_NO_TMUX:-}" = "1" ]; then
  MY_TMUX=""
elif [ -n "${INSTAR_HOOK_TMUX_SESSION+x}" ]; then
  MY_TMUX="${INSTAR_HOOK_TMUX_SESSION}"
else
  MY_TMUX=$(tmux display-message -p '#S' 2>/dev/null || echo "")
fi

OWNERSHIP=$(STATE_FILE="$STATE_FILE" MY_TMUX="$MY_TMUX" HOOK_SESSION="$HOOK_SESSION" python3 -c "
import json, os, sys
try:
    state = json.load(open(os.environ['STATE_FILE']))
except Exception:
    print('approve'); sys.exit(0)
owner = state.get('owner') or {}
o_tmux = owner.get('tmux') or ''
o_sess = owner.get('session') or ''
my_tmux = os.environ.get('MY_TMUX', '')
my_sess = os.environ.get('HOOK_SESSION', '')

# (a) No owner stamped -> conservative no-adopt: approve, never claim ownership.
if not o_tmux and not o_sess:
    print('approve'); sys.exit(0)

# (b)/(c) Owner stamped: block only the proven owner. A session that cannot match
# (including one with no resolvable identity) is approved -> never trap, no drain.
is_owner = (bool(o_tmux) and o_tmux == my_tmux) or (bool(o_sess) and o_sess == my_sess)
if not is_owner:
    print('approve'); sys.exit(0)

# Owner confirmed. Restart reconcile: ONLY on a confirmed tmux-owner match whose
# session UUID rotated (restart) do we update owner.session. The write is gated
# strictly behind the tmux match, so a non-owner can never clobber owner.session.
if o_tmux and o_tmux == my_tmux and my_sess and o_sess != my_sess:
    owner['session'] = my_sess
    state['owner'] = owner
    try:
        with open(os.environ['STATE_FILE'], 'w') as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass
print('owner')
" 2>/dev/null)

if [ "$OWNERSHIP" != "owner" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Check and update reinforcement counter
RESULT=$(python3 -c "
import json, sys
with open('$STATE_FILE') as f:
    state = json.load(f)

protection = state.get('protection', {})
max_r = protection.get('reinforcements', 5)
used = state.get('reinforcementsUsed', 0)

if used >= max_r:
    print(json.dumps({'decision': 'approve'}))
    sys.exit(0)

state['reinforcementsUsed'] = used + 1
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)

phase = state.get('phase', 'idle')
task = state.get('task', 'unknown')
label = protection.get('label', '?')
steps = state.get('steps', [])
total_tests = state.get('totalTests', 0)
wt = state.get('worktree')

prompts = {
    'idle': 'Build initialized. Begin with Phase 0 (CLARIFY) or Phase 1 (PLAN).',
    'clarify': 'In CLARIFY phase. Resolve ambiguity, then transition to PLAN.',
    'planning': 'In PLAN phase. Complete plan with test strategy, then EXECUTE.',
    'executing': 'In EXECUTE phase. Complete current step: code, tests, verify.',
    'verifying': 'In VERIFY phase. Run independent verification and real-world tests.',
    'fixing': 'In FIXING phase. Address findings, return to VERIFY.',
    'hardening': 'In HARDEN phase. Complete observability checklists.',
}

hint = prompts.get(phase, 'Continue with current phase.')
steps_info = ' | %d steps, %d tests' % (len(steps), total_tests) if steps else ''
wt_info = ' | worktree: %s' % wt['path'] if wt else ''

reason = (
    '/build active. Phase: %s (%s, %d/%d reinforcements)%s%s\n\n'
    'Task: %s\n\n%s\n\n'
    'Use \`python3 playbook-scripts/build-state.py status\` to check state.\n'
    'Use \`python3 playbook-scripts/build-state.py transition <phase>\` to advance.\n\n'
    'The build pipeline is not complete. Continue working.'
) % (phase, label, state['reinforcementsUsed'], max_r, steps_info, wt_info, task, hint)

print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null)

echo "$RESULT"
exit 0
