# Phone Chat Composer Fit: Side Effects

## Summary

Tier1 reversible CSS-only repair of open mobile Chats. Original production-served assets with sample data reproduced36px initial composer/Send obscuration only when the compact Needs-you strip is visible. Fresh isolated branch from current cached main ec9401e5; no JavaScript or API changes. Existing chat-state candidate3698 and Accounts3669 remain separate.

## Over-block

No action is blocked. Messages yield available space instead of pushing the composer behind fixed navigation. A visible expanded needs list retains original document scrolling and bottom clearance. Compact/absent states have outer content scrolling above navigation for exceptional overflow; this is separate from the message scroller. Desktop and other pages are outside the scoped media/has selectors.

## Under-block

No physical iPhone/keyboard or every mobile engine claim. Large content can still need scrolling. This is a repair of initial composer fit, not proof that every layout rule or chat issue is solved.

## Level of abstraction

The shell accounts for sibling height through flex layout rather than a new observer or guessed strip-height constant. Existing viewport and safe-area tokens remain the inputs. No event lifecycle, storage or controller is added.

## Signal versus authority

Reference docs/signal-vs-authority.md. There is no new decision authority, detector or gate. Media queries and open-page selectors control presentation only, without changing request or approval permissions.

## Interactions

Mobile shell, main-column, Needs-you strip, main padding and nested chat heights participate. Header, preview/warning banners and composer controls cannot shrink; only message content yields. Messages retain their own scroller. A visible expanded needs list uses the original document-flow rules; a hidden strip with a stale open attribute does not disable fitting. Compact/absent overflow uses main-column, or direct main in embedded mode, as an outer scroll area above navigation. No global overflow:hidden is introduced.

## External surfaces

The phone dashboard's existing composer placement changes. No endpoint, credential, browser enrollment, saved preference, message send, confirmation or installed agent awareness changes. Existing static-asset update path serves the CSS; no state migration is needed.

## Multi-machine posture

The stylesheet is shipped with the existing dashboard bundle and applies wherever that bundle is served. No machine-local durable state or coordination protocol is introduced. The browser exercise uses no approved production chat session or copied profile.

## Rollback

Revert the CSS/docs. No data migration or message repair is required.

## Verification

Actual production asset hashes and rectangles, not source intent alone, established the baseline. Core asset hashes were unchanged after baseline measurement. The first candidate reduced all measured overlap to0 in8viewport/strip cases; phone geometry without a strip and desktop geometry matched baseline exactly. The first extended candidate made expanded needs obscure Send even at maximum scroll on the smallest phone; the failed result is retained. The correction preserves original flow for visible expanded needs and gives exceptional compact content a bounded outer scroller. Final15-case browser matrix passes its geometry assertions:13 ordinary compact/absent cases have0initial overlap; expanded20-item lists remain reachable after scrolling and return to a clear compact state. Two six-attachment stress cases remain reachable through outer scrolling; the390x400 stress case needs that scrolling and is not claimed to fit initially. Light mode, a short viewport and a simulated68px embedded safe-area inset are included. No JavaScript errors or message writes; owned browser exits. Independent Sol source/side-effect review concurred after catching the expanded-state regression. These are production-layout tests with synthetic content, not physical-phone proof. Full suite belongs to throughput; no full pass, release or physical-device proof claimed.

## Class-Closure Declaration

Defect class unbounded-self-action, closure n/a: static CSS, no autonomous or external action. No new user approval is required for this reversible existing-screen repair.


## Proportion and dependency boundary

One stylesheet repair plus overview, upgrade note and side-effects record; two source-review passes and one measured correction after initial reproduction. No new automated CSS-string tests were added: actual browser rectangles establish the layout behavior. The existing chat page/model files pass91tests, and front-door/Needs-you regressions pass22tests, for113focused cases with0failures. Normal commit checks are recorded separately. Dependencies point to this session's frozen validated install in another isolated checkout; no package install or mutation runs in either while checks execute. Complete verification receives normal queue isolation.
