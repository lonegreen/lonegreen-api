#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const uiFiles = [
  "public/marketplace-dashboard.html",
  "public/marketplace-opportunities.html",
  "public/marketplace-offers.html",
  "public/marketplace-analytics.html"
];
const routeFile = path.join(root, "routes", "marketplace.js");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function normalizePath(p) {
  return String(p || "").split("?")[0].split("#")[0];
}

function toRegex(routePath) {
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\\:([a-zA-Z0-9_]+)/g, "[^/]+") + "$");
}

function extractUiMarketplacePaths() {
  const out = new Set();
  for (const rel of uiFiles) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const source = read(full);
    const fetchLiteral = /fetch\(\s*["'](\/marketplace\/[^"']+)["']/g;
    const fetchConcat = /fetch\(\s*[a-zA-Z0-9_.]+\s*\+\s*["'](\/marketplace\/[^"']+)["']/g;
    let m;
    while ((m = fetchLiteral.exec(source))) {
      out.add(normalizePath(m[1]));
    }
    while ((m = fetchConcat.exec(source))) {
      out.add(normalizePath(m[1]));
    }
  }
  return Array.from(out).sort();
}

function extractRouteDefs(source) {
  const defs = [];
  const re = /router\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(source))) {
    defs.push({ method: m[1].toUpperCase(), path: m[2], idx: m.index });
  }
  return defs;
}

function extractBlock(source, startIdx) {
  const end = source.indexOf("\n});", startIdx);
  if (end === -1) return source.slice(startIdx);
  return source.slice(startIdx, end + 4);
}

function main() {
  const routeSource = read(routeFile);
  const routeDefs = extractRouteDefs(routeSource);
  const uiPaths = extractUiMarketplacePaths();
  const failures = [];

  for (const pathRef of uiPaths) {
    const found = routeDefs.find((r) => toRegex(r.path).test(pathRef));
    if (!found) {
      failures.push(`UI references missing marketplace route: ${pathRef}`);
    }
  }

  const requiredCompanyEndpoints = [
    {
      path: "/marketplace/opportunities",
      method: "GET",
      mustContain: ["companyAuth", "requireMinimumRole(\"manager\")", "WHERE c.id = $1"]
    },
    {
      path: "/marketplace/offers/me",
      method: "GET",
      mustContain: ["companyAuth", "requireMinimumRole(\"manager\")", "WHERE mo.company_id = $1"]
    },
    {
      path: "/marketplace/requests/:id/offers",
      method: "POST",
      mustContain: ["companyAuth", "requireMinimumRole(\"manager\")", "const companyId = Number(req.user && req.user.company_id)"]
    }
  ];

  for (const req of requiredCompanyEndpoints) {
    const def = routeDefs.find((r) => r.path === req.path && r.method === req.method);
    if (!def) {
      failures.push(`Missing required company marketplace endpoint: ${req.method} ${req.path}`);
      continue;
    }
    const block = extractBlock(routeSource, def.idx);
    for (const token of req.mustContain) {
      if (!block.includes(token)) {
        failures.push(`Endpoint ${req.method} ${req.path} missing contract token: ${token}`);
      }
    }
  }

  if (failures.length) {
    console.error("Marketplace UI contract FAILED:");
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log("Marketplace UI contract passed.");
}

main();
