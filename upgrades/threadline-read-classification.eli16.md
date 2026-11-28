# Threadline lookups no longer ask for send approval

Looking up a known agent or reading a Threadline conversation is a read. The approval gate was treating these tools as changes because their names did not match its general lookup rules. The gate now recognizes the exact lookup tools. Threadline still checks who can see each result. Sending a message, deleting a thread, and updating the registry still use their existing approval rules.

The problem came from how the shared gate interpreted tool names. When it did not recognize a lookup name, it treated the call as a change and asked for an approval that the lookup never needed. An agent could get stuck before it even found the person or agent it needed to contact.

This repair lists the six existing lookup tools by their exact names on the Threadline service. A similarly named tool on another service gets the usual checks. Network discovery and registry search still send the search terms to the service that runs the lookup. The lookup does not send a Threadline message to another agent.

The startup test checks both sides after a restart. Discovery and listing reach the read path, while sending and deleting still reach the approval path. The separate verified-peer send repair is outside this change.
