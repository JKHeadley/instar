// The wedge canary (docs/specs/machine-self-maintenance.md, Part E, family F1).
//
// A no-UI app that LaunchServices starts and that quits at once. The wedge
// monitor runs `open -g -j InstarWedgeCanary.app`: if LaunchServices cannot
// start even this, the machine's GUI path is not working. It reads nothing,
// writes nothing, draws nothing and needs no permission.
import Foundation

@main
struct InstarWedgeCanary {
    static func main() {
        exit(0)
    }
}
