import { BrowserProvider, Contract, JsonRpcProvider, Wallet } from "ethers";

export const STATUS = [
  "None",
  "Registered",
  "Packaged",
  "In transit",
  "In warehouse",
  "Delivered",
  "Administered",
  "Recalled",
];

export const EVENTS = [
  "Registered",
  "Packaged",
  "Transfer initiated",
  "Custody accepted",
  "Transport recorded",
  "Storage recorded",
  "Temperature reading",
  "Dose administered",
  "Adverse event",
  "Violation",
  "Recalled",
  "Exception authorised",
];

export const ROLE_METHODS = {
  manufacturer: "MANUFACTURER_ROLE",
  logistics: "LOGISTICS_ROLE",
  warehouse: "WAREHOUSE_ROLE",
  clinic: "CLINIC_ROLE",
  regulator: "REGULATOR_ROLE",
  iot: "IOT_ORACLE_ROLE",
};

const PROFILE_ROLES = ["admin", "manufacturer", "logistics", "warehouse", "clinic", "regulator", "iot"];
const WALLET_KEY = "vaxtrace.customWallets";

export function tempC(centi) {
  return (Number(centi) / 100).toFixed(1);
}

export function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(h) {
  if (!h || h === "0x" + "0".repeat(64)) return "—";
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

export async function loadDeployment() {
  const res = await fetch("/deployment.json");
  if (!res.ok) throw new Error("Contract is not deployed yet. Run the demo start script.");
  return res.json();
}

export async function loadDemoAccounts() {
  const res = await fetch("/demo-accounts.json");
  if (!res.ok) return { accounts: [] };
  return res.json();
}

export async function connectMetaMask(deployment) {
  if (!window.ethereum) throw new Error("MetaMask is not installed");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const chainId = "0x" + Number(deployment.chainId).toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "VaxTrace local",
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["http://127.0.0.1:8545"],
        },
      ],
    });
  }
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress(), mode: "metamask" };
}

export function rpcUrl() {
  if (typeof window !== "undefined") return `${window.location.origin}/rpc`;
  return "http://127.0.0.1:8545";
}

export function readProvider() {
  return new JsonRpcProvider(rpcUrl(), undefined, { cacheTimeout: -1 });
}

export async function connectDemo(privateKey) {
  const provider = readProvider();
  const signer = new Wallet(privateKey, provider);
  return { provider, signer, address: signer.address, mode: "demo" };
}

export function contractWith(deployment, signerOrProvider) {
  return new Contract(deployment.address, deployment.abi, signerOrProvider);
}

export function decodeBatch(b, exceptionAuthorised = false) {
  return {
    id: Number(b.id),
    digitalId: b.digitalId,
    vaccineName: b.vaccineName,
    lotNumber: b.lotNumber,
    manufacturer: b.manufacturer,
    currentCustodian: b.currentCustodian,
    manufacturedAt: Number(b.manufacturedAt),
    expiresAt: Number(b.expiresAt),
    tempMinCenti: Number(b.tempMinCenti),
    tempMaxCenti: Number(b.tempMaxCenti),
    vialCount: Number(b.vialCount),
    remainingVials: Number(b.remainingVials),
    status: Number(b.status),
    statusLabel: STATUS[Number(b.status)] || String(b.status),
    coldChainBreached: Boolean(b.coldChainBreached),
    exceptionAuthorised: Boolean(exceptionAuthorised),
    exists: Boolean(b.exists),
  };
}

export async function loadAllBatches(contract) {
  const total = Number(await contract.totalBatches());
  const batches = [];
  for (let i = 1; i <= total; i++) {
    const [raw, exceptionAuthorised] = await Promise.all([
      contract.getBatch(i),
      contract.exceptionAuthorised(i),
    ]);
    batches.push(decodeBatch(raw, exceptionAuthorised));
  }
  return batches;
}

export async function loadOrganisations(contract) {
  try {
    const [accounts, details] = await contract.getOrganisations();
    return accounts.map((addr, idx) => ({
      address: addr,
      name: details[idx].name,
      kind: details[idx].kind,
      registered: Boolean(details[idx].registered),
    }));
  } catch {
    return [];
  }
}

function primaryRole(roles, org, _fallbackAccount) {
  if (org && org.registered && org.kind && PROFILE_ROLES.includes(org.kind)) return org.kind;
  const onChain = PROFILE_ROLES.find((key) => roles[key]);
  if (onChain) return onChain;
  return "unregistered";
}

export async function resolveProfile(contract, address, fallbackAccount = null) {
  const [r, org] = await Promise.all([contract.rolesOf(address), contract.organisations(address)]);
  const roles = {
    manufacturer: Boolean(r.manufacturer),
    logistics: Boolean(r.logistics),
    warehouse: Boolean(r.warehouse),
    clinic: Boolean(r.clinic),
    regulator: Boolean(r.regulator),
    iot: Boolean(r.iot),
    admin: Boolean(r.admin),
  };
  let role = primaryRole(roles, org, fallbackAccount);
  if (role === "unregistered" && org && !org.registered && org.kind) role = "deactivated";
  const label =
    org && org.name && (org.registered || role === "deactivated")
      ? org.name
      : fallbackAccount?.label || shortAddr(address);
  return {
    roles,
    account: { role, label, address, registered: Boolean(org && org.registered) },
  };
}

function walletEntry(entry) {
  return {
    role: entry.role,
    label: entry.label,
    address: entry.address,
    privateKey: entry.privateKey,
    passwordHint: entry.passwordHint ? String(entry.passwordHint) : "",
    // ponytail: plaintext demo gate beside the key, not an encrypted keystore. Production sign-in is MetaMask.
    password: entry.password ? String(entry.password) : "",
  };
}

export function checkWalletPassword(entry, inputPassword) {
  if (!entry.password) return true;
  return entry.password === String(inputPassword || "");
}

function dedupeWallets(list, entry) {
  const key = entry.address.toLowerCase();
  return [...list.filter((w) => w.address.toLowerCase() !== key), walletEntry(entry)];
}

export function loadCustomWallets() {
  try {
    const raw = JSON.parse(localStorage.getItem(WALLET_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((w) => w && typeof w.address === "string" && typeof w.privateKey === "string")
      .map(walletEntry);
  } catch {
    return [];
  }
}

export function saveCustomWallet(entry) {
  localStorage.setItem(WALLET_KEY, JSON.stringify(dedupeWallets(loadCustomWallets(), entry)));
}

export function createRandomWallet() {
  const wallet = Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export async function loadHistory(contract, batchId) {
  const rows = await contract.getHistory(batchId);
  return rows.map((e) => ({
    eventType: Number(e.eventType),
    label: EVENTS[Number(e.eventType)] || String(e.eventType),
    actor: e.actor,
    timestamp: Number(e.timestamp),
    temperatureCenti: Number(e.temperatureCenti),
    offChainHash: e.offChainHash,
    note: e.note,
  }));
}

export async function loadOrgMap(contract, addresses) {
  const unique = [...new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()))];
  const map = {};
  await Promise.all(
    unique.map(async (addr) => {
      try {
        const org = await contract.organisations(addr);
        map[addr] = org.registered && org.name ? org.name : "";
      } catch {
        map[addr] = "";
      }
    })
  );
  return map;
}

export function who(addr, orgs) {
  if (!addr) return "—";
  const name = orgs && orgs[addr.toLowerCase()];
  return name || shortAddr(addr);
}

export async function loadInbound(contract, address, batches) {
  const rows = [];
  for (const batch of batches) {
    const pending = await contract.pendingTransfers(batch.id);
    if (pending.pending && pending.to.toLowerCase() === address.toLowerCase()) {
      rows.push({
        batch,
        from: pending.from,
        expected: Number(pending.expectedDeliveryBy),
      });
    }
  }
  return rows;
}

if (typeof process !== "undefined" && /(?:^|\/)eth\.js$/.test(process.argv?.[1] || "")) {
  const roles = {
    admin: false,
    manufacturer: false,
    logistics: true,
    warehouse: false,
    clinic: false,
    regulator: false,
    iot: false,
  };
  if (primaryRole(roles, { registered: true, kind: "clinic", name: "A" }, null) !== "clinic") {
    throw new Error("org kind should win");
  }
  if (primaryRole(roles, { registered: false, kind: "clinic" }, null) !== "logistics") {
    throw new Error("unregistered org should fall through to roles");
  }
  if (primaryRole({ ...roles, logistics: false }, null, { role: "iot" }) !== "unregistered") {
    throw new Error("no on-chain role is unregistered");
  }
  if (primaryRole({ ...roles, logistics: false }, { registered: false, kind: "clinic" }, { role: "iot" }) !== "unregistered") {
    throw new Error("revoked organisation does not keep the fallback role");
  }
  const merged = dedupeWallets(
    [{ address: "0xABC", role: "clinic", label: "Old", privateKey: "1" }],
    { address: "0xabc", role: "warehouse", label: "New", privateKey: "2" }
  );
  if (merged.length !== 1 || merged[0].label !== "New" || merged[0].role !== "warehouse") {
    throw new Error("wallet dedupe");
  }
  const secured = dedupeWallets([], {
    address: "0xDEF",
    role: "clinic",
    label: "Clinic",
    privateKey: "1",
    password: "secret",
    passwordHint: "demo",
  });
  if (secured[0].password !== "secret" || secured[0].passwordHint !== "demo") {
    throw new Error("wallet password should be preserved");
  }
  if (!checkWalletPassword(secured[0], "secret")) throw new Error("password match");
  if (checkWalletPassword(secured[0], "nope")) throw new Error("password mismatch");
  if (checkWalletPassword(secured[0], "")) throw new Error("empty password should fail when set");
  if (!checkWalletPassword({ password: "" }, "anything")) throw new Error("missing password stays open");
  console.log("eth.js self-check ok");
}
