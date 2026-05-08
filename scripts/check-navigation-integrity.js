#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const controlPath = path.join(root, "public", "control.html");
const publicDir = path.join(root, "public");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function extractArray(source, varName) {
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
  const m = source.match(re);
  if (!m) return [];
  const arrBody = m[1];
  const itemRegex = /["']([^"']+)["']/g;
  const out = [];
  let x;
  while ((x = itemRegex.exec(arrBody))) {
    out.push(x[1]);
  }
  return out;
}

function normalizeFileRef(value) {
  return String(value || "").replace(/^\/+/, "").split("?")[0].split("#")[0];
}

function main() {
  const source = read(controlPath);
  const publicFiles = new Set(fs.readdirSync(publicDir).filter((f) => f.endsWith(".html")));

  const allowedPages = extractArray(source, "allowedPages");
  const workerBlockedPages = extractArray(source, "workerBlockedPages");

  const dataPageRegex = /data-page=["']([^"']+)["']/g;
  const sidebarTargets = [];
  let m;
  while ((m = dataPageRegex.exec(source))) {
    sidebarTargets.push(m[1]);
  }

  const missingLinkedFiles = [];
  for (const target of sidebarTargets) {
    const file = normalizeFileRef(target);
    if (!file.endsWith(".html")) continue;
    if (!publicFiles.has(file)) {
      missingLinkedFiles.push(file);
    }
  }

  const missingAllowedEntries = [];
  for (const target of allowedPages) {
    const file = normalizeFileRef(target);
    if (!file.endsWith(".html")) continue;
    if (!publicFiles.has(file)) {
      missingAllowedEntries.push(target);
    }
  }

  const missingWorkerBlockedEntries = [];
  for (const target of workerBlockedPages) {
    const file = normalizeFileRef(target);
    if (!file.endsWith(".html")) continue;
    if (!publicFiles.has(file)) {
      missingWorkerBlockedEntries.push(target);
    }
  }

  const staffLinkedFiles = new Set(sidebarTargets.map(normalizeFileRef).filter((f) => f.endsWith(".html")));
  const orphanStaffPages = Array.from(publicFiles)
    .filter((f) => !staffLinkedFiles.has(f))
    .filter((f) => !/^customer-|^company-|^login|^terms|^privacy|^refund|^billing-policy|^index|^control/.test(f))
    .sort();

  if (orphanStaffPages.length) {
    console.warn("Navigation warnings (staff pages present but not linked):");
    for (const p of orphanStaffPages) {
      console.warn(`  - ${p}`);
    }
  }

  const hardFailures = [];
  if (missingLinkedFiles.length) {
    hardFailures.push(...missingLinkedFiles.map((f) => `missing linked sidebar file: ${f}`));
  }
  if (missingAllowedEntries.length) {
    hardFailures.push(...missingAllowedEntries.map((f) => `broken allowedPages entry: ${f}`));
  }
  if (missingWorkerBlockedEntries.length) {
    hardFailures.push(...missingWorkerBlockedEntries.map((f) => `broken workerBlockedPages entry: ${f}`));
  }

  if (hardFailures.length) {
    console.error("Navigation integrity FAILED:");
    for (const f of hardFailures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log("Navigation integrity passed.");
}

main();
