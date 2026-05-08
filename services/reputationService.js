const pool = require("../db/pool");

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

async function computeCompanyReputation(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid company id");
  }

  const [reviewRow, offerRow, disputeRow, supportRow, verificationRow] = await Promise.all([
    pool.query(
      `
      SELECT
        COALESCE(AVG(rating), 0)::numeric AS avg_rating,
        COUNT(*)::int AS review_count
      FROM company_reviews
      WHERE company_id = $1
      `,
      [id]
    ),
    pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status IN ('accepted', 'declined'))::int AS responded,
        COUNT(*)::int AS total
      FROM marketplace_offers
      WHERE company_id = $1
      `,
      [id]
    ),
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total_disputes,
        COUNT(*) FILTER (WHERE status IN ('resolved', 'closed'))::int AS resolved_disputes
      FROM disputes
      WHERE company_id = $1
      `,
      [id]
    ),
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total_tickets,
        COUNT(*) FILTER (WHERE status IN ('resolved', 'closed'))::int AS resolved_tickets
      FROM support_tickets
      WHERE company_id = $1
      `,
      [id]
    ),
    pool.query(
      `
      SELECT verification_status
      FROM companies
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    )
  ]);

  const avgRating = Number(reviewRow.rows[0] && reviewRow.rows[0].avg_rating) || 0;
  const reviewCount = Number(reviewRow.rows[0] && reviewRow.rows[0].review_count) || 0;
  const responded = Number(offerRow.rows[0] && offerRow.rows[0].responded) || 0;
  const totalOffers = Number(offerRow.rows[0] && offerRow.rows[0].total) || 0;
  const totalDisputes = Number(disputeRow.rows[0] && disputeRow.rows[0].total_disputes) || 0;
  const resolvedDisputes = Number(disputeRow.rows[0] && disputeRow.rows[0].resolved_disputes) || 0;
  const totalTickets = Number(supportRow.rows[0] && supportRow.rows[0].total_tickets) || 0;
  const resolvedTickets = Number(supportRow.rows[0] && supportRow.rows[0].resolved_tickets) || 0;
  const verificationStatus = String(verificationRow.rows[0] && verificationRow.rows[0].verification_status || "").toLowerCase();

  const reviewAverageFactor = clampScore((avgRating / 5) * 40);
  const reviewVolumeFactor = clampScore(Math.min(20, reviewCount));
  const responseRateFactor = clampScore(totalOffers > 0 ? (responded / totalOffers) * 15 : 0);
  const disputeRatioFactor = clampScore(totalDisputes > 0 ? Math.max(0, 10 - (((totalDisputes - resolvedDisputes) / totalDisputes) * 10)) : 10);
  const verificationFactor = verificationStatus === "verified" ? 10 : (verificationStatus === "pending" ? 4 : 0);
  const supportIssueFactor = clampScore(totalTickets > 0 ? Math.max(0, 5 - (((totalTickets - resolvedTickets) / totalTickets) * 5)) : 5);

  const score = clampScore(
    reviewAverageFactor +
    reviewVolumeFactor +
    responseRateFactor +
    disputeRatioFactor +
    verificationFactor +
    supportIssueFactor
  );

  return {
    score: Number(score.toFixed(2)),
    factors: {
      review_average: Number(reviewAverageFactor.toFixed(2)),
      review_volume: Number(reviewVolumeFactor.toFixed(2)),
      response_rate: Number(responseRateFactor.toFixed(2)),
      dispute_ratio: Number(disputeRatioFactor.toFixed(2)),
      verification_status: Number(verificationFactor.toFixed(2)),
      support_issue_ratio: Number(supportIssueFactor.toFixed(2))
    }
  };
}

async function refreshCompanyReputation(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid company id");
  }
  const computed = await computeCompanyReputation(id);
  await pool.query(
    `
    UPDATE companies
    SET
      reputation_score = $2,
      reputation_updated_at = CURRENT_TIMESTAMP,
      reputation_last_calculated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    `,
    [id, computed.score]
  );
  await pool.query(
    `
    INSERT INTO reputation_score_audits (company_id, score, factors)
    VALUES ($1, $2, $3::jsonb)
    `,
    [id, computed.score, JSON.stringify(computed.factors || {})]
  );
  return computed;
}

module.exports = {
  computeCompanyReputation,
  refreshCompanyReputation
};
