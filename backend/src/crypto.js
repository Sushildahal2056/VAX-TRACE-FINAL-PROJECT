const crypto = require("crypto");

function loadKey() {
  const hex = process.env.OFFCHAIN_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  // ponytail: demo-only fallback key. Rotate via OFFCHAIN_KEY (32-byte hex) before any real PHI.
  return crypto.createHash("sha256").update("vaxtrace-local-demo-key").digest();
}

const KEY = loadKey();

function sha256Json(obj) {
  const canonical = Buffer.from(JSON.stringify(obj), "utf8");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function encryptJson(obj) {
  const plain = Buffer.from(JSON.stringify(obj), "utf8");
  const sha256 = crypto.createHash("sha256").update(plain).digest("hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    sha256,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptJson(record) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    KEY,
    Buffer.from(record.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(record.tag, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]);
  const sha256 = crypto.createHash("sha256").update(plain).digest("hex");
  if (record.sha256 && sha256 !== record.sha256) {
    throw new Error("off-chain hash mismatch");
  }
  return { data: JSON.parse(plain.toString("utf8")), sha256 };
}

function hashHexToBytes32(hex) {
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

module.exports = { sha256Json, encryptJson, decryptJson, hashHexToBytes32 };
