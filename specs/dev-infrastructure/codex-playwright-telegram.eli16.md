# What this PR does — in plain English

## The setup

In v1.2.15 I replaced the Codex-driven Telegram setup with an
instar-native flow because the original Codex attempt was broken —
it printed manual instructions and quit. Justin pushed back: surely
Codex has the same Playwright (browser-automation) capabilities as
Claude does, so why are we making the user do it manually?

Investigation answered that. Yes, Codex CLI supports Playwright.
But instar's setup only registers Playwright for Claude — writes to
`~/.claude.json` and creates a `.mcp.json` in the project — never
to `~/.codex/config.toml` where Codex looks. So when v1.2.14 tried
to use Codex for the Telegram flow, Codex had no browser tools and
fell back to printing manual instructions.

## The fix (two parts)

### Part 1: register Playwright for Codex

New helper `ensureCodexPlaywrightMcp` appends a section to
`~/.codex/config.toml` that tells Codex how to launch the
Playwright browser-automation MCP. The section looks like:

  [mcp_servers."playwright"]
  kind = "stdio"
  command = "npx"
  args = ["-y", "@playwright/mcp@latest"]

(Same shape Justin's Codex already uses for Threadline.) Idempotent
— re-running doesn't duplicate the section.

### Part 2: try Codex+Playwright first, fall back to manual

The wizard's Telegram step is now a two-stage flow:

1. **Try Codex+Playwright first.** Spawn Codex with a very specific
   prompt telling it to drive Telegram Web through BotFather,
   capture the bot token, create a group, capture the chat ID, and
   write everything to `.instar/config.json`. The prompt includes
   explicit "if Playwright isn't reachable, output this sentinel
   and exit" and "if anything fails, output this sentinel and exit"
   instructions. Long timeout (10 minutes) for the QR-code login
   step.

2. **Verify the config write actually happened.** After Codex
   exits, instar reads `.instar/config.json` directly and checks
   that a telegram entry exists with both `token` and `chatId`
   populated. We never trust Codex's exit code alone for "did this
   succeed."

3. **Fall through to manual on failure.** If verification fails for
   any reason — sentinel output, exit code non-zero, missing config
   entry — the wizard automatically drops into the v1.2.15
   readline-based manual flow as a backstop. The user gets the
   same end state either way.

## Why this is the right shape

Codex's strength is execution. Telegram setup IS execution (open
browser, click buttons, capture text from the page). When Codex has
Playwright, it's better at this than asking the user to do it
manually. When Codex doesn't have Playwright (or fails for any
reason), we don't get stuck — we drop straight into manual.

## What doesn't change

- The state machine is unchanged.
- The conversational/identity steps still use the narrative-prompt
  path from v1.2.12.
- The Claude wizard path is untouched.
- The instar-native manual Telegram flow stays exactly as it was in
  v1.2.15 — now serving as the backstop instead of the primary.
