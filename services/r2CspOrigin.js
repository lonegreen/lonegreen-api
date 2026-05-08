/**
 * Returns R2 origin for CSP img-src only when R2 is fully configured.
 * Requirements:
 * - UPLOAD_STORAGE_DRIVER=r2
 * - R2_ACCOUNT_ID
 * - R2_ACCESS_KEY_ID
 * - R2_SECRET_ACCESS_KEY
 * - R2_BUCKET_NAME (or legacy R2_BUCKET)
 * - R2_PUBLIC_BASE_URL (valid http/https URL)
 */
function getR2ImgSrcOrigin() {
  const driver = String(process.env.UPLOAD_STORAGE_DRIVER || "local").trim().toLowerCase();
  if (driver !== "r2") {
    return null;
  }

  const hasAccountId = String(process.env.R2_ACCOUNT_ID || "").trim().length > 0;
  const hasAccessKey = String(process.env.R2_ACCESS_KEY_ID || "").trim().length > 0;
  const hasSecret = String(process.env.R2_SECRET_ACCESS_KEY || "").trim().length > 0;
  const hasBucket = String(process.env.R2_BUCKET_NAME || process.env.R2_BUCKET || "").trim().length > 0;
  if (!hasAccountId || !hasAccessKey || !hasSecret || !hasBucket) {
    return null;
  }

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
