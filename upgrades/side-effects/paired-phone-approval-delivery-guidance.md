# Explain approval setup for an already paired device

When a device is paired and no approval acceptance is current, delivery status explains the separate approval setup. The patch changes only the text returned for the existing fallback state. It leaves the first-approver rules, approval acceptance checks, request carrier and all write paths intact.

The regression uses a paired phone with a presence key and no approval acceptance. No real device was enrolled or approved.

Independent review concurred on the exact wording and unchanged approval rules.
