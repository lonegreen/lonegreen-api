/**
 * Verifies R2 CSP origin parsing and upload readiness interaction with health `ok`.
 * Does not start the HTTP server or require a database for CSP/origin checks.
 *
 * Run: npm run verify:r2-launch
 * Or:  node scripts/verify-r2-launch-fix.js
 */

const assert = require("assert");

function stripEnv(keys) {
  for (const k of keys) {
    delete process.env[k];
  }
}

function runCspOriginTests() {
  const { getR2ImgSrcOrigin } = require("../services/r2CspOrigin");

  stripEnv(["R2_PUBLIC_BASE_URL"]);

  assert.strictEqual(
    getR2ImgSrcOrigin(),
    null,
    "missing R2_PUBLIC_BASE_URL must not add CSP origin"
  );

  process.env.R2_PUBLIC_BASE_URL = "https://media.fairlinx.com/path/ignored";
  delete require.cache[require.resolve("../services/r2CspOrigin")];
  const { getR2ImgSrcOrigin: origin2 } = require("../services/r2CspOrigin");
  assert.strictEqual(
    origin2(),
    "https://media.fairlinx.com",
    "must use origin only (scheme + host), strip path"
  );

  process.env.R2_PUBLIC_BASE_URL = "  https://cdn.example.com:443/foo  ";
  delete require.cache[require.resolve("../services/r2CspOrigin")];
  const { getR2ImgSrcOrigin: origin3 } = require("../services/r2CspOrigin");
  assert.strictEqual(origin3(), "https://cdn.example.com");

  process.env.R2_PUBLIC_BASE_URL = "javascript:alert(1)";
  delete require.cache[require.resolve("../services/r2CspOrigin")];
  const { getR2ImgSrcOrigin: origin4 } = require("../services/r2CspOrigin");
  assert.strictEqual(origin4(), null, "reject non-http(s) schemes");

  stripEnv(["R2_PUBLIC_BASE_URL"]);
  console.log("OK: getR2ImgSrcOrigin() CSP origin tests passed");

  // Mirrors server.js: default img-src without R2 env stays unchanged (same-origin + data + blob only).
  delete require.cache[require.resolve("../services/r2CspOrigin")];
  stripEnv(["R2_PUBLIC_BASE_URL"]);
  const { getR2ImgSrcOrigin: oLocal } = require("../services/r2CspOrigin");
  const imgLocal = ["'self'", "data:", "blob:"];
  const r2o = oLocal();
  if (r2o) imgLocal.push(r2o);
  assert.deepStrictEqual(
    imgLocal,
    ["'self'", "data:", "blob:"],
    "without R2_PUBLIC_BASE_URL, img-src must stay default three directives"
  );

  process.env.R2_PUBLIC_BASE_URL = "https://media.fairlinx.com/assets";
  delete require.cache[require.resolve("../services/r2CspOrigin")];
  const { getR2ImgSrcOrigin: oR2 } = require("../services/r2CspOrigin");
  const imgR2 = ["'self'", "data:", "blob:"];
  const add = oR2();
  if (add) imgR2.push(add);
  assert.deepStrictEqual(
    imgR2,
    ["'self'", "data:", "blob:", "https://media.fairlinx.com"],
    "with R2_PUBLIC_BASE_URL, img-src must include parsed origin only"
  );
  stripEnv(["R2_PUBLIC_BASE_URL"]);

  console.log("OK: server-style img-src directive assembly tests passed");
}

function ensureDistinctStripePrices() {
  // Avoid duplicate Stripe price crash from config/env when loading uploadService
  process.env.STRIPE_PRICE_BUSINESS = process.env.STRIPE_PRICE_BUSINESS || "price_verify_r2_distinct";
  if (process.env.STRIPE_PRICE_BASIC === process.env.STRIPE_PRICE_BUSINESS) {
    process.env.STRIPE_PRICE_BUSINESS = "price_verify_r2_distinct_fallback";
  }
}

function reloadUploadService() {
  delete require.cache[require.resolve("../config/env")];
  delete require.cache[require.resolve("../services/uploadService")];
  return require("../services/uploadService");
}

function runUploadReadinessErrorTest() {
  ensureDistinctStripePrices();

  stripEnv([
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_BASE_URL"
  ]);
  process.env.UPLOAD_STORAGE_DRIVER = "r2";

  const uploadService = reloadUploadService();
  const ur = uploadService.getUploadReadiness();
  assert.strictEqual(ur.status, "error", "r2 driver without R2 env must report uploads.status error");

  const uploadsReady = ur.status !== "error";
  assert.strictEqual(uploadsReady, false, "uploadsReady must be false when uploads.status is error");

  assert.deepStrictEqual(
    uploadService.r2MissingEnvKeys().sort(),
    [
      "R2_ACCESS_KEY_ID",
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
      "R2_PUBLIC_BASE_URL",
      "R2_SECRET_ACCESS_KEY"
    ],
    "r2MissingEnvKeys must list every missing required R2 env var"
  );
  assert.strictEqual(uploadService.isR2Configured(), false, "isR2Configured must be false when R2 env is missing");

  assert.throws(
    () => uploadService.getPublicUploadUrl("test.jpg"),
    (err) => err && err.code === "UPLOAD_DRIVER_NOT_READY",
    "getPublicUploadUrl must refuse when driver=r2 and env is incomplete"
  );

  console.log("OK: upload readiness error state (r2 + missing env) tests passed");

  process.env.UPLOAD_STORAGE_DRIVER = "local";
  reloadUploadService();
}

function runLocalModeUnchangedTest() {
  ensureDistinctStripePrices();
  stripEnv([
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_BASE_URL"
  ]);
  process.env.UPLOAD_STORAGE_DRIVER = "local";

  const uploadService = reloadUploadService();
  const ur = uploadService.getUploadReadiness();
  assert.notStrictEqual(ur.status, "error", "local mode without R2 env must not be error");
  assert.strictEqual(uploadService.getUploadStorageDriver(), "local");

  assert.strictEqual(
    uploadService.getPublicUploadUrl("photo-123.png"),
    "/uploads/photo-123.png",
    "local mode must keep /uploads/<basename> contract"
  );
  assert.strictEqual(
    uploadService.getPublicUploadUrl("/tmp/abs/leaked.png"),
    "/uploads/leaked.png",
    "local mode must basename-strip absolute paths"
  );
  assert.strictEqual(
    uploadService.publicUploadUrl("logo.webp"),
    "/uploads/logo.webp",
    "publicUploadUrl alias must match getPublicUploadUrl"
  );

  console.log("OK: local mode upload URL contract unchanged");
}

function runR2PublicUrlAndKeyParsingTest() {
  ensureDistinctStripePrices();

  process.env.UPLOAD_STORAGE_DRIVER = "r2";
  process.env.R2_ACCOUNT_ID = "acc_test";
  process.env.R2_ACCESS_KEY_ID = "ak_test";
  process.env.R2_SECRET_ACCESS_KEY = "sk_test";
  process.env.R2_BUCKET = "fairlinx-test";
  process.env.R2_PUBLIC_BASE_URL = "https://media.fairlinx.com";

  const uploadService = reloadUploadService();

  assert.strictEqual(uploadService.isR2Configured(), true, "isR2Configured true when all R2 env present");
  assert.deepStrictEqual(uploadService.r2MissingEnvKeys(), [], "no missing keys when R2 env complete");

  assert.strictEqual(
    uploadService.getPublicUploadUrl("photo.jpg"),
    "https://media.fairlinx.com/photo.jpg",
    "r2 mode public URL = base + key"
  );
  assert.strictEqual(
    uploadService.getPublicUploadUrl("nested/path/photo.jpg"),
    "https://media.fairlinx.com/photo.jpg",
    "r2 mode key is basenamed (multer-style filename, not paths)"
  );

  process.env.R2_PUBLIC_BASE_URL = "https://media.fairlinx.com/";
  const uploadService2 = reloadUploadService();
  assert.strictEqual(
    uploadService2.getPublicUploadUrl("photo.jpg"),
    "https://media.fairlinx.com/photo.jpg",
    "r2 mode must trim trailing slash from R2_PUBLIC_BASE_URL"
  );

  process.env.R2_PUBLIC_BASE_URL = "https://media.fairlinx.com";
  const uploadService3 = reloadUploadService();
  assert.strictEqual(
    uploadService3.getPublicUploadUrl(""),
    "",
    "empty filename returns empty string in r2 mode"
  );

  // deleteStoredFile must safely no-op for URLs we do not own.
  return (async () => {
    const r1 = await uploadService3.deleteStoredFile("https://attacker.example.com/evil.jpg");
    assert.strictEqual(r1, false, "deleteStoredFile must not act on foreign URLs");
    const r2 = await uploadService3.deleteStoredFile("");
    assert.strictEqual(r2, false, "deleteStoredFile must no-op on empty input");

    console.log("OK: R2 public URL / key parsing tests passed");

    process.env.UPLOAD_STORAGE_DRIVER = "local";
    stripEnv([
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_PUBLIC_BASE_URL"
    ]);
    reloadUploadService();
  })();
}

(async () => {
  runCspOriginTests();
  runUploadReadinessErrorTest();
  runLocalModeUnchangedTest();
  await runR2PublicUrlAndKeyParsingTest();

  console.log("");
  console.log("All verify-r2-launch-fix checks passed.");
})().catch((err) => {
  console.error("verify-r2-launch-fix FAILED");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
