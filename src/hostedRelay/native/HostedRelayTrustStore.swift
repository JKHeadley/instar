import Foundation
import LocalAuthentication
import Security

/// Persistence for relay trust evidence. The caller supplies the authenticated
/// pairing or transition verifier. Storage alone does not authorize a connection.
struct HostedRelayTrustStore {
    struct Record: Equatable {
        let revision: UUID
        let evidence: Data
    }

    enum Refusal: Error {
        case missing, conflict, malformed, unreadable
        case keychain(OSStatus)
    }

    protocol Storage {
        func read(_ account: UUID) throws -> Record?
        func write(_ record: Record, for account: UUID, replacing revision: UUID?) throws
    }

    let storage: any Storage

    func pair(_ account: UUID, verifyPairing: () throws -> Data) throws -> Data {
        guard try storage.read(account) == nil else { throw Refusal.conflict }
        return try persist(verifyPairing(), for: account, previous: nil)
    }

    func reconnect(_ account: UUID, verifyTransition: (Data) throws -> Data) throws -> Data {
        guard let previous = try storage.read(account) else { throw Refusal.missing }
        try validate(previous.evidence)
        let evidence = try verifyTransition(previous.evidence)
        return try persist(evidence, for: account, previous: previous)
    }

    private func persist(_ evidence: Data, for account: UUID, previous: Record?) throws -> Data {
        try validate(evidence)
        let record: Record
        if let previous, previous.evidence == evidence {
            record = previous
        } else {
            record = Record(revision: UUID(), evidence: evidence)
            try storage.write(record, for: account, replacing: previous?.revision)
        }
        guard try storage.read(account) == record else { throw Refusal.conflict }
        return evidence
    }

    private func validate(_ evidence: Data) throws {
        guard !evidence.isEmpty, evidence.count <= 384 * 1024 else { throw Refusal.malformed }
    }

    /// The service is dedicated to relay evidence. The application provides
    /// its signed private Keychain access group.
    struct KeychainStorage: Storage {
        let accessGroup: String
        private let service = "io.sagemindai.instar.hosted-relay-trust.v1"

        func read(_ account: UUID) throws -> Record? {
            var query = base(account)
            query[kSecReturnData as String] = true
            query[kSecReturnAttributes as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess else { throw Refusal.keychain(status) }
            guard let item = result as? [String: Any],
                  let data = item[kSecValueData as String] as? Data,
                  let revision = item[kSecAttrGeneric as String] as? Data,
                  let id = UUID(uuidString: String(decoding: revision, as: UTF8.self)) else {
                throw Refusal.unreadable
            }
            return Record(revision: id, evidence: data)
        }

        func write(_ record: Record, for account: UUID, replacing revision: UUID?) throws {
            var query = base(account)
            let values: [String: Any] = [
                kSecValueData as String: record.evidence,
                kSecAttrGeneric as String: Data(record.revision.uuidString.utf8)
            ]
            let status: OSStatus
            if let revision {
                query[kSecAttrGeneric as String] = Data(revision.uuidString.utf8)
                status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
            } else {
                query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                status = SecItemAdd(query.merging(values) { _, value in value } as CFDictionary, nil)
            }
            if status == errSecDuplicateItem || status == errSecItemNotFound { throw Refusal.conflict }
            guard status == errSecSuccess else { throw Refusal.keychain(status) }
        }

        private func base(_ account: UUID) -> [String: Any] {
            let context = LAContext()
            context.interactionNotAllowed = true
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account.uuidString,
                kSecAttrSynchronizable as String: false,
                kSecAttrAccessGroup as String: accessGroup,
                kSecUseAuthenticationContext as String: context
            ]
            #if os(macOS)
            query[kSecUseDataProtectionKeychain as String] = true
            #endif
            return query
        }
    }
}
