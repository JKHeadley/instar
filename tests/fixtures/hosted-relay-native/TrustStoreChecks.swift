import Foundation

@main
enum TrustStoreChecks {
    typealias Store = HostedRelayTrustStore

    final class Memory: Store.Storage {
        var records: [UUID: Store.Record] = [:]
        var suppressWrite = false

        func read(_ account: UUID) throws -> Store.Record? { records[account] }

        func write(_ record: Store.Record, for account: UUID, replacing revision: UUID?) throws {
            guard records[account]?.revision == revision else { throw Store.Refusal.conflict }
            if !suppressWrite { records[account] = record }
        }
    }

    static func main() throws {
        let disk = Memory()
        let store = Store(storage: disk)
        let account = UUID()
        let original = Data("original".utf8)
        let rotated = Data("rotated".utf8)
        let stale = Data("stale".utf8)

        do {
            _ = try store.reconnect(account) { _ in fatalError("Missing state reached the verifier") }
            fatalError("Missing state was accepted")
        } catch Store.Refusal.missing {}

        let paired = try store.pair(account) { original }
        precondition(paired == original)
        do {
            _ = try store.pair(account) { fatalError("Existing trust reached the pairing verifier") }
            fatalError("Existing trust was overwritten")
        } catch Store.Refusal.conflict {}

        let reopened = Store(storage: disk)
        do {
            _ = try store.reconnect(account) { prior in
                precondition(prior == original)
                let accepted = try reopened.reconnect(account) { _ in rotated }
                precondition(accepted == rotated)
                return stale
            }
            fatalError("Stale verifier overwrote the later revision")
        } catch Store.Refusal.conflict {}

        disk.suppressWrite = true
        do {
            _ = try reopened.reconnect(account) { prior in
                precondition(prior == rotated)
                return stale
            }
            fatalError("Readback accepted a suppressed write")
        } catch Store.Refusal.conflict {}
    }
}
