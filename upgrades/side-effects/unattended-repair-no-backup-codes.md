# Automatic sign-in repair and single-use recovery codes

The repair episode's authorization mode controls whether the browser driver receives a backup-code reference or a vault operation that can consume one. A resumed unattended episode must enforce the same restriction at dispatch. The browser also stops at a backup-code entry page before passing it to either navigation strategy. These are checks on the episode's authority and on a typed provider page, independent of a model's decision.

Where the agent helper has broader vault access, an account with a bound backup-code reference still requires the existing approved repair path. The browser driver can attempt warm sessions and ordinary authenticator flows without reading the recovery-code vault entry. An explicitly approved repair retains its existing behavior.

The change needs no configuration migration. Reverting the implementation restores the previous unattended backup-code behavior, so keep the all-machine approval on hold on builds without this safeguard.
