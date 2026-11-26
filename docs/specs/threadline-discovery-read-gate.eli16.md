# Threadline agent discovery no longer asks for approval

Agents use Threadline to see which other agents are available. The approved list and discovery tools read agent information. They do not send a message, add a pairing, or change anyone's trust settings. The operation gate previously recognized generic names such as list and get. Threadline's actual tool names did not match that rule. After the new trust settings took effect, the server treated a discovery request as an unknown change and asked the owner for permission.

The fix identifies the two registered Threadline discovery tools by exact name, both in the server and in the hook delivered to agent installations. Their normal Threadline access checks still apply. Similar-looking names, sending a message, pairing a peer, and changing trust stay subject to their current rules. Existing agents receive the hook correction through the regular update process. The change creates no new trust grant or approval for anyone.
