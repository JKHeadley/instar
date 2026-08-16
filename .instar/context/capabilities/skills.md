# Skills System

Reusable behavioral capabilities defined as markdown files. Claude Code auto-discovers them from `.claude/skills/`. You don't need to write code — just write clear instructions in markdown, and they become slash commands available in every session.

## Quick Reference

- **Create**: Write a markdown file at `.claude/skills/my-skill/SKILL.md`
- **Invoke**: `/my-skill` in any Claude Code session
- **Schedule**: Reference in a job: `{"execute": {"type": "skill", "value": "my-skill"}}`
- **List all**: `ls .claude/skills/`

## When to Create a Skill

- You notice yourself doing the same multi-step workflow more than once
- A job would benefit from a structured, repeatable process
- You want to capture a complex behavior pattern so it survives across sessions

## How to Create a Skill

1. Create a directory: `.claude/skills/my-skill/`
2. Write the skill file: `.claude/skills/my-skill/SKILL.md`
3. Start with frontmatter: `name`, `description` (for auto-invocation), and `user_invocable` nested under `metadata:`
4. Describe the behavior, steps, and any grounding requirements
5. It's immediately available as `/my-skill` in the next session

## Example Skill

`.claude/skills/reflect/SKILL.md`:

```markdown
---
name: reflect
description: Analyze what was learned in the current session and persist insights to MEMORY.md
metadata:
  user_invocable: "true"
---

# /reflect

Review what happened in this session:
1. Read recent tool outputs and conversation history
2. Identify patterns, lessons, or insights worth remembering
3. Update .instar/MEMORY.md with anything new
4. Note any infrastructure improvements that should be made
```

## Compounding Value

Skills compound over time. Each skill you create makes future sessions more capable. A skill that checks deployment health, a skill that processes user feedback, a skill that generates reports — these accumulate into an increasingly sophisticated behavioral repertoire. You are not just completing tasks; you are building the infrastructure to complete them better next time.
