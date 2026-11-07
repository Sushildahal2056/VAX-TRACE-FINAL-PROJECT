# VaxTrace

Local demo of a blockchain vaccine supply chain: each batch gets a digital identity, custody moves are signed on Ethereum, and patient details stay encrypted off-chain.



## What you need

- **Node.js 20 or newer** (`node -v`)
- **npm** (comes with Node)
- **Python 3** for `npm run evaluate` and `npm run iot`

## Clone & Install (First-Time Setup)

```bash

npm run setup
```

`npm run setup` (or `npm install`) installs all packages inside `blockchain/`, `backend/`, and `frontend/`.
*(Note: `blockchain/` downloads ~640 Hardhat packages on the first install, which takes 20–60 seconds — wait until `Setup finished` appears.)*

If you ever want to install each folder manually with live progress:

```bash
npm --prefix blockchain install
npm --prefix backend install
npm --prefix frontend install
```

## Run

```bash
npm run demo
```

Wait until the terminal prints `VaxTrace is up`, then open:

**http://127.0.0.1:5173**

The same banner prints the API health URL (http://127.0.0.1:4000/api/health) and the live `MongoDB` URI (`mongodb://127.0.0.1:<port>/`). The Hardhat chain is listening at http://127.0.0.1:8545 (chain id `31337`).

Leave that terminal open. `Ctrl+C` stops the chain, API, and website together.

If you see “port already in use”, the script tries to free `8545`, `4000`, and `5173`. Run `npm run demo` again if a leftover process was stuck.

## Three pages

Signed out, the topbar shows **Public ledger**, **Stakeholder portal**, and **Admin console**. After sign-in, a stakeholder sees **Stakeholder workspace** (no **Admin console** link) and the network admin sees **Admin console** (no **Stakeholder portal** link). The pill shows the organisation and role, next to **Log out**. **Log out** (sidebar and topbar) ends the session. A stakeholder returns to `/portal`. The network admin returns to `/admin`. Sign in again on that page.

- **Public ledger (`/`)** — compact header, then a four-stat strip (**Registered lots**, **Doses available**, **Verified organisations**, **Cold-chain status**). The main column is about three quarters of the width: **Public Lot Verification** (**Reconstruct history**, lot pills, **Batch summary** and **Custody history timeline** side by side) and **Public Lot Registry**. The right sidebar is about one quarter: **Accredited Network Organisations** and **Verification & Privacy Standard**.
- **Stakeholder portal (`/portal`)** — one centered card with two tabs. **Sign in to workspace** (default) has **Log in with MetaMask**, **or sign in with private key** (**Private key (0x…)** and **Log in with private key**), and a compact **Demo presentation quick-login (local test wallets — removed in production)** dropdown. The dropdown lists the six seeded desks plus wallets generated in this browser, each tagged **Active**, **Pending**, or **Rejected**. **Sign in** opens that desk and **Copy key** copies the `0x…` private key. There is no saved-browser password box. **Request new organisation access** asks for **Organisation name**, **Requested role**, **Medsafe / HPI Licence ID**, and **Contact email**, then **Wallet public address (0x…)**. **Generate wallet keypair** works before the name is typed. **Use MetaMask address** fills the public address. **Send public address & licence to Admin** submits the request. A badge on that tab counts pending and rejected applications on this browser.
- **Admin console (`/admin`)** — **Network Admin Console — Sign In** with passphrase `vaxtrace-admin`, the admin private key, or **Log in with MetaMask**. **Pending Accreditation Requests** shows the licence id and contact email; change **Role to grant** if needed, then **Approve & grant role (1 ETH)** or **Reject**. **Registered Network Organisations** has an inline **Change role** dropdown and **Update role** (on-chain), plus **Deactivate** / **Reactivate**. **Register a Verified Organisation** can register an address directly (**Generate demo wallet** is optional). **Audit & compliance** shows **Active MongoDB URI**, the **PHI decryption log**, and **Encrypted off-chain metadata**.

An unregistered wallet that signs in on `/portal` opens the accreditation panel. If an admin clicked **Reject**, the panel shows **Your previous accreditation request for `<name>` (`<kind>`) was rejected by the Network Admin. You may update your organisation details below and resubmit for review.** Name, role, licence id, and contact are pre-filled. **Resubmit for review** returns the screen to **Application pending Network Admin approval**. After the admin approves the address, **Check approval status** opens the role workspace.

Seeded desks in **Demo presentation quick-login**:

- **Southern Biologics Ltd** — register a batch and send it on
- **ColdLink Freight** — accept custody and log temperature
- **National Vaccine Store, Porirua** — hold stock and release it to a clinic
- **Te Whare Hauora Immunisation Clinic** — accept delivery and record a dose
- **Medsafe Inspectorate** — recall a lot or authorise a cold-chain exception
- **Cold-chain IoT oracle** — publish a probe reading

Network admin signs in on `/admin`, not in that dropdown.

## What is already on the ledger

Three seeded batches:

| Batch | Lot | Where it starts |
| --- | --- | --- |
| **#1 Comirnaty 30mcg** | `SB-DEMO-01` | **Delivered** to the clinic, **11/12** vials, cold chain intact |
| **#2 Spikevax Bivalent** | `SB-EXCURSION-02` | **In warehouse**, **10/10** vials, **12.4 °C** breach |
| **#3 Nuvaxovid** | `SB-TRANSIT-03` | **Packaged**, **15/15** vials, waiting for **ColdLink Freight** |

## What to click first

1. On **Public ledger** (`/`), leave batch **1** and click **Reconstruct history** (or a lot pill). **Batch summary** and **Custody history timeline** sit side by side. You should see Comirnaty lot `SB-DEMO-01` through to the clinic. Dose hashes show **PII withheld**. **Public Lot Registry** is in the main column. **Accredited Network Organisations** is in the right sidebar.
2. Open **Stakeholder portal** (`/portal`). In **Demo presentation quick-login**, choose a desk and click **Sign in**.
3. Follow [WORKING_GUIDE.md](WORKING_GUIDE.md) for register, handover, cold chain, dosing, recall, FHIR export, and onboarding. **Log out**, then sign in again on `/portal` or `/admin`.

## MongoDB Compass

Copy the `MongoDB` URI from the demo terminal, or from **Audit & compliance** → **Active MongoDB URI**. That tab is on **Admin console** (`/admin`, passphrase `vaxtrace-admin`) and on **Medsafe Inspectorate** after sign-in at `/portal`.

In Compass, connect to `mongodb://127.0.0.1:<port>/test` and open:

- `offchainrecords` — encrypted `document`, `beneficiary`, `clinical`, and `adverse` rows
- `iotreadings` — probe readings
- `accesslogs` — authorised decryptions

For Atlas, or a MongoDB that survives restarts:

```bash
export MONGO_URI="mongodb+srv://USER:PASSWORD@CLUSTER/"
npm run demo
```

Details are in [WORKING_GUIDE.md](WORKING_GUIDE.md).

## MetaMask (optional)

1. Create a Local network: chain id `31337`, RPC `http://127.0.0.1:8545`, symbol `ETH`.
2. Import a private key from `demo-accounts.json`, or copy one with **Copy key** next to **Demo presentation quick-login**.
3. On **Stakeholder portal** (`/portal`), click **Log in with MetaMask**. A wallet that is not on the ledger opens the accreditation request. Submit it, wait for an admin to approve it on `/admin`, then click **Check approval status**.
4. The admin wallet signs in on **Admin console** (`/admin`) with **Log in with MetaMask**, or with passphrase `vaxtrace-admin`.

Those keys are the public Hardhat test accounts. Use them on this local chain.

## Tests and extras

```bash
npm test                    # smart-contract checks
npm run evaluate            # needs the demo running; writes evaluation/results/benchmark.json
npm run iot -- --batch 1    # extra temperature readings
```

## If it fails

| Symptom | Fix |
| --- | --- |
| `npm run setup` cannot find Node | Install Node 20+ from [nodejs.org](https://nodejs.org) |
| `Contract is not deployed` / empty verify | The demo is stopped. Use `npm run demo`, then refresh |
| Cannot reach the chain / `Failed to fetch` | Keep the demo terminal running; refresh the page |
| Port 8545 / 4000 / 5173 busy | `npm run demo` again, or `lsof -ti :8545,:4000,:5173 \| xargs kill` |
| First API start is slow | First-time MongoDB download. Wait for `VaxTrace is up` |
| Python / `.venv` errors | Re-run `npm run setup` with Python 3 installed before `npm run evaluate` or `npm run iot` |

## Layout

```
blockchain/     Solidity contract, Hardhat tests, deploy + seed
backend/        Encrypted off-chain API (AES-256-GCM, SHA-256 hashes)
frontend/       Public ledger, stakeholder portal, and admin console
iot-coldchain/  Temperature simulator
evaluation/     SQLite baseline vs the chain
Information/    Source report and slides
WORKING_GUIDE.md  Click-by-click demo script
```
