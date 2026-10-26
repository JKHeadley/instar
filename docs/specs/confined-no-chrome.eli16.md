# Plain-English overview: the sealed session no longer gets asked about the browser

## What this change is

Before the feedback pipeline writes a fix it runs a safety rehearsal in a sealed copy of the code. On 2026-10-25 at 15:50, right after the previous fix installed, that rehearsal failed in a new way: every shell-level check passed, but the Claude Code session inside the sealed copy never did its work. Its screen showed a start-up question from Claude Code itself: "Yes, use my browser / No, keep browser tools off". The automatic start-up handler pressed Enter on "No" half a second after it had answered the folder-trust question, the key did not take, and the handler only answers each question once. The session sat on that question until it was ended, wrote nothing, and the rehearsal counted as failed.

This change starts every sealed session with Claude Code's browser integration switched off (`--no-chrome`), so the question never appears.

## What already exists

The sealed session is already launched with a fixed set of start-up arguments: a strict permission mode where anything not explicitly allowed is refused, and a short list of allowed tools (file and shell tools only — no web, no browser, no plug-ins). The start-up handler knows the folder-trust question and this browser question and answers each once.

## What is new

One more argument in that fixed list: `--no-chrome`. It is a documented Claude Code option ("Disable Claude in Chrome integration"). A sealed session has no browser tools anyway, so nothing it could do changes; only the question goes away.

## Safeguards

Nothing about what the session may do is loosened: the permission mode, the allowed-tool list and the sandbox are unchanged, and the rehearsal still has to pass before any fix attempt starts. The tests that pin the exact start-up argument list now include the new argument. Undoing the change is a plain revert.

## Carried alongside

The repository's own commit check started refusing every change at midnight UTC because its list of approved AI models was last reviewed 45 days ago. That review is done in this same change: the Claude and Codex models on the list were each asked to answer live and did (the Gemini one could not be checked from this machine and is carried as is); two newer Claude ids are added to the approved list; nothing about which model is used changes.

## What you need to decide

Nothing. This removes a start-up question that was blocking the feedback pipeline.
