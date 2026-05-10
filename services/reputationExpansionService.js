const pool = require("../db/pool");
const activityLogService = require("./activityLogService");
const trustGraphService = require("./trustGraphService");

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function ratio(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  return t > 0 ? p / t : 0;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function assertCompanyId(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error("Invalid company id");
    err.code = "INVALID_COMPANY_ID";
    throw err;
  }
  return id;
}

async function safeOne(sql, params, label, fallback = {}) {
  try {
    const result = await pool.query(sql, params);
    return result.rows[0] || fallback;
  } catch (err) {
    if (err && (err.code === "42P01" || err.code === "42703")) {
      console.log(JSON.stringify({
        level: "warn",
        event: "reputation_expansion_signal_unavailable",
        signal: label,
        message: err.message
      }));
      return fallback;
    }
    throw err;
  }
}

async function getOperationalBase(companyId) {
  const id = assertCompanyId(companyId);
  const [jobs, invoices, subscriptions, reviews, marketplace, referrals] = await Promise.all([
    safeOne(`
      WITH per_client AS (
        SELECT
          client_id,
          COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'completed')::int AS completed_jobs
        FROM jobs
        WHERE company_id = $1
          AND client_id IS NOT NULL
        GROUP BY client_id
      )
      SELECT
        COUNT(*)::int AS total_jobs,
        COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'completed')::int AS completed_jobs,
        COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'cancelled')::int AS cancelled_jobs,
        COUNT(DISTINCT client_id) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'completed')::int AS clients_with_completed_jobs,
        COALESCE((SELECT COUNT(*) FROM per_client WHERE completed_jobs >= 2), 0)::int AS repeat_clients
      FROM jobs
      WHERE company_id = $1
    `, [id], "jobs"),
    safeOne(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'paid')::int AS paid_invoices,
        COUNT(*)::int AS total_invoices
      FROM invoices
      WHERE company_id = $1
    `, [id], "invoices"),
    safeOne(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active')::int AS active_subscriptions,
        COUNT(*)::int AS total_subscriptions
      FROM subscriptions
      WHERE company_id = $1
    `, [id], "subscriptions"),
    safeOne(`
      SELECT
        COALESCE(AVG(rating), 0)::numeric AS review_average,
        COUNT(*)::int AS review_count
      FROM company_reviews
      WHERE company_id = $1
        AND COALESCE(is_public, TRUE) = TRUE
    `, [id], "reviews"),
    safeOne(`
      SELECT
        COUNT(*)::int AS marketplace_offers,
        COUNT(*) FILTER (WHERE mo.status IN ('accepted', 'rejected'))::int AS marketplace_terminal_offers,
        COUNT(*) FILTER (WHERE mo.status = 'accepted')::int AS accepted_offers,
        COUNT(*) FILTER (WHERE mo.status = 'pending')::int AS pending_offers,
        COALESCE(AVG(EXTRACT(EPOCH FROM (mo.created_at - mr.created_at))) FILTER (WHERE mo.created_at >= mr.created_at), NULL)::numeric AS avg_response_seconds,
        COUNT(*) FILTER (WHERE mo.status = 'accepted' AND mr.converted_at IS NOT NULL)::int AS converted_offers
      FROM marketplace_offers mo
      LEFT JOIN marketplace_requests mr ON mr.id = mo.request_id
      WHERE mo.company_id = $1
    `, [id], "marketplace_offers"),
    safeOne(`
      SELECT
        COUNT(*) FILTER (WHERE r.journey_status = 'converted' OR r.status IN ('qualified', 'rewarded'))::int AS referral_conversions,
        COUNT(*)::int AS referral_total
      FROM referrals r
      JOIN referral_codes rc ON rc.id = r.code_id
      WHERE rc.owner_company_id = $1
         OR rc.scope_company_id = $1
    `, [id], "referrals")
  ]);

  return {
    company_id: id,
    completed_jobs_count: num(jobs.completed_jobs),
    total_jobs_count: num(jobs.total_jobs),
    cancelled_jobs_count: num(jobs.cancelled_jobs),
    repeat_clients_count: num(jobs.repeat_clients),
    clients_with_completed_jobs: num(jobs.clients_with_completed_jobs),
    paid_invoices_count: num(invoices.paid_invoices),
    total_invoices_count: num(invoices.total_invoices),
    active_subscriptions_count: num(subscriptions.active_subscriptions),
    total_subscriptions_count: num(subscriptions.total_subscriptions),
    review_average: round2(num(reviews.review_average)),
    review_count: num(reviews.review_count),
    marketplace_offers_count: num(marketplace.marketplace_offers),
    marketplace_terminal_offers_count: num(marketplace.marketplace_terminal_offers),
    marketplace_pending_offers_count: num(marketplace.pending_offers),
    marketplace_accepted_offers_count: num(marketplace.accepted_offers),
    marketplace_converted_offers_count: num(marketplace.converted_offers),
    average_response_seconds: marketplace.avg_response_seconds == null ? null : round2(num(marketplace.avg_response_seconds)),
    referral_conversions_count: num(referrals.referral_conversions),
    referral_total_count: num(referrals.referral_total)
  };
}

async function getReputationRiskSignals(companyId) {
  const id = assertCompanyId(companyId);
  const base = await getOperationalBase(id);
  const [disputes, complaints] = await Promise.all([
    safeOne(`
      SELECT
        COUNT(*)::int AS total_disputes,
        COUNT(*) FILTER (WHERE status IN ('open', 'reviewing', 'waiting_customer', 'waiting_company'))::int AS open_disputes
      FROM disputes
      WHERE company_id = $1
    `, [id], "disputes"),
    safeOne(`
      SELECT
        COUNT(*)::int AS total_complaints,
        COUNT(*) FILTER (WHERE status IN ('open', 'pending'))::int AS open_complaints
      FROM support_tickets
      WHERE company_id = $1
        AND category IN ('bug', 'account', 'marketplace', 'billing', 'general')
    `, [id], "support_tickets")
  ]);

  const cancelledJobsRatio = round2(ratio(base.cancelled_jobs_count, base.total_jobs_count));
  const disputeRatio = round2(ratio(disputes.total_disputes, Math.max(1, base.completed_jobs_count + base.marketplace_accepted_offers_count)));
  const complaintRatio = round2(ratio(complaints.total_complaints, Math.max(1, base.completed_jobs_count + base.total_invoices_count)));
  const openIssueRatio = round2(ratio(num(disputes.open_disputes) + num(complaints.open_complaints), Math.max(1, num(disputes.total_disputes) + num(complaints.total_complaints))));

  const riskPoints =
    cancelledJobsRatio * 32 +
    disputeRatio * 36 +
    complaintRatio * 24 +
    openIssueRatio * 8;
  const riskScore = round2(clamp(riskPoints * 100, 0, 100));
  const riskLevel = riskScore >= 55 ? "high" : riskScore >= 25 ? "medium" : "low";

  const signals = [];
  if (cancelledJobsRatio >= 0.2) signals.push("elevated_cancellations");
  if (disputeRatio >= 0.08) signals.push("elevated_disputes");
  if (complaintRatio >= 0.08) signals.push("elevated_complaints");
  if (openIssueRatio >= 0.5 && (num(disputes.total_disputes) + num(complaints.total_complaints)) > 0) signals.push("open_issue_backlog");

  return {
    company_id: id,
    generated_at: new Date().toISOString(),
    risk_level: riskLevel,
    risk_score: riskScore,
    signals,
    ratios: {
      cancelled_jobs_ratio: cancelledJobsRatio,
      dispute_ratio: disputeRatio,
      complaint_ratio: complaintRatio,
      open_issue_ratio: openIssueRatio
    },
    counts: {
      cancelled_jobs: base.cancelled_jobs_count,
      total_jobs: base.total_jobs_count,
      total_disputes: num(disputes.total_disputes),
      open_disputes: num(disputes.open_disputes),
      total_complaints: num(complaints.total_complaints),
      open_complaints: num(complaints.open_complaints)
    }
  };
}

async function getReputationOperationalSignals(companyId) {
  const id = assertCompanyId(companyId);
  const base = await getOperationalBase(id);
  let trustGraphRepeatRatio = 0;
  try {
    const trustNetwork = await trustGraphService.getCompanyTrustNetwork(id);
    trustGraphRepeatRatio = num(trustNetwork && trustNetwork.repeat_clients_ratio);
  } catch (_) {
    trustGraphRepeatRatio = ratio(base.repeat_clients_count, base.clients_with_completed_jobs);
  }

  const completionRatio = round2(ratio(base.completed_jobs_count, base.total_jobs_count));
  const repeatClientRatio = round2(ratio(base.repeat_clients_count, base.clients_with_completed_jobs));
  const paidInvoiceRatio = round2(ratio(base.paid_invoices_count, base.total_invoices_count));
  const responseConsistency = round2(ratio(base.marketplace_terminal_offers_count, base.marketplace_offers_count));
  const conversionRatio = round2(ratio(base.marketplace_converted_offers_count, base.marketplace_accepted_offers_count));
  const referralConversionRatio = round2(ratio(base.referral_conversions_count, base.referral_total_count));

  return {
    company_id: id,
    generated_at: new Date().toISOString(),
    signals: {
      completed_jobs_count: base.completed_jobs_count,
      repeat_clients_count: base.repeat_clients_count,
      paid_invoices_count: base.paid_invoices_count,
      cancelled_jobs_ratio: round2(ratio(base.cancelled_jobs_count, base.total_jobs_count)),
      response_consistency: responseConsistency,
      review_average: base.review_average,
      review_count: base.review_count,
      active_subscriptions: base.active_subscriptions_count,
      referral_conversions: base.referral_conversions_count,
      trust_graph_repeat_ratio: round2(trustGraphRepeatRatio),
      completion_ratio: completionRatio,
      repeat_client_ratio: repeatClientRatio,
      paid_invoice_ratio: paidInvoiceRatio,
      marketplace_conversion_ratio: conversionRatio,
      referral_conversion_ratio: referralConversionRatio,
      average_response_seconds: base.average_response_seconds
    },
    counts: base
  };
}

async function getReputationQualityStreaks(companyId) {
  const id = assertCompanyId(companyId);
  const rows = await safeOne(`
    WITH ordered AS (
      SELECT
        id,
        date,
        LOWER(TRIM(COALESCE(status, ''))) AS status,
        ROW_NUMBER() OVER (ORDER BY date DESC NULLS LAST, id DESC) AS rn,
        SUM(CASE WHEN LOWER(TRIM(COALESCE(status, ''))) <> 'completed' THEN 1 ELSE 0 END)
          OVER (ORDER BY date DESC NULLS LAST, id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS breaks
      FROM jobs
      WHERE company_id = $1
    )
    SELECT
      COUNT(*) FILTER (WHERE breaks = 0 AND status = 'completed')::int AS current_completed_job_streak,
      COUNT(*) FILTER (WHERE status = 'completed' AND date >= CURRENT_DATE - INTERVAL '30 days')::int AS completed_jobs_30d,
      COUNT(*) FILTER (WHERE status = 'cancelled' AND date >= CURRENT_DATE - INTERVAL '30 days')::int AS cancelled_jobs_30d
    FROM ordered
  `, [id], "quality_streaks");

  const reviews = await safeOne(`
    SELECT
      COUNT(*) FILTER (WHERE rating >= 4)::int AS positive_reviews,
      COUNT(*)::int AS total_reviews
    FROM company_reviews
    WHERE company_id = $1
      AND created_at >= CURRENT_TIMESTAMP - INTERVAL '180 days'
  `, [id], "review_streaks");

  return {
    company_id: id,
    generated_at: new Date().toISOString(),
    current_completed_job_streak: num(rows.current_completed_job_streak),
    completed_jobs_30d: num(rows.completed_jobs_30d),
    cancelled_jobs_30d: num(rows.cancelled_jobs_30d),
    positive_review_ratio_180d: round2(ratio(reviews.positive_reviews, reviews.total_reviews)),
    positive_reviews_180d: num(reviews.positive_reviews),
    reviews_180d: num(reviews.total_reviews)
  };
}

async function getReputationBadgeCandidates(companyId) {
  const id = assertCompanyId(companyId);
  const [ops, risks] = await Promise.all([
    getReputationOperationalSignals(id),
    getReputationRiskSignals(id)
  ]);
  const s = ops.signals || {};
  const badges = [];

  function add(key, label, reason, strength) {
    badges.push({ key, label, reason, strength: round2(strength) });
  }

  if (s.completed_jobs_count >= 10 && risks.risk_level !== "high") {
    add("verified_completion", "Verified completion", "10+ completed jobs with no high risk flag", Math.min(100, s.completed_jobs_count * 4));
  }
  if (s.repeat_clients_count >= 3 || s.repeat_client_ratio >= 0.35) {
    add("repeat_customer_favorite", "Repeat customer favorite", "Strong repeat-client activity", Math.max(s.repeat_clients_count * 12, s.repeat_client_ratio * 100));
  }
  if (s.response_consistency >= 0.85 && (s.average_response_seconds == null || s.average_response_seconds <= 21600)) {
    add("fast_responder", "Fast responder", "Marketplace offer responses are consistent and timely", s.response_consistency * 100);
  }
  if (s.completion_ratio >= 0.8 && risks.risk_level === "low") {
    add("reliable_operator", "Reliable operator", "High completion ratio with low operational risk", s.completion_ratio * 100);
  }
  if (s.active_subscriptions >= 3 || s.trust_graph_repeat_ratio >= 0.4) {
    add("high_retention", "High retention", "Active recurring relationships or high repeat ratio", Math.max(s.active_subscriptions * 12, s.trust_graph_repeat_ratio * 100));
  }
  if (s.referral_conversions >= 2 || s.referral_conversion_ratio >= 0.25) {
    add("referral_champion", "Referral champion", "Referral activity has converted", Math.max(s.referral_conversions * 20, s.referral_conversion_ratio * 100));
  }
  if (s.completed_jobs_count >= 3 && s.review_average >= 4.5 && s.review_count >= 2 && risks.risk_level === "low") {
    add("rising_pro", "Rising pro", "Early quality signals are trending positive", Math.min(100, 45 + s.review_average * 10 + s.review_count * 2));
  }

  return {
    company_id: id,
    generated_at: new Date().toISOString(),
    badge_candidates: badges.sort((a, b) => b.strength - a.strength)
  };
}

async function buildCompanyReputationExpansion(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const [operations, risks, streaks] = await Promise.all([
    getReputationOperationalSignals(id),
    getReputationRiskSignals(id),
    getReputationQualityStreaks(id)
  ]);
  const badges = await getReputationBadgeCandidates(id);
  const s = operations.signals || {};

  const qualityScore = clamp(
    s.completion_ratio * 22 +
      s.paid_invoice_ratio * 12 +
      Math.min(1, s.review_average / 5) * 18 +
      Math.min(1, s.review_count / 25) * 8 +
      s.response_consistency * 10 +
      s.repeat_client_ratio * 12 +
      Math.min(1, s.active_subscriptions / 10) * 6 +
      Math.min(1, s.referral_conversions / 10) * 5 +
      s.trust_graph_repeat_ratio * 7,
    0,
    100
  );
  const score = round2(clamp(qualityScore - risks.risk_score * 0.35, 0, 100));

  if (options.logActivity) {
    await activityLogService.logActivity({
      companyId: id,
      userId: options.userId || null,
      action: "reputation_expansion_built",
      entityType: "company",
      entityId: id,
      details: { score, risk_level: risks.risk_level, badge_candidates: badges.badge_candidates.length }
    });
    if (badges.badge_candidates.length) {
      await activityLogService.logActivity({
        companyId: id,
        userId: options.userId || null,
        action: "reputation_badge_candidate_detected",
        entityType: "company",
        entityId: id,
        details: { badge_keys: badges.badge_candidates.map((b) => b.key) }
      });
    }
    if (risks.risk_level !== "low" || risks.signals.length) {
      await activityLogService.logActivity({
        companyId: id,
        userId: options.userId || null,
        action: "reputation_risk_detected",
        entityType: "company",
        entityId: id,
        details: { risk_level: risks.risk_level, signals: risks.signals }
      });
    }
  }

  return {
    company_id: id,
    generated_at: new Date().toISOString(),
    reputation_expansion_score: score,
    reputation_risk_level: risks.risk_level,
    reputation_badge_candidates: badges.badge_candidates,
    operations,
    risks,
    streaks,
    scoring: {
      quality_score: round2(qualityScore),
      risk_penalty: round2(risks.risk_score * 0.35)
    }
  };
}

module.exports = {
  buildCompanyReputationExpansion,
  getReputationQualityStreaks,
  getReputationRiskSignals,
  getReputationBadgeCandidates,
  getReputationOperationalSignals
};
