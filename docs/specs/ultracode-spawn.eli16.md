# Ultracode spawn — ELI16

Claude Code has two related controls that sound similar but are not the same.
`--effort xhigh` asks the model to think harder. Ultracode does that *and* lets
Claude dynamically organize workflow agents. Claude's command line does not
accept `--effort ultracode`; instead, Claude Code 2.1.177 officially recognizes
the word `ultracode` in a prompt as a per-turn opt-in.

That prompt trigger depends on Claude's `workflowKeywordTriggerEnabled` setting.
Claude defaults it to true. If an operator explicitly disables it, the keyword
is ordinary prompt text and the workflow mode will not activate; Instar does not
silently override that operator choice.

Instar now exposes exactly that supported mechanism on its existing one-shot
spawn API. A caller adds `ultracode: true` to a Claude Code spawn. Instar prefixes
the keyword to the prompt and otherwise uses the normal launch path. There is no
made-up CLI flag and no settings-file mutation.

Safeguards:

- It is dark by default: omitted or false preserves the original prompt exactly.
- It is accepted only for Claude Code; Codex and Gemini requests are rejected.
- It affects one spawned turn only. It does not persist on a topic or surprise a
  later session.
- The API requires a real boolean, so strings such as `"yes"` are refused.

Migration is awareness-only because there is no stored state or default to
convert. Existing agents receive a short CLAUDE.md section describing the opt-in.
