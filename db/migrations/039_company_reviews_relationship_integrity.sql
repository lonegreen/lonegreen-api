CREATE OR REPLACE FUNCTION validate_company_review_relationship()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM jobs j
    WHERE j.id = NEW.job_id
      AND j.company_id = NEW.company_id
      AND j.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION 'company_reviews relationship must match jobs(id, company_id, client_id)'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_company_review_relationship
ON company_reviews;

CREATE TRIGGER trg_validate_company_review_relationship
BEFORE INSERT OR UPDATE ON company_reviews
FOR EACH ROW
EXECUTE FUNCTION validate_company_review_relationship();
