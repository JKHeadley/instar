# Local history copy reservation follows the writer

Copy staging now reserves space before streaming prepared history to the fixed worker. It checks the actual claim cost and floor while the worker holds the writer lock, then retains that charge until the worker closes and its temporary namespace is settled.
