# Older Conversations Refresh With The Rest Of The List

If you opened older conversations, the dashboard used to refresh the first page while keeping its earlier copy of the older pages. An agent work card could stay in that copy after you answered its last question and it returned to the agent's internal list.

The dashboard now asks for the portion of the list you opened, up to 200 rows. When the server can check the whole request, it updates the rows and the Show more button together. If a registered computer cannot answer, or if a source could only be checked in part, the dashboard keeps the last list and offers a retry. Another open tab refreshes at the depth you opened in that tab.

The dashboard only reads the list during this refresh. An open conversation and its composer have their own state, and answering a question still leaves its history stored. The change uses the server's existing visibility rules. It can only reflect the information those rules have when computers disagree about a work card.
