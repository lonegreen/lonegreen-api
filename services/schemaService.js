const pool = require("../db/pool");

let estimateSchemaReadyPromise = null;
let jobPhotoSchemaReadyPromise = null;
let subscriptionBillingSchemaReadyPromise = null;
let clientLifecycleSchemaReadyPromise = null;
let workflowSchemaReadyPromise = null;
let operationsSchemaReadyPromise = null;

async function tableExists(tableName) {
  const result = await pool.query("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]);
  return Boolean(result.rows[0] && result.rows[0].table_name);
}

async function requireTables(tableNames) {
  const missing = [];

  for (const tableName of tableNames) {
    if (!(await tableExists(tableName))) {
      missing.push(tableName);
    }
  }

  if (missing.length) {
    throw new Error(`Database schema is not ready. Missing table(s): ${missing.join(", ")}. Run node db/setup.js`);
  }
}

async function ensureEstimateSchema() {
  if (!estimateSchemaReadyPromise) {
    estimateSchemaReadyPromise = requireTables(["estimates"]).catch(err => {
      estimateSchemaReadyPromise = null;
      throw err;
    });
  }

  return estimateSchemaReadyPromise;
}

async function ensureJobPhotoSchema() {
  if (!jobPhotoSchemaReadyPromise) {
    jobPhotoSchemaReadyPromise = requireTables(["job_photos"]).catch(err => {
      jobPhotoSchemaReadyPromise = null;
      throw err;
    });
  }

  return jobPhotoSchemaReadyPromise;
}

async function ensureSubscriptionBillingSchema() {
  if (!subscriptionBillingSchemaReadyPromise) {
    subscriptionBillingSchemaReadyPromise = requireTables(["subscriptions", "subscription_billings", "invoices", "payments"]).catch(err => {
      subscriptionBillingSchemaReadyPromise = null;
      throw err;
    });
  }

  return subscriptionBillingSchemaReadyPromise;
}

async function ensureClientLifecycleSchema() {
  if (!clientLifecycleSchemaReadyPromise) {
    clientLifecycleSchemaReadyPromise = requireTables(["clients"]).catch(err => {
      clientLifecycleSchemaReadyPromise = null;
      throw err;
    });
  }

  return clientLifecycleSchemaReadyPromise;
}

async function ensureWorkflowSchema() {
  if (!workflowSchemaReadyPromise) {
    workflowSchemaReadyPromise = requireTables(["clients", "jobs", "estimates", "invoices", "payments"]).catch(err => {
      workflowSchemaReadyPromise = null;
      throw err;
    });
  }

  return workflowSchemaReadyPromise;
}

async function ensureOperationsSchema() {
  if (!operationsSchemaReadyPromise) {
    operationsSchemaReadyPromise = requireTables([
      "activity_log",
      "notifications",
      "workers",
      "worker_zip_groups",
      "subscription_billings",
      "invoices",
      "payments"
    ]).catch(err => {
      operationsSchemaReadyPromise = null;
      throw err;
    });
  }

  return operationsSchemaReadyPromise;
}

module.exports = {
  ensureEstimateSchema,
  ensureJobPhotoSchema,
  ensureSubscriptionBillingSchema,
  ensureClientLifecycleSchema,
  ensureWorkflowSchema,
  ensureOperationsSchema
};
