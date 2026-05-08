const fs = require("fs");
const path = require("path");

const root = process.cwd();
const publicDir = path.join(root, "public");
const warnOnly = process.env.DESIGN_CHECK_STRICT !== "1";

const legacyClassPairs = [
  { legacy: "btn", fx: "fx-btn" },
  { legacy: "panel", fx: "fx-card" },
  { legacy: "badge", fx: "fx-badge" },
  { legacy: "toolbar", fx: "fx-toolbar" },
  { legacy: "section-head", fx: "fx-section-head" },
  { legacy: "summary-card", fx: "fx-stat" },
  { legacy: "kpi-card", fx: "fx-stat" },
  { legacy: "empty", fx: "fx-empty" },
  { legacy: "error-box", fx: "fx-alert" },
  { legacy: "table-wrap", fx: "fx-table-wrap" },
  { legacy: "field", fx: "fx-field" }
];

const greenLegacyLiterals = [
  "#17462c",
  "#1f5c3a",
  "#16a34a",
  "#22c55e",
  "#027a48",
  "#ecfdf3",
  "#eaf5ee"
];

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".html"))
    .map((f) => path.join(dir, f));
}

function hasStylesheetRef(content, hrefPart) {
  return content.includes(`href="${hrefPart}"`) || content.includes(`href='${hrefPart}'`);
}

function classListFromAttr(attr) {
  return attr
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function scanFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(root, filePath).replace(/\\/g, "/");
  const warnings = [];

  const hasBrand = hasStylesheetRef(raw, "/css/brand.css");
  const hasAppShell = hasStylesheetRef(raw, "/app-shell.css");
  const mentionsFx = raw.includes("fx-");

  if (!hasBrand) warnings.push("missing `/css/brand.css` include");
  if (!hasAppShell) warnings.push("missing `/app-shell.css` include");
  if (!mentionsFx) warnings.push("no `fx-*` classes detected in markup/templates");

  const classRegex = /class\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = classRegex.exec(raw)) !== null) {
    const classes = classListFromAttr(match[1]);
    for (const pair of legacyClassPairs) {
      if (classes.includes(pair.legacy) && !classes.includes(pair.fx)) {
        warnings.push(`legacy class \`${pair.legacy}\` without \`${pair.fx}\``);
      }
    }
  }

  const lower = raw.toLowerCase();
  for (const color of greenLegacyLiterals) {
    if (lower.includes(color)) {
      warnings.push(`legacy green literal detected: ${color}`);
    }
  }

  return { rel, warnings };
}

function main() {
  const htmlFiles = listHtmlFiles(publicDir);
  if (!htmlFiles.length) {
    console.log("check:design - no HTML files found in public/");
    process.exit(0);
  }

  const results = htmlFiles.map(scanFile).filter((r) => r.warnings.length > 0);
  if (!results.length) {
    console.log("check:design - no design-system warnings found");
    process.exit(0);
  }

  console.log("check:design - warnings");
  for (const result of results) {
    console.log(`\n- ${result.rel}`);
    const unique = [...new Set(result.warnings)];
    unique.forEach((w) => console.log(`  - ${w}`));
  }

  if (!warnOnly) {
    console.log("\ncheck:design strict mode enabled, exiting with failure");
    process.exit(1);
  }
}

main();
