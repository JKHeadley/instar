# Why the repository inventory no longer checks uncommitted edits

The repository inventory helps a development agent find projects whose committed work might exist on only one machine. It looks for Git repositories, checks where they have remotes, and compares local branches with the remote-tracking information already on disk. When a machine stops responding, other machines can still use the committed-work summary it last shared.

Checking uncommitted edits needs a different kind of Git operation. Git can ask a program configured for that repository to process a working file while checking whether the file changed. An automatic inventory can discover repositories the agent has never reviewed. Finding one should never give it permission to run its programs.

The inventory now skips that check and accepts only the Git queries it needs for discovery and committed history. It still finds repositories, including those nested under ignored directories, and still reports committed work that may need a backup. The local result marks uncommitted data incomplete. A saved pool summary also carries a completeness field, and older summaries without that field are shown as incomplete. A zero in an incomplete result gives no assurance that the working files are clean.

This change adds no setting, new permissions, or migration. It applies the next time an updated agent runs its existing inventory checks. A developer can still inspect edits directly in a repository they trust.
