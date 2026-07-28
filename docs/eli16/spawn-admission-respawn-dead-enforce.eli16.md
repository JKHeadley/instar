# Respawn-dead admission graduation — ELI16

When a message arrives on the Mac Mini for a topic deliberately pinned to the Laptop, the router may correctly save/forward the message because the Laptop is still alive. The old restart path could then ignore that outcome and start a second local session anyway. The safety gate already recognized this and recorded that it would block, but this one restart row was still observation-only.

This change makes that single, strongest-evidence row binding. It blocks the local restart only when all facts agree: the callsite is exactly `telegram-respawn-dead`, the router already returned queued, the topic has an effective hard pin to another machine, that pinned machine is currently alive, the multi-machine pool is live, and durable message custody is available. The refusal action is forward, so the message is preserved rather than dropped.

If the owner is genuinely dark, the pin is absent or unreadable, the target is this machine, custody is unavailable, the pool is dark, or a different spawn path is running, behavior remains unchanged. Those cases retain the existing dry-run or owner-dark ladder. The duplicate reconciler is deliberately not graduated here: prevention at the exact spawn door closes this incident without expanding destructive cleanup authority.
