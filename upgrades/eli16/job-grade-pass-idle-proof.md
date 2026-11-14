# A narrow independent check for the grading job

The grading job asks the server to process decisions waiting for grades. The
server already gives it a receipt saying the request ran. Because Jev sees
that receipt, repeating it cannot tell us whether Jev was right.

This change adds a separate check. When the server can see that all six
grading areas have no decision rows before or after the job, it records a
proof that the job really had nothing to do. If Jev then says the result is
routine, we can mark that one answer correct. If any area has history, or a
read fails, we do not assign a positive grade. Jev remains off until the
broader audit and rollout requirements are met.
