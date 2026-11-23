import Foundation
import CryptoKit
// Synthetic fixed keys only; never use these fixtures for a live channel.
let client = try P256.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 1, count: 32))
let server = try P256.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 2, count: 32))
let salt = Data(repeating: 3, count: 32)
let values: [Any] = ["instar-local-history-channel-v1", 1, "agent/one", "machine-1", "boot-1", "device\\one", "key\"one", Data(repeating: 4, count: 32).base64EncodedString(), client.publicKey.x963Representation.base64EncodedString(), server.publicKey.x963Representation.base64EncodedString(), salt.base64EncodedString(), "channel-vector", 61000]
let transcript = try JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes])
let secret = try client.sharedSecretFromKeyAgreement(with: server.publicKey)
func key(_ direction: String) -> String {
    let info = Data(("instar-local-history-channel-v1:" + direction + ":").utf8) + transcript
    let derived = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: 32)
    return derived.withUnsafeBytes { Data($0).map { String(format: "%02x", $0) }.joined() }
}
let output = ["transcript": String(data: transcript, encoding: .utf8)!, "request": key("request"), "response": key("response"), "clientPublicKey": client.publicKey.x963Representation.base64EncodedString(), "serverPublicKey": server.publicKey.x963Representation.base64EncodedString()]
let json = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys, .withoutEscapingSlashes])
print(String(data: json, encoding: .utf8)!)
