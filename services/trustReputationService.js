/**
 * Phase 1 trust + reputation scores, badges, and optional persistence.
 * Deterministic 0–100 scores; missing data uses neutral priors (no harsh zero punishment).
 */
const pool = require("../db/pool");
const growthFoundationService = require("./growthFoundationService");

function clamp100(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function round2(value) {
  return Number(clamp100(value).toFixed(2));
}

async function safeQuery(sql, params, label) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    if (err && err.code === "42P01") {
      console.log(JSON.stringify({
        level: "warn",
        event: "trust_reputation_table_missing",
        query: label,
        message: err.message
      }));
      return { rows: [] };
    }
    throw err;
  }
}

function verificationPoints(verificationStatus, isVerified) {
  const v = String(verificationStatus || "").toLowerCase().trim();
  if (isVerified === true || v === "verified") {
    return { points: 20, label: "verified" };
  }
  if (v === "pending") {
    return { points: 14, label: "pending" };
  }
  if (v === "rejected" || v === "suspended") {
    return { points: 6, label: v };
  }
  return { points: 12, label: v || "unverified" };
}

/** Responsiveness sub-score scaled to max 5 pts so trust components sum to 100. */
function responsivenessPoints(offersTotal, offersTerminal, avgSeconds) {
  if (offersTotal <= 0) {
    return 3.5;
  }
  const terminalRatio = offersTerminal / offersTotal;
  const speedFactor =
    avgSeconds != null && Number.isFinite(avgSeconds)
      ? clamp100(100 * (1 - Math.min(1, avgSeconds / 86400))) / 100
      : 0.65;
  const raw = 5 * terminalRatio + 5 * speedFactor;
  return Math.min(5, raw / 2);
}

/**
 * Trust score (0–100) weights:
 * - Verification up to 20
 * - Reviews up to 25 (neutral 15/25 when no reviews → 3★ equivalent)
 * - Job reliability up to 25 (neutral when no jobs)
 * - Disputes up to 15 (full credit when none)
 * - Abuse reports up to 10 (full credit when none open)
 * - Marketplace responsiveness up to 10 (neutral mid when no offers)
 */
function computeTrustComponents(inputs) {
  const ver = verificationPoints(inputs.verification_status, inputs.is_verified);
  const verification_pts = ver.points;

  const rc = Number(inputs.review_count || 0);
  const avg = Number(inputs.avg_rating || 0);
  let rating_pts;
  if (rc >= 1 && Number.isFinite(avg)) {
    rating_pts = 25 * (avg / 5);
  } else {
    rating_pts = 15;
  }

  const totalJobs = Number(inputs.jobs_total || 0);
  const completed = Number(inputs.jobs_completed || 0);
  const cancelled = Number(inputs.jobs_cancelled || 0);

  let job_pts;
  if (totalJobs <= 0) {
    job_pts = 18;
  } else {
    const cancelShare = cancelled / totalJobs;
    const completionShare = completed / totalJobs;
    const volumeFactor = Math.min(1, Math.log(1 + completed) / Math.log(46));
    const cancelPenalty = Math.min(1, cancelShare / 0.35);
    const inner = Math.max(
      0,
      Math.min(
        1,
        0.55 * volumeFactor + 0.45 * completionShare * (1 - cancelPenalty)
      )
    );
    job_pts = 25 * inner;
  }

  const disputeTotal = Number(inputs.disputes_total || 0);
  const disputesOpen = Number(inputs.disputes_open || 0);
  let dispute_pts;
  if (disputeTotal <= 0) {
    dispute_pts = 15;
  } else {
    const openRatio = disputesOpen / disputeTotal;
    dispute_pts = 15 * (1 - Math.min(1, openRatio));
  }

  const reportsOpen = Number(inputs.abuse_reports_open || 0);
  let report_pts;
  if (reportsOpen <= 0) {
    report_pts = 10;
  } else {
    report_pts = 10 * (1 - Math.min(1, reportsOpen / 6));
  }

  const offersTotal = Number(inputs.marketplace_offers_total || 0);
  const offersTerminal = Number(inputs.marketplace_offers_terminal || 0);
  const avgSeconds = inputs.avg_response_seconds != null ? Number(inputs.avg_response_seconds) : null;

  const response_pts = responsivenessPoints(offersTotal, offersTerminal, avgSeconds);

  const trust_score = round2(
    verification_pts +
      rating_pts +
      job_pts +
      dispute_pts +
      report_pts +
      response_pts
  );

  return {
    trust_score,
    components: {
      verification_pts: round2(verification_pts),
      rating_pts: round2(rating_pts),
      job_pts: round2(job_pts),
      dispute_pts: round2(dispute_pts),
      report_pts: round2(report_pts),
      response_pts: round2(response_pts),
      verification_label: ver.label
    },
    intermediates: {
      review_count: rc,
      avg_rating: avg,
      jobs_total: totalJobs,
      jobs_completed: completed,
      jobs_cancelled: cancelled,
      disputes_total: disputeTotal,
      disputes_open: disputesOpen,
      abuse_reports_open: reportsOpen,
      marketplace_offers_total: offersTotal,
      marketplace_offers_terminal: offersTerminal,
      avg_response_seconds: avgSeconds
    }
  };
}

function reviewBreadthScore(reviewCount) {
  const rc = Number(reviewCount || 0);
  if (rc <= 0) {
    return 55;
  }
  return clamp100(100 * Math.min(1, Math.sqrt(rc) / Math.sqrt(30)));
}

function marketplaceAcceptanceScore(accepted, rejected) {
  const a = Number(accepted || 0);
  const r = Number(rejected || 0);
  const denom = a + r;
  if (denom <= 0) {
    return 62;
  }
  return clamp100(100 * (a / denom));
}

function marketplaceCompletionScore(conversions) {
  const c = Number(conversions || 0);
  return clamp100(100 * Math.min(1, c / 10));
}

function retentionScore(activeClients, repeatClients) {
  const ac = Number(activeClients || 0);
  const rc = Number(repeatClients || 0);
  if (ac < 3) {
    return 60;
  }
  return clamp100(100 * Math.min(1, rc / Math.max(1, ac)));
}

/**
 * Reputation score (0–100):
 * 42% trust_score + 18% review breadth + 15% marketplace acceptance +
 * 15% marketplace conversions volume + 10% repeat-client retention.
 */
function computeReputationScore(trustScore, inputs) {
  const rb = reviewBreadthScore(inputs.review_count);
  const acc = marketplaceAcceptanceScore(
    inputs.marketplace_offers_accepted,
    inputs.marketplace_offers_rejected
  );
  const mc = marketplaceCompletionScore(inputs.marketplace_conversions);
  const ret = retentionScore(inputs.active_clients, inputs.repeat_clients);

  const reputation_score = round2(
    0.42 * trustScore +
      0.18 * rb +
      0.15 * acc +
      0.15 * mc +
      0.10 * ret
  );

  return {
    reputation_score,
    components: {
      trust_blend: round2(0.42 * trustScore),
      review_breadth: round2(0.18 * rb),
      marketplace_acceptance: round2(0.15 * acc),
      marketplace_completions: round2(0.15 * mc),
      retention: round2(0.10 * ret),
      review_breadth_raw: round2(rb),
      marketplace_acceptance_raw: round2(acc),
      marketplace_completions_raw: round2(mc),
      retention_raw: round2(ret)
    }
  };
}

const BADGE_LABELS = {
  verified: "Verified",
  top_rated: "Top rated",
  fast_responder: "Fast responder",
  reliable: "Reliable",
  trusted_pro: "Trusted Pro",
  rising_pro: "Rising Pro"
};

function computeBadges(trustScore, reputationScore, inputs) {
  const badges = [];
  const v = String(inputs.verification_status || "").toLowerCase();
  if (inputs.is_verified === true || v === "verified") {
    badges.push({ id: "verified", label: BADGE_LABELS.verified });
  }

  const rc = Number(inputs.review_count || 0);
  const avg = Number(inputs.avg_rating || 0);
  if (rc >= 5 && avg >= 4.5) {
    badges.push({ id: "top_rated", label: BADGE_LABELS.top_rated });
  }

  const offersTotal = Number(inputs.marketplace_offers_total || 0);
  const avgSec = inputs.avg_response_seconds != null ? Number(inputs.avg_response_seconds) : null;
  if (offersTotal >= 3 && avgSec != null && Number.isFinite(avgSec) && avgSec <= 7200) {
    badges.push({ id: "fast_responder", label: BADGE_LABELS.fast_responder });
  }

  const totalJobs = Number(inputs.jobs_total || 0);
  const cancelled = Number(inputs.jobs_cancelled || 0);
  const cancelShare = totalJobs > 0 ? cancelled / totalJobs : 0;
  const disputeTotal = Number(inputs.disputes_total || 0);
  const disputesOpen = Number(inputs.disputes_open || 0);
  const openDisputeRatio = disputeTotal > 0 ? disputesOpen / disputeTotal : 0;
  if (trustScore >= 72 && cancelShare <= 0.12 && openDisputeRatio <= 0.25) {
    badges.push({ id: "reliable", label: BADGE_LABELS.reliable });
  }

  if (
    (inputs.is_verified === true || v === "verified") &&
    trustScore >= 82 &&
    reputationScore >= 78 &&
    rc >= 8
  ) {
    badges.push({ id: "trusted_pro", label: BADGE_LABELS.trusted_pro });
  }

  const ageDays = Number(inputs.company_age_days || 0);
  const completed = Number(inputs.jobs_completed || 0);
  if (
    ageDays >= 0 &&
    ageDays <= 540 &&
    reputationScore >= 68 &&
    rc >= 2 &&
    rc <= 12 &&
    completed >= 5
  ) {
    badges.push({ id: "rising_pro", label: BADGE_LABELS.rising_pro });
  }

  return badges;
}

async function gatherTrustInputs(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid company id");
  }

  const [
    companyRow,
    reviewRow,
    jobRow,
    disputeRow,
    abuseRow,
    offerRow,
    conversionRow,
    repeatRow,
    activeClientsRow,
    growthMetrics
  ] = await Promise.all([
    safeQuery(
      `
      SELECT
        verification_status,
        is_verified,
        created_at
      FROM companies
      WHERE id = $1
      LIMIT 1
      `,
      [id],
      "tr_companies"
    ),
    safeQuery(
      `
      SELECT
        COALESCE(AVG(rating), 0)::numeric AS avg_rating,
        COUNT(*)::int AS review_count
      FROM company_reviews
      WHERE company_id = $1
      `,
      [id],
      "tr_reviews"
    ),
    safeQuery(
      `
      SELECT
        COUNT(*)::int AS jobs_total,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'completed')::int AS jobs_completed,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'cancelled')::int AS jobs_cancelled
      FROM jobs
      WHERE company_id = $1
      `,
      [id],
      "tr_jobs"
    ),
    safeQuery(
      `
      SELECT
        COUNT(*)::int AS disputes_total,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(status)) IN ('open', 'reviewing', 'waiting_customer', 'waiting_company')
        )::int AS disputes_open
      FROM disputes
      WHERE company_id = $1
      `,
      [id],
      "tr_disputes"
    ),
    safeQuery(
      `
      SELECT COUNT(*)::int AS abuse_reports_open
      FROM abuse_reports
      WHERE company_id = $1
        AND LOWER(TRIM(status)) IN ('open', 'reviewing')
      `,
      [id],
      "tr_abuse"
    ),
    safeQuery(
      `
      SELECT
        COUNT(*)::int AS marketplace_offers_total,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) IN ('accepted', 'rejected'))::int AS marketplace_offers_terminal,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'accepted')::int AS marketplace_offers_accepted,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'rejected')::int AS marketplace_offers_rejected,
        AVG(EXTRACT(EPOCH FROM (mo.created_at - mr.created_at)))::numeric AS avg_response_seconds
      FROM marketplace_offers mo
      INNER JOIN marketplace_requests mr ON mr.id = mo.request_id
      WHERE mo.company_id = $1
      `,
      [id],
      "tr_offers"
    ),
    safeQuery(
      `
      SELECT COUNT(*)::int AS marketplace_conversions
      FROM marketplace_requests
      WHERE converted_by_company_id = $1
        AND converted_at IS NOT NULL
      `,
      [id],
      "tr_conversions"
    ),
    safeQuery(
      `
      SELECT COUNT(*)::int AS repeat_clients
      FROM (
        SELECT client_id
        FROM jobs
        WHERE company_id = $1
          AND client_id IS NOT NULL
        GROUP BY client_id
        HAVING COUNT(*) >= 2
      ) x
      `,
      [id],
      "tr_repeat"
    ),
    safeQuery(
      `
      SELECT COUNT(*)::int AS active_clients
      FROM clients
      WHERE company_id = $1
        AND COALESCE(archived, FALSE) = FALSE
      `,
      [id],
      "tr_clients"
    ),
    growthFoundationService.getCompanyMetrics(id).catch(() => null)
  ]);

  const co = companyRow.rows[0] || {};
  const rv = reviewRow.rows[0] || {};
  const j = jobRow.rows[0] || {};
  const d = disputeRow.rows[0] || {};
  const a = abuseRow.rows[0] || {};
  const o = offerRow.rows[0] || {};
  const c = conversionRow.rows[0] || {};
  const rp = repeatRow.rows[0] || {};
  const ac = activeClientsRow.rows[0] || {};

  let company_age_days = 0;
  if (co.created_at) {
    const created = new Date(co.created_at).getTime();
    if (!Number.isNaN(created)) {
      company_age_days = Math.floor((Date.now() - created) / (86400 * 1000));
    }
  }

  const inputs = {
    verification_status: co.verification_status,
    is_verified: co.is_verified === true,
    company_age_days,
    avg_rating: Number(rv.avg_rating || 0),
    review_count: Number(rv.review_count || 0),
    jobs_total: Number(j.jobs_total || 0),
    jobs_completed: Number(j.jobs_completed || 0),
    jobs_cancelled: Number(j.jobs_cancelled || 0),
    disputes_total: Number(d.disputes_total || 0),
    disputes_open: Number(d.disputes_open || 0),
    abuse_reports_open: Number(a.abuse_reports_open || 0),
    marketplace_offers_total: Number(o.marketplace_offers_total || 0),
    marketplace_offers_terminal: Number(o.marketplace_offers_terminal || 0),
    marketplace_offers_accepted: Number(o.marketplace_offers_accepted || 0),
    marketplace_offers_rejected: Number(o.marketplace_offers_rejected || 0),
    avg_response_seconds:
      o.avg_response_seconds != null ? Number(o.avg_response_seconds) : null,
    marketplace_conversions: Number(c.marketplace_conversions || 0),
    repeat_clients: Number(rp.repeat_clients || 0),
    active_clients: Number(ac.active_clients || 0),
    growth_foundation: growthMetrics
  };

  return inputs;
}

async function buildCompanyTrustProfile(companyId, options = {}) {
  const exists = await pool.query(`SELECT id FROM companies WHERE id = $1 LIMIT 1`, [
    Number(companyId)
  ]);
  if (!exists.rows.length) {
    const err = new Error("Company not found");
    err.code = "COMPANY_NOT_FOUND";
    throw err;
  }

  const inputs = await gatherTrustInputs(companyId);
  const trust = computeTrustComponents(inputs);
  const rep = computeReputationScore(trust.trust_score, inputs);
  const badges = computeBadges(trust.trust_score, rep.reputation_score, inputs);

  const verified =
    inputs.is_verified === true ||
    String(inputs.verification_status || "").toLowerCase() === "verified";

  const payload = {
    company_id: Number(companyId),
    generated_at: new Date().toISOString(),
    trust_score: trust.trust_score,
    reputation_score: rep.reputation_score,
    verified,
    badges,
    rating_summary: {
      average_rating: round2(inputs.avg_rating),
      review_count: inputs.review_count
    },
    components: {
      trust: trust.components,
      reputation: rep.components,
      inputs_summary: {
        jobs_total: inputs.jobs_total,
        jobs_completed: inputs.jobs_completed,
        marketplace_conversions: inputs.marketplace_conversions,
        disputes_total: inputs.disputes_total,
        disputes_open: inputs.disputes_open,
        marketplace_offers_total: inputs.marketplace_offers_total
      }
    }
  };

  if (options.detail) {
    payload.detail = {
      inputs,
      intermediates: trust.intermediates
    };
  }

  return payload;
}

function buildPublicTrustProfile(fullProfile) {
  return {
    company_id: fullProfile.company_id,
    trust_score: fullProfile.trust_score,
    reputation_score: fullProfile.reputation_score,
    badges: (fullProfile.badges || []).map((b) => ({ id: b.id, label: b.label })),
    rating_summary: fullProfile.rating_summary,
    verified: fullProfile.verified === true,
    generated_at: fullProfile.generated_at
  };
}

async function persistCompanyTrustScores(companyId) {
  const full = await buildCompanyTrustProfile(companyId, { detail: true });
  try {
    await pool.query(
      `
      INSERT INTO company_trust_scores (
        company_id,
        trust_score,
        reputation_score,
        badges,
        components,
        calculated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (company_id) DO UPDATE SET
        trust_score = EXCLUDED.trust_score,
        reputation_score = EXCLUDED.reputation_score,
        badges = EXCLUDED.badges,
        components = EXCLUDED.components,
        calculated_at = EXCLUDED.calculated_at
      `,
      [
        Number(companyId),
        full.trust_score,
        full.reputation_score,
        JSON.stringify(full.badges || []),
        JSON.stringify(full.components || {})
      ]
    );
  } catch (err) {
    if (err && err.code === "42P01") {
      console.log(JSON.stringify({
        level: "warn",
        event: "company_trust_scores_missing",
        company_id: Number(companyId)
      }));
    } else {
      throw err;
    }
  }
  return full;
}

async function recomputeAllCompanyTrustScores(limit = 5000) {
  const rows = await pool.query(`SELECT id FROM companies ORDER BY id ASC LIMIT $1`, [
    Math.min(Number(limit) || 5000, 10000)
  ]);
  let ok = 0;
  let failed = 0;
  const errors = [];
  for (const row of rows.rows) {
    try {
      await persistCompanyTrustScores(row.id);
      ok += 1;
    } catch (err) {
      failed += 1;
      if (errors.length < 40) {
        errors.push({
          company_id: row.id,
          message: err && err.message ? err.message : "recompute_failed"
        });
      }
    }
  }
  return {
    processed: ok + failed,
    ok,
    failed,
    errors
  };
}

module.exports = {
  buildCompanyTrustProfile,
  buildPublicTrustProfile,
  persistCompanyTrustScores,
  recomputeAllCompanyTrustScores,
  gatherTrustInputs,
  computeTrustComponents,
  computeReputationScore,
  computeBadges
};
