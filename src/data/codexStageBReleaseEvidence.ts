/**
 * Echo-signed Stage-B release evidence. Generated only after the exact RC
 * passed the two-hour / fifty-delivery gate and independent review.
 */
export const SHIPPED_CODEX_STAGE_B_RELEASE_EVIDENCE: unknown = {
  "schemaVersion": 1,
  "echoPublicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVfPs10C+igEwHX1QKxkuGv57xUnfEmLygjW+9comCtg=\n-----END PUBLIC KEY-----\n",
  "artifact": {
    "schemaVersion": 1,
    "configSha256": "018d8e91978755abfb021968781d805098d98f9f2c64d70b728d2c18b205d5e8",
    "echoMachineId": "m_03b30f5b32c6ef3eb0afd3ca7054e252",
    "startedAt": 1788251493809,
    "endedAt": 1788259530838,
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
      "ded4deaeb0c09f3911de5aa7086f4114d4e22b356605ff2669e655cde2e72891",
      "cc3484e4f834bd1e496123602322aea8950d44e2172878bac550b0a24e3726c2",
      "f11d401fcba94261f468b9c96a711b9955d59fd0d8b8c97494d8dd5bef96081a",
      "7ed4a2576c2547d930b8efb83ea55f732c466d9e7c330c98a502edc5bb5e960a",
      "d35c349bd787b7df74b467f1dd959ffd7cffa0075f1d38632d9dec23d2c3f4c4",
      "74b92e819f106582fe6c3c96fe118a2d890d2ff7c625cd4404b9e68732322349",
      "7dac92dbcd6b7f628f3f7ce22020283754c3fb527e39c3d600cb61f12474c491"
    ],
    "reviewerDecision": "approved",
    "packageVersion": "1.3.1219",
    "gitCommit": "package:1.3.1219",
    "signature": "Ga8TIYdLoFz3FYKM56NTCjgPlQtSMYJ8lrkKqn0nlrhzsf9zLiZ9DzEkLBMPrVuqWOUbhqnUmU0CuNt2CVFlAw=="
  }
};
