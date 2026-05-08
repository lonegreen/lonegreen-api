const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, ".env")
});

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const {
  NODE_ENV,
  getProductionEnvReadiness,
  SUBSCRIPTION_INTERVAL_ENGINE,
  PORT
} = require("./config/env");

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const maintenanceOnly = require("./middleware/maintenanceOnly");
const auth = require("./middleware/auth");
const { requireMinimumRole } = auth;

const authRoutes = require("./routes/auth");
const leadsRoutes = require("./routes/leads");
const estimatesRoutes = require("./routes/estimates");
const invoicesRoutes = require("./routes/invoices");
const paymentsRoutes = require("./routes/payments");
const clientsRoutes = require("./routes/clients");
const jobsRoutes = require("./routes/jobs");
const subscriptionsRoutes = require("./routes/subscriptions");
const workersRoutes = require("./routes/workers");
const uploadsRoutes = require("./routes/uploads");
const calendarRoutes = require("./routes/calendar");
const zipGroupsRoutes = require("./routes/zipGroups");
const notificationsRoutes = require("./routes/notifications");
const customerRoutes = require("./routes/customer");
const analyticsRoutes = require("./routes/analytics");
const platformRoutes = require("./routes/platform");
const billingRoutes = require("./routes/billing");
const companiesRoutes = require("./routes/companies");
const reviewsRoutes = require("./routes/reviews");
const favoritesRoutes = require("./routes/favorites");
const followsRoutes = require("./routes/follows");
const messagesRoutes = require("./routes/messages");
const marketplaceRoutes = require("./routes/marketplace");
const servicesRoutes = require("./routes/services");
const supportRoutes = require("./routes/support");
const { handleStripeWebhookRequest } = require("./routes/stripeWebhook");
const { isStripeCheckoutConfigured } = require("./services/stripeService");
const launchRoutes = require("./routes/launch");
const trustRoutes = require("./routes/trust");

const { setupDatabase, assertProductionSchemaReady } = require("./db/setup");
const pool = require("./db/pool");
const { startSubscriptionEngine } = require("./services/subscriptionEngine");
const { startQueue, stopQueue, getQueueStatus } = require("./services/jobQueue");
const { startScheduler, stopScheduler, getSchedulerStatus } = require("./services/schedulerService");
const { getHealthReadiness } = require("./services/productionReadiness");
const { getR2ImgSrcOrigin } = require("./services/r2CspOrigin");
const logger = require("./services/logger");
const { logErrorEntry } = require("./services/errorLogService");

const app = express();
app.set("trust proxy", 1);
const RUN_STARTUP_MIGRATIONS = String(process.env.RUN_STARTUP_MIGRATIONS || "").trim().toLowerCase() === "true";
let hasLoggedCanonicalRouteNotice = false;
let lastHealthWarningAt = 0;

app.disable("x-powered-by");

/* CSP img-src: preserve defaults; add Cloudflare R2 public origin when R2_PUBLIC_BASE_URL is set */
const imgSrcDirectives = ["'self'", "data:", "blob:"];
const r2ImgSrcOrigin = getR2ImgSrcOrigin();
if (r2ImgSrcOrigin) {
  imgSrcDirectives.push(r2ImgSrcOrigin);
}

/* Middleware */
app.use(helmet({
  // CSP hardening is intentionally staged.
  // Temporary: keep 'unsafe-inline' for scripts/styles until all public pages remove inline
  // <script>/<style>, inline style attributes, and inline event handlers.
  // TODO(csp-hardening): remove 'unsafe-inline' from script-src/style-src after migration checklist in
  // docs/csp-hardening-plan.md is complete and verified in production-like smoke tests.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", "https://js.stripe.com", "https://accounts.google.com"],
      "style-src": ["'self'", "'unsafe-inline'", "https://accounts.google.com"],
      "img-src": imgSrcDirectives,
      "connect-src": ["'self'", "https://api.stripe.com", "https://accounts.google.com"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://hooks.stripe.com", "https://accounts.google.com"],
      "object-src": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: NODE_ENV === "production"
    ? {
      maxAge: 15552000,
      includeSubDomains: true
    }
    : false,
  frameguard: {
    action: "sameorigin"
  }
}));

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (NODE_ENV !== "production") {
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS origin not allowed"));
  }
};

app.use(cors(corsOptions));

app.post(
  "/billing/stripe/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhookRequest
);

app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhookRequest
);

app.use(express.json({
  limit: "2mb"
}));

app.use(express.urlencoded({
  extended: true
}));

app.use(express.static(
  path.join(__dirname, "public")
));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" }
});
const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const maintenanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many maintenance requests, please try again later" }
});

app.use(apiLimiter);

/* Health */
app.get("/health/live", healthLimiter, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    app: "FairLinx",
    process: {
      status: "ok",
      uptime_seconds: Math.round(process.uptime()),
      pid: process.pid
    },
    time: new Date().toISOString()
  });
});

app.get("/health", healthLimiter, async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const readiness = await getHealthReadiness();
    if (!readiness.ok && Date.now() - lastHealthWarningAt > 60000) {
      lastHealthWarningAt = Date.now();
      logger.warn("HEALTH_READINESS_NOT_READY", {
        database_status: readiness.database && readiness.database.status,
        migrations_status: readiness.migrations && readiness.migrations.status,
        environment_status: readiness.environment && readiness.environment.status
      });
    }

    res.status(readiness.ok ? 200 : 503).json({
      ...readiness,
      env: NODE_ENV,
      port: PORT,
      time: new Date().toISOString()
    });
  } catch (err) {
    logger.error("HEALTH CHECK ERROR", err);
    res.status(503).json({
      ok: false,
      app: "FairLinx",
      env: NODE_ENV,
      error: "Health check failed",
      time: new Date().toISOString()
    });
  }
});

app.get("/health/ready", healthLimiter, async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const readiness = await getHealthReadiness();
    res.status(readiness.ok ? 200 : 503).json({
      ok: readiness.ok,
      app: readiness.app,
      process: readiness.process,
      database: readiness.database,
      migrations: readiness.migrations,
      environment: readiness.environment,
      queue: readiness.queue,
      scheduler: readiness.scheduler,
      time: new Date().toISOString()
    });
  } catch (err) {
    logger.error("HEALTH_READY_CHECK_ERROR", err);
    res.status(503).json({
      ok: false,
      app: "FairLinx",
      error: "Readiness check failed",
      time: new Date().toISOString()
    });
  }
});

app.get("/queue/status", auth, requireMinimumRole("admin"), (req, res) => {
  res.json(getQueueStatus());
});

app.get("/scheduler/status", auth, requireMinimumRole("admin"), (req, res) => {
  res.json(getSchedulerStatus());
});

/* Debug (development only) */
if (NODE_ENV !== "production") {
  app.get("/debug/routes", (req, res) => {
    res.json({
      authMountedAt: "/auth",
      forgotPassword: "POST /auth/forgot-password",
      login: "POST /auth/login",
      signup: "POST /auth/signup"
    });
  });
}

/* Root */
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "login.html")
  );
});

app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

/* Routes */
if (!hasLoggedCanonicalRouteNotice) {
  console.warn("ROUTE NOTICE: Canonical APIs are /workflow/* and /ops/*.");
  console.warn("ROUTE NOTICE: Legacy routes remain mounted for backward compatibility during stabilization.");
  hasLoggedCanonicalRouteNotice = true;
}
app.use("/auth", authRoutes);

app.use("/", leadsRoutes);
app.use("/", estimatesRoutes);
app.use("/", invoicesRoutes);
app.use("/", paymentsRoutes);
app.use("/", clientsRoutes);
app.use("/", jobsRoutes);
app.use("/", subscriptionsRoutes);
app.use("/", workersRoutes);
app.use("/", uploadsRoutes);
app.use("/", calendarRoutes);
app.use("/", zipGroupsRoutes);
app.use("/", notificationsRoutes);
app.use("/", customerRoutes);
app.use("/", analyticsRoutes);
app.use("/", platformRoutes);
app.use("/", billingRoutes);
app.use("/", companiesRoutes);
app.use("/", reviewsRoutes);
app.use("/", favoritesRoutes);
app.use("/", followsRoutes);
app.use("/", messagesRoutes);
app.use("/", marketplaceRoutes);
app.use("/", servicesRoutes);
app.use("/", supportRoutes);
app.use("/", launchRoutes);
app.use("/", trustRoutes);

/* Setup DB route */
app.get("/setup-db", maintenanceOnly, maintenanceLimiter, async (req, res) => {
  try {
    await setupDatabase();
    res.send("Database Ready");
  } catch (err) {
    console.error("SETUP DB ERROR:", err);
    res.status(500).send("Database setup failed");
  }
});

app.post("/setup-db/backup", maintenanceOnly, maintenanceLimiter, async (req, res) => {
  try {
    const { runBackup } = require("./services/backupService");
    const summary = await runBackup({ trigger: "http_maintenance" });
    res.json({
      ok: true,
      path: summary.path,
      filename: summary.filename,
      size_bytes: summary.size_bytes,
      duration_ms: summary.duration_ms,
      rotation: summary.rotation
    });
  } catch (err) {
    logger.error("SETUP_DB_BACKUP_ERROR", err);
    res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Backup failed"
    });
  }
});

/* 404 */
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    method: req.method,
    path: req.originalUrl
  });
});

/* Error handler */
app.use((err, req, res, next) => {
  logger.error("SERVER ERROR", err);

  logErrorEntry({
    route: req.originalUrl || req.url || "",
    method: req.method || "",
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : null,
    companyId: req.user && req.user.company_id,
    userId: req.user && req.user.id,
    severity: "error",
    metadata: { name: err && err.name }
  }).catch(() => {});

  res.status(500).json({
    error: NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Internal server error"
  });
});

/* Start */
let server = null;
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.warn("SERVER_SHUTDOWN_BEGIN", { signal });
  let exitCode = 0;
  try {
    stopScheduler();
    const queueStopStatus = await stopQueue({
      drain: true,
      timeoutMs: Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || 20000)
    });
    if (!queueStopStatus.drained) {
      exitCode = 1;
      logger.error("SERVER_SHUTDOWN_QUEUE_DRAIN_TIMEOUT", queueStopStatus);
    }
  } catch (err) {
    exitCode = 1;
    logger.error("SERVER_SHUTDOWN_STOP_TASKS_ERROR", err);
  }

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    await pool.end();
  } catch (err) {
    exitCode = 1;
    logger.error("SERVER_SHUTDOWN_POOL_CLOSE_ERROR", err);
  }
  logger.warn("SERVER_SHUTDOWN_COMPLETE", { signal });
  process.exit(exitCode);
}

process.on("SIGTERM", () => { gracefulShutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT", () => { gracefulShutdown("SIGINT").catch(() => process.exit(1)); });
process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT_EXCEPTION", err);
  gracefulShutdown("UNCAUGHT_EXCEPTION").catch(() => process.exit(1));
});
process.on("unhandledRejection", (err) => {
  logger.error("UNHANDLED_REJECTION", err);
  gracefulShutdown("UNHANDLED_REJECTION").catch(() => process.exit(1));
});

(async () => {
  try {
    logger.info("SERVER_STARTUP_BEGIN", {
      env: NODE_ENV,
      port: PORT,
      startup_migrations_requested: RUN_STARTUP_MIGRATIONS,
      stripe_checkout_configured: isStripeCheckoutConfigured(),
      stripe_webhook_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET)
    });
    const envReadiness = getProductionEnvReadiness();
    if (envReadiness.status !== "ready") {
      logger.warn("Production readiness environment warnings", envReadiness);
    }

    if (NODE_ENV === "production") {
      if (RUN_STARTUP_MIGRATIONS) {
        logger.warn("STARTUP_MIGRATIONS_IGNORED_IN_PRODUCTION", {
          requested: true
        });
      }
      await assertProductionSchemaReady();
      logger.info("PRODUCTION_SCHEMA_READY");
    } else {
      logger.info("STARTUP_MIGRATIONS_ENABLED", {
        production: false
      });
      await setupDatabase({
        runMigrations: true
      });
      logger.info("STARTUP_MIGRATIONS_COMPLETE");
    }

    await startQueue();

    logger.info("JOB_QUEUE_STARTED", getQueueStatus());

    startScheduler();

    logger.info("SCHEDULER_STARTED", getSchedulerStatus());

    if (SUBSCRIPTION_INTERVAL_ENGINE) {
      startSubscriptionEngine();
      logger.info("SUBSCRIPTION PROCESSOR: hourly setInterval poll ENABLED (SUBSCRIPTION_INTERVAL_ENGINE)");
    } else {
      logger.info("SUBSCRIPTION PROCESSOR: hourly setInterval poll DISABLED — subscription visits run on scheduler only (cron + job queue path)");
    }

    server = app.listen(PORT, () => {
      logger.info("SERVER_LISTENING", {
        port: PORT,
        env: NODE_ENV
      });
    });

  } catch (err) {
    logger.error("STARTUP_ERROR", err);

    process.exit(1);
  }
})();
