ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_slug TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_description TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gallery_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS facebook_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS instagram_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_public_slug_lower
ON companies (LOWER(public_slug))
WHERE public_slug IS NOT NULL AND TRIM(public_slug) <> '';
