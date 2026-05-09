const express = require("express");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const pool = require("../db/pool");
const { SECRET } = require("../config/env");
const { LEGAL_TERMS_VERSION, LEGAL_PRIVACY_VERSION } = require("../config/legal");
const auth = require("../middleware/auth");
const {
  sendPasswordResetVerificationEmail,
  sendCustomerLoginOtpEmail
} = require("../services/emailService");
const logger = require("../services/logger");
const { sendSafeServerError } = require("../services/safeServerError");

const { normalizeRole } = auth;
const router = express.Router();

const authAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" }
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password reset attempts, please try again later" }
});

const passwordResetSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password reset attempts, please try again later" }
});

/* Customer email-OTP login (additive; coexists with /auth/customer-login email+password). */
const customerOtpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-in code requests, please try again later" }
});

const customerOtpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts, please try again later" }
});

/* OTP policy. Keep these here (not env) so all environments enforce the same. */
const CUSTOMER_OTP_TTL_MINUTES = 10;
const CUSTOMER_OTP_MAX_ATTEMPTS = 5;
const CUSTOMER_OTP_RESEND_THROTTLE_SECONDS = 60;

function generateOtpCode() {
  /* 6-digit code, uniformly random across [0, 999999] using crypto.randomInt. */
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

async function hashOtpCode(code) {
  return bcrypt.hash(String(code), 10);
}

function isExpiredIso(value) {
  if (!value) return true;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return true;
  return ts <= Date.now();
}

function buildToken(user) {
  const role = normalizeRole(user.role);

  if (!role) {
    throw new Error("Invalid user role");
  }

  return jwt.sign(
    {
      id: user.id,
      company_id: user.company_id,
      username: user.username,
      role,
      worker_id: user.worker_id || null
    },
    SECRET,
    { expiresIn: "7d" }
  );
}

async function logActivity({
  companyId,
  userId,
  action,
  entityType,
  entityId = null,
  details = {}
}) {
  if (!companyId && ["login_success", "login_failed"].includes(action)) {
    return;
  }

  try {
    await pool.query(
      `
      INSERT INTO activity_log
      (company_id, user_id, action, entity_type, entity_id, details)
      VALUES
      ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        companyId,
        userId || null,
        action,
        entityType || null,
        entityId,
        JSON.stringify(details || {})
      ]
    );
  } catch (err) {
    console.log("AUTH ACTIVITY LOG ERROR:", err.message);
  }
}

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function cleanUsername(username) {
  return String(username || "").trim();
}

function validatePassword(password) {
  return String(password || "").length >= 8;
}

function cleanName(value) {
  return String(value || "").trim();
}

function normalizePhoneForMatch(value) {
  return String(value || "").replace(/\D+/g, "");
}

function generateResetCode() {
  return crypto.randomBytes(24).toString("hex");
}

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || "").trim(), "utf8")
    .digest("hex");
}

function isBcryptHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ""));
}

function resetCodesEqual(stored, provided) {
  const a = Buffer.from(String(stored || ""), "utf8");
  const b = Buffer.from(String(provided || "").trim(), "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function resolveResetDeliveryEmail(user) {
  return cleanEmail(user && user.email);
}

async function getCustomerResetAuditContext(accountId) {
  const result = await pool.query(
    `
    SELECT
      ca.id AS customer_account_id,
      ca.client_id,
      c.company_id
    FROM customer_accounts ca
    LEFT JOIN clients c
      ON c.id = ca.client_id
    WHERE ca.id = $1
    LIMIT 1
    `,
    [accountId]
  );
  return result.rows[0] || null;
}

async function logCustomerResetActivity({ accountId, action, details = {} }) {
  const context = await getCustomerResetAuditContext(accountId);
  await logActivity({
    companyId: context ? context.company_id : null,
    userId: null,
    action,
    entityType: "customer_account",
    entityId: accountId || null,
    details: {
      customer_account_id: accountId || null,
      client_id: context ? context.client_id : null,
      ...details
    }
  });
}

async function findAuthUser(identifier) {
  const cleanValue = String(identifier || "").trim();

  if (!cleanValue) return null;

  const result = await pool.query(
    `
    -- Authentication is intentionally username-based only.
    -- Company email is not deterministic for identity and can overlap across tenants.
    SELECT
      u.*
    FROM users u
    WHERE
      LOWER(u.username) = LOWER($1)
    ORDER BY
      CASE
        WHEN LOWER(u.role) = 'owner' THEN 1
        WHEN LOWER(u.role) = 'admin' THEN 2
        WHEN LOWER(u.role) = 'manager' THEN 3
        ELSE 4
      END,
      u.id ASC
    LIMIT 1
    `,
    [cleanValue]
  );

  return result.rows[0] || null;
}

function buildCustomerToken(account) {
  return jwt.sign(
    {
      id: account.id,
      customer_account_id: account.id,
      role: "customer",
      company_id: account.company_id || null,
      client_id: account.client_id || null,
      email: account.email,
      customer_status: String(account.status || "active").toLowerCase(),
      customer_deactivated_at: account.deactivated_at || null
    },
    SECRET,
    { expiresIn: "14d" }
  );
}

function resolveCustomerAccountStatus(account) {
  const status = String(account && account.status || "").trim().toLowerCase();
  const deactivatedAt = account && account.deactivated_at ? account.deactivated_at : null;
  if (deactivatedAt || status === "deactivated") {
    return "deactivated";
  }
  if (status === "suspended") {
    return "suspended";
  }
  return "active";
}

function customerAccessErrorStatus(account) {
  const status = resolveCustomerAccountStatus(account);
  if (status === "deactivated") {
    return "Customer account is deactivated";
  }
  if (status === "suspended") {
    return "Customer account is suspended";
  }
  return null;
}

/* SIGNUP */

router.post("/signup", async (req, res) => {
  try {
    const {
      name,
      username,
      password,
      phone,
      email,
      address,
      service_area,
      business_hours,
      legal_accepted
    } = req.body || {};

    const cleanName = String(name || "").trim();
    const cleanUser = cleanUsername(username);
    const cleanMail = cleanEmail(email);

    if (!cleanName || !cleanUser || !password) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters"
      });
    }

    const existingUser = await pool.query(
      `
      SELECT id
      FROM users
      WHERE LOWER(username) = LOWER($1)
      LIMIT 1
      `,
      [cleanUser]
    );

    if (existingUser.rows.length) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    const company = await pool.query(
      `
      INSERT INTO companies
      (name, phone, email, address, service_area, business_hours, plan_id, billing_status)
      VALUES
      (
        $1, $2, $3, $4, $5, $6,
        (SELECT id FROM subscription_plans WHERE slug = 'starter' AND active IS NOT FALSE ORDER BY id ASC LIMIT 1),
        'trialing'
      )
      RETURNING id, name
      `,
      [
        cleanName,
        phone || "",
        cleanMail || "",
        address || "",
        service_area || "",
        business_hours || ""
      ]
    );

    const company_id = company.rows[0].id;

    const hashedPassword = await bcrypt.hash(
      String(password),
      10
    );

    const createdUser = await pool.query(
      `
      INSERT INTO users
      (username, email, password, role, company_id, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
      VALUES
      ($1, $2, $3, 'owner', $4, $5, $6, $5, $7)
      RETURNING id, username, role, company_id
      `,
      [
        cleanUser,
        cleanMail || null,
        hashedPassword,
        company_id,
        legal_accepted === true ? new Date().toISOString() : null,
        legal_accepted === true ? LEGAL_TERMS_VERSION : null,
        legal_accepted === true ? LEGAL_PRIVACY_VERSION : null
      ]
    );

    await logActivity({
      companyId: company_id,
      userId: createdUser.rows[0].id,
      action: "signup_completed",
      entityType: "user",
      entityId: createdUser.rows[0].id,
      details: {
        username: cleanUser,
        company_name: company.rows[0].name,
        role: createdUser.rows[0].role
      }
    });

    if (legal_accepted === true) {
      await logActivity({
        companyId: company_id,
        userId: createdUser.rows[0].id,
        action: "legal_terms_accepted",
        entityType: "user",
        entityId: createdUser.rows[0].id,
        details: {
          terms_version: LEGAL_TERMS_VERSION
        }
      });

      await logActivity({
        companyId: company_id,
        userId: createdUser.rows[0].id,
        action: "legal_privacy_accepted",
        entityType: "user",
        entityId: createdUser.rows[0].id,
        details: {
          privacy_version: LEGAL_PRIVACY_VERSION
        }
      });
    }

    return res.json({
      success: true
    });

  } catch (err) {
    console.log("SIGNUP ERROR:", err);
    return res.status(500).json({
      error: "Signup failed"
    });
  }
});

router.get("/legal-consent", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        company_id,
        terms_accepted_at,
        terms_version,
        privacy_accepted_at,
        privacy_version
      FROM users
      WHERE id = $1
      LIMIT 1
    `, [req.user.id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const row = result.rows[0];
    const termsAccepted = row.terms_version === LEGAL_TERMS_VERSION && Boolean(row.terms_accepted_at);
    const privacyAccepted = row.privacy_version === LEGAL_PRIVACY_VERSION && Boolean(row.privacy_accepted_at);

    res.json({
      terms_accepted: termsAccepted,
      privacy_accepted: privacyAccepted,
      accepted: termsAccepted && privacyAccepted,
      terms_accepted_at: row.terms_accepted_at,
      terms_version: row.terms_version,
      privacy_accepted_at: row.privacy_accepted_at,
      privacy_version: row.privacy_version,
      current_terms_version: LEGAL_TERMS_VERSION,
      current_privacy_version: LEGAL_PRIVACY_VERSION
    });
  } catch (err) {
    sendSafeServerError(res, err, "LEGAL CONSENT GET ERROR");
  }
});

router.post("/legal-consent", auth, async (req, res) => {
  try {
    const accepted = req.body && req.body.accepted === true;

    if (!accepted) {
      return res.status(400).json({ error: "Legal acceptance is required" });
    }

    const result = await pool.query(`
      UPDATE users
      SET terms_accepted_at = CURRENT_TIMESTAMP,
          terms_version = $2,
          privacy_accepted_at = CURRENT_TIMESTAMP,
          privacy_version = $3
      WHERE id = $1
      RETURNING
        id,
        company_id,
        terms_accepted_at,
        terms_version,
        privacy_accepted_at,
        privacy_version
    `, [req.user.id, LEGAL_TERMS_VERSION, LEGAL_PRIVACY_VERSION]);

    if (!result.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const row = result.rows[0];

    await logActivity({
      companyId: row.company_id || req.user.company_id || null,
      userId: req.user.id,
      action: "legal_terms_accepted",
      entityType: "user",
      entityId: req.user.id,
      details: {
        terms_version: LEGAL_TERMS_VERSION
      }
    });

    await logActivity({
      companyId: row.company_id || req.user.company_id || null,
      userId: req.user.id,
      action: "legal_privacy_accepted",
      entityType: "user",
      entityId: req.user.id,
      details: {
        privacy_version: LEGAL_PRIVACY_VERSION
      }
    });

    res.json({
      accepted: true,
      terms_accepted: true,
      privacy_accepted: true,
      terms_accepted_at: row.terms_accepted_at,
      terms_version: row.terms_version,
      privacy_accepted_at: row.privacy_accepted_at,
      privacy_version: row.privacy_version,
      current_terms_version: LEGAL_TERMS_VERSION,
      current_privacy_version: LEGAL_PRIVACY_VERSION
    });
  } catch (err) {
    sendSafeServerError(res, err, "LEGAL CONSENT POST ERROR");
  }
});

/* LOGIN */

router.post("/login", authAttemptLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    const loginValue = cleanUsername(username || email);

    if (!loginValue || !password) {
      return res.status(400).json({
        error: "Missing credentials"
      });
    }

    const user = await findAuthUser(loginValue);

    if (!user) {
      return res.status(401).json({
        error: "Invalid login"
      });
    }

    if (user.active === false) {
      return res.status(403).json({
        error: "Account is inactive"
      });
    }

    const normalizedRole = normalizeRole(user.role);

    if (!normalizedRole) {
      return res.status(403).json({
        error: "Invalid account role"
      });
    }

    if (normalizedRole !== "platform_owner" && !user.company_id) {
      logger.warn("LOGIN_MISSING_COMPANY_ID", {
        userId: user.id,
        username: user.username,
        role: normalizedRole
      });
      return res.status(403).json({
        error: "Account is missing company access. Please contact support."
      });
    }

    const storedPassword = user.password || null;

if (!storedPassword) {
  return res.status(400).json({
    error: "Account password is missing. Please reset your password."
  });
}

    let isMatch = false;
    let shouldUpgradePasswordHash = false;

    if (isBcryptHash(storedPassword)) {
      try {
        isMatch = await bcrypt.compare(
          String(password),
          storedPassword
        );
      } catch (compareError) {
        console.log(
          "BCRYPT COMPARE ERROR:",
          compareError.message
        );

        return res.status(400).json({
          error: "Invalid account password data"
        });
      }
    } else {
      // Legacy fallback for old plaintext records; successful login rehashes immediately.
      isMatch = String(password) === String(storedPassword);
      shouldUpgradePasswordHash = isMatch;
    }

    if (!isMatch) {
      return res.status(401).json({
        error: "Invalid login"
      });
    }

    if (shouldUpgradePasswordHash) {
      logger.warn("LOGIN_PASSWORD_PLAINTEXT_ROW", {
        userId: user.id,
        companyId: user.company_id != null ? user.company_id : null,
        note: "users.password was not bcrypt; legacy compare succeeded and will be rehashed"
      });
      try {
        const upgradedHash = await bcrypt.hash(String(password), 10);
        await pool.query(
          `
          UPDATE users
          SET password = $1
          WHERE id = $2
          `,
          [upgradedHash, user.id]
        );
      } catch (hashUpgradeErr) {
        logger.warn("LOGIN_PASSWORD_REHASH_FAILED", {
          userId: user.id,
          companyId: user.company_id,
          error: hashUpgradeErr && hashUpgradeErr.message
        });
      }
    }

    const token = buildToken(user);

    await logActivity({
      companyId: user.company_id,
      userId: user.id,
      action: "login_success",
      entityType: "user",
      entityId: user.id,
      details: {
        username: user.username,
        role: user.role
      }
    });

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: normalizedRole,
        company_id: user.company_id,
        worker_id: user.worker_id || null
      }
    });

  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).json({
      error: "Server error"
    });
  }
});

/* GOOGLE LOGIN */

router.post("/google-login", async (req, res) => {
  return res.status(501).json({
    error: "Google login is temporarily disabled."
  });
});

/* FORGOT PASSWORD */

router.post("/forgot-password", passwordResetLimiter, async (req, res) => {
  try {
    // Recovery uses username because login is username-only (same row as findAuthUser).
    // Optional legacy key `email` is still read only as an alternate JSON field name, not as company-email lookup.
    const username = cleanUsername(req.body?.username ?? req.body?.email);

    if (!username) {
      return res.status(400).json({
        error: "Username is required"
      });
    }

    const user = await findAuthUser(username);

    if (!user) {
      return res.json({
        success: true
      });
    }

    if (user.active === false) {
      return res.json({
        success: true
      });
    }

    const mailTo = resolveResetDeliveryEmail(user);

    const code = generateResetCode();
    const codeHash = hashResetToken(code);

    await pool.query(
      `
      UPDATE password_resets
      SET used = TRUE
      WHERE user_id = $1
      AND used = FALSE
      `,
      [user.id]
    );

    await pool.query(
      `
      INSERT INTO password_resets
      (user_id, code, code_hash, expires_at, used)
      VALUES
      ($1, $2, $3, NOW() + INTERVAL '10 minutes', FALSE)
      `,
      [user.id, codeHash, codeHash]
    );

    if (mailTo) {
      const mailResult = await sendPasswordResetVerificationEmail({
        to: mailTo,
        code,
        username: user.username
      });
      if (!mailResult.ok) {
        logger.warn("PASSWORD_RESET_EMAIL_FAILED", {
          username: user.username,
          skipped: mailResult.skipped,
          error: mailResult.error
        });
        if (process.env.NODE_ENV !== "production") {
          console.log("RESET EMAIL FAILED - DEV CODE:", code);
        }
      }
    }

    if (!mailTo && process.env.NODE_ENV !== "production") {
      console.log(
        "RESET: no user email on file for delivery — DEV CODE:",
        code
      );
    }

    await logActivity({
      companyId: user.company_id,
      userId: user.id,
      action: "password_reset_requested",
      entityType: "user",
      entityId: user.id,
      details: {
        username: user.username,
        reset_delivery: mailTo ? "user_email" : "none"
      }
    });

    return res.json({
      success: true
    });

  } catch (error) {
    sendSafeServerError(res, error, "FORGOT PASSWORD ERROR");
  }
});

/* RESET PASSWORD */

router.post("/reset-password", passwordResetSubmitLimiter, async (req, res) => {
  try {
    // Recovery identifier is username (matches login); legacy body key `email` accepted only as field name.
    const username = cleanUsername(req.body?.username ?? req.body?.email);
    const code = String(req.body?.code || "").trim();
    const newPassword = String(req.body?.password || "");

    if (!username || !code || !newPassword) {
      return res.status(400).json({
        error: "Username, code, and password are required"
      });
    }

    if (!validatePassword(newPassword)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters"
      });
    }

    const user = await findAuthUser(username);

    if (!user) {
      return res.status(400).json({
        error: "Invalid or expired reset code"
      });
    }

    if (user.active === false) {
      return res.status(400).json({
        error: "Invalid or expired reset code"
      });
    }

    const resetResult = await pool.query(
      `
      SELECT id, code, code_hash
      FROM password_resets
      WHERE user_id = $1
      AND used = FALSE
      AND expires_at > NOW()
      ORDER BY id DESC
      LIMIT 1
      `,
      [user.id]
    );

    if (!resetResult.rows.length) {
      return res.status(400).json({
        error: "Invalid or expired reset code"
      });
    }

    const latestReset = resetResult.rows[0];
    const providedCodeHash = hashResetToken(code);
    const storedCodeHash = String(latestReset.code_hash || "").trim();
    const storedLegacyCode = String(latestReset.code || "").trim();
    const codeMatchesHash = Boolean(storedCodeHash) && resetCodesEqual(storedCodeHash, providedCodeHash);
    const codeMatchesLegacy = Boolean(storedLegacyCode) && resetCodesEqual(storedLegacyCode, code);

    if (!codeMatchesHash && !codeMatchesLegacy) {
      await logActivity({
        companyId: user.company_id,
        userId: user.id,
        action: "password_reset_code_invalid",
        entityType: "user",
        entityId: user.id,
        details: {
          username: user.username
        }
      });
      return res.status(400).json({
        error: "Invalid or expired reset code"
      });
    }

    const hashedPassword = await bcrypt.hash(
      newPassword,
      10
    );

    await pool.query(
      `
      UPDATE users
      SET password = $1
      WHERE id = $2
      `,
      [hashedPassword, user.id]
    );

    await pool.query(
      `
      UPDATE password_resets
      SET used = TRUE,
          code = NULL,
          code_hash = NULL
      WHERE id = $1
      `,
      [latestReset.id]
    );

    await logActivity({
      companyId: user.company_id,
      userId: user.id,
      action: "password_reset_completed",
      entityType: "user",
      entityId: user.id,
      details: {
        username: user.username
      }
    });

    return res.json({
      success: true
    });

  } catch (error) {
    sendSafeServerError(res, error, "RESET PASSWORD ERROR");
  }
});

router.post("/customer-signup", authAttemptLimiter, async (req, res) => {
  try {
    const firstName = cleanName(req.body?.first_name);
    const lastName = cleanName(req.body?.last_name);
    const email = cleanEmail(req.body?.email);
    const phone = cleanUsername(req.body?.phone);
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirm_password || "");
    const providedClientId = Number(req.body?.client_id || 0);
    const inviteToken = String(req.body?.invite_token || "").trim();
    const ownershipVerificationCode = String(req.body?.ownership_verification_code || "").trim();

    if (!firstName || !lastName || !email || !phone || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    if (confirmPassword && confirmPassword !== password) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    const existingAccount = await pool.query(
      `SELECT id FROM customer_accounts WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (existingAccount.rows.length) {
      return res.status(409).json({ error: "An account already exists for this email" });
    }

    const normalizedPhone = normalizePhoneForMatch(phone);
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

    let client = null;
    let claimMethod = "standalone";

    if (inviteToken) {
      try {
        const inviteResult = await pool.query(
          `
          SELECT id, client_id, email, phone
          FROM customer_signup_invites
          WHERE token = $1
            AND used_at IS NULL
            AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
          LIMIT 1
          `,
          [inviteToken]
        );
        const invite = inviteResult.rows[0] || null;

        if (invite) {
          const inviteEmail = cleanEmail(invite.email);
          const invitePhone = normalizePhoneForMatch(invite.phone);
          const inviteMatchesEmail = !inviteEmail || inviteEmail === email;
          const inviteMatchesPhone = !invitePhone || invitePhone === normalizedPhone;

          if (inviteMatchesEmail && inviteMatchesPhone) {
            const invitedClient = await pool.query(
              `SELECT id, company_id, name, phone, email FROM clients WHERE id = $1 LIMIT 1`,
              [invite.client_id]
            );
            client = invitedClient.rows[0] || null;

            if (client) {
              claimMethod = "invite_token";
              await pool.query(
                `
                UPDATE customer_signup_invites
                SET used_at = CURRENT_TIMESTAMP
                WHERE id = $1
                `,
                [invite.id]
              );
            }
          }
        }
      } catch (inviteErr) {
        if (inviteErr && inviteErr.code !== "42P01") {
          throw inviteErr;
        }
      }
    }

    if (!client && providedClientId > 0) {
      if (!ownershipVerificationCode) {
        return res.status(403).json({
          error: "Ownership verification is required to link an existing client account"
        });
      }
      const verificationHash = hashResetToken(ownershipVerificationCode);
      const verifiedOwnershipClient = await pool.query(
        `
        SELECT c.id, c.company_id, c.name, c.phone, c.email
        FROM clients c
        JOIN customer_signup_claims sc
          ON sc.client_id = c.id
        WHERE c.id = $1
          AND LOWER(COALESCE(c.email, '')) = LOWER($2)
          AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') = $3
          AND LOWER(sc.email) = LOWER($2)
          AND regexp_replace(COALESCE(sc.phone, ''), '\\D', '', 'g') = $3
          AND sc.verification_code_hash = $4
          AND sc.used_at IS NULL
          AND sc.expires_at > CURRENT_TIMESTAMP
        ORDER BY sc.id DESC
        LIMIT 1
        `,
        [providedClientId, email, normalizedPhone, verificationHash]
      );
      client = verifiedOwnershipClient.rows[0] || null;
      if (!client) {
        return res.status(403).json({
          error: "Ownership verification is invalid or expired"
        });
      }
      await pool.query(
        `
        UPDATE customer_signup_claims
        SET used_at = CURRENT_TIMESTAMP
        WHERE client_id = $1
          AND LOWER(email) = LOWER($2)
          AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $3
          AND verification_code_hash = $4
          AND used_at IS NULL
        `,
        [providedClientId, email, normalizedPhone, verificationHash]
      );
      claimMethod = "verified_ownership";
    }

    if (!client) {
      const createdClient = await pool.query(
        `
        INSERT INTO clients (name, phone, email, address, zip, notes, company_id)
        VALUES ($1, $2, $3, '', '', '', NULL)
        RETURNING id, company_id, name, phone, email
        `,
        [fullName, phone, email]
      );
      client = createdClient.rows[0];
    } else {
      await pool.query(
        `
        UPDATE clients
        SET
          name = COALESCE(NULLIF(TRIM($1), ''), name),
          phone = COALESCE(NULLIF(TRIM($2), ''), phone),
          email = COALESCE(NULLIF(TRIM($3), ''), email)
        WHERE id = $4
        `,
        [fullName, phone, email, client.id]
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const accountResult = await pool.query(
      `
      INSERT INTO customer_accounts
      (client_id, email, password_hash, first_name, last_name, phone, is_verified)
      VALUES
      ($1, $2, $3, $4, $5, $6, FALSE)
      RETURNING id, client_id, email, first_name, last_name, phone, is_verified, created_at
      `,
      [client.id, email, hashedPassword, firstName, lastName, phone]
    );

    return res.status(201).json({
      success: true,
      account: accountResult.rows[0],
      claim_method: claimMethod
    });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER SIGNUP ERROR");
  }
});

router.post("/customer-login", authAttemptLimiter, async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const accountResult = await pool.query(
      `
      SELECT
        ca.id,
        ca.client_id,
        ca.email,
        ca.password_hash,
        ca.first_name,
        ca.last_name,
        ca.phone,
        ca.is_verified,
        ca.created_at,
        ca.status,
        ca.suspended_at,
        ca.suspended_reason,
        ca.deactivated_at,
        c.company_id
      FROM customer_accounts ca
      LEFT JOIN clients c ON c.id = ca.client_id
      WHERE LOWER(ca.email) = LOWER($1)
      LIMIT 1
      `,
      [email]
    );
    const account = accountResult.rows[0];

    if (!account) {
      return res.status(401).json({ error: "Invalid login" });
    }
    const blockedMessage = customerAccessErrorStatus(account);
    if (blockedMessage) {
      return res.status(403).json({ error: blockedMessage });
    }

    const isMatch = await bcrypt.compare(password, String(account.password_hash || ""));
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const token = buildCustomerToken(account);

    return res.json({
      token,
      customer: {
        id: account.id,
        customer_account_id: account.id,
        email: account.email,
        first_name: account.first_name,
        last_name: account.last_name,
        phone: account.phone,
        role: "customer",
        client_id: account.client_id || null,
        company_id: account.company_id || null
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER LOGIN ERROR");
  }
});

/* ============================================================
 * Customer email-OTP login (additive flow).
 *
 *   POST /auth/customer-otp/request  body: { email }
 *   POST /auth/customer-otp/verify   body: { email, code }
 *
 * Coexists with POST /auth/customer-login (email + password).
 * Both endpoints issue the same customer JWT via buildCustomerToken,
 * so downstream auth, tenant scoping (customer_account_id ->
 * customer_account_clients), and customer portal routes are unchanged.
 * ============================================================ */

router.post("/customer-otp/request", customerOtpRequestLimiter, async (req, res) => {
  /* Always return the same generic response regardless of whether the email
   * is registered, to prevent account enumeration via this endpoint. */
  const genericResponse = {
    success: true,
    message: "If an account with that email exists, a sign-in code has been sent."
  };

  try {
    const email = cleanEmail(req.body && req.body.email);
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const accountResult = await pool.query(
      `
      SELECT id, email, customer_otp_last_sent_at
      FROM customer_accounts
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [email]
    );
    const account = accountResult.rows[0];

    if (!account) {
      /* Do not leak account existence; mimic timing of the success path roughly
       * by performing a discardable bcrypt hash (cheap deterrent against
       * trivial timing oracles, not a strong defense — relies on per-IP rate
       * limiter above). */
      try { await bcrypt.hash(generateOtpCode(), 10); } catch (_) { /* ignore */ }
      return res.json(genericResponse);
    }

    /* Per-account resend throttle (in addition to per-IP rate limiter). */
    if (account.customer_otp_last_sent_at) {
      const lastMs = new Date(account.customer_otp_last_sent_at).getTime();
      if (Number.isFinite(lastMs)
        && Date.now() - lastMs < CUSTOMER_OTP_RESEND_THROTTLE_SECONDS * 1000) {
        return res.json(genericResponse);
      }
    }

    const code = generateOtpCode();
    const codeHash = await hashOtpCode(code);
    const expiresAt = new Date(Date.now() + CUSTOMER_OTP_TTL_MINUTES * 60 * 1000);

    await pool.query(
      `
      UPDATE customer_accounts
      SET customer_otp_hash = $2,
          customer_otp_expires_at = $3,
          customer_otp_attempts = 0,
          customer_otp_last_sent_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [account.id, codeHash, expiresAt.toISOString()]
    );

    /* sendCustomerLoginOtpEmail is "safe" — never throws; transient SMTP issues
     * still produce the same generic response so we don't leak anything to the
     * caller. The OTP is logged-in dev only via the email service's own logger. */
    await sendCustomerLoginOtpEmail({ to: account.email, code });

    await logCustomerResetActivity({
      accountId: account.id,
      action: "customer_otp_requested",
      details: { delivery: "customer_email" }
    });

    return res.json(genericResponse);
  } catch (err) {
    /* Do not surface internal failures to the caller in a way that distinguishes
     * "account exists" vs "account does not exist". Log + return the generic
     * response so the UX still tells the user to check their inbox. */
    logger.error("CUSTOMER_OTP_REQUEST_ERROR", { error: err && err.message });
    return res.json(genericResponse);
  }
});

router.post("/customer-otp/verify", customerOtpVerifyLimiter, async (req, res) => {
  try {
    const email = cleanEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || "").trim();

    if (!email || !code) {
      return res.status(400).json({ error: "Email and code are required" });
    }
    if (!/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error: "Invalid code format" });
    }

    const accountResult = await pool.query(
      `
      SELECT
        ca.id,
        ca.client_id,
        ca.email,
        ca.first_name,
        ca.last_name,
        ca.phone,
        ca.is_verified,
        ca.created_at,
        ca.status,
        ca.suspended_at,
        ca.suspended_reason,
        ca.deactivated_at,
        ca.customer_otp_hash,
        ca.customer_otp_expires_at,
        ca.customer_otp_attempts,
        c.company_id
      FROM customer_accounts ca
      LEFT JOIN clients c ON c.id = ca.client_id
      WHERE LOWER(ca.email) = LOWER($1)
      LIMIT 1
      `,
      [email]
    );
    const account = accountResult.rows[0];

    if (!account || !account.customer_otp_hash || !account.customer_otp_expires_at) {
      return res.status(401).json({ error: "Invalid or expired code" });
    }
    const blockedMessage = customerAccessErrorStatus(account);
    if (blockedMessage) {
      return res.status(403).json({ error: blockedMessage });
    }
    if (isExpiredIso(account.customer_otp_expires_at)) {
      /* Clear the stale code so a new one must be requested. */
      await pool.query(
        `
        UPDATE customer_accounts
        SET customer_otp_hash = NULL,
            customer_otp_expires_at = NULL,
            customer_otp_attempts = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [account.id]
      );
      return res.status(401).json({ error: "Invalid or expired code" });
    }
    if (Number(account.customer_otp_attempts || 0) >= CUSTOMER_OTP_MAX_ATTEMPTS) {
      /* Too many failures on this code: invalidate to force a fresh request. */
      await pool.query(
        `
        UPDATE customer_accounts
        SET customer_otp_hash = NULL,
            customer_otp_expires_at = NULL,
            customer_otp_attempts = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [account.id]
      );
      await logCustomerResetActivity({
        accountId: account.id,
        action: "customer_otp_invalidated",
        details: { reason: "max_attempts" }
      });
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    const matches = await bcrypt.compare(code, String(account.customer_otp_hash || ""));
    if (!matches) {
      await pool.query(
        `
        UPDATE customer_accounts
        SET customer_otp_attempts = COALESCE(customer_otp_attempts, 0) + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [account.id]
      );
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    /* Single-use: clear OTP fields atomically before issuing a session token. */
    await pool.query(
      `
      UPDATE customer_accounts
      SET customer_otp_hash = NULL,
          customer_otp_expires_at = NULL,
          customer_otp_attempts = 0,
          customer_email_verified = TRUE,
          is_verified = TRUE,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [account.id]
    );

    await logCustomerResetActivity({
      accountId: account.id,
      action: "customer_otp_verified",
      details: { login_method: "email_otp" }
    });

    const token = buildCustomerToken(account);

    return res.json({
      token,
      customer: {
        id: account.id,
        customer_account_id: account.id,
        email: account.email,
        first_name: account.first_name,
        last_name: account.last_name,
        phone: account.phone,
        role: "customer",
        client_id: account.client_id || null,
        company_id: account.company_id || null,
        login_method: "email_otp"
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER OTP VERIFY ERROR");
  }
});

router.post("/customer-forgot-password", passwordResetLimiter, async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const resetToken = generateResetCode();
    const resetTokenHash = hashResetToken(resetToken);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30);

    const updateResult = await pool.query(
      `
      UPDATE customer_accounts
      SET reset_token = NULL,
          reset_token_hash = $2,
          reset_token_expires = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE LOWER(email) = LOWER($1)
      RETURNING id, email
      `,
      [email, resetTokenHash, expiresAt.toISOString()]
    );

    if (updateResult.rows.length) {
      const accountRow = updateResult.rows[0];
      const mailTo = cleanEmail(accountRow.email);

      await logCustomerResetActivity({
        accountId: accountRow.id,
        action: "customer_password_reset_requested",
        details: {
          reset_delivery: mailTo ? "customer_email" : "none"
        }
      });

      if (mailTo) {
        const mailResult = await sendPasswordResetVerificationEmail({
          to: mailTo,
          code: resetToken,
          username: mailTo
        });
        if (!mailResult.ok) {
          logger.warn("CUSTOMER_PASSWORD_RESET_EMAIL_FAILED", {
            customer_account_id: accountRow.id,
            skipped: mailResult.skipped,
            error: mailResult.error
          });
          if (process.env.NODE_ENV !== "production") {
            console.log("CUSTOMER RESET EMAIL FAILED - DEV CODE:", resetToken);
          }
        }
      } else if (process.env.NODE_ENV !== "production") {
        console.log(
          "CUSTOMER RESET: no customer email on file for delivery — DEV CODE:",
          resetToken
        );
      }
    }

    const payload = { success: true };
    if (process.env.NODE_ENV !== "production") {
      payload.reset_token = resetToken;
    }
    return res.json(payload);
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER FORGOT PASSWORD ERROR");
  }
});

router.post("/customer-reset-password", passwordResetSubmitLimiter, async (req, res) => {
  try {
    const resetToken = String(req.body?.token || "").trim();
    const newPassword = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirm_password || "");

    if (!resetToken || !newPassword) {
      return res.status(400).json({ error: "Token and password are required" });
    }

    if (!validatePassword(newPassword)) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    if (confirmPassword && confirmPassword !== newPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    const resetTokenHash = hashResetToken(resetToken);
    const accountResult = await pool.query(
      `
      SELECT id
      FROM customer_accounts
      WHERE reset_token_expires IS NOT NULL
        AND reset_token_expires > CURRENT_TIMESTAMP
        AND (
          reset_token_hash = $1
          OR reset_token = $2
        )
      LIMIT 1
      `,
      [resetTokenHash, resetToken]
    );

    if (!accountResult.rows.length) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `
      UPDATE customer_accounts
      SET password_hash = $2,
          reset_token = NULL,
          reset_token_hash = NULL,
          reset_token_expires = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [accountResult.rows[0].id, hashedPassword]
    );

    await logCustomerResetActivity({
      accountId: accountResult.rows[0].id,
      action: "customer_password_reset_completed"
    });

    return res.json({ success: true });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER RESET PASSWORD ERROR");
  }
});

module.exports = router;
