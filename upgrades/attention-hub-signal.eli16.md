# Attention topic only carries what needs you — the plain-English version

Every Instar agent has one Telegram topic called "Attention". It is meant to be the agent's direct line to its person: the place for things they actually need to see. Over time, dozens of automatic background checks started posting their routine status there too. On Justin's agent the topic reached about 52,000 messages, and in the last week alone it got about 560 posts: a passkey health check posted 264 times, the worktree checker about 95 times, and the machine-sync checker about 70 lines like "this divergence is back" and "healed". Justin's words: "Its basically useless due to all the noise."

This change puts one filter at the door of the Attention topic. A post only gets through if it is one of these:

- marked urgent;
- raised by the agent itself (the agent decided the person should see it);
- something only the person can do: a sign-in repair that needs a tap, a duplicate conversation that needs their call, the daily feedback list of things that need them, account enrollment checks;
- a security event (something unexpected called the Telegram intake, a passkey revoke that never landed);
- a sign their messages may have been lost, or a setting they asked for that reverted, or quota that is fully spent.

Everything else is still recorded. It stays in the attention list on the dashboard and in the API, and each withheld post is written to a log file (`logs/attention-hub-held.jsonl`) so the agent can answer "why didn't X show up?". Nothing is deleted.

Posts that do get through are also easier to read: just the title and what to do. The "category | Priority" line and the internal "Source:" name are gone. If the same item keeps getting refreshed, it is posted again at most once every six hours unless it becomes more urgent.

Agents also get updated instructions: queue an Attention item only when the person must decide or act, or something they care about is broken and the agent cannot fix it itself.

If this turns out to hide something important, one setting (`attentionHubFilter: "all"` in the Telegram config) brings back the old behaviour without a new release.
