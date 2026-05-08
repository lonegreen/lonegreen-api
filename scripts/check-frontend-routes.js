#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const serverPath = path.join(root, "server.js");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function normalizePath(p) {
  const base = String(p || "").trim();
  if (!base) return "";
  const noQuery = base.split("?")[0].split("#")[0];
  return noQuery.replace(/\/+/g, "/");
}

function toRouteRegex(routePath) {
  const normalized = normalizePath(routePath);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withParams = escaped.replace(/\\:([a-zA-Z0-9_]+)/g, "[^/]+");
  return new RegExp("^" + withParams + "$");
}

function extractRouteMounts(serverSource) {
  const requireMap = new Map();
  const requireRegex = /const\s+([a-zA-Z0-9_]+)\s*=\s*require\(\s*["']\.\/routes\/([^"']+)["']\s*\)\s*;/g;
  let m;
  while ((m = requireRegex.exec(serverSource))) {
    requireMap.set(m[1], `routes/${m[2]}.js`);
  }
  const mounts = [];
  const mountRegex = /app\.use\(\s*["']([^"']+)["']\s*,\s*([a-zA-Z0-9_]+)\s*\)\s*;/g;
  while ((m = mountRegex.exec(serverSource))) {
    const prefix = m[1];
    const varName = m[2];
    if (requireMap.has(varName)) {
      mounts.push({ prefix, file: requireMap.get(varName) });
    }
  }
  return mounts;
}

function extractBackendRoutes() {
  const serverSource = read(serverPath);
  const mounts = extractRouteMounts(serverSource);
  const backend = [];
  const directRouteRegex = /app\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;
  let dm;
  while ((dm = directRouteRegex.exec(serverSource))) {
    backend.push({ method: dm[1].toUpperCase(), path: normalizePath(dm[2]) || "/" });
  }
  for (const mount of mounts) {
    const routeFile = path.join(root, mount.file);
    if (!fs.existsSync(routeFile)) continue;
    const source = read(routeFile);
    const routeRegex = /router\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;
    let m;
    while ((m = routeRegex.exec(source))) {
      const method = m[1].toUpperCase();
      const routePath = normalizePath(m[2]);
      const full = normalizePath((mount.prefix === "/" ? "" : mount.prefix) + routePath);
      backend.push({ method, path: full || "/" });
    }
  }
  return backend;
}

function extractFrontendApiCalls(html) {
  const hits = [];

  const fetchLiteral = /fetch\(\s*["'](\/[^"']+)["']/g;
  let m;
  while ((m = fetchLiteral.exec(html))) {
    hits.push({ path: normalizePath(m[1]), confidence: "high" });
  }

  const fetchConcat = /fetch\(\s*[a-zA-Z0-9_.]+\s*\+\s*["'](\/[^"']+)["']/g;
  while ((m = fetchConcat.exec(html))) {
    hits.push({ path: normalizePath(m[1]), confidence: "high" });
  }

  const commonApiString = /["'](\/(?:auth|billing|companies|company|marketplace|customer|conversations|messages|uploads|services|jobs|clients|workers|estimates|invoices|subscriptions|support)(?:\/[^"'?#\s]*)?)["']/g;
  while ((m = commonApiString.exec(html))) {
    const p = normalizePath(m[1]);
    if (p.endsWith(".html")) continue;
    hits.push({ path: p, confidence: "medium" });
  }

  return hits.filter((h) => h.path && !/^https?:\/\//i.test(h.path));
}

function dedupeCalls(calls) {
  const seen = new Set();
  const out = [];
  for (const c of calls) {
    const key = c.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function pathExistsInBackend(pathname, backendRoutes) {
  for (const route of backendRoutes) {
    if (route.path === pathname) return true;
    if (toRouteRegex(route.path).test(pathname)) return true;
    if (pathname.endsWith("/") && route.path.startsWith(pathname) && route.path.charAt(pathname.length) === ":") {
      return true;
    }
  }
  return false;
}

function main() {
  const backendRoutes = extractBackendRoutes();
  const htmlFiles = fs.readdirSync(publicDir).filter((name) => name.endsWith(".html"));
  const missingHighConfidence = [];

  for (const file of htmlFiles) {
    const html = read(path.join(publicDir, file));
    const calls = dedupeCalls(extractFrontendApiCalls(html));
    for (const call of calls) {
      const p = call.path;
      if (!p.startsWith("/")) continue;
      if (p.startsWith("//")) continue;
      if (p.endsWith(".html")) continue;
      if (p.endsWith("/")) continue;
      if (p.startsWith("/css/") || p.startsWith("/js/")) continue;
      const exists = pathExistsInBackend(p, backendRoutes);
      if (!exists && call.confidence === "high") {
        missingHighConfidence.push({ file, path: p });
      }
    }
  }

  if (missingHighConfidence.length) {
    console.error("Frontend/backend route integrity FAILED:");
    for (const miss of missingHighConfidence) {
      console.error(`  - ${miss.file}: ${miss.path}`);
    }
    process.exit(1);
  }

  console.log("Frontend/backend route integrity passed (no high-confidence missing API routes).");
}

main();
