# PromptGate Auto-Dismiss Memory — ELI16

The short version: when PromptGate successfully presses a known-safe key for a terminal prompt, it should not keep pressing that same stale prompt again every few seconds just because the old text is still visible in the terminal pane.

PromptGate already has two kinds of memory. One remembers prompts it has emitted so the same prompt does not spam the user. Another remembers terminal snapshots that an LLM already judged as not being prompts. The repeated-auto-dismiss bug slipped between those two. After PromptGate sends an auto-dismiss key, the server resets normal prompt state so the next genuine prompt can be detected immediately. That reset is good for real follow-up prompts, but it also erases the normal dedup entry for the prompt that was just dismissed.

Some terminal panes keep old prompt text visible after a key is sent. In that case, the next monitor tick still sees the same package-runner or Gemini modal text. Because the normal dedup was cleared, PromptGate thinks it is allowed to emit again, sends the same key again, clears state again, and repeats.

This change adds a separate memory specifically for successful auto-dismisses. When the server sends the auto-dismiss key and the send reports success, PromptGate records the prompt fingerprint in this memory. That memory is not cleared by the normal input reset. If the same prompt text is seen again while the pane content has not changed, PromptGate suppresses it.

The memory is not permanent. As soon as the captured pane content changes, PromptGate clears the auto-dismiss memory for that session. That means the same prompt shape can be handled again if the terminal actually moves forward or redraws into a new state. Cleanup also clears the memory when the session ends.

The important safety line is delivery success. If the key send fails, PromptGate does not record dismiss memory. That means a prompt is not hidden just because the detector wanted to dismiss it; it is hidden only after the system has evidence that the dismiss key was actually sent.

The tests cover the three practical cases: a successful auto-dismiss blocks repeats while the text is unchanged, a failed send can retry, and changed pane content re-arms the same prompt shape. Reviewers need to decide whether this text-change boundary is the right practical proxy for "same stale modal" versus "new prompt state."
