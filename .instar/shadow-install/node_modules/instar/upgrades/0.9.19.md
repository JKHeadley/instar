# Setup Wizard Now Ships With Package

## What Changed

The conversational setup wizard (powered by Claude Code + Playwright browser automation) was previously missing from the published npm package. The `package.json` `files` whitelist only included `dist`, `dashboard`, and `upgrades` — the `.claude/skills/setup-wizard` directory was excluded, causing every fresh install to silently fall back to the "classic setup" which requires users to manually create Telegram bots through step-by-step terminal instructions.

The fix adds `.claude/skills/setup-wizard` to the `files` array so the skill ships with every install. Now `npx instar` and `instar setup` will launch the full conversational wizard that uses Playwright to automate Telegram bot creation, group setup, and configuration — the user just watches and confirms.

## What to Tell Your User

Setting up a new agent just got much smoother. The setup wizard now uses browser automation to handle Telegram bot creation, group setup, and configuration automatically. Instead of following manual step-by-step instructions, you'll get a conversational experience that does the heavy lifting for you.

## Summary of New Capabilities

- **Setup wizard ships with npm package**: The `.claude/skills/setup-wizard` skill is now included in published releases
- **Automated Telegram setup**: Playwright browser automation handles BotFather interaction, group creation, Topics toggle, and admin assignment
- **No more "falling back to classic setup"**: Fresh installs get the full conversational wizard instead of manual terminal instructions
