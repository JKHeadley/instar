#!/bin/bash
# Lightweight convergence check — heuristic content quality gate before messaging.
# No LLM calls. Fast. Catches the most common agent failure modes.
#
# Usage: echo "message content" | bash .instar/scripts/convergence-check.sh
# Exit codes: 0 = converged (safe to send), 1 = issues found (review needed)
#
# Inspired by Dawn's convergence-check.py (PROP-159) but simplified for
# generic agents. Checks 7 criteria via pattern matching:
#
# 1. capability_claims — Claims about what the agent can't do (may be wrong)
# 2. commitment_overreach — Promises the agent may not be able to keep
# 3. settling — Accepting empty/failed results without investigation
# 4. experiential_fabrication — Claiming to see/read/feel without verification
# 5. sycophancy — Reflexive agreement, excessive apology, capitulation
# 6. url_provenance — URLs with unfamiliar domains that may be fabricated
# 7. temporal_staleness — Language suggesting outdated perspective or stale draft
#
# This is Structure > Willpower: the check runs automatically before
# external messaging, not when the agent remembers to do it.

CONTENT=$(cat)
ISSUES=()
ISSUE_COUNT=0

# 1. CAPABILITY CLAIMS — Watch for "I can't" / "I don't have" / "not available"
if echo "$CONTENT" | grep -qiE "(unfortunately.{0,20}(i can.t|i.m unable|not (possible|available|supported))|i don.t have (the ability|access|a way)|this (isn.t|is not) (possible|available|supported))"; then
  ISSUES+=("CAPABILITY: You're claiming a limitation. Did you check /capabilities first? Many 'I can't' statements are wrong — verify before sending.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 2. COMMITMENT OVERREACH — Promises that may not survive session boundaries
if echo "$CONTENT" | grep -qiE "(i.ll (make sure|ensure|guarantee|always|never forget)|i (promise|commit to|will always)|you can count on me to|i.ll remember (to|this)|from now on i.ll)"; then
  ISSUES+=("COMMITMENT: You're making a promise that may not survive context compaction or session end. Can your infrastructure actually keep this commitment? If not, reframe as intent rather than guarantee.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 3. SETTLING — Accepting empty results without digging deeper
if echo "$CONTENT" | grep -qiE "(no (data|results|information) (available|found|exists)|nothing (to report|happened|was found)|there (is|are) no|could(n.t| not) find (any|the)|appears to be empty|no (relevant|matching|applicable))"; then
  ISSUES+=("SETTLING: You're reporting nothing found. Did you check multiple sources? Could the data source be stale or the search terms wrong? Empty results deserve investigation, not acceptance.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 4. EXPERIENTIAL FABRICATION — Claiming first-person experience without tool verification
if echo "$CONTENT" | grep -qiE "(i (can see|noticed|observed|felt|sensed|perceived) (that |the |a |an )|looking at (this|the|your)|from what i.ve (seen|read|observed)|i.ve (reviewed|examined|analyzed|inspected) (the|your|this))"; then
  ISSUES+=("EXPERIENTIAL: You're claiming a first-person experience. Did you actually access this data with a tool in THIS session, or are you completing a social script? Verify before claiming.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 5. SYCOPHANCY — Reflexive agreement, excessive apology
if echo "$CONTENT" | grep -qiE "(you.re (absolutely|totally|completely) right|i (completely|totally|fully) (agree|understand)|great (question|point|observation)|i apologize for|sorry.{0,20}(mistake|confusion|error|oversight)|that.s (a |an )?(excellent|great|wonderful|fantastic) (point|question|idea|suggestion))"; then
  ISSUES+=("SYCOPHANCY: You may be reflexively agreeing or over-apologizing. If you genuinely agree, state why. If you don't fully agree, say what you actually think. Politeness is not a substitute for honesty.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# 6. URL PROVENANCE — URLs with unfamiliar domains may be fabricated
# Common confabulation: agent constructs plausible URL from project name
# (e.g., "deepsignal.xyz" from project "deep-signal"). Catch and require verification.
# Known-safe domains are whitelisted; anything else gets flagged.
URLS_IN_MSG=$(echo "$CONTENT" | grep -oE 'https?://[^ )"'"'"'>]+' 2>/dev/null || true)
if [ -n "$URLS_IN_MSG" ]; then
  UNFAMILIAR_URLS=""
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    # Skip well-known service domains
    if echo "$url" | grep -qE '(github\.com|vercel\.app|vercel\.com|netlify\.app|netlify\.com|npmjs\.com|npmjs\.org|cloudflare\.com|google\.com|twitter\.com|x\.com|youtube\.com|reddit\.com|discord\.com|discord\.gg|telegram\.org|t\.me|localhost|127\.0\.0\.1|stackoverflow\.com|developer\.mozilla\.org|docs\.anthropic\.com|anthropic\.com|openai\.com|claude\.ai|notion\.so|linear\.app|fly\.io|render\.com|railway\.app|heroku\.com|amazonaws\.com|azure\.com|gitlab\.com|bitbucket\.org|docker\.com|hub\.docker\.com|pypi\.org|crates\.io|rubygems\.org|pkg\.go\.dev|wikipedia\.org|medium\.com|substack\.com|circle\.so|ghost\.io|telegraph\.ph)'; then
      continue
    fi
    UNFAMILIAR_URLS="$UNFAMILIAR_URLS  $url\n"
  done <<< "$URLS_IN_MSG"

  if [ -n "$UNFAMILIAR_URLS" ]; then
    ISSUES+=("URL_PROVENANCE: Your message contains URLs with unfamiliar domains:\n${UNFAMILIAR_URLS}Before including a URL in a message, verify it appeared in actual tool output in THIS session OR confirm it resolves with curl. A common confabulation pattern is constructing plausible-looking domains from project names (e.g., 'deepsignal.xyz' from project 'deep-signal'). If you did not get this URL from a tool, do NOT include it.")
    ISSUE_COUNT=$((ISSUE_COUNT + 1))
  fi
fi

# 7. TEMPORAL STALENESS — Language suggesting outdated perspective or stale draft
# Catches drafts that reference past understanding as current, or use phrasing
# that suggests the content was written at an earlier point in the agent's evolution.
if echo "$CONTENT" | grep -qiE "(i used to (think|believe|feel|assume)|back when i (first|started|was new)|at (that|the) time i|my (early|earlier|initial|original|first) (understanding|thinking|view|perspective|approach)|i didn.t yet understand|before i (learned|realized|discovered|knew)|i (once|previously) (thought|believed|felt)|this was (before|when) i)"; then
  ISSUES+=("TEMPORAL: Your message references past understanding or earlier perspectives. Is this content from an older draft? If your thinking has evolved since writing this, revise to reflect your current understanding before publishing.")
  ISSUE_COUNT=$((ISSUE_COUNT + 1))
fi

# Output results
if [ "$ISSUE_COUNT" -gt "0" ]; then
  echo "=== CONVERGENCE CHECK: ${ISSUE_COUNT} ISSUE(S) FOUND ==="
  echo ""
  for ISSUE in "${ISSUES[@]}"; do
    echo "  - $ISSUE"
    echo ""
  done
  echo "Review and revise before sending. Re-run this check after revision."
  echo "=== END CONVERGENCE CHECK ==="
  exit 1
else
  exit 0
fi
