# Side Effects Of Refreshing Older Conversations

The renderer refreshes a loaded window of up to 200 rows using the existing signed pool list. It replaces the rows, pins and cursor together. The server reports whether the requested inventory was available across the local source and registered computers. Its visibility rules still decide which rows belong in the result.

- **Over-block.** A registered computer with no usable route, an older peer that cannot attest coverage, or a partial source prevents a widened replacement. The previous window stays visible with a retry. Ordinary first-page reads keep their existing response handling.
- **Under-block.** Deeper lists retain their older cached rows. Complete inventory availability does not establish that two replicas have the same work-card state. A server result can still reflect conflicting replica state.
- **Level of abstraction.** The server reports available inventory and the browser owns its displayed window and continuation. No row-level inference from title, history, or first-page absence is added.
- **Signal and authority.** The deterministic coverage check supplies evidence about which sources answered. Existing read authorization and visibility rules remain the authority for which data the browser receives.
- **Interactions.** List reads keep their existing request ownership and deadline. A matching newer tab result can supersede a local refresh. A widened broadcast uses a separate mode older tabs ignore. Visible tabs at a different depth make at most one additional signed list read per minute per tab.
- **External surfaces.** The list response adds a boolean. Existing clients can continue to consume the same rows and cursor. The refresh performs no writes and leaves the open conversation and composer in place.
- **Multi-machine posture.** The list remains proxied on read. The server checks admitted responses against registered machine identities as well as resolved endpoints. A local inventory failure and a registered machine without an endpoint each prevent widened replacement.
- **Rollback.** Reverting the patch restores the old browser caching behavior. There is no data migration or state repair.


## 6b. Operator-surface quality

The conversation rows remain the primary content, with Show more below them. If the refresh cannot check the whole list, the status explains that the last loaded list is still shown and places Try again beside it. Protocol details stay out of the primary content. The existing secondary availability line can name a failed source. Retry only reads, and this change adds no destructive actions. The sentence and button labels are short enough for the existing phone layout and use the existing list controls. The focused tests check the visible wording and the retry state. A live phone layout check still belongs to release verification.

## Integrated renderer

History loading and continuation use their own request owners and expose loading and retry status. A cancelled or outdated browser status response is ignored before the existing local credential deletion path starts. Existing server identity and authorization checks remain in place. The local deletion itself keeps its existing storage semantics.

A complete answer certifies available inventory, with no claim about agreement between work-card replicas. Windows deeper than 200 rows can retain older cached entries until reopened. The server preserves the existing visibility refusal and unread uncertainty signal. Newer credential-notice behavior from main is carried unchanged.

## Independent review

Concur with the review. Reviewer `/root/refresh_review` checked the three renderer modules and list route against main `646c926a6`. The reviewer found no new write authority or peer and owner permission boundary changes. The review identified the history and cancellation behavior, browser key storage limits and replica-coverage limit documented above.

## Evidence

On main base `646c926a6`, 58 renderer tests, 12 signed HTTP tests, one production server lifecycle test and one signed HTTP-to-renderer replay passed. The replay verified that an answered card leaves the loaded list while the neighboring conversation and stored history remain. Full verification will run on the published commit.
