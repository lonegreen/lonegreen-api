const pool = require("../db/pool");

async function logPlatformCompanyAudit(client, entry) {
  const db = client || pool;
  await db.query(
    `
    INSERT INTO platform_company_audit (company_id, actor_user_id, action, payload)
    VALUES ($1, $2, $3, $4::jsonb)
    `,
    [
      entry.company_id,
      entry.actor_user_id != null ? entry.actor_user_id : null,
      String(entry.action || "unknown").trim(),
      JSON.stringify(entry.payload && typeof entry.payload === "object" ? entry.payload : {})
    ]
  );
}

async function getStaffMutationPlatformBlock(companyId) {
  if (!companyId) {
    return null;
  }

  try {
    const r = await pool.query(
      `
      SELECT platform_suspended_at, platform_suspension_reason
      FROM companies
      WHERE id = $1
      LIMIT 1
      `,
      [companyId]
    );

    if (!r.rows.length) {
      return null;
    }

    const row = r.rows[0];
    if (row.platform_suspended_at) {
      return {
        httpStatus: 403,
        payload: {
          error: "This company has been suspended by the platform. Contact support.",
          code: "PLATFORM_COMPANY_SUSPENDED",
          billing_status: "platform_suspended",
          platform_suspended_at: row.platform_suspended_at,
          platform_suspension_reason: row.platform_suspension_reason || null,
          action_required: "platform_unsuspend",
          portal_available: false,
          warning_mode: false
        }
      };
    }
  } catch (err) {
    if (err && err.code === "42703") {
      return null;
    }
    throw err;
  }

  return null;
}

async function suspendCompanyByPlatform({ companyId, actorUserId, reason }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT id, name FROM companies WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [companyId]
    );
    if (!cur.rows.length) {
      const err = new Error("Company not found");
      err.statusCode = 404;
      throw err;
    }

    await client.query(
      `
      UPDATE companies
      SET platform_suspended_at = COALESCE(platform_suspended_at, CURRENT_TIMESTAMP),
          platform_suspension_reason = COALESCE($2::text, platform_suspension_reason)
      WHERE id = $1
      `,
      [companyId, reason != null ? String(reason).trim() : null]
    );

    try {
      await logPlatformCompanyAudit(client, {
        company_id: companyId,
        actor_user_id: actorUserId,
        action: "platform_suspend_company",
        payload: {
          reason: reason != null ? String(reason).trim() : null,
          company_name: cur.rows[0].name || null
        }
      });
    } catch (auditErr) {
      if (!auditErr || auditErr.code !== "42P01") {
        throw auditErr;
      }
    }

    await client.query("COMMIT");
    return { company_id: Number(companyId), suspended: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function unsuspendCompanyByPlatform({ companyId, actorUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT id, name FROM companies WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [companyId]
    );
    if (!cur.rows.length) {
      const err = new Error("Company not found");
      err.statusCode = 404;
      throw err;
    }

    await client.query(
      `
      UPDATE companies
      SET platform_suspended_at = NULL,
          platform_suspension_reason = NULL
      WHERE id = $1
      `,
      [companyId]
    );

    try {
      await logPlatformCompanyAudit(client, {
        company_id: companyId,
        actor_user_id: actorUserId,
        action: "platform_unsuspend_company",
        payload: {
          company_name: cur.rows[0].name || null
        }
      });
    } catch (auditErr) {
      if (!auditErr || auditErr.code !== "42P01") {
        throw auditErr;
      }
    }

    await client.query("COMMIT");
    return { company_id: Number(companyId), suspended: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  logPlatformCompanyAudit,
  getStaffMutationPlatformBlock,
  suspendCompanyByPlatform,
  unsuspendCompanyByPlatform
};
