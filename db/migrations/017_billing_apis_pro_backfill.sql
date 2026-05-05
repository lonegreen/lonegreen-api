UPDATE company_subscriptions cs
SET stripe_customer_id = c.stripe_customer_id,
    stripe_subscription_id = COALESCE(cs.stripe_subscription_id, c.stripe_subscription_id),
    stripe_price_id = COALESCE(cs.stripe_price_id, c.stripe_price_id),
    stripe_plan_key = COALESCE(cs.stripe_plan_key, c.stripe_plan_key),
    stripe_subscription_status = COALESCE(cs.stripe_subscription_status, c.stripe_subscription_status),
    updated_at = CURRENT_TIMESTAMP
FROM companies c
WHERE c.id = cs.company_id
  AND (
    (cs.stripe_customer_id IS NULL OR cs.stripe_customer_id = '')
    OR (cs.stripe_subscription_id IS NULL OR cs.stripe_subscription_id = '')
    OR (cs.stripe_price_id IS NULL OR cs.stripe_price_id = '')
    OR (cs.stripe_plan_key IS NULL OR cs.stripe_plan_key = '')
    OR (cs.stripe_subscription_status IS NULL OR cs.stripe_subscription_status = '')
  );
