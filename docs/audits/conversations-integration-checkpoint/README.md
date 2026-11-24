# Conversations Integration Checkpoint

This checkpoint preserves the tested merge work for Conversations paging, history loading, and offline sending. The two patches target different exact branch tips. Apply each in a disposable integration checkout with its specified base, or use it as a reference when a target has moved.

| Patch | Exact base | What it carries |
| --- | --- | --- |
| `renderer-and-tests.patch` | `8517256b1`, durable offline sends | List refresh and history changes from `a00c5fb60` and `86c2a0572`, merged with the offline-send renderer and tests |
| `owner-visibility-route.patch` | `06a4d9e18`, the owner visibility repair with the project-app fixture correction | Inventory coverage and the existing owner visibility projection in the same list route |

Run `git apply --check` with the appropriate patch before applying it. A check against a different tip provides no assurance that the tests cover the resulting merge.

## Merge decisions

Scheduled list reads keep their list owner and request accounting. History reads for the open conversation use the history owner. The list shows pending sends and the loading and retry controls together. Browser-device revocation keeps both the cancelled-read guard and the identity-checked persisted delete. The combined test fixture keeps the newer IndexedDB setup and both sets of scenarios. Its deep-link test uses the visible retry, and its follower test holds only the chat leadership lock.

The endpoint resolution retains the owner visibility projection, its dedicated unavailable response, and both the unread and list-inventory completeness signals. A complete inventory describes the sources that answered. It does not resolve conflicting visibility state on replicas.

## Evidence

A disposable checkout on each exact base accepted its patch and reproduced every tested file byte for byte. The combined renderer passed 122 focused tests. A separate signed HTTP replay fed the reconciled endpoint's response into that renderer. It removed the answered internal card, kept the legitimate older conversation, and preserved the answered card's stored history. The replay used synthetic data.

This is an integration checkpoint. Full verification still needs the actual combined release head.
