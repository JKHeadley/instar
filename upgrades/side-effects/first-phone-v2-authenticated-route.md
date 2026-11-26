# Dark authenticated first-phone v2 submission

The existing first-phone submission endpoint can dispatch a version 2 proof when a dedicated dependency is injected. The existing signed owner-phone transport gate authenticates the caller first. The new branch checks the exact path and body, then resolves the key and origin through trusted device binding state. The signed host, transport key and caller identity must match. A generic presence proof cannot establish dedicated Face ID approval.

The dark path reports only a witnessed decision or a pending or refused operation. It neither installs a registry key nor screens eligibility on its own. The handler still requires the authority-side eligibility and current slot checks. The normal server wires no v2 dependency and returns unavailable. Legacy v1 behavior is unchanged.

There is no new production endpoint, write authority, setting or migration. The HTTP fixture uses paired synthetic keys. The initialized server check covers the disabled production posture. Withdrawal of this branch would leave all persisted state untouched.

## 6b. Operator-surface quality

The endpoint returns a short decision state for the native confirmation screen. It sends no internal key material or witness data. It adds no destructive action or standalone operator surface. The existing app wording remains in place until the app integrates the new proof.
