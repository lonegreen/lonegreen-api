"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

const IGNORE_SCHEMES = /^(?:https?:|mailto:|tel:|javascript:|data:|blob:)/i;
const IGNORE_DIRS = new Set(["node_modules", "uploads"]);
const PAGE_EXTENSIONS = new Set([".html", ""]);
const ASSET_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".pdf",
  ".map",
  ".txt",
  ".xml",
  ".json"
]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      files.push(...walk(path.join(dir, entry.name)));
    } else {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function cleanTarget(raw) {
  if (!raw) return "";
  const value = String(raw).trim();
  if (!value || value === "#" || value.startsWith("#")) return "";
  if (IGNORE_SCHEMES.test(value)) return "";
  if (value.includes("${") || value.includes("<%")) return "";
  return value.split("#")[0].split("?")[0];
}

function resolvePublicTarget(target, fromFile) {
  if (!target) return null;
  const normalized = target.startsWith("/")
    ? target
    : "/" + toPosix(path.relative(PUBLIC_DIR, path.resolve(path.dirname(fromFile), target)));
  return normalized.replace(/\/+/g, "/");
}

function publicPathExists(publicTarget) {
  if (publicTarget === "/") return true;
  const diskPath = path.join(PUBLIC_DIR, publicTarget.replace(/^\/+/, ""));
  return fs.existsSync(diskPath);
}

function isPageTarget(publicTarget, sourceKind) {
  if (sourceKind === "data-page") return true;
  const ext = path.extname(publicTarget).toLowerCase();
  return PAGE_EXTENSIONS.has(ext);
}

function isKnownAssetTarget(publicTarget) {
  return ASSET_EXTENSIONS.has(path.extname(publicTarget).toLowerCase());
}

function extractTargets(filePath, text) {
  const lines = text.split(/\r?\n/);
  const targets = [];
  const patterns = [
    { kind: "href", regex: /\bhref\s*=\s*["']([^"']+)["']/gi },
    { kind: "src", regex: /\bsrc\s*=\s*["']([^"']+)["']/gi },
    { kind: "data-page", regex: /\bdata-page\s*=\s*["']([^"']+)["']/gi }
  ];

  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      let match;
      pattern.regex.lastIndex = 0;
      while ((match = pattern.regex.exec(line))) {
        const clean = cleanTarget(match[1]);
        if (!clean) continue;
        targets.push({
          kind: pattern.kind,
          raw: match[1],
          target: clean,
          line: index + 1
        });
      }
    }
  });

  return targets;
}

function audit() {
  const htmlFiles = walk(PUBLIC_DIR).filter((file) => file.endsWith(".html"));
  const missingPages = [];
  const missingAssets = [];

  for (const file of htmlFiles) {
    const relFile = toPosix(path.relative(ROOT, file));
    const text = fs.readFileSync(file, "utf8");
    for (const item of extractTargets(file, text)) {
      const target = resolvePublicTarget(item.target, file);
      if (!target) continue;
      if (!target.startsWith("/")) continue;
      if (target.startsWith("/uploads/")) continue;

      const exists = publicPathExists(target);
      if (exists) continue;

      const record = {
        file: relFile,
        line: item.line,
        kind: item.kind,
        target: item.raw
      };

      if (isPageTarget(target, item.kind)) {
        missingPages.push(record);
      } else if (isKnownAssetTarget(target)) {
        missingAssets.push(record);
      }
    }
  }

  if (missingAssets.length) {
    console.log("Suspicious missing local assets:");
    for (const item of missingAssets) {
      console.log(`- ${item.file}:${item.line} ${item.kind} -> ${item.target}`);
    }
    console.log("");
  }

  if (missingPages.length) {
    console.error("Broken local page/navigation targets:");
    for (const item of missingPages) {
      console.error(`- ${item.file}:${item.line} ${item.kind} -> ${item.target}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Navigation audit passed: scanned ${htmlFiles.length} HTML files.`);
}

audit();
