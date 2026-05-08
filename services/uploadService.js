const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const logger = require("./logger");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads");
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const EXTERNAL_DRIVER_NOT_READY_MESSAGE =
  "External upload storage driver is configured but not implemented/enabled yet.";
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
  if (isExternalUploadStorageEnabled()) {
    return callback(new Error(EXTERNAL_DRIVER_NOT_READY_MESSAGE));
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

if (!isExternalUploadStorageEnabled()) {
  ensureUploadDir();
}
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
  const externalEnabled = driver !== "local";

  return {
    status: driver === "local" && nodeEnv === "production" && ephemeralSignals.length ? "warning" : "ok",
    storage: driver,
    external_storage_enabled: externalEnabled,
    external_storage_scaffold_only: externalEnabled,
    upload_dir: UPLOAD_DIR,
    max_file_size_mb: Math.round(MAX_FILE_SIZE / 1024 / 1024),
    allowed_extensions: Array.from(ALLOWED_EXTENSIONS),
    ephemeral_storage_warning: driver === "local" && nodeEnv === "production" && ephemeralSignals.length > 0
  };
}

function localPublicUploadUrl(filename) {
  return `/uploads/${path.basename(filename)}`;
}

function localPathFromPublicUrl(imageUrl) {
  const filename = path.basename(String(imageUrl || ""));

  if (!filename) {
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

function getPublicUploadUrl(keyOrPath) {
  if (isExternalUploadStorageEnabled()) {
    throw new Error(EXTERNAL_DRIVER_NOT_READY_MESSAGE);
  }
  return localPublicUploadUrl(keyOrPath);
}

async function saveUploadedFile(file, options = {}) {
  if (isExternalUploadStorageEnabled()) {
    throw new Error(EXTERNAL_DRIVER_NOT_READY_MESSAGE);
  }
  const fallbackName = options.filename || options.key || "";
  const key = path.basename((file && file.filename) || fallbackName);
  if (!key) {
    throw new Error("Missing uploaded file key");
  }
  return {
    driver: "local",
    key,
    url: localPublicUploadUrl(key),
    path: (file && file.path) || path.join(UPLOAD_DIR, key)
  };
}

async function deleteStoredFile(urlOrKey) {
  if (isExternalUploadStorageEnabled()) {
    throw new Error(EXTERNAL_DRIVER_NOT_READY_MESSAGE);
  }
  return deleteLocalUpload(urlOrKey);
}

function publicUploadUrl(filename) {
  return getPublicUploadUrl(filename);
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
  saveUploadedFile,
  deleteStoredFile,
  getPublicUploadUrl,
  getUploadReadiness,
  publicUploadUrl,
  deleteLocalUpload,
  assertUploadContentMatchesMime,
  assertUploadPathWithinDir
};
