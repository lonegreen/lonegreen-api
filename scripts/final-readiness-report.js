#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const checks = [
  { name: "launch-gate", command: "npm", args: ["run", "check"], severity: "hard-fail" },
  { name: "customer-orphans", command: "npm", args: ["run", "check:customer-orphans"], severity: "hard-fail" },
  { name: "phase-b-precheck", command: "node", args: ["scripts/phase-b-integrity-precheck.js"], severity: "hard-fail" },
  { name: "frontend-routes", command: "npm", args: ["run", "check:frontend-routes"], severity: "hard-fail" },
  { name: "navigation", command: "npm", args: ["run", "check:navigation"], severity: "hard-fail" },
  { name: "marketplace-contract", command: "npm", args: ["run", "check:marketplace-contract"], severity: "hard-fail" }
];

function runCheck(check) {
  const cmd = /^win/.test(process.platform) && check.command === "npm" ? "npm.cmd" : check.command;
  const result = spawnSync(cmd, check.args, {
    cwd: root,
    shell: /^win/.test(process.platform),
    encoding: "utf8",
    stdio: "pipe"
  });
  return {
    ...check,
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function main() {
  console.log("Final readiness report");
  console.log("======================");
  const results = checks.map(runCheck);

  let hasHardFail = false;
  for (const r of results) {
    const ok = r.exitCode === 0;
    if (!ok && r.severity === "hard-fail") {
      hasHardFail = true;
    }
    console.log(`[${ok ? "PASS" : "FAIL"}] ${r.name} (${r.severity})`);
    if (!ok) {
      const out = (r.stderr || r.stdout || "").trim();
      if (out) {
        console.log(out.split("\n").slice(0, 20).join("\n"));
      }
    }
  }

  if (hasHardFail) {
    process.exit(1);
  }
  process.exit(0);
}

main();
