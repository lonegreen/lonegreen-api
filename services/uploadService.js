const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const logger = require("./logger");
const pool = require("../db/pool");
const { NODE_ENV } = require("../config/env");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads");
const LOCAL_PUBLIC_URL_PREFIX = "/uploads/";
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const EXTERNAL_DRIVER_NOT_READY_MESSAGE =
  "External upload storage driver is configured but not implemented/enabled yet.";
const R2_PUBLIC_CACHE_CONTROL = "public, max-age=2592000, immutable";

function externalDriverNotReadyError() {
  const err = new Error(EXTERNAL_DRIVER_NOT_READY_MESSAGE);
  err.code = "UPLOAD_DRIVER_NOT_READY";
  err.statusCode = 503;
  return err;
}

const ALLOWED_EXTENSION_MIME = {
  ".jpg": new Set(["image/jpeg"]),
  ".jpeg": new Set(["image/jpeg"]),
  ".png": new Set(["image/png"]),
  ".webp": new Set(["image/webp"]),
  ".pdf": new Set(["application/pdf"])
};
const ALLOWED_EXTENSIONS = new Set(Object.keys(ALLOWED_EXTENSION_MIME));
const ALLOWED_MIME_TYPES = new Set(
  Object.values(ALLOWED_EXTENSION_MIME).flatMap(set => Array.from(set))
);

/** Blocks disguised executables or script-like names in the original filename (stored name is still randomized). */
const DANGEROUS_NAME_RE = /\.(exe|bat|cmd|com|pif|scr|vbs|js|jar|mjs|cjs|sh|bash|php|phtml|phar|asp|aspx|jsp|jspx|cgi|pl|ps1|psm1|hta|svg)(\.|$)/i;

let hasLoggedEphemeralStorageWarning = false;
const LOCAL_PROD_DURABILITY_WARNING =
  "Local upload storage is not durable in production. Configure external object storage before public launch.";

function getUploadStorageDriver() {
  const raw = String(process.env.UPLOAD_STORAGE_DRIVER || "local").trim().toLowerCase();
  if (["local", "s3", "r2"].includes(raw)) {
    return raw;
  }
  return "local";
}

function isExternalUploadStorageEnabled() {
  return getUploadStorageDriver() !== "local";
}

/* ============================================================
 * R2 (Cloudflare) — S3-compatible object storage driver
 *
 * Activates only when UPLOAD_STORAGE_DRIVER=r2.
 * Reads config from env each access (so .env-only mode picks up changes
 * without rebuilding module state). Client is lazily constructed once.
 *
 * Required env when driver=r2:
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET_NAME (preferred) or R2_BUCKET (legacy)
 *   R2_PUBLIC_BASE_URL   (e.g. https://media.example.com  OR https://pub-<hash>.r2.dev)
 * ============================================================ */

function readR2Config() {
  const bucketName = String(process.env.R2_BUCKET_NAME || "").trim();
  const legacyBucket = String(process.env.R2_BUCKET || "").trim();
  return {
    accountId: String(process.env.R2_ACCOUNT_ID || "").trim(),
    accessKeyId: String(process.env.R2_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || "").trim(),
    bucket: bucketName || legacyBucket,
    publicBaseUrl: String(process.env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "")
  };
}

function r2MissingEnvKeys() {
  const cfg = readR2Config();
  const missing = [];
  if (!cfg.accountId) missing.push("R2_ACCOUNT_ID");
  if (!cfg.accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!cfg.secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!cfg.bucket) missing.push("R2_BUCKET_NAME");
  if (!cfg.publicBaseUrl) missing.push("R2_PUBLIC_BASE_URL");
  return missing;
}

function isR2Configured() {
  return r2MissingEnvKeys().length === 0;
}

function readS3Config() {
  return {
    bucket: String(process.env.S3_BUCKET_NAME || process.env.S3_BUCKET || "").trim(),
    region: String(process.env.S3_REGION || "").trim(),
    accessKeyId: String(process.env.S3_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(process.env.S3_SECRET_ACCESS_KEY || "").trim(),
    publicBaseUrl: String(process.env.S3_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "")
  };
}

function s3MissingEnvKeys() {
  const cfg = readS3Config();
  const missing = [];
  if (!cfg.bucket) missing.push("S3_BUCKET_NAME");
  if (!cfg.region) missing.push("S3_REGION");
  if (!cfg.accessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!cfg.secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  if (!cfg.publicBaseUrl) missing.push("S3_PUBLIC_BASE_URL");
  return missing;
}

function isS3Configured() {
  return s3MissingEnvKeys().length === 0;
}

function productionUploadMisconfiguredError(driverLabel, missingKeys) {
  const err = new Error(
    `Production upload storage: ${driverLabel} driver selected but configuration is incomplete` +
    (missingKeys && missingKeys.length ? `: missing ${missingKeys.join(", ")}` : "")
  );
  err.code = "UPLOAD_DRIVER_MISCONFIGURED_PRODUCTION";
  err.statusCode = 503;
  return err;
}

function getEffectiveUploadStorageDriver() {
  const driver = getUploadStorageDriver();
  const prod = String(NODE_ENV || "").toLowerCase() === "production";
  if (driver === "r2" && !isR2Configured()) {
    if (prod) {
      throw productionUploadMisconfiguredError("R2", r2MissingEnvKeys());
    }
    return "local";
  }
  if (driver === "s3" && !isS3Configured()) {
    if (prod) {
      throw productionUploadMisconfiguredError("S3", s3MissingEnvKeys());
    }
    return "local";
  }
  return driver;
}

function assertR2EnvReady() {
  const missing = r2MissingEnvKeys();
  if (missing.length > 0) {
    const err = new Error(
      "Cloudflare R2 storage driver requested but missing required env: " +
      missing.join(", ")
    );
    err.code = "UPLOAD_DRIVER_NOT_READY";
    err.statusCode = 503;
    throw err;
  }
}

let cachedR2Client = null;
function getR2Client() {
  if (cachedR2Client) {
    return cachedR2Client;
  }
  assertR2EnvReady();
  // Lazy require so projects that never enable R2 don't pay the SDK load cost
  // and so tests with driver=local don't need the SDK to be installed.
  // eslint-disable-next-line global-require
  const { S3Client } = require("@aws-sdk/client-s3");
  const cfg = readR2Config();
  cachedR2Client = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey
    },
    forcePathStyle: false
  });
  return cachedR2Client;
}

function r2PublicUrlFromKey(key) {
  const cfg = readR2Config();
  const cleanKey = String(key || "").replace(/^\/+/, "");
  return `${cfg.publicBaseUrl}/${cleanKey}`;
}

function r2KeyFromPublicUrl(url) {
  const cfg = readR2Config();
  const raw = String(url || "").trim();
  if (!cfg.publicBaseUrl || !raw.startsWith(`${cfg.publicBaseUrl}/`)) {
    return null;
  }
  const key = raw.slice(cfg.publicBaseUrl.length + 1);
  if (!key || key.includes("..")) {
    return null;
  }
  return key;
}

async function r2PutObject(key, bodyBuffer, contentType) {
  const client = getR2Client();
  // eslint-disable-next-line global-require
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const cfg = readR2Config();
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: String(key).replace(/^\/+/, ""),
    Body: bodyBuffer,
    ContentType: contentType || "application/octet-stream",
    CacheControl: R2_PUBLIC_CACHE_CONTROL
  }));
}

async function r2DeleteObject(key) {
  const client = getR2Client();
  // eslint-disable-next-line global-require
  const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
  const cfg = readR2Config();
  try {
    await client.send(new DeleteObjectCommand({
      Bucket: cfg.bucket,
      Key: String(key).replace(/^\/+/, "")
    }));
    return true;
  } catch (err) {
    // Best-effort: do not fail the user mutation if the object is already gone
    // or if the provider is briefly unavailable.
    logger.warn("UPLOAD_R2_DELETE_NOTE", {
      key,
      error: err && err.message
    });
    return false;
  }
}

/**
 * Cloud drivers other than R2 are scaffold-only. Prevent silent prod boot with
 * an unfinished driver. R2 is allowed in production once env vars are present.
 * Local-disk uploads must NOT silently boot in production: object storage is
 * required for durability. Operators may opt-in to a non-durable boot via the
 * explicit ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=true override (used only for
 * narrowly scoped break-glass / single-host scenarios).
 * Throws synchronously at module load (called from maybeWarnEphemeralLocalUploads).
 */
function assertCloudDriverNotActiveInProduction() {
  const driver = getUploadStorageDriver();
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!isProduction) {
    return;
  }
  if (driver === "local") {
    const allowLocal = String(process.env.ALLOW_LOCAL_UPLOADS_IN_PRODUCTION || "")
      .trim()
      .toLowerCase() === "true";
    if (!allowLocal) {
      const err = new Error(
        "UPLOAD_STORAGE_DRIVER='local' is not allowed in production. " +
        LOCAL_PROD_DURABILITY_WARNING + " " +
        "Configure UPLOAD_STORAGE_DRIVER=r2 (with R2_* env vars) or set " +
        "ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=true to explicitly accept the " +
        "non-durable storage risk for this boot."
      );
      err.code = "UPLOAD_DRIVER_NOT_READY";
      throw err;
    }
    logger.warn("UPLOAD_LOCAL_STORAGE_PRODUCTION_OVERRIDE", {
      detail: "ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=true: booting with non-durable local upload storage."
    });
    return;
  }
  if (driver === "r2") {
    // R2 is implemented; require env to be complete in production.
    const missing = r2MissingEnvKeys();
    if (missing.length > 0) {
      const err = new Error(
        "UPLOAD_STORAGE_DRIVER='r2' is set but missing env: " + missing.join(", ")
      );
      err.code = "UPLOAD_DRIVER_NOT_READY";
      throw err;
    }
    return;
  }
  // s3 (and any other future scaffold)
  const err = new Error(
    "UPLOAD_STORAGE_DRIVER='" + driver + "' is scaffold-only. " +
    "Implement and verify the driver before enabling it in production."
  );
  err.code = "UPLOAD_DRIVER_NOT_READY";
  throw err;
}

function maybeWarnEphemeralLocalUploads() {
  if (hasLoggedEphemeralStorageWarning) {
    return;
  }

  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const isProduction = nodeEnv === "production";
  const hostSignals = [
    process.env.RENDER,
    process.env.RENDER_SERVICE_ID,
    process.env.RENDER_EXTERNAL_URL,
    process.env.DYNO
  ].filter(Boolean);
  const isLocalDriver = getUploadStorageDriver() === "local";

  if (isProduction && isLocalDriver) {
    logger.warn("UPLOAD_LOCAL_STORAGE_PRODUCTION_WARNING", {
      detail: LOCAL_PROD_DURABILITY_WARNING
    });
  }

  if (isProduction && isLocalDriver && hostSignals.length > 0) {
    logger.warn("UPLOAD_EPHEMERAL_STORAGE_WARNING", {
      detail: "local disk uploads on ephemeral host; /public/uploads may be lost on redeploy"
    });
  }

  hasLoggedEphemeralStorageWarning = true;
  assertCloudDriverNotActiveInProduction();
}

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function safeExtension(originalName) {
  return path.extname(String(originalName || "")).toLowerCase();
}

function hasUnsafeName(originalName) {
  const name = path.basename(String(originalName || ""));
  return !name
    || name.length > 180
    || /[<>:"|?*\x00-\x1F]/.test(name)
    || name.startsWith(".")
    || name.includes("..")
    || DANGEROUS_NAME_RE.test(name);
}

function safeFilename(file) {
  const ext = safeExtension(file.originalname);
  const suffix = crypto.randomBytes(8).toString("hex");
  return `${Date.now()}-${suffix}${ext}`;
}

function fileFilter(req, file, callback) {
  const driver = getEffectiveUploadStorageDriver();
  if (driver === "s3") {
    // Still scaffold-only: refuse early to avoid writing temp files we cannot publish.
    return callback(externalDriverNotReadyError());
  }

  const ext = safeExtension(file.originalname);
  const allowedMimeForExt = ALLOWED_EXTENSION_MIME[ext];

  if (hasUnsafeName(file.originalname)) {
    return callback(new Error("Unsafe file name"));
  }

  if (!allowedMimeForExt || !allowedMimeForExt.has(file.mimetype)) {
    return callback(new Error("Unsupported file type"));
  }

  return callback(null, true);
}

// Multer always writes to local temp first (UPLOAD_DIR). For driver=r2 we then
// transfer the temp file to R2 via publishUploadedFile() and delete the local
// copy. This keeps magic-byte verification (assertUploadContentMatchesMime),
// safe-name checks, and request flow identical across drivers.
ensureUploadDir();
maybeWarnEphemeralLocalUploads();

const storage = multer.diskStorage({
  destination(req, file, callback) {
    ensureUploadDir();
    callback(null, UPLOAD_DIR);
  },
  filename(req, file, callback) {
    callback(null, safeFilename(file));
  }
});

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 10
  }
});

function getUploadReadiness() {
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const ephemeralSignals = [
    process.env.RENDER,
    process.env.RENDER_SERVICE_ID,
    process.env.RENDER_EXTERNAL_URL,
    process.env.DYNO
  ].filter(Boolean);

  const driver = getUploadStorageDriver();
  let effectiveDriver = "local";
  try {
    effectiveDriver = getEffectiveUploadStorageDriver();
  } catch (err) {
    return {
      status: "error",
      storage: driver,
      effective_storage: null,
      external_storage_enabled: driver !== "local",
      error_code: err && err.code ? err.code : "UPLOAD_DRIVER_ERROR",
      message: err && err.message ? err.message : String(err),
      upload_dir: UPLOAD_DIR,
      max_file_size_mb: Math.round(MAX_FILE_SIZE / 1024 / 1024),
      allowed_extensions: Array.from(ALLOWED_EXTENSIONS),
      ephemeral_storage_warning: driver === "local" && nodeEnv === "production"
    };
  }
  const externalEnabled = driver !== "local";
  const r2Configured = driver === "r2" ? isR2Configured() : null;
  const r2Missing = driver === "r2" ? r2MissingEnvKeys() : [];
  const s3Configured = driver === "s3" ? isS3Configured() : null;
  const s3Missing = driver === "s3" ? s3MissingEnvKeys() : [];

  let status = "ok";
  if (driver === "local" && nodeEnv === "production") {
    status = "warning";
  }
  if (driver === "r2" && !r2Configured) {
    status = "error";
  }
  if (driver === "s3") {
    status = isS3Configured() ? "warning" : "error";
  }

  return {
    status,
    storage: driver,
    effective_storage: effectiveDriver,
    external_storage_enabled: externalEnabled,
    external_storage_scaffold_only: driver === "s3",
    r2_configured: r2Configured,
    r2_missing_env: r2Missing,
    r2_public_base_url: driver === "r2" ? readR2Config().publicBaseUrl || null : null,
    r2_fallback_to_local: driver === "r2" && effectiveDriver === "local",
    s3_configured: s3Configured,
    s3_missing_env: s3Missing,
    s3_fallback_to_local: driver === "s3" && effectiveDriver === "local",
    upload_dir: UPLOAD_DIR,
    max_file_size_mb: Math.round(MAX_FILE_SIZE / 1024 / 1024),
    allowed_extensions: Array.from(ALLOWED_EXTENSIONS),
    ephemeral_storage_warning: driver === "local" && nodeEnv === "production" && ephemeralSignals.length > 0
  };
}

function validateStorageDriverEnv() {
  const configuredDriver = getUploadStorageDriver();
  if (configuredDriver === "r2") {
    return {
      driver: "r2",
      ready: isR2Configured(),
      missing_env: r2MissingEnvKeys()
    };
  }
  if (configuredDriver === "s3") {
    return {
      driver: "s3",
      ready: isS3Configured(),
      missing_env: s3MissingEnvKeys()
    };
  }
  return {
    driver: "local",
    ready: true,
    missing_env: []
  };
}

function getStorageActivationStatus() {
  const configured = getUploadStorageDriver();
  const effective = getEffectiveUploadStorageDriver();
  const validation = validateStorageDriverEnv();
  const activation_blockers = [];
  if (configured !== "local" && !validation.ready) {
    activation_blockers.push(`Missing env for ${configured}: ${validation.missing_env.join(", ")}`);
  }
  if (configured === "local" && String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    activation_blockers.push("Local upload storage is not durable for production launch. Configure external object storage.");
  }
  if (configured === "s3") {
    activation_blockers.push("S3 upload adapter remains scaffold-only in this phase.");
  }
  return {
    status: activation_blockers.length ? "needs_review" : "ready",
    configured_driver: configured,
    effective_driver: effective,
    env_ready: validation.ready,
    missing_env: validation.missing_env,
    activation_blockers
  };
}

function adapterNotReady(message, code) {
  const err = new Error(message);
  err.code = code || "UPLOAD_ADAPTER_NOT_READY";
  err.statusCode = 503;
  return err;
}

function buildStorageAdapters() {
  return {
    local: {
      ready: true,
      publicUrlFromKey: (key) => localPublicUploadUrl(path.basename(String(key || ""))),
      upload: async ({ key }) => ({ key: path.basename(String(key || "")), url: localPublicUploadUrl(path.basename(String(key || ""))) }),
      remove: async ({ url }) => deleteLocalUpload(url)
    },
    r2: {
      ready: isR2Configured(),
      publicUrlFromKey: (key) => r2PublicUrlFromKey(path.basename(String(key || ""))),
      upload: async ({ key, filePath, contentType }) => {
        if (!isR2Configured()) throw adapterNotReady("R2 adapter is not configured", "UPLOAD_R2_NOT_CONFIGURED");
        const safeKey = path.basename(String(key || ""));
        const buffer = await fs.promises.readFile(filePath);
        await r2PutObject(safeKey, buffer, contentType);
        return { key: safeKey, url: r2PublicUrlFromKey(safeKey) };
      },
      remove: async ({ url }) => {
        if (!isR2Configured()) return false;
        const key = r2KeyFromPublicUrl(url);
        return key ? r2DeleteObject(key) : false;
      }
    },
    s3: {
      ready: false,
      publicUrlFromKey: (key) => {
        const cfg = readS3Config();
        if (!cfg.publicBaseUrl) throw adapterNotReady("S3 public URL base is not configured", "UPLOAD_S3_NOT_CONFIGURED");
        return `${cfg.publicBaseUrl}/${path.basename(String(key || ""))}`;
      },
      upload: async () => {
        throw adapterNotReady("S3 adapter scaffold is not enabled for uploads in this phase", "UPLOAD_S3_SCAFFOLD");
      },
      remove: async () => false
    }
  };
}

function localPublicUploadUrl(filename) {
  return `/uploads/${path.basename(filename)}`;
}

function localPathFromPublicUrl(imageUrl) {
  const raw = String(imageUrl || "").trim();
  if (!raw) {
    return null;
  }

  // Only operate on URLs we actually own (relative /uploads/<file> path).
  // Reject absolute/external URLs to avoid acting on attacker-supplied paths.
  if (!raw.startsWith(LOCAL_PUBLIC_URL_PREFIX)) {
    return null;
  }

  const filename = path.basename(raw);
  if (!filename || filename === "." || filename === "..") {
    return null;
  }

  return path.join(UPLOAD_DIR, filename);
}

async function assertUploadPathWithinDir(filePath) {
  const resolvedFile = path.resolve(String(filePath || ""));
  const resolvedDir = path.resolve(UPLOAD_DIR);
  if (resolvedFile === resolvedDir || !resolvedFile.startsWith(resolvedDir + path.sep)) {
    throw new Error("Upload path outside allowed directory");
  }
}

/**
 * Confirms on-disk magic bytes match declared image/PDF MIME (mitigates spoofed Content-Type).
 */
async function assertUploadContentMatchesMime(filePath, mimetype) {
  await assertUploadPathWithinDir(filePath);

  const fh = await fs.promises.open(filePath, "r");
  const buf = Buffer.alloc(16);
  try {
    await fh.read(buf, 0, 16, 0);
  } finally {
    await fh.close();
  }

  const declared = String(mimetype || "").toLowerCase();

  if (declared === "image/jpeg" || declared === "image/jpg") {
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
      throw new Error("File content does not match JPEG");
    }
    return;
  }

  if (declared === "image/png") {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.subarray(0, 8).equals(sig)) {
      throw new Error("File content does not match PNG");
    }
    return;
  }

  if (declared === "image/webp") {
    const head = buf.slice(0, 12).toString("utf8");
    if (!head.startsWith("RIFF") || buf.slice(8, 12).toString("utf8") !== "WEBP") {
      throw new Error("File content does not match WEBP");
    }
    return;
  }

  if (declared === "application/pdf") {
    const head = buf.slice(0, 5).toString("utf8");
    if (!head.startsWith("%PDF")) {
      throw new Error("File content does not match PDF");
    }
    return;
  }

  throw new Error("Unsupported content validation for MIME type");
}

async function deleteLocalUpload(imageUrl) {
  const localPath = localPathFromPublicUrl(imageUrl);

  if (!localPath) {
    return false;
  }

  try {
    await fs.promises.unlink(localPath);
    return true;
  } catch (err) {
    console.log("UPLOAD FILE DELETE NOTE:", err.message);
    return false;
  }
}

/**
 * Always-safe deletion of the local temp file produced by multer for the given
 * incoming request file, regardless of which storage driver is active.
 * Use this for pre-publish error paths (validation failures, auth failures,
 * etc.) — at that point the file has only been written to local temp.
 */
async function cleanupLocalTemp(reqFile) {
  if (!reqFile || !reqFile.path) {
    return false;
  }
  try {
    await assertUploadPathWithinDir(reqFile.path);
  } catch {
    return false;
  }
  try {
    await fs.promises.unlink(reqFile.path);
    return true;
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      logger.warn("UPLOAD_LOCAL_TEMP_CLEANUP_NOTE", { error: err.message });
    }
    return false;
  }
}

/**
 * Publish a multer-uploaded local temp file to its final storage destination
 * and return the public URL to persist in the database.
 *
 *  - driver=local: leaves file at public/uploads/<filename>; returns /uploads/<filename>
 *  - driver=r2:    streams the buffer to R2, deletes the local temp on success,
 *                  and returns `${R2_PUBLIC_BASE_URL}/<key>`.
 *
 * Route handlers should call this exactly once after `verifyUploadContent` and
 * before persisting the URL. If a later step (e.g., DB insert) fails, callers
 * should pass the returned URL to `deleteStoredFile` to remove the orphan.
 */
async function publishUploadedFile(reqFile) {
  if (!reqFile || !reqFile.path || !reqFile.filename) {
    throw new Error("publishUploadedFile requires a multer disk-storage file");
  }
  const driver = getEffectiveUploadStorageDriver();

  if (driver === "local") {
    return localPublicUploadUrl(reqFile.filename);
  }

  if (driver === "r2") {
    assertR2EnvReady();
    await assertUploadPathWithinDir(reqFile.path);
    const buffer = await fs.promises.readFile(reqFile.path);
    const key = path.basename(reqFile.filename);
    try {
      await r2PutObject(key, buffer, reqFile.mimetype);
    } catch (err) {
      // Leave local temp in place so the route's catch can call cleanupLocalTemp.
      logger.error("UPLOAD_R2_PUT_FAILED", {
        key,
        error: err && err.message
      });
      const wrapped = new Error("Cloud storage upload failed");
      wrapped.code = "UPLOAD_R2_PUT_FAILED";
      wrapped.statusCode = 502;
      throw wrapped;
    }
    // Successful upload to R2: remove the local temp copy.
    try {
      await fs.promises.unlink(reqFile.path);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        logger.warn("UPLOAD_R2_LOCAL_TEMP_UNLINK_NOTE", { error: err.message });
      }
    }
    return r2PublicUrlFromKey(key);
  }

  // s3 and any future scaffold-only driver
  throw externalDriverNotReadyError();
}

async function saveUploadedFile(file, options = {}) {
  const driver = getEffectiveUploadStorageDriver();
  if (driver === "s3") {
    throw externalDriverNotReadyError();
  }
  const fallbackName = options.filename || options.key || "";
  const key = path.basename((file && file.filename) || fallbackName);
  if (!key) {
    throw new Error("Missing uploaded file key");
  }
  if (driver === "r2") {
    if (!file || !file.path) {
      throw new Error("saveUploadedFile requires a multer disk-storage file when driver=r2");
    }
    const buffer = await fs.promises.readFile(file.path);
    await r2PutObject(key, buffer, file.mimetype);
    try { await fs.promises.unlink(file.path); } catch { /* ignore */ }
    return {
      driver: "r2",
      key,
      url: r2PublicUrlFromKey(key),
      path: null
    };
  }
  return {
    driver: "local",
    key,
    url: localPublicUploadUrl(key),
    path: (file && file.path) || path.join(UPLOAD_DIR, key)
  };
}

/**
 * Delete a previously-published file by its public URL. Dispatches to the
 * correct backend based on URL prefix; safely no-ops on URLs we don't own.
 */
async function deleteStoredFile(urlOrKey) {
  const raw = String(urlOrKey || "").trim();
  if (!raw) {
    return false;
  }

  // Local relative path: /uploads/<filename>
  if (raw.startsWith(LOCAL_PUBLIC_URL_PREFIX)) {
    return deleteLocalUpload(raw);
  }

  // R2 public URL: starts with R2_PUBLIC_BASE_URL
  if (getUploadStorageDriver() === "r2" || isR2Configured()) {
    const key = r2KeyFromPublicUrl(raw);
    if (key) {
      return r2DeleteObject(key);
    }
  }

  // Unknown / external URL: do not act.
  return false;
}

/**
 * Returns the canonical public URL for a stored object, given a multer-style
 * filename. For local driver that's `/uploads/<filename>`; for R2 it's the
 * R2 public base URL plus the same key.
 *
 * Note: callers that have a multer `req.file` and want to PUBLISH should call
 * `publishUploadedFile(req.file)` instead — it both transfers (when needed)
 * and returns the URL.
 */
function publicUploadUrl(filename) {
  const driver = getEffectiveUploadStorageDriver();
  const key = path.basename(String(filename || ""));
  if (!key) {
    return "";
  }
  if (driver === "local") {
    return localPublicUploadUrl(key);
  }
  if (driver === "r2") {
    if (!isR2Configured()) {
      throw externalDriverNotReadyError();
    }
    return r2PublicUrlFromKey(key);
  }
  throw externalDriverNotReadyError();
}

function getUploadAdapter() {
  const adapters = buildStorageAdapters();
  const driver = getEffectiveUploadStorageDriver();
  return adapters[driver] || adapters.local;
}

function getDeleteAdapter() {
  return getUploadAdapter();
}

/**
 * Read-only: DB rows pointing at missing jobs (storage URLs may still exist — audit visibility only).
 */
async function findOrphanUploads(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
  const candidates = [];
  try {
    const r = await pool.query(
      `
      SELECT jp.id AS job_photo_id, jp.job_id, jp.company_id, jp.image_url
      FROM job_photos jp
      LEFT JOIN jobs j ON j.id = jp.job_id AND j.company_id = jp.company_id
      WHERE jp.job_id IS NOT NULL
        AND j.id IS NULL
      ORDER BY jp.id
      LIMIT $1
      `,
      [limit]
    );
    for (const row of r.rows) {
      candidates.push({
        kind: "job_photo_missing_job",
        job_photo_id: row.job_photo_id,
        job_id: row.job_id,
        company_id: row.company_id,
        image_url: row.image_url
      });
    }
  } catch (err) {
    logger.warn("FIND_ORPHAN_UPLOADS_QUERY_SKIPPED", {
      message: err && err.message ? String(err.message) : String(err)
    });
  }
  return {
    scanned_at: new Date().toISOString(),
    candidate_count: candidates.length,
    candidates
  };
}

async function validateUploadOwnership({ companyId, jobId, imageUrl }) {
  const cid = Number(companyId);
  if (!Number.isInteger(cid) || cid <= 0 || !imageUrl) {
    return { ok: false, reason: "invalid_input" };
  }
  const jid = jobId != null ? Number(jobId) : null;
  const params = [String(imageUrl), cid];
  let sql = `
    SELECT jp.id
    FROM job_photos jp
    INNER JOIN jobs j ON j.id = jp.job_id AND j.company_id = jp.company_id
    WHERE jp.image_url = $1
      AND jp.company_id = $2
  `;
  if (jid != null && Number.isInteger(jid) && jid > 0) {
    sql += ` AND jp.job_id = $3`;
    params.push(jid);
  }
  sql += `
    LIMIT 1
  `;
  try {
    const r = await pool.query(sql, params);
    return { ok: r.rows.length > 0 };
  } catch (err) {
    logger.warn("VALIDATE_UPLOAD_OWNERSHIP_ERROR", { message: err && err.message });
    return { ok: false, reason: "query_error" };
  }
}

async function getUploadCleanupCandidates(options) {
  return findOrphanUploads(options);
}

module.exports = {
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  upload,
  ensureUploadDir,
  getUploadStorageDriver,
  isExternalUploadStorageEnabled,
  getEffectiveUploadStorageDriver,
  externalDriverNotReadyError,
  saveUploadedFile,
  deleteStoredFile,
  publishUploadedFile,
  cleanupLocalTemp,
  getPublicUploadUrl: publicUploadUrl,
  getUploadReadiness,
  publicUploadUrl,
  deleteLocalUpload,
  assertUploadContentMatchesMime,
  assertUploadPathWithinDir,
  isR2Configured,
  r2MissingEnvKeys,
  isS3Configured,
  s3MissingEnvKeys,
  buildStorageAdapters,
  getUploadAdapter,
  getDeleteAdapter,
  validateStorageDriverEnv,
  getStorageActivationStatus,
  findOrphanUploads,
  validateUploadOwnership,
  getUploadCleanupCandidates
};
