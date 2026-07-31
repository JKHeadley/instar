# ELI16 — Remediation intent and audit records are checked after restart

Before an automated remediation runs, Instar writes a durable intent record.
It then writes audit rows showing that the attempt started and how it ended.
Both files already had read APIs, but the live server never called them, so a
crash in the small gap between those writes could leave evidence that nobody
compared after restart.

The remediation bootstrap now restores a bounded tail of accepted audit rows
and compares it with recent durable intents. A matching attempt starts cleanly.
An intent with no audit evidence becomes a loud boot warning instead of a
silent forensic gap. The intent reader now streams its journal, avoiding a
whole-file synchronous read when this dormant path becomes live. The audit hot
index reads at most two megabytes and one thousand rows, so old logs cannot make
startup memory grow without bound.
