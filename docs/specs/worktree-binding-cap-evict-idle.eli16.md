# Topic workspaces no longer run out for good: the plain version

When an Instar agent starts a session for a conversation topic that does code work, it gives that topic its own private copy of the code, called a workspace. To keep things tidy there is a limit of 30 workspace records at once. When the limit is reached, Instar is supposed to drop the record of a workspace that is finished.

The problem: nothing ever marks a workspace as finished. So once an agent had worked in 30 topics, every record stayed "active" forever, the cleanup step had nothing it was allowed to drop, and every new topic session was refused with "Max active bindings (30) reached". On 3 November this blocked two new topics the operator had just asked for; the oldest records were from bug topics closed on 28 October.

The fix: when the limit is reached and nothing is marked finished, Instar drops the record of the oldest workspace that no session is using right now. A workspace is "in use" when a live session holds its lock. Only the record goes. The workspace folder and its git branch stay on disk untouched, and if that topic ever starts a session again, Instar finds the existing folder and reuses it, exactly as it already does after a restart. If all 30 workspaces really are in use by live sessions, Instar still refuses, now with a message that says so.

What could go wrong: an idle topic whose record was dropped comes back and gets its workspace re-registered; nothing is lost. Each drop is written to the workspace history log, so it can be audited. Undoing the change is a revert; no data needs repair.

What to decide: nothing. It is a small, reversible fix.
