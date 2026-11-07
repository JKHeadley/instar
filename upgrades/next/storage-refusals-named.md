<!-- bump: patch -->

## What Changed

Storage refusals for app and Slack attachments, phone uploads and files copied between machines now name the machine they are about: "Mac Studio is nearly out of disk space, so the file wasn't stored.", "The file store on Mac Studio is full.", "Mac Studio has too many uploads in progress." They never say "this machine". Error codes and statuses are unchanged. The low-disk attention notice is titled with the machine's name instead of its internal id. With no registered name, the host's own name is used.

## What to Tell Your User

When one of your machines is too full to keep a file you sent, the message now says which machine, for example "Mac Studio is nearly out of disk space, so the file wasn't stored."

## Summary of New Capabilities

- Storage refusals and their notices name the machine

## Evidence

Unit tests cover:
- the named disk-floor and store-full refusals;
- the host-name fallback;
- the store-full notice title.

The store-cap test now injects its disk reading. It had failed on the Mac Studio (95% full, below the floor) because it read the real disk.
