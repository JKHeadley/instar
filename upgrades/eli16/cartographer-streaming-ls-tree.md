# Streaming cartographer tree reads — ELI16

The cartographer compares its index with Git's view of every file and directory. Previously Git had to finish producing that entire list before Instar could begin reading it, and the complete output lived in one large memory buffer. A sufficiently large repository could exceed that buffer and make the sweep refuse.

Instar now reads each piece as Git produces it. Complete NUL-separated records are parsed immediately; only a record split between chunks is carried forward. The resulting path-to-object map has the same records and ordering as before, so candidate selection and authoring behavior do not change.

The detector trusts the map only after Git exits successfully. A spawn error, non-zero exit, signal, or incomplete final record rejects the whole partial result through the existing `detect-git-error` refusal path. The work still runs in the established detect worker by default. The old `gitMaxBuffer` setting remains accepted for compatibility but no longer controls this stream.
