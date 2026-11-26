import Foundation
import CryptoKit
// Independent native implementation of the frozen v1 record description.
let aad = #"["instar-local-history-channel-v1","channel-1","machine-1","boot-1","device-1","request","POST","/mobile/imported-history/local/library","1"]"#.data(using: .utf8)!
let nonce = try AES.GCM.Nonce(data: Data([0,0,0,1,0,0,0,0,0,0,0,1]))
let key = SymmetricKey(data: Data(repeating: 1, count: 32))
let box = try AES.GCM.seal(Data("synthetic vector".utf8), using: key, nonce: nonce, authenticating: aad)
let wire = Data([0,0,0,0,0,0,0,1]) + box.ciphertext + box.tag
print(wire.map { String(format: "%02x", $0) }.joined())
