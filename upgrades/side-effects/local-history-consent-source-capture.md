# Side effects of checking source capture for owner consent

The dormant consent helper compares a server-resolved capture with the exact operation, owner and ordered raw file hashes associated with the sealed import preview. It uses the verified source machine and the prepared file hashes in the approval material. This keeps the source bytes distinct from the normalized bytes shown in the preview.

The check reads existing private staging records. It adds no persistent data, route, external request, permission, or log. A missing capture or mismatch fails before the helper can return approval material. The resolver must independently establish current source ownership and machine identity. The code does not wire a production resolver or change the hold on real history.

Reverting the change removes the dormant check and requires no data migration. The synthetic staging fixture covers matching captures, missing captures, an operation or owner mismatch, file order changes and substitution of a normalized digest for a raw capture digest.

Independent review concurred with the raw-to-prepared binding and the boundary on production authority.
