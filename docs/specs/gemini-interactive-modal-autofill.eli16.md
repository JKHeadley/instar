# Gemini interactive modal autofill — ELI16

Gemini has a few pop-up style questions that are not really the agent asking the
user what to do. They are Gemini CLI asking about its own safety rails, like:
"a possible loop was detected, should loop detection stay on?", "do you trust
this workspace?", or "do you want to continue with this install/default?".

Before this fix, Instar noticed those questions and forwarded them to Telegram.
That helped visibility, but it did not solve the actual problem: the Gemini
terminal was still sitting at the modal waiting for a keypress. In an autonomous
session, nobody is always there to press Enter, so the whole session could wedge
until Justin manually touched the pane.

The fix teaches Prompt Gate to recognize those specific Gemini CLI modals before
it uses the normal "ask the human" relay path. For each known modal, the safe
answer is deterministic:

- keep loop detection enabled;
- trust the current workspace when Gemini is asking its workspace-trust modal;
- use Gemini CLI's highlighted/default answer for install confirmation.

Prompt Gate already had a way to send a key directly for deterministic system
prompts. It used that for Claude's optional feedback survey. This change reuses
that mechanism for Gemini's blocking modal prompts. That means Instar sends the
key into the tmux session immediately, clears the detector's cache, and lets the
Gemini session keep working.

The change is intentionally narrow. It does not auto-answer generic install
questions. The install detector requires Gemini/Gemini-CLI/MCP/tool context, so
a normal shell question like "do you want to install this dependency?" can still
go through the existing manual/classifier path.

The tests pin both sides: Gemini loop detection, workspace trust, and install
confirmation get an `autoDismissKey`; a generic non-Gemini install prompt does
not. Existing Prompt Gate, InputClassifier, and AutoApprover tests also stay
green, which proves the broader relay and auto-approval paths were not changed.
