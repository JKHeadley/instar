<!-- bump: patch -->

## What Changed — A Slack reconnect after sleep/wake can no longer crash the whole agent

Agents that use Slack keep a live connection open, and reconnect it whenever the machine sleeps and wakes. A timing race during that reconnect could throw an error from deep inside the Slack connection (trying to acknowledge a message a split-second before the line was fully open). Because that error happened in a background handler, it bubbled all the way up and crashed the entire agent — closing its databases and dropping in-flight work — just because one Slack acknowledgement couldn't be sent. For a laptop agent that sleeps and wakes constantly, that was a recurring-outage risk.

Now there are two safety nets: the agent checks the connection is actually open before sending the acknowledgement (and Slack re-delivers anything it didn't hear back on, so nothing is lost), and the kind of isolated, self-healing Slack reconnect hiccup that caused the crash is now treated as recoverable — logged and shrugged off — instead of taking the whole agent down. Genuinely serious errors still crash-and-restart as before.

## Summary of New Capabilities

- The Slack Socket Mode client guards its event acknowledgement on the socket being open (with a try/catch), so a mid-reconnect send can't throw. The process-level crash handler's recoverable-error allowlist was extracted into a small testable module and now also covers the Slack reconnect race, so an isolated Slack WebSocket hiccup never crashes the agent or closes its databases.

## What to Tell Your User

If you run a Slack-connected agent on a laptop, it won't get knocked offline by a sleep/wake reconnect glitch anymore. A brief Slack hiccup is now logged and recovered from instead of crashing the whole agent, and any Slack message involved is re-delivered, so nothing is lost.

## Evidence

- Found in the agent's own server log: a FATAL uncaught "Sent before connected" crash right after a sleep/wake Slack reconnect, closing the databases.
- Root traced to an unguarded WebSocket acknowledgement send in the Slack client (it checked the socket existed but not that it was open, and wasn't in a try/catch), throwing in an async handler that escaped the reconnect's error handling.
- Unit tests: the recoverable-error policy treats the Slack race + the existing HTTP races as recoverable and unknown/serious errors (mutex, sqlite-closed) as fatal; source assertions confirm the ack is guarded and the handler routes through the policy. Slack reconnect + heartbeat suites stay green. Independent adversarial review confirmed the extraction is behavior-preserving and the new suppression is safe.
