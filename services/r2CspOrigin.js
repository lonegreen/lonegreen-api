/**
 * Parses R2_PUBLIC_BASE_URL and returns the origin (scheme + host) for CSP img-src.
 * Used only when the env var is set; missing/invalid values return null (no CSP change).
 * No wildcards; only http/https origins.
 */
function getR2ImgSrcOrigin() {
  const raw = String(process.env.R2_PUBLIC_BASE_URL || "").trim();
  if (!raw) {
    return null;
  }
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) {
      return null;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

module.exports = {
  getR2ImgSrcOrigin
};
