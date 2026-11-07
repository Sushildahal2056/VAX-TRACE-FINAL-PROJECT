const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function loadDeployment() {
  const candidates = [
    process.env.DEPLOYMENT_PATH,
    path.join(__dirname, "..", "deployment.json"),
    path.join(__dirname, "..", "..", "deployment.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return null;
}

function getProvider() {
  const url = process.env.RPC_URL || "http://127.0.0.1:8545";
  return new ethers.JsonRpcProvider(url);
}

function getContract(signerOrProvider) {
  const deployment = loadDeployment();
  if (!deployment) throw new Error("deployment.json missing — run the Hardhat deploy script first");
  const address = process.env.CONTRACT_ADDRESS || deployment.address;
  return new ethers.Contract(address, deployment.abi, signerOrProvider);
}

async function relayerContract() {
  const deployment = loadDeployment();
  const provider = getProvider();
  const key = process.env.RELAYER_KEY || (deployment && deploymentRelayerKey());
  if (!key) throw new Error("RELAYER_KEY not set");
  const wallet = new ethers.Wallet(key, provider);
  return getContract(wallet);
}

function deploymentRelayerKey() {
  const demoPath = path.join(__dirname, "..", "..", "demo-accounts.json");
  if (!fs.existsSync(demoPath)) return null;
  const demo = JSON.parse(fs.readFileSync(demoPath, "utf8"));
  const iot = demo.accounts.find((a) => a.role === "iot");
  return iot ? iot.privateKey : null;
}

async function rolesOf(address) {
  const c = getContract(getProvider());
  const r = await c.rolesOf(address);
  return {
    manufacturer: r.manufacturer,
    logistics: r.logistics,
    warehouse: r.warehouse,
    clinic: r.clinic,
    regulator: r.regulator,
    iot: r.iot,
    admin: Boolean(r.admin),
  };
}

function canReadPhi(roles) {
  return Boolean(roles.clinic || roles.regulator);
}

module.exports = {
  loadDeployment,
  getProvider,
  getContract,
  relayerContract,
  rolesOf,
  canReadPhi,
};
