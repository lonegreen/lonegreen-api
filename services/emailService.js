const nodemailer = require("nodemailer");
const logger = require("./logger");

function requiredEnv(name) {
  const value = process.env[name];

  if (!value || !String(value).trim()) {
    throw new Error(`${name} is missing in .env`);
  }

  return String(value).trim();
}

function getEmailConfig() {
  const nodeEnv = String(process.env.NODE_ENV || "development").toLowerCase();
  const allowInsecureTls = nodeEnv !== "production"
    && String(process.env.EMAIL_TLS_REJECT_UNAUTHORIZED || "true").toLowerCase() === "false";

  return {
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: Number(process.env.EMAIL_PORT || 465),
    secure: String(process.env.EMAIL_SECURE || "true") === "true",
    user: requiredEnv("EMAIL_USER"),
    pass: requiredEnv("EMAIL_PASS"),
    from: process.env.EMAIL_FROM || requiredEnv("EMAIL_USER"),
    tlsRejectUnauthorized: !allowInsecureTls
  };
}

function isEmailConfigured() {
  return Boolean(process.env.EMAIL_USER && String(process.env.EMAIL_USER).trim()
    && process.env.EMAIL_PASS && String(process.env.EMAIL_PASS).trim());
}

function getEmailReadiness() {
  const missing = ["EMAIL_USER", "EMAIL_PASS"]
    .filter(name => !process.env[name] || !String(process.env[name]).trim());

  return {
    status: missing.length ? "not_configured" : "configured",
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: Number(process.env.EMAIL_PORT || 465),
    secure: String(process.env.EMAIL_SECURE || "true") === "true",
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER || null,
    tls_reject_unauthorized: String(process.env.NODE_ENV || "development").toLowerCase() === "production"
      ? true
      : String(process.env.EMAIL_TLS_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false",
    missing
  };
}

function createTransporter() {
  const config = getEmailConfig();

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      rejectUnauthorized: config.tlsRejectUnauthorized,
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEmail({ to, subject, html, text }) {
  if (!to) {
    throw new Error("Email recipient is required");
  }

  if (!subject) {
    throw new Error("Email subject is required");
  }

  const config = getEmailConfig();
  const transporter = createTransporter();

  return transporter.sendMail({
    from: config.from,
    to,
    subject,
    html: html || "",
    text: text || "",
  });
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 600;

async function sendEmailWithRetry(payload, options = {}) {
  const maxAttempts = Number(options.retries || DEFAULT_RETRIES) || DEFAULT_RETRIES;
  const baseDelay = Number(options.baseDelayMs || DEFAULT_BASE_DELAY_MS) || DEFAULT_BASE_DELAY_MS;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await sendEmail(payload);
      if (attempt > 1) {
        logger.info("EMAIL_SEND_RECOVERED", { to: payload.to, subject: payload.subject, attempt });
      }
      return result;
    } catch (err) {
      lastErr = err;
      logger.warn("EMAIL_SEND_ATTEMPT_FAILED", {
        to: payload.to,
        subject: payload.subject,
        attempt,
        max_attempts: maxAttempts,
        error: err && err.message ? err.message : String(err)
      });
      if (attempt < maxAttempts) {
        await sleep(baseDelay * attempt);
      }
    }
  }

  logger.error("EMAIL_SEND_FAILED", {
    to: payload.to,
    subject: payload.subject,
    attempts: maxAttempts,
    error: lastErr && lastErr.message ? lastErr.message : String(lastErr)
  });
  throw lastErr;
}

/**
 * Never throws. Returns { ok, skipped?, error? } for operational/triggered mail.
 */
async function sendOperationalEmailSafe(payload, options = {}) {
  if (!isEmailConfigured()) {
    logger.warn("EMAIL_SKIPPED_NOT_CONFIGURED", { kind: options.kind || "generic" });
    return { ok: false, skipped: "not_configured" };
  }

  const to = String(payload && payload.to || "").trim();
  if (!to) {
    logger.warn("EMAIL_SKIPPED_NO_RECIPIENT", { kind: options.kind || "generic" });
    return { ok: false, skipped: "no_recipient" };
  }

  try {
    await sendEmailWithRetry({ ...payload, to }, options);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendInvoiceSentEmail({ to, invoice, companyName }) {
  const payload = buildInvoiceSentPayload({ invoice, companyName, overrideTo: to });
  if (!payload) {
    return { ok: false, skipped: "no_recipient" };
  }
  return sendOperationalEmailSafe(payload, { kind: "invoice_sent" });
}

async function sendPaymentReceiptEmail({ to, invoice, payment, companyName }) {
  const payload = buildPaymentReceiptPayload({ invoice, payment, companyName, overrideTo: to });
  if (!payload) {
    return { ok: false, skipped: "no_recipient" };
  }
  return sendOperationalEmailSafe(payload, { kind: "payment_receipt" });
}

async function sendPaymentReminderEmail({ to, invoice, companyName }) {
  const payload = buildPaymentReminderPayload({ invoice, companyName, overrideTo: to });
  if (!payload) {
    return { ok: false, skipped: "no_recipient" };
  }
  return sendOperationalEmailSafe(payload, { kind: "payment_reminder" });
}

async function sendSubscriptionReminderEmail({
  clientEmail,
  companyEmail,
  clientName,
  service,
  nextDate,
  companyName,
  overrideTo
}) {
  const payload = buildSubscriptionReminderPayload({
    clientEmail,
    companyEmail,
    clientName,
    service,
    nextDate,
    companyName,
    overrideTo
  });
  if (!payload) {
    return { ok: false, skipped: "no_recipient" };
  }
  return sendOperationalEmailSafe(payload, { kind: "subscription_reminder" });
}

function pickInvoiceRecipient(clientEmail, companyEmail, overrideTo) {
  const o = String(overrideTo || "").trim().toLowerCase();
  if (o) {
    return o;
  }
  const c = String(clientEmail || "").trim().toLowerCase();
  if (c) {
    return c;
  }
  return String(companyEmail || "").trim().toLowerCase();
}

function buildInvoiceSentPayload({ invoice, companyName, overrideTo }) {
  const to = pickInvoiceRecipient(invoice.client_email, invoice.company_email, overrideTo);
  if (!to) {
    return null;
  }
  const invNo = invoice.invoice_number || `#${invoice.id}`;
  const amount = Number(invoice.amount || 0).toFixed(2);
  const subject = `Invoice ${invNo} from ${companyName || "FairLinx"}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px">
      <h2>Invoice ${escHtml(invNo)}</h2>
      <p>${escHtml(companyName || "Your service provider")} has sent you an invoice.</p>
      <p><strong>Amount:</strong> $${escHtml(amount)}</p>
      ${invoice.due_date ? `<p><strong>Due:</strong> ${escHtml(String(invoice.due_date).split("T")[0])}</p>` : ""}
      <p>If you have questions, reply to this email or contact the business directly.</p>
    </div>
  `;
  const text = `Invoice ${invNo} for $${amount}. From ${companyName || "FairLinx"}.`;
  return { to, subject, html, text };
}

function buildPaymentReceiptPayload({ invoice, payment, companyName, overrideTo }) {
  const to = pickInvoiceRecipient(invoice.client_email, invoice.company_email, overrideTo);
  if (!to) {
    return null;
  }
  const invNo = invoice.invoice_number || `#${invoice.id}`;
  const paid = Number(payment.amount || 0).toFixed(2);
  const subject = `Payment received — Invoice ${invNo}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px">
      <h2>Payment received</h2>
      <p>Thank you. We recorded a payment of <strong>$${escHtml(paid)}</strong> for invoice <strong>${escHtml(invNo)}</strong>.</p>
      <p>${escHtml(companyName || "Your service provider")}</p>
    </div>
  `;
  const text = `Payment of $${paid} recorded for invoice ${invNo}.`;
  return { to, subject, html, text };
}

function buildPaymentReminderPayload({ invoice, companyName, overrideTo }) {
  const to = pickInvoiceRecipient(invoice.client_email, invoice.company_email, overrideTo);
  if (!to) {
    return null;
  }
  const invNo = invoice.invoice_number || `#${invoice.id}`;
  const amount = Number(invoice.amount || 0).toFixed(2);
  const remaining = invoice.remaining_balance != null
    ? Number(invoice.remaining_balance).toFixed(2)
    : amount;
  const subject = `Payment reminder — Invoice ${invNo}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px">
      <h2>Payment reminder</h2>
      <p>This is a friendly reminder that invoice <strong>${escHtml(invNo)}</strong> has an outstanding balance of <strong>$${escHtml(remaining)}</strong>.</p>
      ${invoice.due_date ? `<p><strong>Due date:</strong> ${escHtml(String(invoice.due_date).split("T")[0])}</p>` : ""}
      <p>${escHtml(companyName || "Your service provider")}</p>
    </div>
  `;
  const text = `Reminder: invoice ${invNo} balance $${remaining}.`;
  return { to, subject, html, text };
}

function buildSubscriptionReminderPayload({ clientEmail, companyEmail, clientName, service, nextDate, companyName, overrideTo }) {
  const to = pickInvoiceRecipient(clientEmail, companyEmail, overrideTo);
  if (!to) {
    return null;
  }
  const subject = `Upcoming service — ${service || "Subscription"}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px">
      <h2>Subscription reminder</h2>
      <p>Hello ${escHtml(clientName || "there")},</p>
      <p>This is a reminder regarding <strong>${escHtml(service || "your scheduled service")}</strong>.</p>
      ${nextDate ? `<p><strong>Next visit date:</strong> ${escHtml(String(nextDate).split("T")[0])}</p>` : ""}
      <p>${escHtml(companyName || "Your service provider")}</p>
    </div>
  `;
  const text = `Subscription reminder for ${service || "service"}.`;
  return { to, subject, html, text };
}

async function sendPasswordResetVerificationEmail({ to, code, username }) {
  const subject = "FairLinx Password Reset Code";
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px">
      <h2>Password reset</h2>
      <p>Username: <strong>${escHtml(username || "")}</strong></p>
      <p>Your verification code is:</p>
      <p style="font-size:22px;letter-spacing:2px;font-weight:700">${escHtml(code)}</p>
      <p>This code expires in 10 minutes.</p>
    </div>
  `;
  const text = `Password reset code (expires in 10 minutes): ${code}`;
  return sendOperationalEmailSafe({ to, subject, html, text }, { kind: "password_reset" });
}

module.exports = {
  getEmailReadiness,
  isEmailConfigured,
  sendEmail,
  sendEmailWithRetry,
  sendOperationalEmailSafe,
  sendInvoiceSentEmail,
  sendPaymentReceiptEmail,
  sendPaymentReminderEmail,
  sendSubscriptionReminderEmail,
  sendPasswordResetVerificationEmail,
  pickInvoiceRecipient,
  buildInvoiceSentPayload,
  buildPaymentReceiptPayload,
  buildPaymentReminderPayload,
  buildSubscriptionReminderPayload,
};
