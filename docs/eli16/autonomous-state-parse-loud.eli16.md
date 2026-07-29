# When an autonomous run file is broken, say so

An autonomous run is kept alive by a stop hook. Before a session is allowed to
end, that hook reads the run’s state file and checks whether the run is still
active. The server also reads the same file to report which runs are active.

Those two readers did not agree on the file format. The server accepted plain
`key: value` lines anywhere in the file. The hook accepted those fields only
inside a fenced frontmatter block. If a state file existed and said
`active: true` but had lost its fences, the server reported a healthy active run
while the hook found no active value and quietly returned success. That success
allowed every turn to stop. From the outside the run looked alive, but the part
that continued it had gone inert.

The fix preserves the existing format contract rather than changing every
reader. A genuinely absent state file still means there is no autonomous job,
so the hook exits cleanly and says nothing. Once the hook has selected an
existing state file, however, missing fences or a missing/invalid `active` field
are corruption. The hook now writes a clear error naming the state file and
returns a failure status. It can no longer translate “I found the file but
cannot read its control field” into “there is no active run.”

The behavior is pinned with an executable test over the real production hook.
On the same fence-less file, the server-side reader still reports
`active: true`; before the fix the hook returned exit 0 with empty output, and
after the fix it returns nonzero with the visible corruption message. Separate
cases prove that no file remains a silent exit 0 and a valid fenced
`active: false` file remains a silent exit 0.

Existing installations receive the corrected hook through a new capability
marker in the update migrator. Anchor-compatible recent hooks are patched at
three exact anchors, so unrelated custom lines survive. Older canonical hooks
are replaced only when their complete bytes match an exact SHA-256 recorded
from repository history. A hook matching neither proof is left untouched. The
change does not repair, rewrite, delete, pause, or resume any autonomous state
file, and it does not change the API’s status reader. Its job is narrower:
corrupt state may still require an operator or writer to repair it, but it must
no longer impersonate the healthy no-job case.
