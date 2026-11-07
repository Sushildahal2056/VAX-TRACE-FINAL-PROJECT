const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

const EncryptedSchema = new mongoose.Schema(
  {
    kind: { type: String, required: true },
    sha256: { type: String, required: true, unique: true, index: true },
    batchId: { type: String, default: "" },
    iv: String,
    tag: String,
    ciphertext: String,
    createdBy: String,
  },
  { timestamps: true }
);

const AccessLogSchema = new mongoose.Schema(
  {
    sha256: String,
    actor: String,
    action: String,
    reason: String,
  },
  { timestamps: true }
);

const ApplicationSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    kind: { type: String, required: true },
    contact: { type: String, default: "" },
    licenceId: { type: String, default: "" },
    status: { type: String, default: "pending" }, // pending | approved | deactivated | rejected
  },
  { timestamps: true }
);

const IoTSchema = new mongoose.Schema(
  {
    batchId: { type: String, required: true, index: true },
    temperatureCenti: Number,
    sha256: String,
    source: String,
    breached: Boolean,
    recordedOnChain: { type: Boolean, default: false },
  },
  { timestamps: true }
);

let Record;
let AccessLog;
let IoTReading;
let Application;
let memoryServer;
let activeUri = "";

async function connectStore() {
  if (mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGO_URI;
  if (uri) {
    activeUri = uri;
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    console.log("off-chain store: MongoDB at MONGO_URI");
  } else {
    memoryServer = await MongoMemoryServer.create();
    activeUri = memoryServer.getUri();
    await mongoose.connect(activeUri, { serverSelectionTimeoutMS: 8000 });
    console.log("off-chain store: in-process MongoDB at " + activeUri);
  }
  Record = mongoose.models.OffchainRecord || mongoose.model("OffchainRecord", EncryptedSchema);
  AccessLog = mongoose.models.AccessLog || mongoose.model("AccessLog", AccessLogSchema);
  IoTReading = mongoose.models.IoTReading || mongoose.model("IoTReading", IoTSchema);
  Application = mongoose.models.OrgApplication || mongoose.model("OrgApplication", ApplicationSchema);
}

function records() {
  return Record;
}

function logs() {
  return AccessLog;
}

function iot() {
  return IoTReading;
}

function applications() {
  return Application;
}

function mongoUri() {
  return activeUri;
}

module.exports = { connectStore, records, logs, iot, applications, mongoUri };
