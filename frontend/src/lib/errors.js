const HINTS = [
  ["BatchNotFound", "That batch is not on the ledger. After a fresh `npm run demo`, try batch 1."],
  [
    "InvalidState",
    "Wrong step for this batch. Package it before transferring, or accept it at the clinic before giving a dose.",
  ],
  ["BatchIsRecalled", "This batch has been recalled and cannot move further."],
  [
    "ColdChainBreach",
    "Temperature left the allowed range. A regulator must authorise an exception before a dose can be given.",
  ],
  ["DuplicateLot", "This manufacturer already registered that lot number. Use a new lot."],
  ["EmptyVials", "No vials left in this batch."],
  ["NotCustodian", "Only the organisation that currently holds the batch can do that."],
  ["NoPendingTransfer", "There is no inbound transfer waiting for this wallet."],
  ["BatchExpired", "This batch is past its expiry date."],
  ["InvalidRecipient", "Pick a registered logistics, warehouse, clinic, or manufacturer account."],
  [
    "InvalidInput",
    "Check the form: expiry must be in the future, minimum temperature below maximum, and vial count above zero.",
  ],
  ["TransferAlreadyPending", "A transfer is already waiting to be accepted."],
  ["UnauthorizedActor", "This role is not allowed to perform that action."],
  ["AccessControlUnauthorizedAccount", "This wallet does not have the required role."],
  ["could not detect network", "Cannot reach the local chain. Keep the `npm run demo` terminal running."],
  ["Failed to fetch", "The API or chain is not reachable. Start the app with `npm run demo`."],
  ["missing revert data", "The local chain rejected the transaction. Confirm `npm run demo` is still running."],
];

export function friendlyError(err) {
  const raw = [err?.shortMessage, err?.reason, err?.message, err?.info?.error?.message, String(err || "")]
    .filter(Boolean)
    .join(" ");
  const hit = HINTS.find(([needle]) => raw.includes(needle));
  if (hit) return hit[1];
  if (err?.shortMessage) return err.shortMessage;
  if (err?.message) return err.message;
  return "Something went wrong. Check the demo terminal for errors.";
}

export function dateInputToUnix(dateStr) {
  const parts = String(dateStr || "").split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error("Enter a valid expiry date.");
  }
  const [year, month, day] = parts;
  return Math.floor(new Date(year, month - 1, day, 12, 0, 0).getTime() / 1000);
}

export function parseBatchQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) throw new Error("Enter a batch number (for example 1) or a 0x digital id.");
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { digitalId: q };
  if (/^\d+$/.test(q) && Number(q) >= 1) return { batchId: Number(q) };
  throw new Error("Enter a whole batch number (1) or a 66-character 0x digital id.");
}
