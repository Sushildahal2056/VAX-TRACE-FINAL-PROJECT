import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "./lib/api";
import { dateInputToUnix, friendlyError, parseBatchQuery } from "./lib/errors";
import { isAddress } from "ethers";
import {
  ROLE_METHODS,
  connectDemo,
  connectMetaMask,
  contractWith,
  createRandomWallet,
  decodeBatch,
  loadAllBatches,
  loadCustomWallets,
  loadDemoAccounts,
  loadDeployment,
  loadHistory,
  loadInbound,
  loadOrgMap,
  loadOrganisations,
  readProvider,
  resolveProfile,
  saveCustomWallet,
  shortAddr,
  shortHash,
  tempC,
  who,
} from "./lib/eth";

const ORG_KINDS = ["clinic", "warehouse", "logistics", "manufacturer", "regulator", "iot"];
const HOLDER_KINDS = ["logistics", "warehouse", "clinic", "manufacturer"];

const TEMP_EVENTS = new Set([4, 5, 6, 9]);

function useBoundId(batches) {
  const [id, setId] = useState(() => (batches[0] ? String(batches[0].id) : ""));
  useEffect(() => {
    if (!batches.length) return;
    if (!id || !batches.some((b) => String(b.id) === String(id))) {
      setId(String(batches[0].id));
    }
  }, [batches, id]);
  return [id, setId];
}

function when(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function stamp(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

async function readBatch(contract, parsed) {
  const raw = parsed.digitalId
    ? await contract.getBatchByDigitalId(parsed.digitalId)
    : await contract.getBatch(parsed.batchId);
  return decodeBatch(raw, await contract.exceptionAuthorised(raw.id));
}

function isAdminSession(session) {
  return Boolean(session && (session.roles?.admin || session.account?.role === "admin"));
}

function demoStakeholderKeys(demoAccounts, registeredSet = null, applications = []) {
  const known = new Set();
  const rows = [];
  for (const account of demoAccounts || []) {
    if (!account?.privateKey || !account.address || account.role === "admin") continue;
    known.add(account.address.toLowerCase());
    rows.push(account);
  }
  const appAddresses = new Set(
    (applications || []).filter((a) => a?.address).map((a) => a.address.toLowerCase())
  );
  for (const wallet of loadCustomWallets()) {
    if (!wallet?.privateKey || !wallet.address || wallet.role === "admin") continue;
    const key = wallet.address.toLowerCase();
    if (known.has(key)) continue;
    if (registeredSet !== null && !registeredSet.has(key) && !appAddresses.has(key)) continue;
    known.add(key);
    rows.push(wallet);
  }
  return rows;
}

function needsAccreditation(session) {
  if (!session?.account) return false;
  if (session.account.role === "admin" || session.roles?.admin) return false;
  return session.account.role === "unregistered" || session.account.role === "deactivated" || !session.account.registered;
}

function walletStatusTag(account, applications, registeredSet, seeded) {
  const key = String(account?.address || "").toLowerCase();
  if (!key) return "";
  const app = (applications || []).find((row) => String(row.address || "").toLowerCase() === key);
  const onLedger = Boolean(registeredSet && registeredSet.has(key));
  if (!onLedger && app?.status === "rejected") return "Rejected";
  if (!onLedger && app?.status === "pending") return "Pending";
  if (onLedger || seeded.has(key)) return "Active";
  return "";
}

function accessCards(demoAccounts, registeredSet, deactivatedSet, applications) {
  if (!registeredSet) return [];
  const saved = new Map();
  for (const wallet of [...demoAccounts, ...loadCustomWallets()]) {
    if (!wallet?.address || wallet.role === "admin") continue;
    saved.set(wallet.address.toLowerCase(), wallet);
  }
  const cards = [];
  const seen = new Set();
  for (const app of applications) {
    if ((app.status !== "pending" && app.status !== "rejected") || !app.address) continue;
    const key = app.address.toLowerCase();
    if (registeredSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    const wallet = saved.get(key);
    cards.push({
      address: app.address,
      label: app.name || wallet?.label || shortAddr(app.address),
      role: app.kind || wallet?.role,
      privateKey: wallet?.privateKey || "",
      status: app.status,
      deactivated: Boolean(deactivatedSet && deactivatedSet.has(key)),
    });
  }
  if (deactivatedSet) {
    for (const [key, wallet] of saved) {
      if (seen.has(key) || !deactivatedSet.has(key)) continue;
      seen.add(key);
      cards.push({ ...wallet, deactivated: true });
    }
  }
  return cards;
}

async function markApplication(address, status, actor) {
  try {
    await api(`/api/org-applications/${address}/status`, {
      method: "POST",
      address: actor,
      body: { status },
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/not found/i.test(msg) || msg.includes("404")) return;
    throw err;
  }
}

function destinationsFor(orgList, accounts, self) {
  const seen = new Set();
  const selfKey = self.toLowerCase();
  const rows = [];
  for (const entry of [...orgList, ...accounts]) {
    if (!entry.address) continue;
    const key = entry.address.toLowerCase();
    if (seen.has(key) || key === selfKey) continue;
    if (entry.registered === false) continue;
    const roleOrKind = entry.kind || entry.role;
    if (!HOLDER_KINDS.includes(roleOrKind)) continue;
    seen.add(key);
    rows.push({
      address: entry.address,
      label: entry.name || entry.label || shortAddr(entry.address),
    });
  }
  return rows;
}

function LiveDot() {
  const [ok, setOk] = useState(null);
  useEffect(() => {
    let stop = false;
    async function ping() {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (!stop) setOk(Boolean(data.chain));
      } catch {
        if (!stop) setOk(false);
      }
    }
    ping();
    const timer = setInterval(ping, 10000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <span className={`live ${ok ? "on" : ok === false ? "off" : ""}`}>
      {ok ? "Ledger live" : ok === false ? "Ledger offline" : "Connecting"}
    </span>
  );
}

function statusTone(label) {
  if (label === "Recalled") return "danger";
  if (label === "In transit") return "gold";
  return "";
}

export default function App() {
  const [session, setSession] = useState(null);
  const [sessionKey, setSessionKey] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const adminSession = isAdminSession(session);

  function logout() {
    setSession(null);
    setSessionKey((n) => n + 1);
    navigate(adminSession ? "/admin" : "/portal");
  }

  function navClass(path) {
    return location.pathname === path ? "nav-link active" : "nav-link";
  }

  return (
    <>
      <header className="topbar">
        <div className="brand-lockup">
          <Link className="brand" to="/">
            <span className="emblem" aria-hidden="true">VT</span>
            <span className="brand-copy">
              <strong>VaxTrace</strong>
              <span>National Vaccine Distribution Ledger</span>
            </span>
          </Link>
          <LiveDot />
        </div>
        <nav className="nav">
          <Link className={navClass("/")} to="/">Public ledger</Link>
          {adminSession ? (
            <Link className={navClass("/admin")} to="/admin">Admin console</Link>
          ) : session ? (
            <Link className={navClass("/portal")} to="/portal">Stakeholder workspace</Link>
          ) : (
            <>
              <Link className={navClass("/portal")} to="/portal">Stakeholder portal</Link>
              <Link className={navClass("/admin")} to="/admin">Admin console</Link>
            </>
          )}
          {adminSession && (
            <>
              <span className="session-pill">VaxTrace network admin · ADMIN</span>
              <button className="btn" type="button" onClick={logout}>Log out</button>
            </>
          )}
          {session && !adminSession && (
            <>
              <span className="session-pill">{session.account.label} · {session.account.role.toUpperCase()}</span>
              <button className="btn" type="button" onClick={logout}>Log out</button>
            </>
          )}
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/portal" element={<Portal key={sessionKey} session={session} setSession={setSession} logout={logout} />} />
        <Route path="/admin" element={<AdminPage key={sessionKey} session={session} setSession={setSession} logout={logout} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

function Home() {
  const [query, setQuery] = useState("1");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [orgs, setOrgs] = useState({});
  const [batches, setBatches] = useState([]);
  const [orgList, setOrgList] = useState([]);
  const [ready, setReady] = useState(false);

  async function verifyQuery(raw) {
    setError("");
    setBusy(true);
    try {
      const parsed = parseBatchQuery(raw);
      const deployment = await loadDeployment();
      const c = contractWith(deployment, readProvider());
      const batch = await readBatch(c, parsed);
      const history = await loadHistory(c, batch.id);
      const check = await c.verifyAuthenticity(batch.id);
      const names = await loadOrgMap(c, [
        batch.manufacturer,
        batch.currentCustodian,
        ...history.map((row) => row.actor),
      ]);
      setOrgs((prev) => ({ ...prev, ...names }));
      setResult({
        batch,
        history,
        genuine: Boolean(check.genuine),
        recalled: Boolean(check.recalled),
        breached: Boolean(check.coldChainBreached),
      });
    } catch (err) {
      setResult(null);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  function openLot(raw, scroll) {
    const next = String(raw);
    setQuery(next);
    verifyQuery(next);
    if (scroll) document.getElementById("verify")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const deployment = await loadDeployment();
        const c = contractWith(deployment, readProvider());
        const [all, registered] = await Promise.all([loadAllBatches(c), loadOrganisations(c)]);
        const names = await loadOrgMap(c, [
          ...all.flatMap((b) => [b.manufacturer, b.currentCustodian]),
          ...registered.map((org) => org.address),
        ]);
        for (const org of registered) {
          if (org.registered && org.name) names[org.address.toLowerCase()] = org.name;
        }
        if (cancel) return;
        setBatches(all);
        setOrgList(registered);
        setOrgs((prev) => ({ ...names, ...prev }));
      } catch {
        if (!cancel) {
          setBatches([]);
          setOrgList([]);
        }
      } finally {
        if (!cancel) setReady(true);
      }
    })();
    verifyQuery("1");
    return () => {
      cancel = true;
    };
  }, []);

  const activeOrgs = orgList.filter((org) => org.registered);
  const doses = batches.reduce((sum, batch) => (batch.statusLabel === "Recalled" ? sum : sum + batch.remainingVials), 0);
  const breaches = batches.filter((batch) => batch.coldChainBreached).length;
  const coldLabel = !ready
    ? "—"
    : breaches === 0
      ? "Intact"
      : `${breaches} excursion${breaches === 1 ? "" : "s"} flagged`;

  return (
    <main className="wrap ledger">
      <header className="public-banner">
        <h1>National Vaccine Lot Verification & Supply-Chain Registry</h1>
        <p className="lede">
          Verify batch authenticity, cold-chain compliance, and custody handovers in real time. Patient identifiers remain encrypted off-chain.
        </p>
      </header>
      <div className="stats hero-stats" aria-label="Live network summary">
        <div className="stat">
          <b>{ready ? batches.length.toLocaleString() : "—"}</b>
          <span>Registered lots</span>
        </div>
        <div className="stat">
          <b>{ready ? doses.toLocaleString() : "—"}</b>
          <span>Doses available</span>
        </div>
        <div className="stat">
          <b>{ready ? activeOrgs.length.toLocaleString() : "—"}</b>
          <span>Verified organisations</span>
        </div>
        <div className={`stat${ready && breaches ? " alert" : ""}`}>
          <b className={coldLabel.length > 8 ? "compact" : ""}>{coldLabel}</b>
          <span>Cold-chain status</span>
        </div>
      </div>
      <div className="public-layout">
        <div className="public-main">
          <section className="card" id="verify">
            <div className="kicker">Public verification</div>
            <h2>Public Lot Verification</h2>
            <form
              className="verify-bar"
              onSubmit={(e) => {
                e.preventDefault();
                verifyQuery(query);
              }}
            >
              <label className="sr-only" htmlFor="verify-q">Batch number or 0x digital id</label>
              <input
                id="verify-q"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Batch number or 0x digital id"
              />
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? "Checking ledger…" : "Reconstruct history"}
              </button>
            </form>
            {batches.length > 0 && (
              <div className="lot-pills" aria-label="Quick-select lot">
                {batches.map((batch) => (
                  <button
                    key={batch.id}
                    className={`pill${String(result?.batch?.id) === String(batch.id) ? " active" : ""}`}
                    type="button"
                    disabled={busy}
                    onClick={() => openLot(batch.id, false)}
                  >
                    #{batch.id} {batch.vaccineName}
                  </button>
                ))}
              </div>
            )}
            {error && <p className="flash">{error}</p>}
            {result && (
              <>
                <p className={result.genuine && !result.recalled ? "okbox" : "flash"}>
                  {result.genuine
                    ? result.recalled
                      ? "On the ledger — recalled. Do not administer."
                      : result.breached
                        ? "On the ledger — genuine lot, but the cold chain was breached."
                        : "On the ledger — genuine registered lot."
                    : "Not found on the ledger. Treat as unverified."}
                </p>
                <BatchView batch={result.batch} history={result.history} orgs={orgs} publicView />
              </>
            )}
          </section>
          {ready ? (
            <BatchTable
              batches={batches}
              orgs={orgs}
              kicker="Transparency"
              heading="Public Lot Registry"
              empty="No lots have been registered on the ledger yet."
              onInspect={(batch) => openLot(batch.id, true)}
            />
          ) : (
            <p className="card">Loading the public lot registry…</p>
          )}
        </div>
        <aside className="public-aside">
          <article className="card">
            <div className="kicker">Accreditation</div>
            <h2>Accredited Network Organisations</h2>
            <p className="org-count">
              <b>{ready ? activeOrgs.length.toLocaleString() : "—"}</b>
              {" "}active organisation{activeOrgs.length === 1 ? "" : "s"}
            </p>
            {activeOrgs.length ? (
              <div className="org-list">
                {activeOrgs.map((org) => (
                  <div className="org-row" key={org.address}>
                    <b>{org.name}</b>
                    <span className={`badge kind-${org.kind}`}>{org.kind}</span>
                    <span className="mono">{shortAddr(org.address)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p>{ready ? "No accredited organisations are listed on the ledger yet." : "Loading the organisation register…"}</p>
            )}
          </article>
          <article className="card">
            <div className="kicker">Reference</div>
            <h2>Verification & Privacy Standard</h2>
            <ul className="std-list">
              <li>
                <strong>On-chain (Chain 31337)</strong>
                <span>Batch digital ID, role-checked custody handovers, temperature breaches, and SHA-256 hashes.</span>
              </li>
              <li>
                <strong>Off-chain (AES-256-GCM)</strong>
                <span>Beneficiary NHI, names, and clinical notes — never exposed on the public ledger.</span>
              </li>
            </ul>
          </article>
        </aside>
      </div>
      <p className="footer">
        Local demonstration network. Not a production immunisation register.
      </p>
    </main>
  );
}

function Portal({ session, setSession, logout }) {
  const [demo, setDemo] = useState({ accounts: [] });
  const [demoReady, setDemoReady] = useState(false);
  const [deployment, setDeployment] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("overview");
  const [keyInput, setKeyInput] = useState("");
  const [registeredSet, setRegisteredSet] = useState(null);
  const [deactivatedSet, setDeactivatedSet] = useState(null);
  const [applyName, setApplyName] = useState("");
  const [applyKind, setApplyKind] = useState("clinic");
  const [applyAddress, setApplyAddress] = useState("");
  const [applyKey, setApplyKey] = useState("");
  const [applyKeyFor, setApplyKeyFor] = useState("");
  const [applyOk, setApplyOk] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyLicence, setApplyLicence] = useState("");
  const [applyContact, setApplyContact] = useState("");
  const [gateTab, setGateTab] = useState("signin");
  const [demoPick, setDemoPick] = useState("");
  const [walletRev, setWalletRev] = useState(0);
  const [applications, setApplications] = useState([]);
  const [searchParams] = useSearchParams();
  const stakeholder = Boolean(session) && !isAdminSession(session);

  useEffect(() => {
    loadDemoAccounts().then(setDemo).catch(() => {}).finally(() => setDemoReady(true));
    loadDeployment().then(setDeployment).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (stakeholder || !deployment) return undefined;
    let cancel = false;
    setRegisteredSet(null);
    setDeactivatedSet(null);
    loadOrganisations(contractWith(deployment, readProvider()))
      .then((orgs) => {
        if (cancel) return;
        setRegisteredSet(
          new Set(orgs.filter((org) => org.registered && org.address).map((org) => org.address.toLowerCase()))
        );
        setDeactivatedSet(
          new Set(orgs.filter((org) => org.address && !org.registered).map((org) => org.address.toLowerCase()))
        );
      })
      .catch(() => {
        if (!cancel) {
          setRegisteredSet(new Set());
          setDeactivatedSet(new Set());
        }
      });
    return () => {
      cancel = true;
    };
  }, [deployment, stakeholder]);

  useEffect(() => {
    if (stakeholder) return undefined;
    let cancel = false;
    api("/api/org-applications")
      .then((data) => {
        if (!cancel) setApplications(Array.isArray(data.applications) ? data.applications : []);
      })
      .catch(() => {
        if (!cancel) setApplications([]);
      });
    return () => {
      cancel = true;
    };
  }, [stakeholder, applyOk]);

  useEffect(() => {
    if (session) return;
    setKeyInput("");
    setErr("");
    setApplyOk("");
    setTab("overview");
    setGateTab("signin");
  }, [session]);

  async function openSession(conn, fallback) {
    if (!deployment) throw new Error("Contract is not deployed yet. Run `npm run demo`.");
    const c = contractWith(deployment, conn.signer);
    const profile = await resolveProfile(c, conn.address, fallback);
    if (isAdminSession(profile)) {
      throw new Error("Network Admin signs in on the Admin console.");
    }
    setSession({ ...conn, ...profile, contract: c, deployment });
    setKeyInput("");
    setErr("");
    setApplyOk("");
    setTab("overview");
    setGateTab("signin");
  }

  async function pick(account) {
    setErr("");
    try {
      const conn = await connectDemo(account.privateKey);
      await openSession(conn, account);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  async function connectKey(e) {
    e.preventDefault();
    setErr("");
    try {
      const raw = keyInput.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error("Enter a 64-character 0x private key.");
      }
      const conn = await connectDemo(raw);
      const known = demoStakeholderKeys(demo.accounts).find(
        (a) => a.address.toLowerCase() === conn.address.toLowerCase()
      );
      await openSession(conn, known || null);
      setKeyInput("");
    } catch (error) {
      setErr(friendlyError(error));
    }
  }

  async function metamask() {
    setErr("");
    try {
      if (!deployment) throw new Error("Contract is not deployed yet. Run `npm run demo`.");
      const conn = await connectMetaMask(deployment);
      const known = demoStakeholderKeys(demo.accounts).find(
        (a) => a.address.toLowerCase() === conn.address.toLowerCase()
      ) || { role: "unknown", label: "MetaMask account", address: conn.address };
      await openSession(conn, known);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  function persistApplyWallet(address, privateKey, label, role) {
    if (!privateKey || !isAddress(address)) return;
    saveCustomWallet({
      role,
      label: String(label || "").trim() || "New organisation",
      address,
      privateKey,
    });
  }

  function generateApplyWallet() {
    setErr("");
    setApplyOk("");
    const wallet = createRandomWallet();
    persistApplyWallet(wallet.address, wallet.privateKey, applyName, applyKind);
    setApplyAddress(wallet.address);
    setApplyKey(wallet.privateKey);
    setApplyKeyFor(wallet.address);
    setWalletRev((n) => n + 1);
  }

  function onApplyName(value) {
    setApplyName(value);
    if (applyKey && applyKeyFor && applyAddress.trim().toLowerCase() === applyKeyFor.toLowerCase()) {
      persistApplyWallet(applyAddress.trim(), applyKey, value, applyKind);
    }
  }

  function onApplyKind(value) {
    setApplyKind(value);
    if (applyKey && applyKeyFor && applyAddress.trim().toLowerCase() === applyKeyFor.toLowerCase()) {
      persistApplyWallet(applyAddress.trim(), applyKey, applyName, value);
    }
  }

  function editApplyAddress(value) {
    setApplyAddress(value);
  }

  async function useMetaMaskAddress() {
    setErr("");
    setApplyOk("");
    try {
      if (!deployment) throw new Error("Contract is not deployed yet. Run `npm run demo`.");
      const conn = await connectMetaMask(deployment);
      setApplyAddress(conn.address);
      setApplyKey("");
      setApplyKeyFor("");
    } catch (error) {
      setErr(friendlyError(error));
    }
  }

  async function sendApplication(e) {
    e.preventDefault();
    setErr("");
    setApplyOk("");
    setApplyBusy(true);
    try {
      const name = applyName.trim();
      const address = applyAddress.trim();
      const licenceId = applyLicence.trim();
      const contact = applyContact.trim();
      if (!name) throw new Error("Organisation name is required.");
      if (!ORG_KINDS.includes(applyKind)) throw new Error("Choose a role.");
      if (!licenceId) throw new Error("Medsafe / HPI licence ID is required.");
      if (!contact) throw new Error("Contact email is required.");
      if (!isAddress(address)) throw new Error("Enter a valid wallet address.");
      if (applyKey && applyKeyFor.toLowerCase() === address.toLowerCase()) {
        saveCustomWallet({
          role: applyKind,
          label: name,
          address,
          privateKey: applyKey,
        });
        setWalletRev((n) => n + 1);
      }
      await api("/api/org-applications", {
        method: "POST",
        body: { address, name, kind: applyKind, licenceId, contact },
      });
      setApplications((prev) => [
        ...prev.filter((app) => String(app.address || "").toLowerCase() !== address.toLowerCase()),
        { address, name, kind: applyKind, licenceId, contact, status: "pending" },
      ]);
      setApplyOk(
        `Application sent to Network admin with public address ${address} and licence ${licenceId}. Save the private key shown above — it stayed in this browser. Once the admin approves the address, log in with that private key.`
      );
    } catch (error) {
      setErr(friendlyError(error));
    } finally {
      setApplyBusy(false);
    }
  }

  if (searchParams.get("mode") === "admin") return <Navigate to="/admin" replace />;
  if (isAdminSession(session)) return <Navigate to="/admin" replace />;

  if (!session) {
    const keys = demoStakeholderKeys(demo.accounts, registeredSet, applications);
    const seeded = new Set(
      (demo.accounts || []).filter((account) => account?.address).map((account) => account.address.toLowerCase())
    );
    const demoValue = keys.some((account) => account.address === demoPick) ? demoPick : (keys[0]?.address || "");
    const shownWaiting = accessCards(demo.accounts, registeredSet, deactivatedSet, applications);
    const reviewCount = shownWaiting.filter((row) => row.status === "pending" || row.status === "rejected").length;

    async function signDemo() {
      const account = keys.find((row) => row.address === demoValue);
      if (account) await pick(account);
    }

    function copyDemoKey() {
      const account = keys.find((row) => row.address === demoValue);
      if (account?.privateKey) navigator.clipboard.writeText(account.privateKey);
    }

    function waitingBadge(row) {
      if (row.status === "rejected") return { tone: "danger", text: "Rejected by admin" };
      if (row.deactivated) return { tone: "danger", text: "Deactivated" };
      return { tone: "warn", text: "Pending admin approval" };
    }

    return (
      <main className="wrap portal-auth" autoComplete="off">
        <header className="section-title">
          <div className="kicker">Stakeholder portal</div>
          <h1>{gateTab === "signin" ? "Sign in to workspace" : "Request new organisation access"}</h1>
        </header>
        <div className="gate-tabs" role="tablist">
          <button
            className={`btn ${gateTab === "signin" ? "primary" : ""}`}
            type="button"
            role="tab"
            aria-selected={gateTab === "signin"}
            onClick={() => { setErr(""); setGateTab("signin"); }}
          >
            Sign in to workspace
          </button>
          <button
            className={`btn ${gateTab === "apply" ? "primary" : ""}`}
            type="button"
            role="tab"
            aria-selected={gateTab === "apply"}
            onClick={() => { setErr(""); setGateTab("apply"); }}
          >
            Request new organisation access
            {reviewCount > 0 && <span className="badge warn tab-badge">{reviewCount}</span>}
          </button>
        </div>
        {err && <p className="flash">{err}</p>}
        {gateTab === "signin" ? (
          <div className="card">
            <h2>MetaMask or Private Key (Standard Sign-In)</h2>
            <button className="btn primary block" type="button" onClick={metamask}>
              Log in with MetaMask
            </button>
            <div className="or-divider">or sign in with private key</div>
            <form onSubmit={connectKey} autoComplete="off">
              <label htmlFor="stakeholder-key">Private key (0x…)</label>
              <input
                id="stakeholder-key"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="0x…"
                autoComplete="new-password"
                spellCheck={false}
              />
              <button className="btn block" type="submit">Log in with private key</button>
            </form>
            <div className="demo-switch">
              <h3>Demo presentation quick-login (local test wallets — removed in production)</h3>
              {keys.length ? (
                <div className="demo-row">
                  <select key={walletRev} value={demoValue} onChange={(e) => setDemoPick(e.target.value)}>
                    {keys.map((account) => {
                      const tag = walletStatusTag(account, applications, registeredSet, seeded);
                      return (
                        <option key={account.address} value={account.address}>
                          {account.label || shortAddr(account.address)} ({account.role}){tag ? ` · ${tag}` : ""}
                        </option>
                      );
                    })}
                  </select>
                  <button className="btn primary" type="button" onClick={signDemo}>Sign in</button>
                  <button className="btn" type="button" onClick={copyDemoKey}>Copy key</button>
                </div>
              ) : (
                <p>{demoReady ? "No demo keys are available in this browser yet." : "Loading demo keys…"}</p>
              )}
            </div>
          </div>
        ) : (
          <form className="card" onSubmit={sendApplication}>
            <label htmlFor="apply-name">Organisation name</label>
            <input
              id="apply-name"
              value={applyName}
              onChange={(e) => onApplyName(e.target.value)}
              placeholder="Otago Community Clinic"
            />
            <label htmlFor="apply-kind">Requested role</label>
            <select id="apply-kind" value={applyKind} onChange={(e) => onApplyKind(e.target.value)}>
              {ORG_KINDS.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
            <label htmlFor="apply-licence">Medsafe / HPI Licence ID</label>
            <input
              id="apply-licence"
              value={applyLicence}
              onChange={(e) => setApplyLicence(e.target.value)}
              placeholder="HPI-FAC-8821"
            />
            <label htmlFor="apply-contact">Contact email</label>
            <input
              id="apply-contact"
              type="email"
              value={applyContact}
              onChange={(e) => setApplyContact(e.target.value)}
              placeholder="clinic@otago.health.nz"
            />
            <label htmlFor="apply-address">Wallet public address (0x…)</label>
            <input
              id="apply-address"
              value={applyAddress}
              onChange={(e) => editApplyAddress(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="actions">
              <button className="btn" type="button" onClick={generateApplyWallet}>
                Generate wallet keypair
              </button>
              <button className="btn" type="button" onClick={useMetaMaskAddress}>
                Use MetaMask address
              </button>
            </div>
            {applyKey && (
              <div className="keypair">
                <p>Public address</p>
                <p className="mono">{applyAddress}</p>
                <p>Private key</p>
                <p className="mono">{applyKey}</p>
                <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(applyKey)}>
                  Copy private key
                </button>
              </div>
            )}
            <div className="actions">
              <button className="btn primary" type="submit" disabled={applyBusy || !isAddress(applyAddress)}>
                {applyBusy ? "Sending…" : "Send public address & licence to Admin"}
              </button>
            </div>
            {applyOk && <p className="okbox">{applyOk}</p>}
            {shownWaiting.length > 0 && (
              <div className="app-list">
                <h3>Applications on this browser</h3>
                {shownWaiting.map((row) => {
                  const badge = waitingBadge(row);
                  return (
                    <div className="app-row" key={row.address}>
                      <div>
                        <b>{row.label || shortAddr(row.address)}</b>
                        <div className="mono">{shortAddr(row.address)}</div>
                      </div>
                      <div className="row-actions">
                        <span className={`badge ${badge.tone}`}>{badge.text}</span>
                        {row.privateKey && (
                          <button className="btn" type="button" onClick={() => pick(row)}>
                            {row.status === "rejected" ? "Amend & resubmit" : "Open"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </form>
        )}
      </main>
    );
  }

  const role = session.account.role;
  const tabs = tabsFor(role, session.roles);

  return (
    <main className="wrap portal">
      <aside className="side">
        <div className="card">
          <div className="kicker">{role}</div>
          <strong>{session.account.label}</strong>
          <div className="mono wallet">{shortAddr(session.address)}</div>
        </div>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`btn ${tab === t.id ? "active" : ""}`}
            onClick={() => { setErr(""); setTab(t.id); }}
          >
            {t.label}
          </button>
        ))}
        <button
          className="btn"
          type="button"
          onClick={() => {
            setKeyInput("");
            setErr("");
            setApplyOk("");
            setTab("overview");
            setGateTab("signin");
            logout();
          }}
        >
          Log out
        </button>
      </aside>
      <section>
        {err && <p className="flash">{err}</p>}
        <Workbench
          session={session}
          setSession={setSession}
          tab={tab}
          setTab={(next) => { setErr(""); setTab(next); }}
          setErr={setErr}
        />
      </section>
    </main>
  );
}

function AdminPage({ session, setSession, logout }) {
  const [demo, setDemo] = useState({ accounts: [] });
  const [deployment, setDeployment] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("overview");
  const [passphrase, setPassphrase] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadDemoAccounts().then(setDemo).catch(() => {});
    loadDeployment().then(setDeployment).catch((e) => setErr(friendlyError(e)));
  }, []);

  useEffect(() => {
    if (session) return;
    setPassphrase("");
    setAdminKey("");
    setErr("");
  }, [session]);

  async function adminAccount() {
    const loaded = demo.accounts.length ? demo.accounts : (await loadDemoAccounts()).accounts || [];
    return loaded.find((a) => a.role === "admin") || null;
  }

  async function openAdmin(conn, fallback) {
    if (!deployment) throw new Error("Contract is not deployed yet. Run `npm run demo`.");
    const c = contractWith(deployment, conn.signer);
    const known = await adminAccount();
    const profile = await resolveProfile(c, conn.address, fallback || known);
    if (!isAdminSession(profile)) throw new Error("This wallet is not the Network Admin.");
    if (known && known.address.toLowerCase() === conn.address.toLowerCase()) {
      const phrase = passphrase.trim();
      if (!phrase) throw new Error("Admin passphrase is required.");
      await api("/api/admin/unlock", { method: "POST", body: { passphrase: phrase } });
    }
    setSession({ ...conn, ...profile, contract: c, deployment });
    setTab("overview");
    setPassphrase("");
    setAdminKey("");
    setErr("");
  }

  async function login(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const raw = adminKey.trim();
      if (raw) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
          throw new Error("Enter a 64-character 0x admin private key.");
        }
        const conn = await connectDemo(raw);
        const admin = await adminAccount();
        const fallback = admin && admin.address.toLowerCase() === conn.address.toLowerCase() ? admin : null;
        await openAdmin(conn, fallback);
        return;
      }
      const phrase = passphrase.trim();
      if (!phrase) throw new Error("Enter the admin passphrase, or an admin private key.");
      const admin = await adminAccount();
      if (!admin?.privateKey) throw new Error("Network admin wallet is not available.");
      await openAdmin(await connectDemo(admin.privateKey), admin);
    } catch (error) {
      setErr(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function metamask() {
    setErr("");
    setBusy(true);
    try {
      if (!deployment) throw new Error("Contract is not deployed yet. Run `npm run demo`.");
      const conn = await connectMetaMask(deployment);
      const admin = await adminAccount();
      const fallback = admin && admin.address.toLowerCase() === conn.address.toLowerCase() ? admin : null;
      await openAdmin(conn, fallback);
    } catch (error) {
      setErr(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  if (!isAdminSession(session)) {
    return (
      <main className="wrap">
        <form className="card admin-signin" onSubmit={login} autoComplete="off">
          <div className="kicker">Restricted</div>
          <h2>Network Admin Console — Sign In</h2>
          <p>Sign in with the admin passphrase, or with the admin private key or MetaMask.</p>
          {err && <p className="flash">{err}</p>}
          <label>Admin passphrase</label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Admin passphrase (default: vaxtrace-admin)"
            autoComplete="new-password"
          />
          <div className="or-divider">or</div>
          <label>Admin private key (0x…)</label>
          <input
            type="password"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            placeholder="0x…"
            autoComplete="new-password"
            spellCheck={false}
          />
          <button className="btn block" type="button" onClick={metamask} disabled={busy}>
            Log in with MetaMask
          </button>
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Checking…" : "Log in to Admin Console"}
            </button>
          </div>
        </form>
      </main>
    );
  }

  const tabs = tabsFor("admin", session.roles);

  return (
    <main className="wrap portal">
      <aside className="side">
        <div className="card">
          <div className="kicker">admin</div>
          <strong>VaxTrace network admin</strong>
          <div className="mono wallet">{shortAddr(session.address)}</div>
        </div>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`btn ${tab === t.id ? "active" : ""}`}
            onClick={() => { setErr(""); setTab(t.id); }}
          >
            {t.label}
          </button>
        ))}
        <button
          className="btn"
          type="button"
          onClick={() => {
            setPassphrase("");
            setAdminKey("");
            setErr("");
            logout();
          }}
        >
          Log out
        </button>
      </aside>
      <section>
        {err && <p className="flash">{err}</p>}
        <Workbench
          session={session}
          setSession={setSession}
          tab={tab}
          setTab={(next) => { setErr(""); setTab(next); }}
          setErr={setErr}
        />
      </section>
    </main>
  );
}

function tabsFor(role, roles = {}) {
  if (role === "admin" || roles.admin) {
    return [
      { id: "overview", label: "Overview" },
      { id: "orgs", label: "Organisations" },
      { id: "audit", label: "Audit & compliance" },
      { id: "trace", label: "Trace a batch" },
    ];
  }
  if (role === "regulator" || roles.regulator) {
    return [
      { id: "overview", label: "Overview" },
      { id: "regulate", label: "Recall & exceptions" },
      { id: "audit", label: "Audit & compliance" },
      { id: "trace", label: "Trace a batch" },
    ];
  }
  const common = [
    { id: "overview", label: "Overview" },
    { id: "trace", label: "Trace a batch" },
  ];
  if (role === "manufacturer") return [...common, { id: "register", label: "Register batch" }, { id: "move", label: "Transfer custody" }];
  if (role === "logistics") return [...common, { id: "accept", label: "Accept custody" }, { id: "move", label: "Transfer custody" }, { id: "iot", label: "Cold chain" }];
  if (role === "warehouse") return [...common, { id: "accept", label: "Accept custody" }, { id: "move", label: "Transfer custody" }, { id: "iot", label: "Cold chain" }];
  if (role === "clinic") return [...common, { id: "accept", label: "Accept delivery" }, { id: "admin", label: "Administer dose" }, { id: "ae", label: "Adverse event" }];
  if (role === "iot") return [...common, { id: "iot", label: "Cold chain" }];
  if (role === "unregistered" || role === "deactivated") {
    return [
      { id: "overview", label: "Accreditation" },
      { id: "trace", label: "Trace a batch" },
    ];
  }
  return common;
}

function UnregisteredPanel({ session, setSession, setErr }) {
  const [application, setApplication] = useState(undefined);
  const [chainOrg, setChainOrg] = useState(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("clinic");
  const [licenceId, setLicenceId] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState("");
  const modeLabel = session.mode === "metamask" ? "MetaMask" : "Local key";
  const deactivated =
    session.account.role === "deactivated" ||
    Boolean(chainOrg && !chainOrg.registered && chainOrg.kind);

  async function loadStatus() {
    const [org, data] = await Promise.all([
      session.contract.organisations(session.address),
      api("/api/org-applications"),
    ]);
    const rows = Array.isArray(data.applications) ? data.applications : [];
    const snapshot = {
      name: org.name || "",
      kind: org.kind || "",
      registered: Boolean(org.registered),
    };
    setChainOrg(snapshot);
    setApplication(
      rows.find((row) => String(row.address || "").toLowerCase() === session.address.toLowerCase()) || null
    );
    return snapshot;
  }

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [org, data] = await Promise.all([
          session.contract.organisations(session.address),
          api("/api/org-applications"),
        ]);
        if (cancel) return;
        const rows = Array.isArray(data.applications) ? data.applications : [];
        setChainOrg({
          name: org.name || "",
          kind: org.kind || "",
          registered: Boolean(org.registered),
        });
        setApplication(
          rows.find((row) => String(row.address || "").toLowerCase() === session.address.toLowerCase()) || null
        );
      } catch (err) {
        if (!cancel) {
          setChainOrg({ name: "", kind: "", registered: false });
          setApplication(null);
          setErr(friendlyError(err));
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [session.address, session.contract, setErr]);

  useEffect(() => {
    if (!application || application.status !== "rejected") return;
    setName(application.name || "");
    setKind(ORG_KINDS.includes(application.kind) ? application.kind : "clinic");
    setLicenceId(application.licenceId || "");
    setContact(application.contact || "");
  }, [application]);

  async function checkApproval() {
    setChecking(true);
    setNote("");
    setErr("");
    try {
      const profile = await resolveProfile(session.contract, session.address, session.account);
      const ready =
        profile.roles.admin ||
        (profile.account.registered && profile.account.role !== "unregistered" && profile.account.role !== "deactivated");
      if (ready) {
        setSession({ ...session, ...profile });
        return;
      }
      const snapshot = await loadStatus();
      setNote(
        snapshot.kind && !snapshot.registered
          ? "This organisation is still deactivated on-chain."
          : "Still waiting for Network Admin approval on-chain."
      );
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setChecking(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setNote("");
    setErr("");
    try {
      const trimmed = name.trim();
      const licence = licenceId.trim();
      const email = contact.trim();
      if (!trimmed) throw new Error("Organisation name is required.");
      if (!ORG_KINDS.includes(kind)) throw new Error("Choose a role.");
      await api("/api/org-applications", {
        method: "POST",
        body: { address: session.address, name: trimmed, kind, licenceId: licence, contact: email },
      });
      const saved = loadCustomWallets().find(
        (wallet) => wallet.address.toLowerCase() === session.address.toLowerCase()
      );
      if (saved?.privateKey) {
        saveCustomWallet({ role: kind, label: trimmed, address: session.address, privateKey: saved.privateKey });
      }
      setApplication({
        address: session.address,
        name: trimmed,
        kind,
        licenceId: licence,
        contact: email,
        status: "pending",
      });
      setNote("");
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const pending = !deactivated && application?.status === "pending";
  const rejectedApp = !deactivated && application?.status === "rejected" ? application : null;

  return (
    <article className="card">
      <div className="kicker">Organisation onboarding</div>
      <div className="identity">
        <div>
          <div className="kicker">Connected wallet</div>
          <div className="mono">{session.address}</div>
        </div>
        <div>
          <div className="kicker">Connection</div>
          <b>{modeLabel}</b>
        </div>
      </div>
      {deactivated ? (
        <div className="flash">
          <b>Organisation deactivated by Network Admin</b>
          <p>
            {(chainOrg?.name || session.account.label)}
            {chainOrg?.kind ? ` (${chainOrg.kind})` : ""} had its role revoked on-chain.
            Historical custody records stay on the ledger. The Network Admin must reactivate the organisation before this wallet can open a desk.
          </p>
          <button className="btn" type="button" onClick={checkApproval} disabled={checking}>
            {checking ? "Checking…" : "Check approval status"}
          </button>
        </div>
      ) : pending ? (
        <div className="warnbox">
          <b>Application pending Network Admin approval</b>
          <p>
            Requested organisation <strong>{application.name}</strong>
            {" "}· role <span className="badge">{application.kind}</span>
          </p>
          <button className="btn primary" type="button" onClick={checkApproval} disabled={checking}>
            {checking ? "Checking…" : "Check approval status"}
          </button>
        </div>
      ) : application === undefined ? (
        <p>Checking accreditation status…</p>
      ) : (
        <form onSubmit={submit}>
          {rejectedApp && (
            <div className="flash reject-banner" role="status">
              Your previous accreditation request for <strong>{rejectedApp.name}</strong> ({rejectedApp.kind}) was rejected by the Network Admin. You may update your organisation details below and resubmit for review.
            </div>
          )}
          <h2>Request organisation accreditation for this wallet</h2>
          <label>Organisation name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Otago Community Clinic" />
          <label>Requested role</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {ORG_KINDS.map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <label>Medsafe / HPI Licence ID</label>
          <input value={licenceId} onChange={(e) => setLicenceId(e.target.value)} placeholder="HPI-FAC-8821" />
          <label>Contact email</label>
          <input type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="clinic@otago.health.nz" />
          <label>Wallet address</label>
          <input value={session.address} readOnly />
          <div className="actions">
            <button className="btn primary" disabled={busy}>
              {busy ? "Sending…" : rejectedApp ? "Resubmit for review" : "Submit to Network Admin for approval"}
            </button>
          </div>
        </form>
      )}
      {note && <p className="okbox">{note}</p>}
    </article>
  );
}

function Workbench({ session, setSession, tab, setTab, setErr }) {
  const [batches, setBatches] = useState([]);
  const [inbound, setInbound] = useState([]);
  const [orgs, setOrgs] = useState({});
  const [orgList, setOrgList] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const isAdmin = session.account.role === "admin" || session.roles?.admin;

  async function refresh() {
    const all = await loadAllBatches(session.contract);
    setBatches(all);
    const incoming = await loadInbound(session.contract, session.address, all);
    setInbound(incoming);
    const registered = await loadOrganisations(session.contract);
    setOrgList(registered);
    const names = await loadOrgMap(session.contract, [
      ...all.flatMap((b) => [b.manufacturer, b.currentCustodian]),
      ...incoming.map((row) => row.from),
      ...registered.map((org) => org.address),
      session.address,
    ]);
    for (const org of registered) {
      if (org.registered && org.name) names[org.address.toLowerCase()] = org.name;
    }
    setOrgs(names);
  }

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((e) => setErr(friendlyError(e)))
      .finally(() => setLoading(false));
  }, [session.address, tab]);

  const mine = batches.filter((b) => b.currentCustodian.toLowerCase() === session.address.toLowerCase());
  const breaches = batches.filter((b) => b.coldChainBreached && b.statusLabel !== "Recalled");
  const wide = isAdmin || session.account.role === "regulator";

  if (tab === "overview" && needsAccreditation(session)) {
    return <UnregisteredPanel session={session} setSession={setSession} setErr={setErr} />;
  }

  if (tab === "overview") {
    const next = [];
    if (isAdmin) next.push({ label: "Onboard or review network organisations", go: "orgs" });
    if (session.account.role === "manufacturer" && !mine.length) {
      next.push({ label: "Register a new lot", go: "register" });
    }
    if (inbound.length) next.push({ label: `Accept ${inbound.length} inbound transfer${inbound.length === 1 ? "" : "s"}`, go: "accept" });
    if (session.account.role === "clinic" && mine.length) next.push({ label: "Record a dose from stock on hand", go: "admin" });
    if (session.account.role === "regulator" && breaches.length) {
      next.push({ label: `Review ${breaches.length} cold-chain breach${breaches.length === 1 ? "" : "es"}`, go: "regulate" });
    }
    if (mine.length && ["manufacturer", "logistics", "warehouse"].includes(session.account.role)) {
      next.push({ label: "Send a lot to the next holder", go: "move" });
    }
    const vials = batches.reduce(
      (sum, b) => sum + (wide || b.currentCustodian.toLowerCase() === session.address.toLowerCase() ? b.remainingVials : 0),
      0
    );
    return (
      <div className="grid">
        {loading && <p className="card">Loading the ledger…</p>}
        <div className="stats">
          {isAdmin ? (
            <>
              <div className="stat">
                <b>{batches.length}</b>
                <span>lots on network</span>
              </div>
              <div className="stat">
                <b>{orgList.length}</b>
                <span>registered organisations</span>
              </div>
              <div className="stat">
                <b>{breaches.length}</b>
                <span>cold-chain flags</span>
              </div>
              <div className="stat">
                <b>{vials}</b>
                <span>vials remaining</span>
              </div>
            </>
          ) : (
            <>
              <div className="stat">
                <b>{session.account.role === "regulator" ? batches.length : mine.length}</b>
                <span>{session.account.role === "regulator" ? "lots on network" : "in your custody"}</span>
              </div>
              <div className="stat">
                <b>{inbound.length}</b>
                <span>waiting to accept</span>
              </div>
              <div className="stat">
                <b>{breaches.length}</b>
                <span>cold-chain flags</span>
              </div>
              <div className="stat">
                <b>{vials}</b>
                <span>vials remaining</span>
              </div>
            </>
          )}
        </div>
        {next.length > 0 && (
          <article className="card">
            <div className="kicker">Up next</div>
            {next.map((item) => (
              <div className="next" key={item.go + item.label}>
                <span>{item.label}</span>
                <button className="btn primary" onClick={() => setTab(item.go)}>Continue</button>
              </div>
            ))}
          </article>
        )}
        {inbound.length > 0 && (
          <article className="card">
            <div className="kicker">Inbound</div>
            <h2>Lots waiting for you</h2>
            {inbound.map((row) => (
              <div className="inbound" key={row.batch.id}>
                <div>
                  <b>#{row.batch.id} {row.batch.vaccineName}</b>
                  <div className="mono">from {who(row.from, orgs)} · due {when(row.expected)}</div>
                </div>
                <button className="btn primary" onClick={() => setTab("accept")}>Review</button>
              </div>
            ))}
          </article>
        )}
        <BatchTable
          batches={wide ? batches : mine}
          orgs={orgs}
          empty={
            wide
              ? "No batches on the ledger yet."
              : "You are not holding any batches. Register one or accept an inbound transfer."
          }
        />
      </div>
    );
  }
  if (tab === "register") return <RegisterForm session={session} onDone={refresh} setErr={setErr} busy={busy} setBusy={setBusy} />;
  if (tab === "move") return <TransferForm session={session} batches={mine} orgList={orgList} onDone={refresh} setErr={setErr} />;
  if (tab === "accept") return <AcceptForm session={session} batches={batches} orgs={orgs} onDone={refresh} setErr={setErr} />;
  if (tab === "iot") return <IotForm session={session} batches={batches} onDone={refresh} setErr={setErr} />;
  if (tab === "admin") return <AdminForm session={session} batches={mine} onDone={refresh} setErr={setErr} />;
  if (tab === "ae") return <AdverseForm session={session} batches={mine.length ? mine : batches} onDone={refresh} setErr={setErr} />;
  if (tab === "regulate") return <RegulateForm session={session} batches={batches} onDone={refresh} setErr={setErr} />;
  if (tab === "orgs") return <OrgAdminPanel session={session} orgList={orgList} batches={batches} onDone={refresh} setErr={setErr} />;
  if (tab === "audit") return <AuditPanel session={session} setErr={setErr} />;
  if (tab === "trace") return <TracePanel session={session} batches={batches} orgs={orgs} />;
  return null;
}

function BatchTable({ batches, orgs = {}, empty = "No batches on the ledger yet.", onInspect, kicker = "Lots", heading }) {
  const [q, setQ] = useState("");
  if (!batches.length) {
    if (!heading) return <p className="card">{empty}</p>;
    return (
      <div className="card">
        <div className="kicker">{kicker}</div>
        <h2>{heading}</h2>
        <p>{empty}</p>
      </div>
    );
  }
  const filtered = batches.filter((b) => {
    const hay = `${b.id} ${b.vaccineName} ${b.lotNumber} ${b.statusLabel} ${who(b.currentCustodian, orgs)}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div className="kicker">{kicker}</div>
      {heading && <h2>{heading}</h2>}
      {batches.length > 3 && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by lot, vaccine, status or holder"
          style={{ marginBottom: "0.8rem" }}
        />
      )}
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Vaccine</th>
            <th>Lot</th>
            <th>Status</th>
            <th>Holder</th>
            <th>Vials</th>
            <th>Cold chain</th>
            {onInspect && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {filtered.map((b) => (
            <tr key={b.id}>
              <td className="mono">{b.id}</td>
              <td>{b.vaccineName}</td>
              <td className="mono">{b.lotNumber}</td>
              <td><span className={`badge ${statusTone(b.statusLabel)}`}>{b.statusLabel}</span></td>
              <td>{who(b.currentCustodian, orgs)}</td>
              <td>{b.remainingVials}/{b.vialCount}</td>
              <td>
                {b.coldChainBreached && b.exceptionAuthorised ? (
                  <span className="badge gold">breach (exception)</span>
                ) : b.coldChainBreached ? (
                  <span className="badge danger">breach</span>
                ) : (
                  <span className="badge">intact</span>
                )}
              </td>
              {onInspect && (
                <td>
                  <button className="btn" type="button" onClick={() => onInspect(b)}>Inspect</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {q && !filtered.length && <p>No lots match that filter.</p>}
    </div>
  );
}

function RegisterForm({ session, onDone, setErr, busy, setBusy }) {
  const [form, setForm] = useState({
    vaccineName: "Comirnaty 30mcg",
    lotNumber: `SB-${Math.floor(Math.random() * 9000 + 1000)}`,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 300).toISOString().slice(0, 10),
    tempMin: "2",
    tempMax: "8",
    vialCount: "20",
    notes: "Certificate of analysis stored off-chain.",
  });

  const [ok, setOk] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setOk("");
    try {
      if (!form.vaccineName.trim() || !form.lotNumber.trim()) {
        throw new Error("Vaccine name and lot number are required.");
      }
      const vials = Number(form.vialCount);
      if (!Number.isInteger(vials) || vials < 1) throw new Error("Vial count must be a whole number greater than zero.");
      const minC = Number(form.tempMin);
      const maxC = Number(form.tempMax);
      if (!Number.isFinite(minC) || !Number.isFinite(maxC) || minC >= maxC) {
        throw new Error("Minimum temperature must be below maximum.");
      }
      const expires = dateInputToUnix(form.expiresAt);
      if (expires <= Math.floor(Date.now() / 1000)) throw new Error("Expiry must be in the future.");
      const off = await api("/api/offchain", {
        method: "POST",
        address: session.address,
        body: { kind: "document", batchId: "", payload: { notes: form.notes, lotNumber: form.lotNumber } },
      });
      const tx = await session.contract.registerBatch(
        form.vaccineName.trim(),
        form.lotNumber.trim(),
        expires,
        Math.round(minC * 100),
        Math.round(maxC * 100),
        vials,
        off.bytes32
      );
      await tx.wait();
      await onDone();
      setOk(`Lot ${form.lotNumber.trim()} is on the ledger.`);
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="kicker">Manufacturer portal</div>
      <h2>Register a batch</h2>
      <label>Vaccine</label>
      <input value={form.vaccineName} onChange={(e) => setForm({ ...form, vaccineName: e.target.value })} />
      <label>Lot number</label>
      <input value={form.lotNumber} onChange={(e) => setForm({ ...form, lotNumber: e.target.value })} />
      <div className="grid cols-2">
        <div>
          <label>Expiry</label>
          <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        </div>
        <div>
          <label>Vial count</label>
          <input type="number" value={form.vialCount} onChange={(e) => setForm({ ...form, vialCount: e.target.value })} />
        </div>
        <div>
          <label>Min °C</label>
          <input value={form.tempMin} onChange={(e) => setForm({ ...form, tempMin: e.target.value })} />
        </div>
        <div>
          <label>Max °C</label>
          <input value={form.tempMax} onChange={(e) => setForm({ ...form, tempMax: e.target.value })} />
        </div>
      </div>
      <label>Manufacturing notes (off-chain)</label>
      <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      <div style={{ marginTop: "1rem" }}>
        <button className="btn primary" disabled={busy}>
          {busy ? "Signing…" : "Commit identity to the ledger"}
        </button>
      </div>
      {ok && <p className="okbox">{ok}</p>}
    </form>
  );
}

function TransferForm({ session, batches, orgList = [], onDone, setErr }) {
  const [demo, setDemo] = useState({ accounts: [] });
  const [batchId, setBatchId] = useBoundId(batches);
  const [to, setTo] = useState("");
  const [hours, setHours] = useState("48");
  const [ok, setOk] = useState("");

  useEffect(() => {
    loadDemoAccounts().then(setDemo);
  }, []);

  const destinations = destinationsFor(orgList, demo.accounts, session.address);

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setOk("");
    try {
      const waitHours = Number(hours);
      if (!Number.isFinite(waitHours) || waitHours <= 0) throw new Error("Expected delivery hours must be greater than zero.");
      if (!to) throw new Error("Choose a recipient.");
      const expected = Math.floor(Date.now() / 1000) + waitHours * 3600;
      const tx = await session.contract.initiateTransfer(batchId, to, expected);
      await tx.wait();
      await onDone();
      setOk(`Transfer of batch #${batchId} is waiting for the recipient to accept.`);
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  async function pack(id) {
    setErr("");
    setOk("");
    try {
      const tx = await session.contract.recordPackaging(id, "0x" + "0".repeat(64));
      await tx.wait();
      await onDone();
      setOk(`Batch #${id} marked packaged.`);
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  return (
    <div className="grid">
      <form className="card" onSubmit={submit}>
        <div className="kicker">Custody</div>
        <h2>Hand a batch to the next holder</h2>
        <label>Batch</label>
        {batches.length ? (
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                #{b.id} {b.vaccineName} ({b.statusLabel})
              </option>
            ))}
          </select>
        ) : (
          <p>You have no batch in custody to send.</p>
        )}
        <label>Recipient</label>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Select organisation</option>
          {destinations.map((a) => (
            <option key={a.address} value={a.address}>
              {a.label}
            </option>
          ))}
        </select>
        <label>Expected delivery (hours)</label>
        <input value={hours} onChange={(e) => setHours(e.target.value)} />
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          <button className="btn primary" disabled={!batchId || !to}>
            Initiate transfer
          </button>
          <button className="btn" type="button" disabled={!batchId} onClick={() => pack(batchId)}>
            Mark packaged
          </button>
        </div>
        {ok && <p className="okbox">{ok}</p>}
      </form>
    </div>
  );
}

function AcceptForm({ session, batches, orgs = {}, onDone, setErr }) {
  const [pending, setPending] = useState([]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const rows = [];
      for (const b of batches) {
        const p = await session.contract.pendingTransfers(b.id);
        if (p.pending && p.to.toLowerCase() === session.address.toLowerCase()) {
          rows.push({ batch: b, from: p.from, expected: Number(p.expectedDeliveryBy) });
        }
      }
      if (!cancel) setPending(rows);
    })();
    return () => {
      cancel = true;
    };
  }, [batches, session.address]);

  async function accept(id) {
    setErr("");
    try {
      const tx = await session.contract.acceptCustody(id);
      await tx.wait();
      await onDone();
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  if (!pending.length) return <p className="card">No inbound transfers waiting for this wallet.</p>;
  return (
    <div className="card">
      <h2>Inbound custody</h2>
      {pending.map((p) => (
        <div key={p.batch.id} style={{ marginBottom: "0.8rem" }}>
          <b>#{p.batch.id} {p.batch.vaccineName}</b>
          <div className="mono">from {who(p.from, orgs)} · due {when(p.expected)}</div>
          <button className="btn primary" onClick={() => accept(p.batch.id)}>
            Accept custody
          </button>
        </div>
      ))}
    </div>
  );
}

function IotForm({ session, batches, onDone, setErr }) {
  const canCheckpoint = Boolean(session.roles?.logistics || session.roles?.warehouse);
  const [mode, setMode] = useState("reading");
  const [note, setNote] = useState("");
  const [batchId, setBatchId] = useBoundId(batches);
  const [temp, setTemp] = useState("5.0");
  const [ok, setOk] = useState("");
  const checkpoint = canCheckpoint && mode === "checkpoint";
  const asWarehouse =
    session.account.role === "warehouse" ||
    (session.roles?.warehouse && !session.roles?.logistics && session.account.role !== "logistics");

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setOk("");
    try {
      const celsius = Number(temp);
      if (!Number.isFinite(celsius) || celsius < -80 || celsius > 80) {
        throw new Error("Temperature must be a number between -80 and 80 °C.");
      }
      const centi = Math.round(celsius * 100);
      if (checkpoint) {
        if (!note.trim()) throw new Error("Add a location or bay note for this checkpoint.");
        const zero = "0x" + "0".repeat(64);
        const tx = asWarehouse
          ? await session.contract.recordStorage(batchId, centi, zero, note.trim())
          : await session.contract.recordTransport(batchId, centi, zero, note.trim());
        await tx.wait();
        await onDone();
        setOk(asWarehouse ? "Storage checkpoint recorded on-chain." : "Transport checkpoint recorded on-chain.");
        return;
      }
      const result = await api("/api/iot/reading", {
        method: "POST",
        address: session.address,
        body: { batchId, temperatureCenti: centi, source: "portal-probe" },
      });
      await onDone();
      setOk(
        result.onChain && result.onChain.breached
          ? `${celsius.toFixed(1)} °C recorded and flagged as a cold-chain breach.`
          : `${celsius.toFixed(1)} °C recorded on-chain.`
      );
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="kicker">IoT cold-chain module</div>
      <h2>{checkpoint ? "Record a custody checkpoint" : "Record a temperature"}</h2>
      <p>
        {checkpoint
          ? "The note is written on-chain with the temperature. Logistics records transport; a warehouse records storage."
          : "Readings are stored encrypted off-chain. The oracle posts the hash and value on-chain; a breach flags the batch."}
      </p>
      {canCheckpoint && (
        <>
          <label>Reading type</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="reading">IoT oracle reading (off-chain + chain)</option>
            <option value="checkpoint">Custody checkpoint (on-chain transport / storage note)</option>
          </select>
        </>
      )}
      <label>Batch</label>
      <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>#{b.id} {b.vaccineName}</option>
        ))}
      </select>
      <label>Temperature °C</label>
      <input value={temp} onChange={(e) => setTemp(e.target.value)} />
      {checkpoint && (
        <>
          <label>Location or bay</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Truck, route, or warehouse bay" />
        </>
      )}
      <div style={{ marginTop: "1rem" }}>
        <button className="btn primary" disabled={!batchId}>
          {checkpoint ? "Record checkpoint" : "Submit reading"}
        </button>
      </div>
      {ok && <p className="okbox">{ok}</p>}
    </form>
  );
}

function AdminForm({ session, batches, onDone, setErr }) {
  const [batchId, setBatchId] = useBoundId(batches);
  const [form, setForm] = useState({
    nhi: "ZZZ1234",
    name: "Alexandra Chen",
    dob: "1988-03-12",
    site: "Left deltoid",
  });
  const [done, setDone] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setDone(null);
    try {
      if (!form.nhi.trim() || !form.name.trim()) throw new Error("NHI and full name are required.");
      const batch = batches.find((b) => String(b.id) === String(batchId));
      if (!batch) throw new Error("This clinic has no batch in custody.");
      if (batch.coldChainBreached && !batch.exceptionAuthorised) {
        throw new Error("This batch has a cold-chain breach. Ask the regulator to authorise an exception first.");
      }
      const ben = await api("/api/offchain", {
        method: "POST",
        address: session.address,
        body: {
          kind: "beneficiary",
          batchId,
          payload: { nhi: form.nhi, name: form.name, dob: form.dob, vaccineName: batch?.vaccineName, lotNumber: batch?.lotNumber },
        },
      });
      const clin = await api("/api/offchain", {
        method: "POST",
        address: session.address,
        body: {
          kind: "clinical",
          batchId,
          payload: { site: form.site, vaccineName: batch?.vaccineName, lotNumber: batch?.lotNumber },
        },
      });
      const tx = await session.contract.administerDose(batchId, ben.bytes32, clin.bytes32);
      await tx.wait();
      setDone({ beneficiary: ben.sha256, clinical: clin.sha256 });
      await onDone();
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="kicker">Vaccination centre</div>
      <h2>Administer a dose</h2>
      <p>Name, NHI and notes never go on-chain. The contract stores two hashes.</p>
      <label>Batch in clinic custody</label>
      <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>
            #{b.id} {b.vaccineName} · {b.remainingVials} vials
          </option>
        ))}
      </select>
      <label>NHI</label>
      <input value={form.nhi} onChange={(e) => setForm({ ...form, nhi: e.target.value })} />
      <label>Full name</label>
      <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label>Date of birth</label>
      <input type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} />
      <label>Injection site</label>
      <input value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} />
      <div style={{ marginTop: "1rem" }}>
        <button className="btn primary" disabled={!batchId}>Record administration</button>
      </div>
      {done && (
        <p className="okbox mono">
          beneficiary hash {done.beneficiary}
          <br />
          clinical hash {done.clinical}
        </p>
      )}
    </form>
  );
}

function AdverseForm({ session, batches, onDone, setErr }) {
  const [batchId, setBatchId] = useBoundId(batches);
  const [notes, setNotes] = useState("Patient reported fever within 24 hours.");
  const [ok, setOk] = useState("");

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setOk("");
    try {
      if (!notes.trim()) throw new Error("Describe the adverse event.");
      const off = await api("/api/offchain", {
        method: "POST",
        address: session.address,
        body: { kind: "adverse", batchId, payload: { notes: notes.trim() } },
      });
      const tx = await session.contract.reportAdverseEvent(batchId, off.bytes32);
      await tx.wait();
      await onDone();
      setOk("Adverse event hashed on-chain. Clinical notes stay off-chain.");
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="kicker">Pharmacovigilance</div>
      <h2>Report an adverse event</h2>
      <p>The ledger stores only a hash. The description is encrypted off-chain.</p>
      <label>Related batch</label>
      <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>#{b.id} {b.vaccineName}</option>
        ))}
      </select>
      <label>Clinical notes</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div style={{ marginTop: "1rem" }}>
        <button className="btn primary" disabled={!batchId}>File report</button>
      </div>
      {ok && <p className="okbox">{ok}</p>}
    </form>
  );
}

function OrgAdminPanel({ session, orgList, batches, onDone, setErr }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("clinic");
  const [address, setAddress] = useState("");
  const [generatedKey, setGeneratedKey] = useState("");
  const [generatedFor, setGeneratedFor] = useState("");
  const [lastSavedKey, setLastSavedKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [apps, setApps] = useState([]);
  const [appsError, setAppsError] = useState("");
  const [appsVersion, setAppsVersion] = useState(0);
  const [pendingKinds, setPendingKinds] = useState({});
  const [orgKinds, setOrgKinds] = useState({});
  const localWallets = loadCustomWallets();
  const pending = apps.filter((app) => app.status === "pending");

  function pendingKind(app) {
    const picked = pendingKinds[String(app.address || "").toLowerCase()];
    if (ORG_KINDS.includes(picked)) return picked;
    return ORG_KINDS.includes(app.kind) ? app.kind : "clinic";
  }

  function orgKindChoice(org) {
    const picked = orgKinds[org.address.toLowerCase()];
    if (ORG_KINDS.includes(picked)) return picked;
    return ORG_KINDS.includes(org.kind) ? org.kind : "clinic";
  }

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const data = await api("/api/org-applications");
        if (cancel) return;
        setApps(Array.isArray(data.applications) ? data.applications : []);
        setAppsError("");
      } catch (err) {
        if (!cancel) setAppsError(friendlyError(err));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [session.address, appsVersion]);

  function held(addr) {
    const key = addr.toLowerCase();
    return batches.filter((b) => b.currentCustodian.toLowerCase() === key).length;
  }

  function generate() {
    const wallet = createRandomWallet();
    setAddress(wallet.address);
    setGeneratedKey(wallet.privateKey);
    setGeneratedFor(wallet.address);
  }

  function editAddress(value) {
    setAddress(value);
    if (generatedFor && value.trim().toLowerCase() !== generatedFor.toLowerCase()) {
      setGeneratedKey("");
      setGeneratedFor("");
    }
  }

  async function approve(app) {
    setErr("");
    setOk("");
    setLastSavedKey(null);
    setBusy(true);
    try {
      const chosenKind = pendingKind(app);
      if (!ROLE_METHODS[chosenKind]) throw new Error("Choose a role.");
      const roleBytes32 = await session.contract[ROLE_METHODS[chosenKind]]();
      const tx = await session.contract.registerOrganisation(app.address, app.name, chosenKind, roleBytes32, {
        value: BigInt("1000000000000000000"),
      });
      await tx.wait();
      await onDone();
      await api(`/api/org-applications/${app.address}/status`, {
        method: "POST",
        address: session.address,
        body: { status: "approved", kind: chosenKind },
      });
      setAppsVersion((n) => n + 1);
      setOk(`Approved ${app.name} (${chosenKind}) on-chain and funded 1 ETH for gas.`);
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function reject(app) {
    setErr("");
    setOk("");
    setLastSavedKey(null);
    setBusy(true);
    try {
      await api(`/api/org-applications/${app.address}/status`, {
        method: "POST",
        address: session.address,
        body: { status: "rejected" },
      });
      setApps((prev) => prev.filter((row) => String(row.address).toLowerCase() !== app.address.toLowerCase()));
      setOk(`Rejected ${app.name}.`);
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(org) {
    setErr("");
    setOk("");
    setLastSavedKey(null);
    setBusy(true);
    try {
      const tx = await session.contract.deactivateOrganisation(org.address);
      await tx.wait();
      await onDone();
      await markApplication(org.address, "deactivated", session.address);
      setAppsVersion((n) => n + 1);
      setOk(`Deactivated ${org.name}. All roles revoked on-chain; historical custody records remain intact.`);
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function updateRole(org) {
    setErr("");
    setOk("");
    setLastSavedKey(null);
    setBusy(true);
    try {
      const newRole = orgKindChoice(org);
      if (!ROLE_METHODS[newRole]) throw new Error("Choose a role.");
      const roleBytes32 = await session.contract[ROLE_METHODS[newRole]]();
      const tx = await session.contract.registerOrganisation(org.address, org.name, newRole, roleBytes32);
      await tx.wait();
      await onDone();
      setOk(`Updated ${org.name} role to ${newRole} on-chain.`);
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function reactivate(org) {
    setErr("");
    setOk("");
    setLastSavedKey(null);
    setBusy(true);
    try {
      if (!ROLE_METHODS[org.kind]) throw new Error("Choose a role.");
      const roleBytes32 = await session.contract[ROLE_METHODS[org.kind]]();
      const tx = await session.contract.registerOrganisation(org.address, org.name, org.kind, roleBytes32);
      await tx.wait();
      await onDone();
      await markApplication(org.address, "approved", session.address);
      setAppsVersion((n) => n + 1);
      setOk(`Reactivated ${org.name} (${org.kind}) on-chain.`);
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setOk("");
    setLastSavedKey(null);
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("Organisation name is required.");
      if (!ROLE_METHODS[kind]) throw new Error("Choose a role.");
      const wallet = address.trim();
      if (!isAddress(wallet)) throw new Error("Enter a valid wallet address.");
      const roleBytes32 = await session.contract[ROLE_METHODS[kind]]();
      const saveKey = generatedKey && generatedFor.toLowerCase() === wallet.toLowerCase();
      const tx = await session.contract.registerOrganisation(wallet, name.trim(), kind, roleBytes32, {
        value: saveKey ? BigInt("1000000000000000000") : 0n,
      });
      await tx.wait();
      if (saveKey) {
        const saved = { label: name.trim(), address: wallet, privateKey: generatedKey };
        saveCustomWallet({ role: kind, ...saved });
        setLastSavedKey(saved);
      } else {
        setLastSavedKey(null);
      }
      await onDone();
      await markApplication(wallet, "approved", session.address);
      setAppsVersion((n) => n + 1);
      setGeneratedKey("");
      setGeneratedFor("");
      setName("");
      setAddress("");
      setOk(
        `${name.trim()} is registered as ${kind}.${saveKey ? " Funded with 1 ETH and saved in this browser for the stakeholder quick-login." : ""} The organisation can now sign in on the stakeholder portal.`
      );
    } catch (err) {
      setErr(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      {ok && (
        <div className="okbox">
          <p>{ok}</p>
          {lastSavedKey && (
            <>
              <p className="mono">{lastSavedKey.privateKey}</p>
              <button
                className="btn"
                type="button"
                onClick={() => navigator.clipboard.writeText(lastSavedKey.privateKey)}
              >
                Copy key
              </button>
            </>
          )}
        </div>
      )}
      <div className="card">
        <div className="kicker">Applications</div>
        <h2>Pending Accreditation Requests</h2>
        {appsError && <p className="flash">{appsError}</p>}
        {pending.length ? (
          pending.map((app) => {
            const chosenKind = pendingKind(app);
            return (
              <article className="pending-app" key={app.address}>
                <b>{app.name}</b>
                <div>{app.licenceId || "—"} · {app.contact || "—"}</div>
                <div className="mono" title={app.address}>{shortAddr(app.address)}</div>
                <label htmlFor={`grant-${app.address}`}>Role to grant</label>
                <select
                  id={`grant-${app.address}`}
                  className="tight"
                  value={chosenKind}
                  onChange={(e) => setPendingKinds((prev) => ({
                    ...prev,
                    [app.address.toLowerCase()]: e.target.value,
                  }))}
                >
                  {ORG_KINDS.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <div className="row-actions">
                  <button className="btn primary" type="button" disabled={busy} onClick={() => approve(app)}>
                    Approve & grant role (1 ETH)
                  </button>
                  <button className="btn danger" type="button" disabled={busy} onClick={() => reject(app)}>
                    Reject
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          !appsError && <p>No pending applications.</p>
        )}
      </div>
      <div className="card" style={{ overflowX: "auto" }}>
        <div className="kicker">Network</div>
        <h2>Registered Network Organisations</h2>
        {orgList.length ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Current Role</th>
                <th>Address</th>
                <th>Held</th>
                <th>Status</th>
                <th>Change Role</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orgList.map((org) => {
                const saved = localWallets.find(
                  (w) => w.address.toLowerCase() === org.address.toLowerCase()
                );
                const staff = org.kind !== "admin";
                return (
                  <tr key={org.address}>
                    <td>{org.name}</td>
                    <td><span className={`badge kind-${org.kind}`}>{org.kind}</span></td>
                    <td className="mono" title={org.address}>{shortAddr(org.address)}</td>
                    <td>{held(org.address)}</td>
                    <td>
                      {org.registered ? (
                        <span className="badge">Active</span>
                      ) : (
                        <span className="badge danger">Deactivated</span>
                      )}
                    </td>
                    <td>
                      {staff ? (
                        <div className="row-actions">
                          <select
                            className="tight"
                            aria-label={`Change role for ${org.name}`}
                            value={orgKindChoice(org)}
                            onChange={(e) => setOrgKinds((prev) => ({
                              ...prev,
                              [org.address.toLowerCase()]: e.target.value,
                            }))}
                          >
                            {ORG_KINDS.map((role) => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                          <button className="btn" type="button" disabled={busy} onClick={() => updateRole(org)}>
                            Update role
                          </button>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {staff && org.registered && (
                          <button className="btn danger" type="button" disabled={busy} onClick={() => deactivate(org)}>
                            Deactivate
                          </button>
                        )}
                        {staff && !org.registered && (
                          <button className="btn" type="button" disabled={busy} onClick={() => reactivate(org)}>
                            Reactivate
                          </button>
                        )}
                        {saved?.privateKey && (
                          <button
                            className="btn"
                            type="button"
                            onClick={() => navigator.clipboard.writeText(saved.privateKey)}
                          >
                            Copy key
                          </button>
                        )}
                        {org.kind === "admin" && !saved?.privateKey && "—"}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p>No organisations registered yet.</p>
        )}
      </div>
      <form className="card" onSubmit={submit}>
        <div className="kicker">Direct onboarding</div>
        <h2>Register a Verified Organisation</h2>
        <p>Register a public address that is already verified. Generate demo wallet saves the key in this browser so it shows up in the stakeholder quick-login.</p>
        <label>Organisation name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Role</label>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {ORG_KINDS.map((role) => (
            <option key={role} value={role}>{role}</option>
          ))}
        </select>
        <label>Wallet address</label>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <input value={address} onChange={(e) => editAddress(e.target.value)} placeholder="0x…" />
          </div>
          <button className="btn" type="button" onClick={generate} style={{ whiteSpace: "nowrap" }}>
            Generate demo wallet
          </button>
        </div>
        {generatedKey && (
          <div className="keypair">
            <p>Submitting funds this key with 1 ETH and saves it for stakeholder sign-in.</p>
            <p className="mono">{generatedKey}</p>
            <button
              className="btn"
              type="button"
              onClick={() => navigator.clipboard.writeText(generatedKey)}
            >
              Copy private key
            </button>
          </div>
        )}
        <div style={{ marginTop: "1rem" }}>
          <button className="btn primary" disabled={busy}>
            {busy ? "Signing…" : "Register organisation"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AuditPanel({ session, setErr }) {
  const [payload, setPayload] = useState(null);
  const [health, setHealth] = useState(null);
  const [orgs, setOrgs] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [audit, live] = await Promise.all([
          api("/api/audit/logs", { address: session.address }),
          api("/api/health"),
        ]);
        const names = await loadOrgMap(session.contract, [
          ...(audit.logs || []).map((row) => row.actor),
          ...(audit.records || []).map((row) => row.createdBy),
        ]);
        if (cancel) return;
        setPayload(audit);
        setHealth(live);
        setOrgs(names);
      } catch (err) {
        if (!cancel) setErr(friendlyError(err));
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [session.address, session.contract, setErr]);

  if (loading) return <p className="card">Loading audit records…</p>;
  if (!payload) return <p className="card">Audit logs are not available for this role.</p>;

  const counts = payload.counts || {};
  const logs = payload.logs || [];
  const records = payload.records || [];

  return (
    <div className="grid">
      <div className="stats">
        <div className="stat">
          <b>{counts.records ?? 0}</b>
          <span>Encrypted off-chain records</span>
        </div>
        <div className="stat">
          <b>{counts.iotReadings ?? 0}</b>
          <span>IoT readings stored</span>
        </div>
        <div className="stat">
          <b>{counts.accessLogs ?? 0}</b>
          <span>Authorised PHI decryptions</span>
        </div>
      </div>
      <article className="card">
        <div className="kicker">Off-chain store</div>
        <h2>Active MongoDB URI</h2>
        <p className="mono" style={{ wordBreak: "break-all" }}>{health?.mongoUri || "—"}</p>
      </article>
      <article className="card" style={{ overflowX: "auto" }}>
        <div className="kicker">Access</div>
        <h2>PHI decryption log</h2>
        {logs.length ? (
          <table>
            <thead>
              <tr>
                <th>Actor</th>
                <th>SHA-256</th>
                <th>Action</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((row, i) => (
                <tr key={`${row.sha256 || "log"}-${i}`}>
                  <td>{who(row.actor, orgs)}</td>
                  <td className="mono">{shortHash(row.sha256)}</td>
                  <td>{row.action || "—"}</td>
                  <td>{stamp(row.createdAt || row.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No decryption events yet.</p>
        )}
      </article>
      <article className="card" style={{ overflowX: "auto" }}>
        <div className="kicker">Records</div>
        <h2>Encrypted off-chain metadata</h2>
        <p>Only ciphertext and hashes are stored. These rows never include plaintext names, NHI, or clinical notes.</p>
        {records.length ? (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Batch</th>
                <th>SHA-256</th>
                <th>Created by</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {records.map((row) => (
                <tr key={row.sha256}>
                  <td>{row.kind}</td>
                  <td className="mono">{row.batchId || "—"}</td>
                  <td className="mono">{shortHash(row.sha256)}</td>
                  <td>{who(row.createdBy, orgs)}</td>
                  <td>{stamp(row.createdAt || row.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No encrypted records yet.</p>
        )}
      </article>
    </div>
  );
}

function RegulateForm({ session, batches, onDone, setErr }) {
  const [batchId, setBatchId] = useBoundId(batches);
  const [reason, setReason] = useState("Cold-chain failure reported by depot");
  const [ok, setOk] = useState("");

  async function recall() {
    setErr("");
    setOk("");
    try {
      if (!reason.trim()) throw new Error("A recall reason is required.");
      if (!window.confirm(`Recall batch #${batchId}? This cannot be reversed on the ledger.`)) return;
      const tx = await session.contract.recallBatch(batchId, reason.trim());
      await tx.wait();
      await onDone();
      setOk(`Batch #${batchId} recalled.`);
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  async function override() {
    setErr("");
    setOk("");
    try {
      const tx = await session.contract.authoriseException(batchId);
      await tx.wait();
      await onDone();
      setOk(`Exception authorised for batch #${batchId}.`);
    } catch (err) {
      setErr(friendlyError(err));
    }
  }

  return (
    <div className="card">
      <div className="kicker">Regulator console</div>
      <h2>Recalls and clinical exceptions</h2>
      <label>Batch</label>
      <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>
            #{b.id} {b.vaccineName} {b.coldChainBreached ? "(breach)" : ""}
          </option>
        ))}
      </select>
      <label>Recall reason</label>
      <input value={reason} onChange={(e) => setReason(e.target.value)} />
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <button className="btn danger" type="button" onClick={recall}>Recall batch</button>
        <button className="btn" type="button" onClick={override}>Authorise exception</button>
      </div>
      {ok && <p className="okbox">{ok}</p>}
    </div>
  );
}

function TracePanel({ session, batches, orgs = {} }) {
  const [id, setId] = useBoundId(batches);
  const [view, setView] = useState(null);
  const [names, setNames] = useState(orgs);
  const [phi, setPhi] = useState(null);
  const [fhir, setFhir] = useState(null);
  const [err, setErr] = useState("");
  const canOpen = Boolean(session.roles?.clinic || session.roles?.regulator);

  async function load() {
    setErr("");
    setPhi(null);
    setFhir(null);
    try {
      const parsed = parseBatchQuery(id);
      const batch = await readBatch(session.contract, parsed);
      const history = await loadHistory(session.contract, batch.id);
      const resolved = await loadOrgMap(session.contract, [
        batch.manufacturer,
        batch.currentCustodian,
        ...history.map((row) => row.actor),
      ]);
      setNames({ ...orgs, ...resolved });
      setView({ batch, history });
    } catch (error) {
      setView(null);
      setErr(friendlyError(error));
    }
  }

  async function openHash(hash) {
    setFhir(null);
    try {
      const row = await api(`/api/offchain/${hash.replace(/^0x/, "")}`, { address: session.address });
      setPhi(row);
    } catch (error) {
      setPhi({ error: friendlyError(error) });
    }
  }

  async function exportFhir() {
    setErr("");
    try {
      const resource = await api(`/api/interop/immunization/${phi.sha256}`, { address: session.address });
      setFhir(resource);
    } catch (error) {
      setErr(friendlyError(error));
    }
  }

  return (
    <div className="grid">
      <div className="card">
        <div className="kicker">Traceability</div>
        <h2>Reconstruct a batch</h2>
        <div className="grid cols-2">
          <input value={id} onChange={(e) => setId(e.target.value)} />
          <button className="btn primary" onClick={load}>Load history</button>
        </div>
        {err && <p className="flash">{err}</p>}
      </div>
      {view && (
        <BatchView
          batch={view.batch}
          history={view.history}
          orgs={names}
          onOpenHash={canOpen ? openHash : null}
        />
      )}
      {phi && (
        <div className="card">
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(phi, null, 2)}</pre>
          {phi.sha256 && !phi.error && (
            <div style={{ marginTop: "0.8rem" }}>
              <button className="btn" type="button" onClick={exportFhir}>Export FHIR Immunization</button>
            </div>
          )}
        </div>
      )}
      {fhir && <pre className="card mono">{JSON.stringify(fhir, null, 2)}</pre>}
    </div>
  );
}

function BatchView({ batch, history, orgs = {}, publicView, onOpenHash }) {
  const [copied, setCopied] = useState(false);
  const pane = publicView ? "summary-pane" : "card";
  return (
    <div className="batch-split">
      <article className={pane}>
        <div className="kicker">Batch #{batch.id}</div>
        <h3>Batch summary</h3>
        <p>
          <b>{batch.vaccineName}</b> · lot <span className="mono">{batch.lotNumber}</span> · {batch.remainingVials}/{batch.vialCount} vials ·{" "}
          <span className={`badge ${statusTone(batch.statusLabel)}`}>{batch.statusLabel}</span>{" "}
          {batch.coldChainBreached && batch.exceptionAuthorised && (
            <span className="badge gold">breach (exception)</span>
          )}
          {batch.coldChainBreached && !batch.exceptionAuthorised && (
            <span className="badge danger">cold-chain breach</span>
          )}
        </p>
        <p className="mono">
          digital id {shortHash(batch.digitalId)}{" "}
          <button
            className="linkish"
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(batch.digitalId);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy full id"}
          </button>
        </p>
        <p>
          Required {tempC(batch.tempMinCenti)}–{tempC(batch.tempMaxCenti)} °C · expires {when(batch.expiresAt)}
        </p>
        <p>Held by {who(batch.currentCustodian, orgs)}</p>
      </article>
      <article className={pane}>
        <h3>Custody history timeline</h3>
        <ol className="timeline">
          {history.map((e, i) => (
            <li key={i}>
              <i />
              <div>
                <b>{e.label}</b>{" "}
                {e.note && e.note !== e.label && <span className="badge gold">{e.note}</span>}
                <div className="mono">
                  {when(e.timestamp)} · {who(e.actor, orgs)}
                  {TEMP_EVENTS.has(e.eventType) ? ` · ${tempC(e.temperatureCenti)} °C` : ""}
                </div>
                {e.offChainHash && e.offChainHash !== "0x" + "0".repeat(64) && (
                  <div>
                    hash {shortHash(e.offChainHash)}
                    {onOpenHash && (
                      <button className="btn" style={{ marginLeft: 8 }} onClick={() => onOpenHash(e.offChainHash)}>
                        Decrypt (authorised)
                      </button>
                    )}
                    {publicView && <span> · PII withheld</span>}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </article>
    </div>
  );
}
