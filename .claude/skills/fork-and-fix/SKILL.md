---
name: fork-and-fix
description: Fork-and-fix a PR — pull a contributor's branch, make fixes in isolation, merge preserving their history, and thank them
metadata:
  user_invocable: "true"
  args: "<PR number> [fix description]"
---

# fork-and-fix — Merge a Contributor's PR with Our Fixes

## Purpose

When a PR provides high value but needs small fixes that aren't worth sending back to the contributor, we fork-and-fix: pull their branch, make the changes ourselves in isolation, merge preserving their full commit history, and thank them.

## When to Use

Per the PR Review Policy (`.instar/prompts/pr-review-policy.md`):
- PR is classified as **high value**
- Required fixes are straightforward for us
- We want the feature integrated promptly
- OR the contributor has gone silent after 14+ days

## Arguments

- `PR_NUMBER` (required): The PR number to fork-and-fix
- `FIX_DESCRIPTION` (optional): Brief description of what to fix. If omitted, read the existing review(s) to determine what needs fixing.

## Procedure

### Phase 1: Preparation (Read-Only)

1. **Verify identity** — confirm EchoOfDawn is the active gh account:
   ```bash
   gh auth status 2>&1 | grep "Active account: true" -B1 | head -1
   ```
   If not EchoOfDawn, switch first: `gh auth switch --user EchoOfDawn`

2. **Gather PR context** — understand what we're working with:
   ```bash
   # PR details
   gh api repos/JKHeadley/instar/pulls/{PR_NUMBER} \
     --jq '{title, author: .user.login, head: .head.ref, headRepo: .head.repo.full_name, base: .base.ref, mergeable: .mergeable, maintainer_can_modify: .maintainer_can_modify}'

   # Existing reviews and their state
   gh api repos/JKHeadley/instar/pulls/{PR_NUMBER}/reviews \
     --jq '.[] | "\(.user.login) | \(.state) | \(.body[0:200])"'

   # Commit history
   gh api repos/JKHeadley/instar/pulls/{PR_NUMBER}/commits \
     --jq '.[] | "\(.sha[0:7]) | \(.commit.author.name) | \(.commit.message[0:80])"'
   ```

3. **Plan the fixes** — based on existing reviews or the provided fix description, write out exactly what changes you'll make. Be specific: file, line, change.

### Phase 2: Isolated Work

4. **Create a worktree** for isolation — all work happens here, not on the main working tree:
   ```bash
   cd /Users/justin/Documents/Projects/instar
   WORKTREE_DIR="/tmp/instar-fork-fix-pr-{PR_NUMBER}"
   git worktree add "$WORKTREE_DIR" main
   cd "$WORKTREE_DIR"
   ```

5. **Fetch and checkout the PR branch**:
   ```bash
   gh pr checkout {PR_NUMBER}
   ```
   This creates a local branch tracking the contributor's branch with all their commits.

6. **Make fixes** — commit each fix separately with clear messages:
   ```bash
   git commit -m "$(cat <<'EOF'
   fix: {description of fix}

   Applied during fork-and-fix of PR #{PR_NUMBER}.
   Original concern: {what the review flagged}

   Co-Authored-By: Echo (EchoOfDawn) <noreply@anthropic.com>
   EOF
   )"
   ```
   Keep commits atomic — one fix per commit so the contributor can see exactly what changed and why.

### Phase 3: Merge

7. **Attempt to push to the contributor's fork** (preserves "merged" status on GitHub):
   ```bash
   git push 2>&1
   ```
   This works if the contributor enabled "Allow edits from maintainers" on their PR.

8. **If push succeeded** — merge via GitHub to preserve PR linkage:
   ```bash
   gh pr merge {PR_NUMBER} --repo JKHeadley/instar --merge \
     --subject "Merge PR #{PR_NUMBER}: {title} (fork-and-fix)" \
     --body "Merged with additional fixes by EchoOfDawn. See PR thread for details."
   ```
   The PR shows as **"Merged"** with a purple icon. All contributor commits are in main.

9. **If push failed** (no maintainer edit access) — merge locally:
   ```bash
   # Switch to main
   git checkout main
   git pull origin main

   # Merge the PR branch (creates a merge commit preserving all contributor commits)
   git merge --no-ff {pr-branch-name} \
     -m "$(cat <<'EOF'
   Merge PR #{PR_NUMBER}: {title}

   Fork-and-fix merge. Original PR by {contributor}.
   Additional fixes by EchoOfDawn applied before merge.

   Closes #{PR_NUMBER}
   EOF
   )"

   # Push to origin
   git push origin main
   ```
   The `Closes #{PR_NUMBER}` in the commit message auto-closes the PR. It shows as **"Closed"** rather than "Merged" — slightly less clean but functionally identical. All contributor commits are preserved in main's history.

### Phase 4: Attribution & Cleanup

10. **Post a thank-you comment** on the original PR explaining what we did:
    ```bash
    gh pr comment {PR_NUMBER} --repo JKHeadley/instar --body "$(cat <<'COMMENT'
    Thanks for this contribution, @{contributor}! We've merged your PR with a few small additions:

    {For each fix commit:}
    - **{fix description}**: {why we made this change}

    Your original commits are preserved in main — full attribution intact. Appreciate the solid work on this, and welcome to the project!

    — Echo (EchoOfDawn)
    COMMENT
    )"
    ```

11. **Dismiss any stale reviews** that were addressed:
    ```bash
    # Dismiss CHANGES_REQUESTED reviews since we've addressed everything
    gh api repos/JKHeadley/instar/pulls/{PR_NUMBER}/reviews/{REVIEW_ID}/dismissals \
      -X PUT -f message="Changes addressed during fork-and-fix merge."
    ```

12. **Clean up the worktree**:
    ```bash
    cd /Users/justin/Documents/Projects/instar
    git worktree remove "$WORKTREE_DIR" --force
    ```

13. **Update the follow-up tracker** — remove the PR from pending change requests if it was tracked:
    ```bash
    python3 << 'PYEOF'
    import json, os
    tracker_path = '/Users/justin/.instar/agents/echo/.instar/state/github-monitor-followups.json'
    if os.path.exists(tracker_path):
        with open(tracker_path) as f:
            data = json.load(f)
        key = f"pr-{PR_NUMBER}"
        if key in data.get("pendingChangeRequests", {}):
            del data["pendingChangeRequests"][key]
            with open(tracker_path, 'w') as f:
                json.dump(data, f, indent=2)
            print(f"Removed PR #{PR_NUMBER} from follow-up tracker")
    PYEOF
    ```

14. **Notify via Telegram**:
    ```bash
    cat <<'EOF' | /Users/justin/.instar/agents/echo/.claude/scripts/telegram-reply.sh 2317
    PR #{PR_NUMBER} merged via fork-and-fix. {contributor}'s original work is in main with full attribution. Fixes applied: {list}. Contributor has been thanked.
    EOF
    ```

## Failure Modes

- **Merge conflicts**: If the PR branch conflicts with main, DO NOT force-resolve. Report the conflicts and ask Justin whether to proceed or wait.
- **CI failures**: After merging, if CI fails on main, revert immediately: `git revert -m 1 {merge-commit-sha} && git push origin main`. Notify via Telegram.
- **Large PRs (>1000 lines)**: Pause and confirm with Justin before proceeding — large fork-and-fix operations carry more risk.

## What This Skill Does NOT Do

- It does not approve PRs (only Justin approves)
- It does not auto-merge without fixes (use `gh pr merge` directly for clean PRs)
- It does not handle PRs to other repos (JKHeadley/instar only)
- It does not create new PRs — it merges the original contributor's PR
