# Project Scope, in plain language

Project Scope keeps a long plan from quietly losing its unfinished pieces. It
groups related initiatives into rounds and gives every item a visible journey:
outline, drafted spec, converged spec, approval, build, and merge. The server is
responsible for checking the evidence behind each step, so an item cannot move
forward merely because a caller says that the work exists.

This repair changes where the server looks for spec evidence. A project points
at a local checkout so the server has access to the repository, but that
checkout may be days old or may intentionally be on an unrelated branch. It is
therefore a poor source of truth for whether a spec has landed. The server now
reads the live canonical repository identity and main-branch head, freezes that
head to one immutable commit, and reads the spec and its convergence report from
that snapshot. The checkout supplies the Git object database; the checked-out
branch and a stale local remote-tracking ref no longer decide the answer.

The important safeguard is honesty about uncertainty. An exact absence on the
canonical snapshot is still a normal stage refusal: the required artifact is
not there. If Git cannot resolve the reference or read the object, the server
reports that the evidence could not be verified. It does not turn an
infrastructure failure into the confident but false claim that the spec is
missing.

All production dependencies for stage validation are now assembled in one
typed factory. That includes canonical repository/snapshot resolution, the repository-artifact
reader, the pull-request reader, and the merge-ancestry check. A missing helper
is a loud wiring error. This closes the recurring class in which one forgotten
dependency made an entire pipeline stage unreachable while returning a
plausible project-level rejection.

Nothing here creates a new database, changes project records, or verifies the
TaskFlow identifier used by the later build stage. The repair is deliberately
limited to giving the existing spec, convergence, and merge gates one coherent
repository world and one complete production assembly point.
