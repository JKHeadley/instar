# Gemini Hybrid Setup Driver — Plain-English Overview

> The one-line version: Gemini setup now follows the same code-owned wizard shape as Codex, so Gemini can help with friendly wording without being asked to run a Claude-specific setup script.

## The problem in one breath

The Gemini setup path was technically selectable, but the main wizard still treated Gemini like a prose wrapper around the Claude setup skill. It asked Gemini to read a Claude-authored file and follow instructions that assumed Claude-style tools and behavior. That is exactly how we got a broken setup review: Gemini looked for a tool named like a shell runner, but that tool does not exist in Gemini's real tool set.

## What already exists

- **The shared setup state machine** — Instar already has a deterministic wizard spine for the Codex setup path. It owns the questions, answer validation, transitions, and setup actions.
- **The Gemini CLI adapter** — Instar already knows how to run Gemini as a one-shot command using a verified model and the normal approval mode.
- **The native Telegram backstop** — The wizard already has an Instar-owned manual Telegram path that validates the bot token, discovers chat IDs, and writes config without asking an LLM to perform those side effects.

## What this adds

This adds a Gemini-specific setup driver. The driver uses Gemini only for short, bounded narrative paragraphs between structured questions. Instar prints the actual questions, validates answers, runs init, writes config, starts the server, and handles Telegram setup. Gemini is no longer handed the Claude setup skill, and it is not asked to run shell commands, write files, or drive browser automation.

## The new pieces

- **Gemini setup driver** — A sibling to the Codex driver. It consumes the shared wizard state machine, calls Gemini only for narrative text, and runs setup actions in Instar code.
- **Gemini setup dispatch** — The setup command now routes `gemini-cli` to the Gemini driver before the Claude skill spawn path is built.
- **Driver boundary tests** — Unit and integration tests check that Gemini uses the state machine, initializes agents as `gemini-cli`, avoids the Claude setup skill, and avoids shell/tool expectations.
- **Live narrative smoke** — An end-to-end test reaches the real Gemini CLI one-shot path. When Gemini quota is exhausted, the test records that as external unavailability rather than a product regression.

## The safeguards

**Prevents Claude assumptions from leaking into Gemini setup.** The setup command no longer asks Gemini to read the Claude wizard skill. The Gemini driver has source-level tests that reject references to the setup skill, shell-runner names, Playwright MCP prompts, and dangerous sandbox-bypass language.

**Keeps side effects owned by Instar.** Gemini can produce a paragraph, but it does not decide transitions or perform actions. The code path that initializes the project, adds the user, starts the server, writes Telegram config, and sends greetings remains deterministic TypeScript.

**Keeps the live test honest about external capacity.** The E2E test uses the real Gemini CLI path, but Gemini may refuse requests when model capacity is exhausted. That condition is reported as quota unavailability, not hidden as a successful prose generation.

## What ships when

This PR ships the driver, dispatch, model constant, and tests together. It does not attempt to add Gemini browser automation or a Gemini-native Telegram automation flow. That is intentional: the current safety line is that Gemini setup narrative is model-assisted, while setup side effects stay code-owned.

## What you actually need to decide

Approve this if the right first Gemini setup milestone is a code-owned hybrid wizard that uses Gemini only for bounded narrative and leaves all setup actions inside Instar.
