# Local history writer child registration

The fixed worker used to check a prepared copy now binds its actual child process to a private temporary namespace before receiving the prepared files. The namespace is settled after that child has closed. Ordinary previews still use their existing shared process custody.
