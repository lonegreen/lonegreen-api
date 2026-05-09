const pool = require("../db/pool");
const logger = require("./logger");

const SUBSCRIPTION_ENGINE_LOCK_KEY_1 = 742011;
const SUBSCRIPTION_ENGINE_LOCK_KEY_2 = 202602;

async function suggestWorkerForSubscription(subscription, db = pool) {
  const workerSuggestion = await db.query(`
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
  const client = await pool.connect();
  let lockAcquired = false;
  const startedAt = Date.now();

  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [SUBSCRIPTION_ENGINE_LOCK_KEY_1, SUBSCRIPTION_ENGINE_LOCK_KEY_2]
    );

    lockAcquired = lockResult.rows[0] && lockResult.rows[0].acquired === true;
    if (!lockAcquired) {
      logger.info("SUBSCRIPTION_ENGINE_RUN_SKIPPED", {
        reason: "lock_unavailable",
        duration_ms: Date.now() - startedAt
      });
      return { skipped: true, reason: "lock_unavailable" };
    }

    logger.info("SUBSCRIPTION_ENGINE_RUN_STARTED", {
      lock_acquired: true
    });

    // Tenant-isolation guard: a subscription with NULL/invalid company_id or
    // client_id has no owning tenant and MUST NOT produce subscription_visit
    // jobs. Filtering at the SELECT layer prevents downstream INSERTs from
    // ever materializing a job with company_id = NULL.
    const subs = await client.query(`
      SELECT * FROM subscriptions
      WHERE status = 'active'
        AND company_id IS NOT NULL
        AND client_id IS NOT NULL
    `);

    const limitDate = new Date();
    limitDate.setDate(limitDate.getDate() + 30);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const subscription of subs.rows) {
      if (!subscription.next_date) continue;

      // Defense-in-depth: even after the SELECT-side filter, refuse to act on
      // any subscription row whose company_id failed to resolve to a positive
      // integer. Without a resolved tenant we cannot insert a tenant-scoped
      // job; skipping is strictly safer than producing an orphan visit.
      const subscriptionCompanyId = Number(subscription.company_id);
      if (!Number.isInteger(subscriptionCompanyId) || subscriptionCompanyId <= 0) {
        logger.warn("SUBSCRIPTION_ENGINE_SKIP_MISSING_COMPANY_ID", {
          subscription_id: subscription.id,
          client_id: subscription.client_id,
          raw_company_id: subscription.company_id
        });
        continue;
      }

      const subscriptionClientId = Number(subscription.client_id);
      if (!Number.isInteger(subscriptionClientId) || subscriptionClientId <= 0) {
        logger.warn("SUBSCRIPTION_ENGINE_SKIP_MISSING_CLIENT_ID", {
          subscription_id: subscription.id,
          company_id: subscriptionCompanyId,
          raw_client_id: subscription.client_id
        });
        continue;
      }

      let currentDate = new Date(subscription.next_date);
      currentDate.setHours(0, 0, 0, 0);

      while (currentDate < today) {
        advanceSubscriptionDate(currentDate, subscription.frequency);
      }

      while (currentDate <= limitDate) {
        const dateStr = currentDate.toISOString().split("T")[0];

        const exists = await client.query(`
          SELECT id FROM jobs
          WHERE source_subscription_id = $1
            AND date = $2
            AND type = 'subscription_visit'
            AND company_id = $3
        `, [subscription.id, dateStr, subscriptionCompanyId]);

        if (exists.rows.length === 0) {
          const assignedWorkerId = subscription.worker_id || await suggestWorkerForSubscription(subscription, client);

          // SQL-level guard: refuse to materialize a row whose tenant ($5)
          // is NULL or non-positive. The application-side guards above
          // already prevent this; this is the final backstop.
          const inserted = await client.query(`
            INSERT INTO jobs
            (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
            SELECT $1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included'
            WHERE $5 IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM jobs
                WHERE source_subscription_id = $6
                  AND date = $3
                  AND type = 'subscription_visit'
                  AND company_id = $5
              )
            RETURNING id
          `, [
            subscriptionClientId,
            subscription.service,
            dateStr,
            assignedWorkerId,
            subscriptionCompanyId,
            subscription.id
          ]);

          if (inserted.rows.length > 0) {
            logger.info("Subscription visit created", {
              client_id: subscriptionClientId,
              date: dateStr,
              subscription_id: subscription.id,
              company_id: subscriptionCompanyId
            });
          }
        }

        advanceSubscriptionDate(currentDate, subscription.frequency);
      }
    }

    logger.info("SUBSCRIPTION_ENGINE_RUN_COMPLETED", {
      processed: subs.rows.length,
      duration_ms: Date.now() - startedAt
    });
    return { skipped: false, processed: subs.rows.length };
  } catch (err) {
    if (err && err.code === "23505") {
      logger.warn("Subscription engine duplicate insert skipped by database uniqueness guard", {
        error: err.message,
        duration_ms: Date.now() - startedAt
      });
      return { skipped: false, duplicate_skipped: true };
    }

    logger.error("SUBSCRIPTION_ENGINE_RUN_ERROR", {
      duration_ms: Date.now() - startedAt,
      error: err
    });
    return { skipped: false, error: err && (err.message || String(err)) };
  } finally {
    if (lockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock($1, $2)",
          [SUBSCRIPTION_ENGINE_LOCK_KEY_1, SUBSCRIPTION_ENGINE_LOCK_KEY_2]
        );
      } catch (unlockErr) {
        logger.error("SUBSCRIPTION ENGINE UNLOCK ERROR", unlockErr);
      }
    }

    client.release();
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
