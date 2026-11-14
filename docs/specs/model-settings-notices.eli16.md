# Model settings notices that reflect real pending changes

A session can be deliberately started with a model choice that differs from the topic’s usual defaults. That choice belongs to the running session. A server restart must not reinterpret it as a failed settings change or schedule a replacement session. Defaults from a group or framework choose what starts next; they do not order an existing conversation to restart.

The fix records an explicit direct-spawn choice together with the topic settings it overrode. When those settings still match, the running choice is accepted silently. A later real profile change supersedes the launch preference. This includes creating an explicit topic pin equal to an inherited default. Thinking and effort settings remain checked: recording the model choice does not pretend that unrelated settings were applied. Existing unpinned sessions also stay quiet when only inherited defaults have drifted.

When a genuine topic-specific mismatch exists, the existing recovery still waits for idle and still respects protection. Its explanatory notice is remembered on disk, so repeated server boots do not repeat it. A busy retry does not add the redundant mid-task message. Protection instructions remain visible because they require an operator action. After successful recovery, a later mismatch can be reported again.

This is a narrow reversible fix. Extra launch and notice fields live alongside the existing local session bookkeeping; older state files load without migration. Existing topic ownership and messaging delivery continue to control which machine speaks. There are no new operator controls. Regression tests drive the HTTP spawn route and repeated orchestrator restarts, and a sustained-pressure ratchet verifies that one unchanged mismatch cannot generate an unbounded stream of notices.


The full checks also exposed a problem in the Linux test runner's terminal multiplexer: an old tmux release can lose a child-process notification and leave a finished process looking unfinished. The three Linux test lanes now use the same checksum-verified release containing the upstream fix. Tests keep their real process-exit and retained-pane checks, and a synchronization file makes sure pane retention is installed before a test process may finish. This changes the disposable GitHub runner toolchain, not anyone's installed agent or model settings. No sessions or test agents are started on the laptop.

A separate pairing test assumed two randomly generated words could never be identical. That array-only assertion is removed; the real request still proves a wrong word rejects the pairing, and now also checks its response status.
