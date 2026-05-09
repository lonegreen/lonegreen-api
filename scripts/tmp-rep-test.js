require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const pool = require("../db/pool");
const sql = `
SELECT
  (
    LEAST(100, GREATEST(0, COALESCE(rev.average_rating, 0) * 20))
  )::numeric AS reputation_score
FROM companies c
LEFT JOIN (
  SELECT company_id, AVG(rating)::numeric AS average_rating
  FROM company_reviews
  GROUP BY company_id
) rev ON rev.company_id = c.id
WHERE c.is_public = TRUE
LIMIT 1
`;
pool
  .query(sql)
  .then((r) => {
    console.log("ok", r.rows);
  })
  .catch((e) => {
    console.error("err", e.message);
  })
  .finally(() => pool.end());
