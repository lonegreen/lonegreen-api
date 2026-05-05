const pool = require("../db/pool");

function warnDeprecatedRoute(route, canonicalRoute) {
  console.warn(`Deprecated route used: ${route}. Use ${canonicalRoute}.`);
}

function parseIntSafe(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function normalizeDateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().split("T")[0];
  return String(value).split("T")[0];
}

function parseDateOnly(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateOnly(date) {
  return date.toISOString().split("T")[0];
}

function addFrequency(date, frequency) {
  const next = new Date(date.getTime());

  if (frequency === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }

  if (frequency === "biweekly") {
    next.setUTCDate(next.getUTCDate() + 14);
    return next;
  }

  if (frequency === "monthly") {
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }

  return null;
}

function buildSubscriptionVisitDates(baseDate, frequency, count = 8) {
  const dates = [];
  let cursor = parseDateOnly(baseDate);

  if (!cursor) return dates;

  const windowStart = parseDateOnly(new Date().toISOString().split("T")[0]);
  const windowEnd = addFrequency(windowStart, "monthly") || windowStart;
  let guard = 0;

  while (cursor && cursor < windowStart && guard < Math.max(count * 8, 64)) {
    cursor = addFrequency(cursor, frequency);
    guard += 1;
  }

  while (cursor && cursor <= windowEnd && guard < Math.max(count * 8, 64)) {
    dates.push(formatDateOnly(cursor));
    cursor = addFrequency(cursor, frequency);
    guard += 1;
  }

  return dates;
}

function buildUpcomingSubscriptionDates(baseDate, frequency) {
  return buildSubscriptionVisitDates(baseDate, frequency, 8);
}

function normalizeJobStatus(status) {
  const allowed = ["scheduled", "assigned", "in_progress", "completed", "cancelled"];
  const map = {
    draft: "scheduled",
    confirmed: "scheduled",
    en_route: "assigned",
    arrived: "assigned",
    rescheduled: "scheduled",
    skipped: "cancelled",
    no_access: "cancelled",
    no_show: "cancelled",
    weather_delay: "cancelled",
    needs_followup: "assigned",
    needs_rework: "assigned",
    quoted: "scheduled",
    approved: "scheduled",
    rejected: "cancelled"
  };
  const resolved = map[status] || status || "scheduled";
  return allowed.includes(resolved) ? resolved : "scheduled";
}

function normalizeJobPaymentStatus(type, paymentStatus) {
  if (type === "subscription_visit") {
    return "included";
  }

  if (paymentStatus === "included_in_subscription" || paymentStatus === "included") {
    return "included";
  }

  if (paymentStatus === "paid") {
    return "paid";
  }

  if (paymentStatus === "unpaid") {
    return "unpaid";
  }

  return "unpaid";
}

function normalizePaymentStatus(value, jobType = "one_time_job") {
  if (jobType === "subscription_visit") return "included";
  if (value === "paid") return "paid";
  if (value === "included" || value === "included_in_subscription") return "included";
  return "unpaid";
}

async function getSuggestedWorker(companyId, clientId, explicitZip = "") {
  const clientLookup = clientId
    ? await pool.query(`
        SELECT zip
        FROM clients
        WHERE id = $1 AND company_id = $2
        LIMIT 1
      `, [clientId, companyId])
    : { rows: [] };

  const zip = explicitZip || (clientLookup.rows[0] && clientLookup.rows[0].zip) || "";
  if (!zip) {
    return null;
  }

  const result = await pool.query(`
    SELECT workers.id, workers.name, workers.phone, zip_groups.id AS zip_group_id, zip_groups.name AS zip_group_name
    FROM zip_codes
    JOIN zip_groups ON zip_groups.id = zip_codes.group_id AND zip_groups.company_id = zip_codes.company_id
    JOIN worker_zip_groups ON worker_zip_groups.group_id = zip_groups.id AND worker_zip_groups.company_id = zip_groups.company_id
    JOIN workers ON workers.id = worker_zip_groups.worker_id AND workers.company_id = worker_zip_groups.company_id
    WHERE zip_codes.company_id = $1
      AND zip_codes.zip = $2
      AND workers.company_id = $1
      AND COALESCE(workers.active, TRUE) = TRUE
    ORDER BY workers.name ASC
    LIMIT 1
  `, [companyId, zip]);

  return result.rows[0] || null;
}

module.exports = {
  warnDeprecatedRoute,
  parseIntSafe,
  normalizeDateOnly,
  parseDateOnly,
  formatDateOnly,
  addFrequency,
  buildSubscriptionVisitDates,
  buildUpcomingSubscriptionDates,
  normalizeJobStatus,
  normalizeJobPaymentStatus,
  normalizePaymentStatus,
  getSuggestedWorker
};
