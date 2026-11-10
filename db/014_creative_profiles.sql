BEGIN;
SET search_path=lockd,public;
-- Creative categories and public profile details. DJs are the public launch category; the other
-- categories are the curated invite-only beta and are only assigned by Lockd (no self-service).
-- Social links are public profile content the creative manages themselves.
ALTER TABLE accounts ADD COLUMN category text NOT NULL DEFAULT 'dj'
 CHECK(category IN ('dj','live_music','host','comedian','creator','photo_film'));
ALTER TABLE accounts ADD COLUMN headline text CHECK(headline IS NULL OR length(headline) BETWEEN 2 AND 80);
ALTER TABLE accounts ADD COLUMN socials jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(socials)='object');

CREATE OR REPLACE FUNCTION public_profiles(s text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'slug',slug,'stageName',stage_name,'parish',parish,'bio',bio,
 'category',a.category,'headline',a.headline,'socials',a.socials,
 'packages',(SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'priceMinor',p.price_minor,'depositMinor',p.deposit_minor,'durationMinutes',p.duration_minutes) ORDER BY p.price_minor) FROM packages p WHERE p.account_id=a.id)) ORDER BY a.created_at),'[]'::jsonb)
 FROM accounts a WHERE published AND listing_state<>'restricted' AND (slug=s OR (s IS NULL AND listing_state='approved'))
$$;

-- The service validates each network's URL shape; the database keeps the allowed keys, https only
-- and sane lengths, so no caller can store script URLs or arbitrary keys.
CREATE FUNCTION set_social_links(d jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a uuid; k text; v jsonb;
BEGIN
 SELECT id INTO a FROM accounts WHERE user_id=actor_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Creative access required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(d)<>'object' THEN RAISE EXCEPTION 'Invalid social links'; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(d) LOOP
  IF k NOT IN ('instagram','tiktok','youtube','facebook','x','website') OR jsonb_typeof(v)<>'string'
   OR (v#>>'{}') !~ '^https://[^\s<>"]+$' OR length(v#>>'{}')>200 THEN RAISE EXCEPTION 'Invalid social link'; END IF;
 END LOOP;
 UPDATE accounts SET socials=d WHERE id=a;
END $$;
GRANT EXECUTE ON FUNCTION set_social_links(jsonb) TO lockd_runtime;
COMMIT;
