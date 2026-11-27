# ELI16: the message store only uses plain names as file names (SEC-127)

When another agent sends this agent a message, the message carries two labels: its own id and the id of the conversation it belongs to. The agent keeps every message and every conversation as a small file on disk, and it uses those ids as the file names.

Until now it took the ids exactly as they arrived. A file name is a kind of address, and some characters in an address mean "go up a folder" or "start from the top of the disk". So an id that contained those characters could point the agent at a file somewhere else on the machine, outside the folder where messages belong, and the agent would read or write that file as if it were a conversation.

Now the agent checks each id before using it as a file name. An id is used only when it is one plain name: no folder separators, not the special names for "this folder" or "the folder above", no hidden null character, and no longer than a disk allows for one file name (229 bytes: the 255-byte limit minus the longest ending the store adds). Every id the agents really use, such as the long random ids and the short "msg-" and "thr-" ids, passes this check unchanged, so normal conversations look and work exactly as before.

The same check now guards the agent's second record of each conversation, the running history it keeps for every agent-to-agent thread, so neither place can be pointed outside its folder.

When an id fails the check, the agent refuses to store that message or conversation and says so in its log, instead of writing a file in the wrong place. Looking up an unsafe id simply finds nothing. Nothing is deleted or moved outside the message folder.
