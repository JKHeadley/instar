# How Development now explains feedback limits

The Development page asks you to approve the models that sort incoming feedback and decide which work items to fix. The approval cards used to show a daily amount in dollars even when a model ran through a subscription. That amount is an internal counter used to limit how much the readiness model can do in one day.

The subscription cards now show what that means in practice. Triage has a daily limit on model calls. It also pauses when the account as a whole reaches its usage threshold. Other work uses that account too, so the threshold describes when triage pauses. Readiness charges a fixed amount to its internal counter before each batch. The card shows an approximate number of calls covered by that budget.

When the serving route cannot be confirmed, the card says so. The dollar field requires a confirmed metered API route. Confirming an approval still uses the existing PIN and sends the original budget value when the dollar field is hidden.
