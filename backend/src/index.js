const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { ethers } = require("ethers");
const { connectStore, records, logs, iot, applications, mongoUri } = require("./store");
const { encryptJson, decryptJson, hashHexToBytes32 } = require("./crypto");
const { loadDeployment, relayerContract, rolesOf, canReadPhi, getProvider } = require("./chain");

const PORT = Number(process.env.PORT || 4000);
const nonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_KINDS = new Set(["document", "beneficiary", "clinical", "adverse"]);
const ORG_KINDS = ["clinic", "warehouse", "logistics", "manufacturer", "regulator", "iot"];
const APPLICATION_STATUSES = ["approved", "deactivated", "rejected"];

function actorFrom(req) {
  const header = req.header("x-wallet-address");
  if (header && ethers.isAddress(header)) return ethers.getAddress(header);
  return null;
}

function parseSha256(raw) {
  const hex = String(raw || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    const err = new Error("sha256 must be 64 hex characters");
    err.status = 400;
    throw err;
  }
  return hex;
}

function parseBatchId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    const err = new Error("batchId must be a positive integer");
    err.status = 400;
    throw err;
  }
  return n;
}

function parseTempCenti(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -8000 || n > 8000) {
    const err = new Error("temperatureCenti must be hundredths of °C between -80 and 80");
    err.status = 400;
    throw err;
  }
  return Math.trunc(n);
}

function sweepNonces(now = Date.now()) {
  for (const [address, entry] of nonces) {
    if (now - entry.at > NONCE_TTL_MS) nonces.delete(address);
  }
}

async function requireWallet(req, res, next) {
  const address = actorFrom(req);
  if (!address) return res.status(401).json({ error: "Connect a wallet address (x-wallet-address)." });
  req.wallet = address;
  try {
    req.roles = await rolesOf(address);
    next();
  } catch (err) {
    if (req.method === "GET") {
      req.roles = {};
      return next();
    }
    return res.status(503).json({
      error: "Cannot read roles from the local chain. Keep `npm run demo` running.",
      detail: err.message,
    });
  }
}

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  const deployment = loadDeployment();
  let chain = false;
  try {
    await getProvider().getBlockNumber();
    chain = true;
  } catch {
    chain = false;
  }
  res.json({
    ok: true,
    service: "vaxtrace-offchain",
    contract: deployment ? deployment.address : null,
    chainId: deployment ? deployment.chainId : null,
    chain,
    mongoUri: mongoUri(),
  });
});

app.get("/api/deployment", (_req, res) => {
  const deployment = loadDeployment();
  if (!deployment) return res.status(404).json({ error: "not deployed" });
  res.json({
    address: deployment.address,
    chainId: deployment.chainId,
    accounts: deployment.accounts,
    abi: deployment.abi,
  });
});

app.post("/api/auth/nonce", (req, res) => {
  const address = req.body && req.body.address;
  if (!address || !ethers.isAddress(address)) {
    return res.status(400).json({ error: "valid address required" });
  }
  sweepNonces();
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  nonces.set(ethers.getAddress(address), { nonce, at: Date.now() });
  res.json({ nonce, message: `VaxTrace login\n${nonce}` });
});

app.post("/api/auth/verify", async (req, res) => {
  try {
    const { address, signature } = req.body || {};
    const checksum = ethers.getAddress(address);
    const entry = nonces.get(checksum);
    if (!entry || Date.now() - entry.at > NONCE_TTL_MS) {
      nonces.delete(checksum);
      return res.status(400).json({ error: "request a nonce first" });
    }
    const recovered = ethers.verifyMessage(`VaxTrace login\n${entry.nonce}`, signature);
    if (recovered.toLowerCase() !== checksum.toLowerCase()) {
      return res.status(401).json({ error: "signature mismatch" });
    }
    nonces.delete(checksum);
    const roles = await rolesOf(checksum);
    res.json({ address: checksum, roles });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get("/api/me", requireWallet, (req, res) => {
  res.json({ address: req.wallet, roles: req.roles });
});

app.post("/api/admin/unlock", (req, res) => {
  const expected = process.env.ADMIN_PASSPHRASE || "vaxtrace-admin";
  const passphrase = req.body && req.body.passphrase;
  if (String(passphrase || "").trim() !== expected) {
    return res.status(401).json({ error: "Invalid admin passphrase." });
  }
  const deployment = loadDeployment();
  res.json({ ok: true, adminAccount: (deployment && deployment.accounts && deployment.accounts.admin) || null });
});

app.post("/api/org-applications", async (req, res) => {
  try {
    const { address, name, kind, contact, licenceId } = req.body || {};
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ error: "valid address required" });
    }
    const trimmedName = String(name || "").trim();
    if (!trimmedName) return res.status(400).json({ error: "name required" });
    if (!ORG_KINDS.includes(kind)) {
      return res.status(400).json({ error: "kind must be clinic, warehouse, logistics, manufacturer, regulator, or iot" });
    }
    const checksum = ethers.getAddress(address);
    const saved = await applications().findOneAndUpdate(
      { address: checksum },
      {
        $set: {
          address: checksum,
          name: trimmedName,
          kind,
          contact: String(contact ?? "").trim().slice(0, 120),
          licenceId: String(licenceId ?? "").trim().slice(0, 120),
          status: "pending",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(saved);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get("/api/org-applications", async (_req, res) => {
  try {
    res.json({ applications: await applications().find().sort({ createdAt: -1 }).lean() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/org-applications/:address/status", requireWallet, async (req, res) => {
  try {
    if (!req.roles.admin) return res.status(403).json({ error: "admin role required" });
    const { status, kind } = req.body || {};
    if (!APPLICATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: "status must be approved, deactivated, or rejected" });
    }
    if (!ethers.isAddress(req.params.address)) {
      return res.status(400).json({ error: "valid address required" });
    }
    const update = { status };
    if (kind && ORG_KINDS.includes(kind)) update.kind = kind;
    const updated = await applications().updateOne({ address: ethers.getAddress(req.params.address) }, update);
    if (!updated.matchedCount) return res.status(404).json({ error: "application not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post("/api/offchain", requireWallet, async (req, res) => {
  try {
    const { kind, payload, batchId } = req.body || {};
    if (!kind || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "kind and payload required" });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ error: "kind must be document, beneficiary, clinical, or adverse" });
    }
    if (kind === "beneficiary" && !req.roles.clinic && !req.roles.regulator) {
      return res.status(403).json({ error: "only clinic or regulator can store beneficiary records" });
    }
    const sealed = encryptJson({
      kind,
      batchId: batchId || "",
      recordedBy: req.wallet,
      recordedAt: new Date().toISOString(),
      payload,
    });
    await records().create({
      kind,
      batchId: String(batchId || ""),
      createdBy: req.wallet,
      ...sealed,
    });
    res.status(201).json({
      sha256: sealed.sha256,
      bytes32: hashHexToBytes32(sealed.sha256),
      kind,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get("/api/offchain/:sha256", requireWallet, async (req, res) => {
  try {
    if (!canReadPhi(req.roles)) {
      return res.status(403).json({ error: "role cannot read off-chain PHI" });
    }
    const sha256 = parseSha256(req.params.sha256);
    const row = await records().findOne({ sha256 });
    if (!row) return res.status(404).json({ error: "record not found — this hash was never stored off-chain" });
    const opened = decryptJson(row);
    await logs().create({
      sha256,
      actor: req.wallet,
      action: "decrypt",
      reason: String(req.query.reason || "").slice(0, 200),
    });
    res.json({ sha256: opened.sha256, data: opened.data });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get("/api/offchain/:sha256/integrity", async (req, res) => {
  let sha256;
  try {
    sha256 = parseSha256(req.params.sha256);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const row = await records().findOne({ sha256 });
  if (!row) return res.json({ exists: false, sha256 });
  res.json({ exists: true, sha256, kind: row.kind, batchId: row.batchId });
});

app.post("/api/iot/reading", requireWallet, async (req, res) => {
  try {
    const batchId = parseBatchId(req.body && req.body.batchId);
    const temperatureCenti = parseTempCenti(req.body && req.body.temperatureCenti);
    const source = String((req.body && req.body.source) || "probe").slice(0, 80);
    if (!req.roles.iot && !req.roles.logistics && !req.roles.warehouse && !req.roles.regulator) {
      return res.status(403).json({ error: "role cannot submit IoT readings" });
    }
    let breached = false;
    try {
      const contract = await relayerContract();
      const batch = await contract.getBatch(batchId);
      breached = temperatureCenti < Number(batch.tempMinCenti) || temperatureCenti > Number(batch.tempMaxCenti);
    } catch {
      /* chain lookup optional; oracle write below is authoritative */
    }
    const sealed = encryptJson({
      batchId: String(batchId),
      temperatureCenti,
      source,
      recordedBy: req.wallet,
      recordedAt: new Date().toISOString(),
    });
    const row = await iot().create({
      batchId: String(batchId),
      temperatureCenti,
      sha256: sealed.sha256,
      source,
      breached,
    });
    let onChain = null;
    try {
      const contract = await relayerContract();
      const tx = await contract.recordTemperature(
        BigInt(batchId),
        temperatureCenti,
        hashHexToBytes32(sealed.sha256)
      );
      const receipt = await tx.wait();
      row.recordedOnChain = true;
      await row.save();
      onChain = { txHash: receipt.hash, gasUsed: receipt.gasUsed.toString(), breached };
    } catch (err) {
      onChain = { error: err.message };
      return res.status(502).json({
        sha256: sealed.sha256,
        bytes32: hashHexToBytes32(sealed.sha256),
        onChain,
        error: "Reading stored off-chain, but the on-chain oracle write failed.",
      });
    }
    res.status(201).json({
      sha256: sealed.sha256,
      bytes32: hashHexToBytes32(sealed.sha256),
      onChain,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get("/api/iot/:batchId", async (req, res) => {
  let batchId;
  try {
    batchId = parseBatchId(req.params.batchId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const rows = await iot().find({ batchId: String(batchId) }).sort({ createdAt: 1 }).lean();
  res.json({
    readings: rows.map((r) => ({
      temperatureCenti: r.temperatureCenti,
      sha256: r.sha256,
      source: r.source,
      recordedOnChain: r.recordedOnChain,
      at: r.createdAt,
    })),
  });
});

app.get("/api/interop/immunization/:sha256", requireWallet, async (req, res) => {
  try {
    if (!canReadPhi(req.roles)) return res.status(403).json({ error: "role cannot export immunization" });
    const sha256 = parseSha256(req.params.sha256);
    const row = await records().findOne({ sha256 });
    if (!row) return res.status(404).json({ error: "record not found" });
    const opened = decryptJson(row);
    const payload = opened.data.payload || {};
    res.json({
      resourceType: "Immunization",
      status: "completed",
      patient: payload.nhi
        ? {
            identifier: {
              system: "https://standards.digital.health.nz/ns/nhi-id",
              value: payload.nhi,
            },
            display: payload.name || undefined,
          }
        : undefined,
      vaccineCode: { text: payload.vaccineName || opened.data.kind },
      lotNumber: payload.lotNumber || "",
      occurrenceDateTime: opened.data.recordedAt,
      protocolApplied: [{ doseNumberPositiveInt: payload.doseNumber || 1 }],
      extension: [
        {
          url: "https://vaxtrace.local/off-chain-hash",
          valueString: hashHexToBytes32(sha256),
        },
      ],
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get("/api/audit/logs", requireWallet, async (req, res) => {
  try {
    if (!(req.roles.regulator || req.roles.admin)) {
      return res.status(403).json({ error: "only regulator or admin can view audit logs" });
    }
    res.json({
      counts: {
        records: await records().countDocuments(),
        iotReadings: await iot().countDocuments(),
        accessLogs: await logs().countDocuments(),
      },
      logs: await logs().find().sort({ createdAt: -1 }).limit(50).lean(),
      records: await records()
        .find({}, { ciphertext: 0, iv: 0, tag: 0 })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

connectStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`VaxTrace API on http://127.0.0.1:${PORT}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
