# See whether account allowance will last until reset

The Accounts page already tells you how much of each allowance has been used. This change adds a forecast section on that same page, so you can see where recent spending is heading without asking an agent to interpret a technical report. It reads the existing forecast service; it does not change where work runs or how much it spends.

Each provider gets its current outlook. Opening its details shows the named accounts, their weekly usage estimate at reset, and the range produced by recent spending rates. An estimate that reaches the limit says so. Stale readings, conflicting machines, missing identity and insufficient history stay visibly uncertain. The page never turns a missing number into zero usage.

The section also says how many forecasts have been checked against actual resets and how far off they were on average, in percentage points. Missing final readings and resets with no usable forecast are counted separately. A small sample is simply a small sample; it does not certify reliability. The observed development history currently has two scored outcomes, which is enough to display the comparison but not enough to establish that it predicts every account well.

The new section loads independently of sign-in controls. An unavailable forecast cannot prevent you from using the Accounts page. Its text explains that it is an estimate and changes nothing automatically. There is no new notification, background model call, credential writer, spending control or setting to approve. Reverting the change removes the section without altering stored history or active conversations.

The separate Fable allowance is shown separately wherever the existing API provides it, both in provider outlook and account projections; it is never combined with the weekly budget. The original brainstorm’s plan explicitly requires this distinction.
