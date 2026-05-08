const pool = require("../db/pool");

function getTrustExpiryWindowDays() {
  const raw = Number(process.env.TRUST_EXPIRY_WINDOW_DAYS);
  if (!Number.isInteger(raw) || raw <= 0) {
    return 30;
  }
  return raw;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function toDateOnlyString(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function dateDiffInDays(fromDateText, toDateText) {
  const from = new Date(`${fromDateText}T00:00:00.000Z`);
  const to = new Date(`${toDateText}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  const diff = to.getTime() - from.getTime();
  return Math.floor(diff / 86400000);
}

async function getExpiringTrustItems(options = {}) {
  const windowDays = Number.isInteger(options.windowDays) ? options.windowDays : getTrustExpiryWindowDays();
  const result = await pool.query(
    `
    SELECT
      id,
      name,
      verification_status,
      insurance_status,
      insurance_expiry_date,
      license_status,
      license_expiry_date,
      platform_suspended_at
    FROM companies
    ORDER BY id ASC
    `
  );

  const today = new Date().toISOString().slice(0, 10);
  const items = [];

  for (const row of result.rows) {
    const insuranceExpiry = toDateOnlyString(row.insurance_expiry_date);
    const licenseExpiry = toDateOnlyString(row.license_expiry_date);
    const insuranceDays = insuranceExpiry ? dateDiffInDays(today, insuranceExpiry) : null;
    const licenseDays = licenseExpiry ? dateDiffInDays(today, licenseExpiry) : null;
    const insuranceExpired = insuranceDays != null && insuranceDays < 0;
    const licenseExpired = licenseDays != null && licenseDays < 0;
    const insuranceExpiringSoon = insuranceDays != null && insuranceDays >= 0 && insuranceDays <= windowDays;
    const licenseExpiringSoon = licenseDays != null && licenseDays >= 0 && licenseDays <= windowDays;

    if (insuranceExpired || licenseExpired || insuranceExpiringSoon || licenseExpiringSoon) {
      items.push({
        company_id: row.id,
        company_name: row.name || "",
        verification_status: normalizeStatus(row.verification_status) || "pending",
        insurance_status: normalizeStatus(row.insurance_status) || "pending",
        insurance_expiry_date: insuranceExpiry || null,
        insurance_days_until_expiry: insuranceDays,
        insurance_expired: insuranceExpired,
        insurance_expiring_soon: insuranceExpiringSoon,
        license_status: normalizeStatus(row.license_status) || "pending",
        license_expiry_date: licenseExpiry || null,
        license_days_until_expiry: licenseDays,
        license_expired: licenseExpired,
        license_expiring_soon: licenseExpiringSoon,
        platform_suspended: Boolean(row.platform_suspended_at)
      });
    }
  }

  return items;
}

async function syncExpiredTrustStatuses() {
  const items = await getExpiringTrustItems();
  let updatedCount = 0;

  for (const item of items) {
    const shouldExpireInsurance = item.insurance_expired
      && (item.insurance_status === "approved" || item.insurance_status === "verified");
    const shouldExpireLicense = item.license_expired
      && (item.license_status === "approved" || item.license_status === "verified");
    if (!shouldExpireInsurance && !shouldExpireLicense) {
      continue;
    }

    await pool.query(
      `
      UPDATE companies
      SET
        insurance_status = CASE
          WHEN $2::boolean = TRUE THEN 'expired'
          ELSE insurance_status
        END,
        license_status = CASE
          WHEN $3::boolean = TRUE THEN 'expired'
          ELSE license_status
        END
      WHERE id = $1
      `,
      [item.company_id, shouldExpireInsurance, shouldExpireLicense]
    );
    updatedCount += 1;
  }

  return {
    updated_count: updatedCount
  };
}

async function buildTrustAlertsForCompany(companyId) {
  const parsedCompanyId = Number(companyId);
  if (!Number.isInteger(parsedCompanyId) || parsedCompanyId <= 0) {
    return [];
  }
  const items = await getExpiringTrustItems();
  const row = items.find((item) => item.company_id === parsedCompanyId);
  if (!row) return [];

  const alerts = [];
  if (row.insurance_expired) {
    alerts.push({
      type: "insurance_expired",
      severity: "danger",
      message: "Insurance has expired.",
      expiry_date: row.insurance_expiry_date,
      days_until_expiry: row.insurance_days_until_expiry
    });
  } else if (row.insurance_expiring_soon) {
    alerts.push({
      type: "insurance_expiring_soon",
      severity: "warning",
      message: `Insurance expires in ${row.insurance_days_until_expiry} day(s).`,
      expiry_date: row.insurance_expiry_date,
      days_until_expiry: row.insurance_days_until_expiry
    });
  }

  if (row.license_expired) {
    alerts.push({
      type: "license_expired",
      severity: "danger",
      message: "License has expired.",
      expiry_date: row.license_expiry_date,
      days_until_expiry: row.license_days_until_expiry
    });
  } else if (row.license_expiring_soon) {
    alerts.push({
      type: "license_expiring_soon",
      severity: "warning",
      message: `License expires in ${row.license_days_until_expiry} day(s).`,
      expiry_date: row.license_expiry_date,
      days_until_expiry: row.license_days_until_expiry
    });
  }

  return alerts;
}

module.exports = {
  getTrustExpiryWindowDays,
  getExpiringTrustItems,
  syncExpiredTrustStatuses,
  buildTrustAlertsForCompany
};
