#!/bin/bash
# Dangerous command guard — safety infrastructure for autonomous agents.
# Supports safety.level in .instar/config.json:
#   Level 1 (default): Block and ask user. Level 2: Agent self-verifies.
# Input: Claude passes the command as arg $1; Codex (stdin-only) delivers the
# hook event as JSON on stdin. Claude uses tool_input.command; Codex's exec_command
# tool uses tool_input.cmd — accept either (verified live 2026-05-24).
INPUT="$1"
if [ -z "$INPUT" ]; then
  INPUT="$(cat 2>/dev/null | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); ti=d.get('tool_input',{}) or {}
    print(ti.get('command') or ti.get('cmd') or '')
except Exception:
    print('')" 2>/dev/null)"
fi
INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"

# Read safety level from config
SAFETY_LEVEL=1
if [ -f "$INSTAR_DIR/config.json" ]; then
  SAFETY_LEVEL=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('safety', {}).get('level', 1))" 2>/dev/null || echo "1")
fi

# ALWAYS blocked (catastrophic, irreversible)
for pattern in "rm -rf /" "rm -rf ~" "> /dev/sda" "mkfs\." "dd if=" ":(){:|:&};:"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Catastrophic command detected: $pattern" >&2
    echo "Always blocked regardless of safety level. User must execute directly." >&2
    exit 2
  fi
done

# Deployment/push commands — check coherence gate first
for pattern in "vercel deploy" "vercel --prod" "git push" "npm publish" "npx wrangler deploy" "fly deploy" "railway up"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ -f "$INSTAR_DIR/config.json" ]; then
      PORT=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
      TOPIC_ID="${INSTAR_TELEGRAM_TOPIC:-}"
      ACTION="deploy"
      echo "$INPUT" | grep -qi "git push" && ACTION="git-push"
      echo "$INPUT" | grep -qi "npm publish" && ACTION="git-push"
      CTX="{}"
      [ -n "$TOPIC_ID" ] && CTX="{\"topicId\": $TOPIC_ID}"
      CHECK=$(curl -s -X POST "http://localhost:$PORT/coherence/check" -H 'Content-Type: application/json' -d "{\"action\":\"$ACTION\",\"context\":$CTX}" 2>/dev/null)
      if echo "$CHECK" | grep -q '"recommendation":"block"'; then
        SUMMARY=$(echo "$CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary','Coherence check failed'))" 2>/dev/null || echo "Coherence check failed")
        echo "BLOCKED: Coherence gate blocked this action." >&2
        echo "$SUMMARY" >&2
        echo "Run POST /coherence/reflect for a detailed self-verification checklist." >&2
        exit 2
      fi
    fi
  fi
done

# Safe-case carve-out: `git push --force-with-lease` to a NON-protected branch is the
# legitimate way to update one's OWN amended/rebased PR branch (--force-with-lease refuses
# to overwrite unseen work; a feature/PR branch is not shared history). Still block plain
# --force/-f and any force-push explicitly targeting a protected branch (main/master/develop/
# release*). Residual on-main edge is double-protected: agents work in feature-branch worktrees
# (never on main) and main carries remote branch protection that rejects a force-push regardless.
FORCE_WITH_LEASE_OWN_BRANCH=0
if echo "$INPUT" | grep -qiE 'git +push[^|;&]*--force-with-lease'; then
  # Scan ONLY the git-push invocation for a protected branch — NOT the whole $INPUT.
  # The previous whole-input scan false-positived on unrelated text in the command
  # (e.g. a heredoc status message mentioning "release cadence" or "main"), blocking a
  # legitimate PR-branch force-with-lease update (2026-06-07, topic 19437). Isolating to
  # the push invocation keeps the main/master/release block precise.
  PUSH_INVOCATION=$(echo "$INPUT" | grep -oiE 'git +push[^|;&]*' | head -1)
  if echo "$PUSH_INVOCATION" | grep -qiE '(^|[[:space:]:/])(main|master|develop|release[A-Za-z0-9._/-]*)([[:space:]]|:|$)'; then
    FORCE_WITH_LEASE_OWN_BRANCH=0
  else
    FORCE_WITH_LEASE_OWN_BRANCH=1
  fi
fi

# Risky commands — behavior depends on safety level
for pattern in "rm -rf \." "git push --force" "git push -f" "git reset --hard" "git clean -fd"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ "$FORCE_WITH_LEASE_OWN_BRANCH" -eq 1 ] && echo "$pattern" | grep -qiE 'git push (--force|-f)'; then
      continue
    fi
    if [ "$SAFETY_LEVEL" -eq 1 ]; then
      echo "BLOCKED: Potentially destructive command detected: $pattern" >&2
      echo "Authorization required: Ask the user whether to proceed with this operation." >&2
      echo "Once they confirm, YOU execute the command — never ask the user to run it themselves." >&2
      exit 2
    else
      IDENTITY=""
      if [ -f "$INSTAR_DIR/AGENT.md" ]; then
        IDENTITY=$(head -20 "$INSTAR_DIR/AGENT.md" | tr '\n' ' ')
      fi
      echo "{\"decision\":\"approve\",\"additionalContext\":\"=== SELF-VERIFICATION REQUIRED ===\\nDestructive command detected: $pattern\\n\\n1. Is this necessary for the current task?\\n2. What are the consequences if this goes wrong?\\n3. Is there a safer alternative?\\n4. Does this align with your principles?\\n\\nIdentity: $IDENTITY\\n\\nIf ALL checks pass, proceed. If ANY fails, stop.\\n=== END SELF-VERIFICATION ===\"}"
      exit 0
    fi
  fi
done

# SQL must look like a statement, not prose that merely names a keyword. Match
# at input/statement start or immediately after a SQL-bearing quote/separator,
# and require the following table/database identifier. Ambiguous statement
# shapes still block; prose mentions in heredocs, echo text, JSON, or grep args
# do not become destructive merely because the tool input contains the words.
for sql_spec in \
  "D""ROP TABLE|(^[[:space:]]*|[;\"'=][[:space:]]*)[Dd][Rr][Oo][Pp][[:space:]]+[Tt][Aa][Bb][Ll][Ee]([[:space:]]+[Ii][Ff][[:space:]]+[Ee][Xx][Ii][Ss][Tt][Ss])?[[:space:]]+[^[:space:];]+" \
  "D""ROP DATABASE|(^[[:space:]]*|[;\"'=][[:space:]]*)[Dd][Rr][Oo][Pp][[:space:]]+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]([[:space:]]+[Ii][Ff][[:space:]]+[Ee][Xx][Ii][Ss][Tt][Ss])?[[:space:]]+[^[:space:];]+" \
  "T""RUNCATE|(^[[:space:]]*|[;\"'=][[:space:]]*)[Tt][Rr][Uu][Nn][Cc][Aa][Tt][Ee][[:space:]]+([Tt][Aa][Bb][Ll][Ee][[:space:]]+)?[^[:space:];]+" \
  "D""ELETE FROM|(^[[:space:]]*|[;\"'=][[:space:]]*)[Dd][Ee][Ll][Ee][Tt][Ee][[:space:]]+[Ff][Rr][Oo][Mm][[:space:]]+[^[:space:];]+"; do
  pattern="${sql_spec%%|*}"
  sql_pattern="${sql_spec#*|}"
  if echo "$INPUT" | grep -qE "$sql_pattern"; then
    if [ "$SAFETY_LEVEL" -eq 1 ]; then
      echo "BLOCKED: Potentially destructive command detected: $pattern" >&2
      echo "Authorization required: Ask the user whether to proceed with this operation." >&2
      echo "Once they confirm, YOU execute the command — never ask the user to run it themselves." >&2
      exit 2
    else
      IDENTITY=""
      if [ -f "$INSTAR_DIR/AGENT.md" ]; then
        IDENTITY=$(head -20 "$INSTAR_DIR/AGENT.md" | tr '\n' ' ')
      fi
      echo "{\"decision\":\"approve\",\"additionalContext\":\"=== SELF-VERIFICATION REQUIRED ===\\nDestructive command detected: $pattern\\n\\n1. Is this necessary for the current task?\\n2. What are the consequences if this goes wrong?\\n3. Is there a safer alternative?\\n4. Does this align with your principles?\\n\\nIdentity: $IDENTITY\\n\\nIf ALL checks pass, proceed. If ANY fails, stop.\\n=== END SELF-VERIFICATION ===\"}"
      exit 0
    fi
  fi
done
+
# 'gh pr merge' watch-exit-merge gate — closes the PR #539 class.
# Justin merged #539 on 'gh run watch' exit code (= success), but 'watch'
# returns 0 on workflow COMPLETION regardless of conclusion; meanwhile the
# PR's branch-protection checks were RED. Cost a fix-forward (#540) + a
# fleet outage. The rule: 'gh pr merge' must NEVER fire if any PR-event
# check is non-pass. This guard runs 'gh pr checks <num>' and refuses on
# any failure / pending / queued check.
#
# 'gh pr merge --auto' is the documented safe path (only fires when
# checks pass) — let it through. Other flags (--admin, no flag) get
# verified against the live check state.
if echo "$INPUT" | grep -qiE '(^|[;&|(\s])gh +pr +merge( |$|--)'; then
  if echo "$INPUT" | grep -qE '(^| )--auto( |$)'; then
    : # --auto is the safe async gate; allow.
  else
    PR_NUM=$(echo "$INPUT" | grep -oE 'gh +pr +merge[ +-]+[0-9]+' | grep -oE '[0-9]+' | head -1)
    if [ -z "$PR_NUM" ]; then
      PR_NUM=$(gh pr view --json number -q .number 2>/dev/null)
    fi
    if [ -n "$PR_NUM" ]; then
      CHECKS_JSON=$(gh pr checks "$PR_NUM" --json name,state 2>/dev/null)
      if [ -n "$CHECKS_JSON" ]; then
        NON_OK=$(echo "$CHECKS_JSON" | python3 -c "
import sys, json
try:
    rows = json.loads(sys.stdin.read())
    if isinstance(rows, list):
        bad = [r.get('name','?') + '=' + str(r.get('state','?')) for r in rows
               if str(r.get('state','')).upper() not in ('SUCCESS','SKIPPED','SKIPPING','NEUTRAL','')]
        print(','.join(bad))
except Exception:
    pass
" 2>/dev/null)
        if [ -n "$NON_OK" ]; then
          echo "BLOCKED: PR #$PR_NUM has non-passing checks: $NON_OK" >&2
          echo "" >&2
          echo "'gh pr merge' must not run while any check is failing, pending, or queued." >&2
          echo "Closes the 2026-05-27 #539 watch-exit-merge class — 'gh run watch' returns 0" >&2
          echo "on workflow completion regardless of conclusion, which caused a fix-forward" >&2
          echo "(#540) + a fleet outage when #539 was merged on a red unit-test shard." >&2
          echo "" >&2
          echo "Options:" >&2
          echo "  1) Wait. Re-check with: gh pr checks $PR_NUM" >&2
          echo "  2) Use 'gh pr merge --auto' — async gate that ONLY fires when all" >&2
          echo "     checks pass. Documented safe path." >&2
          echo "  3) If a non-passing check is an intentional skip (e.g. Contract Tests" >&2
          echo "     on non-tagged PRs), it appears as SKIPPED / SKIPPING in" >&2
          echo "     'gh pr checks --json state' output and the gate already allows it." >&2
          exit 2
        fi
      fi
    fi
  fi
fi
