# Side-effects review for launch-bound managed Codex homes

A fresh launch gets a private directory keyed by its server-owned launch ID. Canonical home and workspace paths cannot contain one another. The directory is checked for links, ownership and permissions. The server stores its file identity with the native session binding. It can then refuse a missing, linked, replaced or exposed home even when a callback supplies the expected native session ID.

This is an isolation and evidence check under a trusted local state root. It is not a sandbox against arbitrary same-user filesystem access. The packaged lifecycle fixture uses the helper and binds the actual home together with the native launch. A production caller still needs to provide the trusted root, authentication, and exact launch transport. Output and feature defaults are unchanged.

## Second-pass review

**Reviewer:** managed_worker_home_review, independent Instar second-pass agent

Concur with the amended dark fixture. Bidirectional containment, private permissions and the persisted directory identity preserve the launch binding.
