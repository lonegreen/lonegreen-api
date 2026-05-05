const pool = require("../db/pool");
const activityLogService = require("./activityLogService");
const base = {
  ...activityLogService,
  ...require("./notificationService"),
  ...require("./invoiceService"),
  ...require("./workerAssignmentService"),
  ...require("./schemaService")
};

const LEAD_STATUSES = ["new", "contacted", "quoted", "approved", "rejected", "converted"];
const ESTIMATE_STATUSES = ["new", "contacted", "quoted", "approved", "rejected", "converted"];

function normalizeLeadStatus(status) {
  return LEAD_STATUSES.includes(status) ? status : "new";
}

function normalizeEstimateStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();

  if (normalized === "draft") {
    return "new";
  }

  if (normalized === "sent") {
    return "quoted";
  }

  return ESTIMATE_STATUSES.includes(normalized) ? normalized : "new";
}

function nextMonthDateString(baseDate) {
  const current = base.parseDateOnly(baseDate) || base.parseDateOnly(new Date().toISOString().split("T")[0]);
  const next = base.addFrequency(current, "monthly");
  return next ? base.formatDateOnly(next) : new Date().toISOString().split("T")[0];
}

async function getClientById(companyId, clientId) {
  const result = await pool.query(`
    SELECT *
    FROM clients
    WHERE id = $1 AND company_id = $2
    LIMIT 1
  `, [clientId, companyId]);

  return result.rows[0] || null;
}

async function createClientFromContact(companyId, contact) {
  const result = await pool.query(`
    INSERT INTO clients (name, phone, address, zip, notes, company_id)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING *
  `, [
    contact.name || "New Client",
    contact.phone || "",
    contact.address || "",
    contact.zip || "",
    contact.notes || "",
    companyId
  ]);

  return result.rows[0];
}

async function getLead(companyId, id) {
  await base.ensureWorkflowSchema();
  const result = await pool.query(`
    SELECT *
    FROM estimates
    WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
    LIMIT 1
  `, [id, companyId]);

  return result.rows[0] || null;
}

async function getEstimate(companyId, id) {
  await base.ensureWorkflowSchema();
  const result = await pool.query(`
    SELECT *
    FROM estimates
    WHERE id = $1 AND company_id = $2 AND record_type = 'estimate'
    LIMIT 1
  `, [id, companyId]);

  return result.rows[0] || null;
}

function formatTimelineItem(type, eventDate, title, status, body, extra = {}) {
  return {
    type,
    event_date: eventDate,
    title,
    status,
    body,
    ...extra
  };
}

module.exports = {
  ...base,
  normalizeLeadStatus,
  normalizeEstimateStatus,
  nextMonthDateString,
  getClientById,
  createClientFromContact,
  getLead,
  getEstimate,
  formatTimelineItem
};
