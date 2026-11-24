# Settings Tap Targets Side Effects

## Summary

Tier 1 presentation repair with three scoped selectors in the existing dashboard stylesheet. One independent source review checked selector ownership, specificity and the narrow breakpoint.

## Over-block and Under-block

The CSS increases target height on Files and Inside when the viewport is at most 599 CSS pixels wide. Existing links, buttons and handlers keep their roles. The measurements cover the three selected controls in the tested states.

## Level Of Abstraction

The existing dashboard stylesheet owns these sizes. The Files help anchor centers its existing text vertically. The other two controls gain a minimum height.

## Signal Versus Authority

Measurements provide review evidence. The patch changes presentation and leaves every request and permission decision with its existing owner.

## Interactions and External Surfaces

The narrow layout reserves a few more pixels around the controls. At 1280 pixels, the measured controls retain the exact baseline geometry and centerline hit offsets. These static assets use the normal dashboard release path on each machine.

## Rollback

Revert the stylesheet change and publish through the normal release process. The patch writes no persistent state.

## Evidence

Sixteen headless browser cases used the exact candidate CSS with saved dashboard assets and synthetic data. All three controls reached a 44-pixel vertical centerline hit target at 390 pixels in both themes, including populated Files and Inside where applicable. The three browser processes exited cleanly with zero page errors or application writes. These receipts cover the browser fixtures.
