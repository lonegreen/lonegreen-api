const pool = require("../db/pool");
const logger = require("./logger");

async function suggestWorkerForSubscription(subscription) {
  const workerSuggestion = await pool.query(`
    SELECT workers.id
    FROM clients
    JOIN zip_codes ON zip_codes.zip = clients.zip AND zip_codes.company_id = clients.company_id
    JOIN worker_zip_groups ON worker_zip_groups.group_id = zip_codes.group_id AND worker_zip_groups.company_id = clients.company_id
    JOIN workers ON workers.id = worker_zip_groups.worker_id AND workers.company_id = clients.company_id
    WHERE clients.id = $1
      AND clients.company_id = $2
      AND COALESCE(workers.active, TRUE) = TRUE
    ORDER BY workers.name ASC
    LIMIT 1
  `, [subscription.client_id, subscription.company_id]);

  return workerSuggestion.rows[0] ? workerSuggestion.rows[0].id : null;
}

function advanceSubscriptionDate(date, frequency) {
  if (frequency === "weekly") {
    date.setDate(date.getDate() + 7);
    return;
  }

  if (frequency === "biweekly") {
    date.setDate(date.getDate() + 14);
    return;
  }

  date.setMonth(date.getMonth() + 1);
}

async function processSubscriptions() {
  try {
    const subs = await pool.query(`
      SELECT * FROM subscriptions
      WHERE status = 'active'
    `);

    const limitDate = new Date();
    limitDate.setDate(limitDate.getDate() + 30);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const subscription of subs.rows) {
      if (!subscription.next_date) continue;

      let currentDate = new Date(subscription.next_date);
      currentDate.setHours(0, 0, 0, 0);

      while (currentDate < today) {
        advanceSubscriptionDate(currentDate, subscription.frequency);
      }

      while (currentDate <= limitDate) {
        const dateStr = currentDate.toISOString().split("T")[0];

        const exists = await pool.query(`
          SELECT id FROM jobs
          WHERE source_subscription_id = $1
            AND date = $2
            AND type = 'subscription_visit'
            AND company_id = $3
        `, [subscription.id, dateStr, subscription.company_id]);

        if (exists.rows.length === 0) {
          const assignedWorkerId = subscription.worker_id || await suggestWorkerForSubscription(subscription);

          await pool.query(`
            INSERT INTO jobs
            (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
            VALUES ($1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included')
          `, [
            subscription.client_id,
            subscription.service,
            dateStr,
            assignedWorkerId,
            subscription.company_id,
            subscription.id
          ]);

          logger.info("Subscription visit created", {
            client_id: subscription.client_id,
            date: dateStr,
            subscription_id: subscription.id,
            company_id: subscription.company_id
          });
        }

        advanceSubscriptionDate(currentDate, subscription.frequency);
      }
    }

    logger.info("Subscription engine pass completed");
  } catch (err) {
    logger.error("SUBSCRIPTION ENGINE ERROR", err);
  }
}

function startSubscriptionEngine(intervalMs = 60 * 60 * 1000) {
  logger.info("Subscription interval engine started", {
    interval_ms: intervalMs
  });
  return setInterval(processSubscriptions, intervalMs);
}

module.exports = {
  processSubscriptions,
  startSubscriptionEngine
};
