const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const ORGS = [
  { index: 1, role: "MANUFACTURER_ROLE", name: "Southern Biologics Ltd", kind: "manufacturer" },
  { index: 2, role: "LOGISTICS_ROLE", name: "ColdLink Freight", kind: "logistics" },
  { index: 3, role: "WAREHOUSE_ROLE", name: "National Vaccine Store, Porirua", kind: "warehouse" },
  { index: 4, role: "CLINIC_ROLE", name: "Te Whare Hauora Immunisation Clinic", kind: "clinic" },
  { index: 5, role: "REGULATOR_ROLE", name: "Medsafe Inspectorate", kind: "regulator" },
  { index: 6, role: "IOT_ORACLE_ROLE", name: "Cold-chain IoT oracle", kind: "iot" },
];

async function main() {
  const [admin, ...rest] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("VaccineSupplyChain");
  const contract = await Factory.deploy(admin.address);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const roleAccounts = {};
  for (const org of ORGS) {
    const signer = rest[org.index - 1];
    if (!signer) throw new Error(`Missing signer for ${org.kind}`);
    const role = await contract[org.role]();
    await (await contract.grantRole(role, signer.address)).wait();
    await (await contract.setOrganisation(signer.address, org.name, org.kind)).wait();
    roleAccounts[org.kind] = signer.address;
  }
  await (await contract.setOrganisation(admin.address, "VaxTrace network admin", "admin")).wait();

  const network = await hre.ethers.provider.getNetwork();
  const artifact = await hre.artifacts.readArtifact("VaccineSupplyChain");
  const deployment = {
    address,
    chainId: Number(network.chainId),
    network: hre.network.name,
    admin: admin.address,
    accounts: { admin: admin.address, ...roleAccounts },
    abi: artifact.abi,
  };

  const root = path.join(__dirname, "..", "..");
  const payload = JSON.stringify(deployment, null, 2);
  fs.writeFileSync(path.join(root, "deployment.json"), payload);
  fs.writeFileSync(path.join(root, "backend", "deployment.json"), payload);
  fs.mkdirSync(path.join(root, "frontend", "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "public", "deployment.json"), payload);

  const demo = {
    comment: "Well-known Hardhat accounts. Local demo only.",
    rpc: "http://127.0.0.1:8545",
    chainId: Number(network.chainId),
    contract: address,
    accounts: [],
  };
  const labels = [
    ["admin", "Network admin"],
    ["manufacturer", "Southern Biologics Ltd"],
    ["logistics", "ColdLink Freight"],
    ["warehouse", "National Vaccine Store, Porirua"],
    ["clinic", "Te Whare Hauora Immunisation Clinic"],
    ["regulator", "Medsafe Inspectorate"],
    ["iot", "Cold-chain IoT oracle"],
  ];
  const signers = await hre.ethers.getSigners();
  const { HDNodeWallet } = hre.ethers;
  const phrase = "test test test test test test test test test test test junk";
  for (let i = 0; i < labels.length; i++) {
    const wallet = HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${i}`);
    demo.accounts.push({
      role: labels[i][0],
      label: labels[i][1],
      address: signers[i].address,
      privateKey: wallet.privateKey,
    });
  }
  fs.writeFileSync(path.join(root, "demo-accounts.json"), JSON.stringify(demo, null, 2));
  fs.writeFileSync(
    path.join(root, "frontend", "public", "demo-accounts.json"),
    JSON.stringify(demo, null, 2)
  );

  console.log(`VaxTrace deployed at ${address} (chain ${deployment.chainId})`);
  for (const [kind, addr] of Object.entries(deployment.accounts)) {
    console.log(`  ${kind.padEnd(14)} ${addr}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
