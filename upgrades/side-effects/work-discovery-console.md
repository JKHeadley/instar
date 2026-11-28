# Side-effects review for the private Work search form

**Scope.** This is the visible Work page increment of A1. It uses the existing private-console session and read-only endpoint. The credential prefix is a visibility hint. The server owns every authorization decision.

**Evidence and privacy.** The request contains only the typed query in JSON. The page keeps it in memory for the current visit. Results use text nodes for provider text and derive links from allowlisted repository or native message identity. Unknown reply shapes and server diagnostic detail do not appear in the page. A revoked or changed console session cannot publish a pending result. Ending the Work visit aborts the request and clears its displayed private results.

**Compatibility.** Existing Jobs, Projects, Work Board and conversation routes keep their own behavior. The endpoint controls feature availability. On older or disabled servers the private Work page reports a scoped failure without substituting a broader search. Removing this panel restores the prior Work page without a data migration.

**Evidence.** Focused DOM checks cover session visibility hints, link validation, escaped provider text, failure and navigation. The production owner-path test uses the static dashboard asset, actual unlock and product POST route, then checks the source links in the rendered Work view.

## 6b. Operator-surface quality

The form leads with the search field and Search button. Result rows name a conversation or pull request, with readable snippets and evidence links. Coverage stays in an expandable section. No raw request, internal identity, or debugging state is primary content. The panel only reads work and contains no destructive action. It uses the console's existing narrow-screen input and stacked list patterns with plain labels and accessible status updates. The focused DOM and actual served-form tests cover the interaction. The release canary still needs the ordinary owner-facing channel.

## Natural-language pull-request lookup

Work also checks all meaningful terms when a page has room after literal matches. Each result identifies the method that found it. The lookup reads the existing bounded public inventory in memory and sends no user terms to GitHub. The existing Chief of Staff lookup stays literal. The ordinary five-second Work deadline can return unavailable while an inventory refresh finishes. A retry can use the completed scan.

A fixture with a newer verbatim match and an older all-term match retained both in that order. An isolated Work HTTP canary with the real public GitHub provider returned the permanent agent-links PR for the original question. A first cold scan took about nine seconds with a longer test budget. An ordinary-budget rehearsal returned unavailable on the cold request and found the PR on retry. These checks used local fixture admission. An actual owner-channel answer and assignment remain release evidence.
