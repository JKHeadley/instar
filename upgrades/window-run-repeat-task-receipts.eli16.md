# A long task can keep producing work receipts

A 24-hour autonomous run can have only a few real checklist tasks. Echo's window watcher needs a changed file every 30 minutes to prove work is advancing. Before this fix, it assigned each receipt to the next task that had never received one. After one receipt per task, it refused every later receipt even while a task remained open. The watcher then marked the run at risk when its last receipt aged out.

The watcher still chooses the first open task without a receipt when one exists. Once all open tasks have a receipt, it chooses the first task that is still open. It does this for both normal work receipts and recovery checkpoints. It still refuses a file whose contents match any earlier receipt in this run, a completed checklist, a mismatched run, and a receipt after the run ends.

The same rule is checked in a small unit test, an authenticated HTTP integration test, and an end-to-end test that starts the production server. The end-to-end test also checks that completing one task moves later receipts to the next open task, replaying old contents is refused, and completing every task closes the receipt path.
