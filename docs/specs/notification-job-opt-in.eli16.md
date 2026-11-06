# Per-job notification opt-in, in plain English

## What this is

Quiet by Default keeps automated reports out of your chat and puts them in the
Notifications page. Today the only switch for scheduled jobs covers all of them: every
job report reaches you, or none do. This change lets you pick one job, such as the
2.0 check-in, and hear from it, while every other job stays quiet. It also makes the
agent offer you that choice when a new job is created.

## What already exists

The notification gate decides, for each automated message, whether to send it or file
it quietly. It already has per-category switches, a limit on how many pushes can go out
in ten minutes, and a settings writer that copies your choices to your other machines.

## What is new

- A per-job switch. A job you turned on can send its report to the conversation where you
  said yes. Anything else from that job, and everything if you ticked it on the dashboard
  instead, arrives in the Attention topic. Reports from other jobs keep going to the
  Notifications page.
- A way to set it: a new server call that needs the same proof as the category switch,
  meaning your dashboard PIN or a recent message from you. The dashboard page shows the
  jobs next to the categories.
- A prompt at creation. The agent's standing instructions and scheduling skill tell it
  to ask you when it creates a job that reports to you, and the job commands repeat
  that. Nothing blocks, and no answer means quiet.

## The safeguards

The important one is that a session cannot pass itself off as your opted-in job. The
name that arrives with a report today is written by whoever sends it, so it proves
nothing. The gate only trusts a name the server worked out itself: from a session the
scheduler started, or from the scheduler directly. A session that merely claims the name
stays quiet. The trusted name is sealed into the signed record of the message, so
messages recovered after a restart or passed between machines get the same answer.

An opted-in job also cannot use your yes to post anywhere it likes: outside the
conversation where you said yes, its reports go to the Attention topic.

Machines running an older version reject the setting rather than misreading it. Misread,
it would have switched on every job report there. The existing limit on pushes still
applies.

## What you should know

If you have turned on the whole "Scheduled job reports" category, one job cannot be
turned off underneath it. The agent will say so rather than promise silence.

Two limits are real. The server can check that you sent a recent message, but not that
the message said yes, so the agent's instructions carry that part. This is the same check
the category switch uses today. And agents usually create jobs by writing the job file,
where only those instructions can prompt the ask, not the server.

A yes also cannot make a silent job talk: a job that only speaks up on problems stays
silent after a good run unless its own instructions send a report.

## What you need to decide

Nothing. The default stays quiet, and your only choice is per job, when the agent asks.
