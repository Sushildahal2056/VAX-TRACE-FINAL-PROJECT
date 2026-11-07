const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE_YEAR = 365 * 24 * 60 * 60;

async function deploy() {
  const [admin, manufacturer, logistics, warehouse, clinic, regulator, iot, stranger] =
    await ethers.getSigners();
  const factory = await ethers.getContractFactory("VaccineSupplyChain");
  const c = await factory.deploy(admin.address);
  await c.waitForDeployment();
  await c.grantRole(await c.MANUFACTURER_ROLE(), manufacturer.address);
  await c.grantRole(await c.LOGISTICS_ROLE(), logistics.address);
  await c.grantRole(await c.WAREHOUSE_ROLE(), warehouse.address);
  await c.grantRole(await c.CLINIC_ROLE(), clinic.address);
  await c.grantRole(await c.REGULATOR_ROLE(), regulator.address);
  await c.grantRole(await c.IOT_ORACLE_ROLE(), iot.address);
  await c.setOrganisation(manufacturer.address, "Manufacturer", "manufacturer");
  await c.setOrganisation(logistics.address, "Logistics", "logistics");
  await c.setOrganisation(warehouse.address, "Warehouse", "warehouse");
  await c.setOrganisation(clinic.address, "Clinic", "clinic");
  await c.setOrganisation(regulator.address, "Regulator", "regulator");
  await c.setOrganisation(iot.address, "IoT Oracle", "iot");
  await c.setOrganisation(admin.address, "Admin", "admin");
  return { c, admin, manufacturer, logistics, warehouse, clinic, regulator, iot, stranger };
}

function expiry() {
  return Math.floor(Date.now() / 1000) + ONE_YEAR;
}

async function register(c, manufacturer, lot = "LOT-1") {
  const doc = ethers.id("coa");
  const tx = await c
    .connect(manufacturer)
    .registerBatch("Comirnaty", lot, expiry(), 200, 800, 10, doc);
  const receipt = await tx.wait();
  const ev = receipt.logs.find((l) => l.fragment && l.fragment.name === "BatchRegistered");
  return { batchId: ev.args.batchId, digitalId: ev.args.digitalId };
}

describe("VaccineSupplyChain", () => {
  it("assigns a unique digital identity and rejects unauthorised batch insertion", async () => {
    const { c, manufacturer, stranger } = await deploy();
    const { batchId, digitalId } = await register(c, manufacturer);
    const batch = await c.getBatch(batchId);
    expect(batch.exists).to.equal(true);
    expect(batch.digitalId).to.equal(digitalId);
    expect(await c.digitalIdToBatch(digitalId)).to.equal(batchId);

    await expect(
      c.connect(stranger).registerBatch("FakeVax", "COUNTERFEIT", expiry(), 200, 800, 5, ethers.id("x"))
    ).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
  });

  it("walks a batch through packaging, custody, delivery and hashed administration", async () => {
    const { c, manufacturer, logistics, warehouse, clinic } = await deploy();
    const { batchId } = await register(c, manufacturer);
    await c.connect(manufacturer).recordPackaging(batchId, ethers.id("pack"));

    const soon = Math.floor(Date.now() / 1000) + 86400;
    await c.connect(manufacturer).initiateTransfer(batchId, logistics.address, soon);
    await c.connect(logistics).acceptCustody(batchId);
    await c.connect(logistics).recordTransport(batchId, 400, ethers.id("t1"), "truck-1");

    await c.connect(logistics).initiateTransfer(batchId, warehouse.address, soon);
    await c.connect(warehouse).acceptCustody(batchId);
    await c.connect(warehouse).recordStorage(batchId, 450, ethers.id("s1"), "bay-A");

    await c.connect(warehouse).initiateTransfer(batchId, clinic.address, soon);
    await c.connect(clinic).acceptCustody(batchId);

    const beneficiaryHash = ethers.sha256(ethers.toUtf8Bytes(JSON.stringify({ nhi: "ABC1234" })));
    const clinicalHash = ethers.sha256(ethers.toUtf8Bytes(JSON.stringify({ site: "left arm" })));
    await c.connect(clinic).administerDose(batchId, beneficiaryHash, clinicalHash);

    const batch = await c.getBatch(batchId);
    expect(batch.remainingVials).to.equal(9n);
    expect(batch.status).to.equal(5n); // Delivered until last vial
    const history = await c.getHistory(batchId);
    expect(history.length).to.be.greaterThan(6);
    const hashes = history.map((e) => e.offChainHash);
    expect(hashes).to.include(beneficiaryHash);
    expect(batch.lotNumber).to.not.equal("ABC1234");
    expect(history.some((e) => e.note.includes("ABC1234"))).to.equal(false);
  });

  it("flags an out-of-range temperature and blocks administration until a regulator override", async () => {
    const { c, manufacturer, logistics, warehouse, clinic, regulator, iot } = await deploy();
    const { batchId } = await register(c, manufacturer);
    await c.connect(manufacturer).recordPackaging(batchId, ethers.ZeroHash);
    const soon = Math.floor(Date.now() / 1000) + 86400;
    await c.connect(manufacturer).initiateTransfer(batchId, logistics.address, soon);
    await c.connect(logistics).acceptCustody(batchId);
    await c.connect(iot).recordTemperature(batchId, 2500, ethers.id("hot"));

    const batch = await c.getBatch(batchId);
    expect(batch.coldChainBreached).to.equal(true);

    await c.connect(logistics).initiateTransfer(batchId, warehouse.address, soon);
    await c.connect(warehouse).acceptCustody(batchId);
    await c.connect(warehouse).initiateTransfer(batchId, clinic.address, soon);
    await c.connect(clinic).acceptCustody(batchId);

    await expect(
      c.connect(clinic).administerDose(batchId, ethers.id("b"), ethers.id("c"))
    ).to.be.revertedWithCustomError(c, "ColdChainBreach");

    await c.connect(regulator).authoriseException(batchId);
    await c.connect(clinic).administerDose(batchId, ethers.id("b"), ethers.id("c"));
    expect((await c.getBatch(batchId)).remainingVials).to.equal(9n);
  });

  it("lets a regulator recall a batch and blocks further custody movement", async () => {
    const { c, manufacturer, logistics, regulator } = await deploy();
    const { batchId } = await register(c, manufacturer);
    await c.connect(manufacturer).recordPackaging(batchId, ethers.ZeroHash);
    await c.connect(regulator).recallBatch(batchId, "contaminated lot");
    await expect(
      c
        .connect(manufacturer)
        .initiateTransfer(batchId, logistics.address, Math.floor(Date.now() / 1000) + 1000)
    ).to.be.revertedWithCustomError(c, "BatchIsRecalled");
    const check = await c.verifyAuthenticity(batchId);
    expect(check.genuine).to.equal(true);
    expect(check.recalled).to.equal(true);
  });

  it("rejects a custody accept from the wrong stakeholder", async () => {
    const { c, manufacturer, logistics, clinic } = await deploy();
    const { batchId } = await register(c, manufacturer);
    await c.connect(manufacturer).recordPackaging(batchId, ethers.ZeroHash);
    await c
      .connect(manufacturer)
      .initiateTransfer(batchId, logistics.address, Math.floor(Date.now() / 1000) + 1000);
    await expect(c.connect(clinic).acceptCustody(batchId)).to.be.revertedWithCustomError(
      c,
      "NoPendingTransfer"
    );
  });

  it("rejects a duplicate manufacturer lot number", async () => {
    const { c, manufacturer } = await deploy();
    await register(c, manufacturer, "LOT-DUP");
    await expect(register(c, manufacturer, "LOT-DUP")).to.be.revertedWithCustomError(
      c,
      "DuplicateLot"
    );
  });

  it("allows admin to onboard a new organisation on-chain and transfer custody to it", async () => {
    const { c, admin, manufacturer, stranger } = await deploy();
    expect((await c.rolesOf(admin.address)).admin).to.equal(true);

    await c
      .connect(admin)
      .registerOrganisation(stranger.address, "South Island Clinic", "clinic", await c.CLINIC_ROLE());

    const orgs = await c.getOrganisations();
    const idx = orgs.accounts.findIndex((a) => a === stranger.address);
    expect(idx).to.be.greaterThanOrEqual(0);
    expect(orgs.details[idx].name).to.equal("South Island Clinic");
    expect(orgs.details[idx].kind).to.equal("clinic");
    expect((await c.rolesOf(stranger.address)).clinic).to.equal(true);

    const { batchId } = await register(c, manufacturer);
    await c.connect(manufacturer).recordPackaging(batchId, ethers.id("pack"));
    const soon = Math.floor(Date.now() / 1000) + 86400;
    await c.connect(manufacturer).initiateTransfer(batchId, stranger.address, soon);
    await c.connect(stranger).acceptCustody(batchId);

    const beneficiaryHash = ethers.sha256(ethers.toUtf8Bytes(JSON.stringify({ nhi: "SI0001" })));
    const clinicalHash = ethers.sha256(ethers.toUtf8Bytes(JSON.stringify({ site: "left arm" })));
    await c.connect(stranger).administerDose(batchId, beneficiaryHash, clinicalHash);

    const batch = await c.getBatch(batchId);
    expect(batch.currentCustodian).to.equal(stranger.address);
    expect(batch.remainingVials).to.equal(9n);

    await c
      .connect(admin)
      .registerOrganisation(stranger.address, "South Island Clinic", "warehouse", await c.WAREHOUSE_ROLE());
    expect((await c.rolesOf(stranger.address)).clinic).to.equal(false);
    expect((await c.rolesOf(stranger.address)).warehouse).to.equal(true);

    await c
      .connect(admin)
      .registerOrganisation(stranger.address, "South Island Clinic", "clinic", await c.CLINIC_ROLE());

    await c.connect(admin).deactivateOrganisation(stranger.address);
    expect((await c.organisations(stranger.address)).registered).to.equal(false);
    expect((await c.rolesOf(stranger.address)).clinic).to.equal(false);

    const next = await register(c, manufacturer, "LOT-DEACT");
    await c.connect(manufacturer).recordPackaging(next.batchId, ethers.id("pack2"));
    await expect(
      c.connect(manufacturer).initiateTransfer(next.batchId, stranger.address, soon)
    ).to.be.revertedWithCustomError(c, "InvalidRecipient");
  });
});
