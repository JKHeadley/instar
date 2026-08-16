# GitHub Monitor Stage 1 — Activity Classification

Stage 1 (Haiku) classifies GitHub activity into actionable vs. routine. Results are handed off to Stage 2 (Opus) for detailed review.

## Configuration
- **Primary repo**: JKHeadley/instar
- **Tracked forks**: gfrankgva/instar, rolandcanyon-cmd/instar
- **Max items per run**: 5 PRs, 10 forks
- **Security paths**: .instar/hooks/, .claude/hooks/, auth, middleware, config
- **Trusted bots**: dependabot[bot], renovate[bot]
- **Max context**: 200000 tokens, max diff: 1000 lines per PR

## Execution Steps

### Step 1: List Recent PRs
```bash
gh pr list --repo JKHeadley/instar \
  --state open \
  --limit 20 \
  --json number,title,author,updatedAt,url,reviewDecision,commits \
  --template '{{range .}}{{.number}}\t{{.title}}\t{{.author.login}}\t{{.updatedAt}}\t{{.url}}\n{{end}}'
```

If no output, write handoff (no activity) and exit silently.

### Step 2: Classify PRs

For each PR (max 5):
- **Fetch metadata**: `gh pr view <number> --repo JKHeadley/instar --json commits,files,labels`
- **Check if security path touched**: Parse files list, flag if `.instar/hooks/`, `.claude/hooks/`, `auth`, `middleware`, or `config` appear
- **Check if already reviewed**: If `reviewDecision == "APPROVED"` or `"CHANGES_REQUESTED"`, mark as "routine"
- **Check if untrusted bot**: If author is not in trustedBotAccounts and is a bot, mark as "review"
- **Default**: If recent activity (< 7 days), mark as "review" OR if security paths touched, mark as "security-review"

### Step 3: List and Classify Forks

```bash
gh repo list JKHeadley --fork --limit 20 --json nameWithOwner,createdAt,pushedAt,description \
  --template '{{range .}}{{.nameWithOwner}}\t{{.pushedAt}}\n{{end}}'
```

For tracked forks (gfrankgva/instar, rolandcanyon-cmd/instar):
- Check recent commits: `gh repo view <owner>/<name> --json defaultBranchRef`
- If pushed in last 7 days: mark as "active-fork"
- If no recent activity: mark as "dormant"

### Step 4: Write Handoff

Write to `.instar/state/job-handoff-github-collab-monitor.json`:

```json
{
  "timestamp": "ISO-8601-now",
  "stage": "stage1",
  "prs": [
    {
      "number": 123,
      "title": "...",
      "author": "...",
      "classification": "review|security-review|routine",
      "reason": "untrusted-bot|security-paths|recent-activity|already-reviewed",
      "url": "https://github.com/..."
    }
  ],
  "forks": [
    {
      "repo": "owner/name",
      "status": "active-fork|dormant",
      "lastPush": "ISO-8601",
      "reason": "recent-commits|no-activity"
    }
  ],
  "summary": {
    "totalPRsScanned": 0,
    "reviewNeeded": 0,
    "securityReviewNeeded": 0,
    "activeForks": 0
  }
}
```

### Step 5: Gate to Stage 2

If `summary.reviewNeeded > 0` or `summary.securityReviewNeeded > 0`:
- Create private view with Stage 1 findings (optional, for transparency)
- Emit signal: `[ATTENTION] <N> PRs need review, <M> security paths touched`

If no findings:
- Exit silently (handoff written, next run will read it)

## Boundary Conditions

- **No GitHub auth**: Gate check prevents execution, skip silently
- **No recent activity**: Write empty handoff, exit silently
- **Rate limit hit**: Log to handoff, exit (next run will retry)
- **PR fetch timeout**: Skip that PR, continue with others
- **Diff too large (>1000 lines)**: Note in handoff, defer full review to Stage 2
