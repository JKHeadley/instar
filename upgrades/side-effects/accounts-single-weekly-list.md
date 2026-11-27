# Side-Effects Review — Accounts Single Weekly Reset List

## Summary
Tier 1 SMALL. Three runtime assets, one ordering/rendered-DOM test file, overview, side-effects and release fragment. Accounts become one full-width column across services, sorted by future weekly reset. Five-hour windows remain visible and do not reorder accounts. Revert fully undoes this display change.

## Decision-point Inventory
Only display order and layout change. nextWeeklyReset reads existing visible weekly windows from the freshest deduplicated account reading. No account selection, session placement, quota tracking, sign-in or permission authority changes.

## 1. Over-block
No action, account or window is rejected. Missing/expired weekly resets remain listed after known future resets. Names and details remain available; service groups become a quiet service label on every row.

## 2. Under-block
No new validation or permission gate. The existing model still owns identity-safe actions, partial responses, rolled-over readings and warnings. A stale but future weekly estimate remains visibly marked with its reading age. Unknown data does not become a fabricated reset.

## 3. Level-of-abstraction Fit
The Accounts model owns deduplication and display order. The renderer maps that sorted account list once, without framework grouping that would destroy global order. Scoped Accounts CSS overrides generic multi-column detail grids, leaving other pages unchanged.

## 4. Signal Vs Authority Compliance
Complies with docs/signal-vs-authority.md. No block/allow surface or semantic intent detector. Weekly timestamp comparison is a deterministic presentation rule, not authority to select or deny an account.

## 4b. Judgment-point Check
No new static heuristic at a competing-signals judgment point. The owner explicitly chose weekly-reset order. Future versus unknown/expired and equal names are enumerable display boundaries; account selection and pacing policies remain outside this code path.

## 5. Interactions
Existing freshest reading, machine cells, warnings, sign-in actions and detail sheet are retained. Header counts and needs-you items use the same accounts. Sorting can update their order but does not remove an item. Known pending PR3669 adds a detail-page class and multi-column account grid: this repair intentionally replaces framework groups with one list and supplies more specific single-column CSS. Integration must preserve this renderer and retain3669full-width/other-page improvements. No new timer, polling or retry. Stable name/id ties avoid reshuffling when deadlines agree.

## 6. External Surfaces
Only web Accounts presentation changes. No route, payload, credential, durable state, URL, notice or channel changes. Existing account details and sign-in forms stay reachable from phone rows. No new operator action or approval is introduced.

## 6b. Operator-surface Quality
1. Accounts remain visible directly in one continuous list; no collapse or extra navigation.
2. Each row shows a human account name and quiet service label. No raw id is added as primary text.
3. Destructive controls are unchanged; account rows open existing details.
4. Sixteen normalChrome fixed-frame cases pass:390/1280/1600pixels,both themes,currentand3669CSS,plus1280with25%largertext. Actual row font15to18.75pxandwindowlabel13to16.25pxaremeasured. Onecolumnfillsavailablewidth,norootsidewaysoverflow,correctdetailsheet,anddefault1280bars52.7%ofrow. ThefirstcombinedCSSpreviewcaughtalign-items:startshrink;scopedstretchfixandrerunproveclosure. Sampledataonly,noliveaccountorrealphoneclaim.

## 7. Multi-machine Posture
Replicated as normal packaged dashboard assets. Existing pooled account reads and their partial-data explanations remain unchanged. The freshest reading per account still drives visible windows. No new user notice needing one-voice gating, durable state that could strand on transfer, or generated URL. No status/health/capabilities/channels answer changes.

## 8. Rollback
Revert code and publish a patch. No state migration or credential repair. Display order reverts while saved accounts and measurements remain intact.

## Verification And Proportion
Finalsource50focusedunitcases,4HTTPintegrationcases,3productionpoolscopelifecyclecases,productionbuildand16normalChromecasespass. SourceRED14of15newcasesfailonoldcode;all15passwithrepair. IndependentSMALLreviewconcurred.No runtime concernfound. Normalcommitgatesandcompletesharedverificationremainpending;notreleasedorlive. Tier1display-only change; no duplicate full suite in this lane. Source artifacts and evidence live in the topic's private accounts-single-list directory until committed.

## Class-Closure Declaration
No agent-authored-artifact defect — not applicable. No self-triggered controller added or modified.

## Independent Review
Reviewer review_accounts_list concurred with final model, renderer, identity/actions and scoped stretch correction. Source/content hashes are bound to the final private browser receipt. No raw account data or secrets are included.
