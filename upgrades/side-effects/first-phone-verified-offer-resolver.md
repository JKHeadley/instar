# First-phone verified offer resolver

The dormant resolver reads an acknowledged offer by callback hash. It requires the independently verified, unexpired local holder and recomputes the exact proposal digest from independently resolved owner, approval account, device, keys, disclosure, slot and offer expiry. A changed holder, owner, device, address, disclosure or slot refuses the offer.

The production evidence readers and the durable offer store still need composition. The resolver grants no device authority and does not replace the final commit-time checks.

Independent review concurred on the dormant resolver. The saved offer also pins the issuing holder machine, so a reused epoch on another holder cannot match.
