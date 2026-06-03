# Quota Warning Spam Fix — ELI16

Viewable private artifact:
https://echo.dawn-tunnel.dev/view/3549e97d-8bcc-4320-9fd0-c70b364dbe5a?sig=c4f780ce95e056f912a8aa959a982ad0baaeef692cfe993dbbf86a27efb168b7

When an agent has no "quota state" file (a small file that tracks how much of its usage budget is
left), Instar safely lets all scheduled jobs run anyway — and logs a one-line note: "No quota state
file found — all jobs will run."

The problem: that note was being written on **every single check** — hundreds of times a day (902× on
one agent). A log full of the same harmless line over and over buries the messages that actually
matter, like a smoke alarm that beeps every second so you stop hearing it.

The fix makes Instar say it **once** when the file goes missing, then stay quiet until the situation
changes. If the file later comes back and then disappears again, it'll say it once more. Nothing about
how jobs run changes — the agent still safely runs everything when there's no budget file. Only the
noise is gone.

_Tier-1 fix · branch `echo/quota-no-file-warn-once` · 2 new unit tests + 88 quota-tracker tests green._
