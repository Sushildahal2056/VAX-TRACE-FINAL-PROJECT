#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

function run(command, args, cwd, stdio = "inherit") {
  const child = spawn(command, args, {
    cwd,
    stdio,
    shell: process.platform === "win32",
  });
  children.push(child);
  return child;
}

function waitExit(child) {
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${child.spawnargs.join(" ")} exited ${code}`));
    });
  });
}

function waitForPort(port, timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`nothing listening on :${port}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function waitForRpc(timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const json = await res.json();
      if (json.result) return;
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Hardhat RPC did not become ready on http://127.0.0.1:8545");
}

function freePort(port) {
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" }).trim();
    if (!out) return;
    for (const pid of out.split("\n")) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening */
  }
}

function shutdown() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  for (const port of [5173, 4000, 8545]) freePort(port);
}

function ensureInstalled() {
  const missing = ["blockchain", "backend", "frontend"].filter(
    (dir) => !fs.existsSync(path.join(root, dir, "node_modules"))
  );
  if (missing.length) {
    console.log(`First-time run: installing dependencies in ${missing.join(", ")}…`);
    execSync("node scripts/setup.mjs", { cwd: root, stdio: "inherit" });
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

async function main() {
  ensureInstalled();
  console.log("Stopping anything left on :8545 :4000 :5173…");
  for (const port of [5173, 4000, 8545]) freePort(port);
  await new Promise((r) => setTimeout(r, 400));

  const chainLog = fs.openSync(path.join(root, "hardhat-node.log"), "w");
  console.log("Starting Hardhat node…");
  run("npx", ["hardhat", "node"], path.join(root, "blockchain"), ["ignore", chainLog, chainLog]);
  await waitForPort(8545);
  await waitForRpc();

  console.log("Deploying contract…");
  await waitExit(
    run("npx", ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], path.join(root, "blockchain"))
  );

  console.log("Starting off-chain API (first run may download MongoDB)…");
  run("node", ["src/index.js"], path.join(root, "backend"));
  await waitForPort(4000, 120000);
  const health = await (await fetch("http://127.0.0.1:4000/api/health")).json();
  const mongoUri = health.mongoUri || "";

  console.log("Seeding demo batches…");
  await waitExit(
    run("npx", ["hardhat", "run", "scripts/seed.js", "--network", "localhost"], path.join(root, "blockchain"))
  );

  console.log("Starting website…");
  run("npx", ["vite", "--host", "127.0.0.1", "--port", "5173"], path.join(root, "frontend"));
  await waitForPort(5173);

  console.log("\nVaxTrace is up");
  console.log("  Open        http://127.0.0.1:5173");
  console.log("  Verify      batch 1 on the home page");
  console.log("  API health  http://127.0.0.1:4000/api/health");
  console.log(`  MongoDB     ${mongoUri}`);
  console.log("\nLeave this terminal open. Ctrl+C stops everything.\n");
}

main().catch((err) => {
  console.error(err.message || err);
  shutdown();
  process.exit(1);
});
