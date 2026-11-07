const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const API = "http://127.0.0.1:4000";

async function postJson(url, address, body) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-address": address,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function saveOffchain(address, body) {
  const res = await postJson(`${API}/api/offchain`, address, body);
  if (!res) return { bytes32: hre.ethers.id(JSON.stringify(body)) };
  if (!res.ok) throw new Error(`off-chain API ${res.status}: ${await res.text()}`);
  const saved = await res.json();
  if (!saved.bytes32) throw new Error("off-chain API did not return bytes32");
  return saved;
}

async function main() {
  const file = path.join(__dirname, "..", "..", "deployment.json");
  if (!fs.existsSync(file)) throw new Error("Deploy the contract before seeding");
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const [admin, manufacturer, logistics, warehouse, clinic, regulator, iot] =
    await hre.ethers.getSigners();
  const c = await hre.ethers.getContractAt("VaccineSupplyChain", deployment.address);

  if ((await c.totalBatches()) > 0n) {
    console.log("Seed skipped — batches already exist");
    return;
  }

  async function saveIot(address, batchId, temperatureCenti, source) {
    const body = { batchId: Number(batchId), temperatureCenti, source };
    const res = await postJson(`${API}/api/iot/reading`, address, body);
    if (!res) {
      const readingHash = hre.ethers.id(JSON.stringify(body));
      await (await c.connect(iot).recordTemperature(batchId, temperatureCenti, readingHash)).wait();
      return { bytes32: readingHash };
    }
    if (!res.ok) throw new Error(`IoT API ${res.status}: ${await res.text()}`);
    const saved = await res.json();
    if (!saved.bytes32) throw new Error("IoT API did not return bytes32");
    return saved;
  }

  const expiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const soon = Math.floor(Date.now() / 1000) + 48 * 3600;
  const zero = hre.ethers.ZeroHash;

  async function register(name, lot, vials, notes) {
    const doc = await saveOffchain(manufacturer.address, {
      kind: "document",
      batchId: "",
      payload: { notes, lotNumber: lot },
    });
    const tx = await c
      .connect(manufacturer)
      .registerBatch(name, lot, expiry, 200, 800, vials, doc.bytes32);
    const receipt = await tx.wait();
    const ev = receipt.logs.find((l) => l.fragment && l.fragment.name === "BatchRegistered");
    const id = ev.args.batchId;
    await (await c.connect(manufacturer).recordPackaging(id, zero)).wait();
    return id;
  }

  const id1 = await register(
    "Comirnaty 30mcg",
    "SB-DEMO-01",
    12,
    "Certificate of analysis: appearance, identity, potency and sterility within specification. Released for chilled distribution."
  );
  await (await c.connect(manufacturer).initiateTransfer(id1, logistics.address, soon)).wait();
  await (await c.connect(logistics).acceptCustody(id1)).wait();
  await (
    await c.connect(logistics).recordTransport(id1, 420, zero, "Auckland–Porirua chilled linehaul")
  ).wait();
  await saveIot(iot.address, id1, 390, "reefer-probe-01");
  await (await c.connect(logistics).initiateTransfer(id1, warehouse.address, soon)).wait();
  await (await c.connect(warehouse).acceptCustody(id1)).wait();
  await (
    await c.connect(warehouse).recordStorage(id1, 450, zero, "Porirua National Store Bay A")
  ).wait();
  await (await c.connect(warehouse).initiateTransfer(id1, clinic.address, soon)).wait();
  await (await c.connect(clinic).acceptCustody(id1)).wait();
  const beneficiary = await saveOffchain(clinic.address, {
    kind: "beneficiary",
    batchId: Number(id1),
    payload: {
      nhi: "NHI4821",
      name: "Aroha Bennett",
      dob: "1984-03-12",
      vaccineName: "Comirnaty 30mcg",
      lotNumber: "SB-DEMO-01",
    },
  });
  const clinical = await saveOffchain(clinic.address, {
    kind: "clinical",
    batchId: Number(id1),
    payload: { site: "Left deltoid", vaccineName: "Comirnaty 30mcg", lotNumber: "SB-DEMO-01" },
  });
  await (
    await c.connect(clinic).administerDose(id1, beneficiary.bytes32, clinical.bytes32)
  ).wait();

  const id2 = await register(
    "Spikevax Bivalent",
    "SB-EXCURSION-02",
    10,
    "Certificate of analysis: potency, sterility and identity within specification. Labelled for 2–8 °C storage."
  );
  await (await c.connect(manufacturer).initiateTransfer(id2, logistics.address, soon)).wait();
  await (await c.connect(logistics).acceptCustody(id2)).wait();
  await (await c.connect(logistics).initiateTransfer(id2, warehouse.address, soon)).wait();
  await (await c.connect(warehouse).acceptCustody(id2)).wait();
  await saveIot(iot.address, id2, 1240, "depot-sensor-B2");
  if (!(await c.getBatch(id2)).coldChainBreached) {
    throw new Error("batch 2 cold-chain breach was not recorded on-chain");
  }

  const id3 = await register(
    "Nuvaxovid",
    "SB-TRANSIT-03",
    15,
    "Certificate of analysis: identity and potency confirmed. Released to the chilled distribution lane."
  );
  await (await c.connect(manufacturer).initiateTransfer(id3, logistics.address, soon)).wait();

  console.log(`Seeded batch #${id1} Comirnaty 30mcg / SB-DEMO-01 through clinic administration`);
  console.log(`Seeded batch #${id2} Spikevax Bivalent / SB-EXCURSION-02 with a 12.4 °C cold-chain breach`);
  console.log(`Seeded batch #${id3} Nuvaxovid / SB-TRANSIT-03 pending acceptance by logistics`);
  void admin;
  void regulator;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
