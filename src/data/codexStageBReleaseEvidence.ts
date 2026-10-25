/**
 * Echo-signed Stage-B release evidence. Generated only after the exact RC
 * passed the two-hour / fifty-delivery gate and independent review.
 */
export const SHIPPED_CODEX_STAGE_B_RELEASE_EVIDENCE: unknown = {
  "schemaVersion": 1,
  "echoPublicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVfPs10C+igEwHX1QKxkuGv57xUnfEmLygjW+9comCtg=\n-----END PUBLIC KEY-----\n",
  "artifact": {
    "schemaVersion": 1,
    "packageVersion": "1.3.1220",
    "gitCommit": "cfe468dc5ef3f31ac71c28aed6bdc28a26131f49",
    "configSha256": "018d8e91978755abfb021968781d805098d98f9f2c64d70b728d2c18b205d5e8",
    "echoMachineId": "m_03b30f5b32c6ef3eb0afd3ca7054e252",
    "startedAt": 1788576017942,
    "endedAt": 1788583231083,
    "deliveryCount": 50,
    "caseCounts": {
      "identical": 2,
      "multiline": 1,
      "active-turn": 2,
      "resize": 1,
      "outage": 1,
      "transfer": 1
    },
    "failures": {
      "falseUnknown": 0,
      "falseExhaustion": 0,
      "duplicateKeyOwnership": 0,
      "lostInbound": 0,
      "staleOwnerAction": 0
    },
    "rawEvidenceDigests": [
      "8f451873786a8e7c48e64535d72d78d2e97cdae0f4287abcae3bc8b646195bb9",
      "f2d07ef4046e49fed158732d90b5d0105f585ca2fa13732ac6d0e9a238b357c0",
      "b7dda84ce9e43178c2fb84bdcd2e5c3ed30cf277067e7f415cdebbd8588f864e",
      "37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570",
      "263e662820f478f2a160a8cf5eb96086dc1442ee5fd18329b32c1ea2248fb569",
      "f360834ee52fc22702d630d92ced062f2b8d9b83dd896ced22647de3234ae2ad",
      "1b94aa70b163015ab1d4a10f0d170790ad73aa1fd241cb6a828191052b3628a1",
      "9fcf5e1558ec0b700dabce0fcc93638683d9b211cb09cd15190bf984e9ef92c7"
    ],
    "reviewerDecision": "approved",
    "signature": "9CmBo9oVesfP8Kpi94L/paiK+9vNQskTVoY16450HwnsA3AYDjXpiv+Nwkf0vm4ltnEXdeoDhUMOS80npoWwDw=="
  }
};
