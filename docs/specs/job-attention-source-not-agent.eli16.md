# Scheduled jobs stop posting to the Attention topic as "agent" — plain-English overview

## What happened

Every few hours, Justin's Attention topic got a message saying "Evolution actions are overdue", each time worded a little differently, asking for a "bulk triage". Only the agent could do that triage, so the message was noise. It came from a built-in scheduled job, the overdue check, which runs every four hours on a small model.

The Attention topic has a filter. Routine automated status is held back and kept on the dashboard. Only urgent things, things the user must decide or tap, and things the agent itself chose to raise get through. The overdue check labelled its message as coming from "agent", the label that means "I, the agent, decided you need to see this". So the filter let it through every time. Each run reworded the text, so the system treated each one as a new message and posted it again.

## What changes

1. The overdue check now labels its item with its own job name. The filter recognises that as automated status. The item stays on the dashboard, always up to date, and stops posting to the Attention topic. The job also becomes report-only, as its description always said. It no longer tries to cancel actions or message the user. Its item text has a fixed shape, so it stops being reworded.
2. If a row already exists from before, the new label replaces the old one the next time the job runs. Without this, the old row would keep its "agent" label and keep getting through.
3. A second built-in job, the monthly bench refresh, had the same wrong label. Its message is a real request for the operator to review a routing change, so it keeps reaching the operator. It now uses its own name, which is listed as one that needs the operator.
4. A test now fails if any shipped job labels its attention item "agent". Agents also learn, through their instructions file, that a job they write must use its own name. New agents get this at setup. Existing agents get it on their next update, and their job text is refreshed on update automatically.

## What stays the same

Items the agent raises itself still reach the user. Nothing is deleted. Held items are kept on the dashboard and in the held-posts log. The operator can still switch the filter off completely with the existing setting.

## What to decide

Nothing beyond merging. This is a small change that a revert fully undoes.
