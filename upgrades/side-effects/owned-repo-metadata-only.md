# Side-effects review for repository inventory metadata reads

## Summary and decision points

Restrict the existing unattended Git reader to the fixed inventory queries and the branch-history query with remote selectors. Reject other forms before starting Git. The existing feature gate still controls whether the inventory runs.

## Over-block and under-block

The allowed forms cover common-directory resolution, remote metadata, nested repository discovery and committed history. Uncommitted work is unmeasured, including on a dirty worktree. Log calls suppress signature checks, external diffs and text conversion. Inventory calls disable pagers, filesystem monitoring and Git transports.

## Level of abstraction and signal versus authority

The restriction lives in the inventory reader, before the shared Git executor. Repository presence is inventory data. It grants no permission to run repository-configured programs. The completeness field distinguishes an unmeasured check from a positive observation.

## Interactions and operator surfaces

Existing committed-work defect rules still receive their original inputs. No scan or write path is added. The local response preserves its existing completeness flag. Replicas can carry the optional completeness field, and the pool view treats an absent flag as incomplete. Exact working-file data is never added to replication.

## 6b. Operator-surface quality

The page still leads with work that needs a copy. The repository row says in plain language when uncommitted changes were not fully checked. It exposes no internal status codes or raw Git output and adds no destructive action. The short label fits in the existing row that wraps at phone width.

## Multi-machine posture and rollback

Both old and new replica records can be read. The fix takes effect on each machine when it updates. There is no data migration. Reverting the implementation would restore the old unattended inspection, including its unsafe execution boundary.
