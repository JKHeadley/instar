# Keep casual withdrawals in the conversation

If you say “nevermind” on its own, the agent should understand that you are withdrawing a thought or request. That should normally reach the conversation instead of ending the session. If you tell the agent to stop something urgently, that instruction still takes effect. A message can contain both ideas, as in “Never mind the last question, stop everything now.”

The change gives the model those cases directly. It keeps short emergency commands working through the existing immediate controls and keeps the model's preference to stop when it hears a plausible urgent instruction. The focused checks exercise how the server routes the different answers and verify that the model receives the new examples. Those checks use a fixed response, so they cannot establish how a live model will classify every message.
