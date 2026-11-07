#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd, required = true) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    if (!required) return false;
    console.error(`Failed to run ${command} ${args.join(" ")}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (!required) return false;
    process.exit(result.status || 1);
  }
  return true;
}

function version(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr || "").trim().split("\n")[0];
}

const nodeVer = version("node");
if (!nodeVer) {
  console.error("Node.js is not installed. Install Node 20+ from https://nodejs.org then run: npm run setup");
  process.exit(1);
}
const major = Number((nodeVer.match(/v?(\d+)/) || [])[1]);
if (Number.isFinite(major) && major < 18) {
  console.error(`Node ${nodeVer} is too old. Use Node 20 or newer.`);
  process.exit(1);
}
console.log(`Node ${nodeVer}`);

const dirs = ["blockchain", "backend", "frontend"];
for (let i = 0; i < dirs.length; i++) {
  const dir = dirs[i];
  console.log(`\n[${i + 1}/${dirs.length}] Installing ${dir} packages (this can take 20-60 seconds on a fresh clone)…`);
  run(npmCmd, ["install", "--no-audit", "--no-fund", "--progress=true"], path.join(root, dir));
}

const python = version("python3") ? "python3" : version("python") ? "python" : null;
if (!python) {
  console.log("\nPython not found — skipped optional evaluation virtualenv.");
} else {
  console.log(`\n${python} ${version(python)} (optional evaluation environment)`);
  const venv = path.join(root, ".venv");
  const venvBin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
  const pyBin = path.join(venvBin, process.platform === "win32" ? "python.exe" : "python");
  const pipBin = path.join(venvBin, process.platform === "win32" ? "pip.exe" : "pip");
  const created = fs.existsSync(pyBin) || run(python, ["-m", "venv", ".venv"], root, false);
  if (created && fs.existsSync(pipBin)) {
    run(pipBin, ["install", "-r", "evaluation/requirements.txt"], root, false);
  } else {
    console.log("Skipped optional Python virtualenv — the web app, API, and blockchain do not require it.");
  }
}

console.log("\nSetup finished. Start the app with:\n  npm run demo\n");
