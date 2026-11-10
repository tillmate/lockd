BEGIN;
SET search_path=lockd,public;
-- Super Admin operations. billing_staff_members stays the staff identity and TOTP record;
-- membership keeps its existing billing authority. Further authority is granted per scope.
CREATE TABLE staff_scopes (
 user_id uuid NOT NULL REFERENCES billing_staff_members, scope text NOT NULL CHECK(scope IN ('listings','support','notifications','admin')),
 granted_by uuid REFERENCES users, reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,scope)
);
-- Every staff mutation outside billing is recorded here, append-only, with a reason code.
CREATE TABLE staff_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users, scope text NOT NULL,
 kind text NOT NULL, account_id uuid REFERENCES accounts, subject_id text, reason_code text NOT NULL,
 note text NOT NULL CHECK(length(note) BETWEEN 10 AND 1000), details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER staff_events_immutable BEFORE UPDATE OR DELETE ON staff_events FOR EACH ROW EXECUTE FUNCTION immutable();
-- Fresh MFA step-up is required for every scope; admin implies the operational scopes.
CREATE FUNCTION staff_can(s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT billing_staff() AND EXISTS(SELECT 1 FROM staff_scopes WHERE user_id=actor_id() AND (scope=s OR scope='admin'))
$$;
CREATE FUNCTION staff_scope_list() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT coalesce(array_agg(scope ORDER BY scope),'{}') FROM staff_scopes s JOIN billing_staff_members m ON m.user_id=s.user_id WHERE s.user_id=actor_id() AND m.enabled
$$;
CREATE FUNCTION staff_event(sc text,k text,a uuid,sub text,code text,n text,d jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
BEGIN
 IF n IS NULL OR length(trim(n)) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'Record a note of at least 10 characters'; END IF;
 INSERT INTO staff_events(actor_id,scope,kind,account_id,subject_id,reason_code,note,details) VALUES(actor_id(),sc,k,a,sub,code,trim(n),d);
END $$;

-- Listing moderation. New listings wait for review before appearing in the public directory; the
-- DJ's own booking link works unless staff restrict it. Existing accounts are grandfathered.
ALTER TABLE accounts ADD COLUMN listing_state text NOT NULL DEFAULT 'pending' CHECK(listing_state IN ('pending','approved','restricted'));
UPDATE accounts SET listing_state='approved';
CREATE TABLE listing_reviews (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts, actor_id uuid NOT NULL REFERENCES users,
 from_state text NOT NULL, to_state text NOT NULL CHECK(to_state IN ('approved','restricted')),
 reason_code text NOT NULL CHECK(reason_code IN ('identity_checked','profile_complete','impersonation','fraud_report','prohibited_content','payment_dispute','incomplete_profile','other')),
 note text NOT NULL CHECK(length(note) BETWEEN 10 AND 1000), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER listing_reviews_immutable BEFORE UPDATE OR DELETE ON listing_reviews FOR EACH ROW EXECUTE FUNCTION immutable();
CREATE FUNCTION review_listing(aid uuid,target text,code text,n text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a accounts; rid bigint;
BEGIN
 IF NOT staff_can('listings') OR owns(aid) THEN RAISE EXCEPTION 'Listings staff with fresh MFA required; you cannot review your own listing' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM accounts WHERE id=aid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
 IF NOT staff_can('listings') THEN RAISE EXCEPTION 'MFA expired while waiting; authenticate again' USING ERRCODE='42501'; END IF;
 IF target NOT IN ('approved','restricted') THEN RAISE EXCEPTION 'Choose approve or restrict'; END IF;
 IF (target='approved' AND code NOT IN ('identity_checked','profile_complete','other')) OR (target='restricted' AND code IN ('identity_checked','profile_complete')) THEN RAISE EXCEPTION 'Reason code does not match the decision'; END IF;
 IF a.listing_state=target THEN RETURN target; END IF;
 INSERT INTO listing_reviews(account_id,actor_id,from_state,to_state,reason_code,note) VALUES(aid,actor_id(),a.listing_state,target,code,trim(n)) RETURNING id INTO rid;
 UPDATE accounts SET listing_state=target WHERE id=aid;
 PERFORM staff_event('listings','LISTING_'||upper(target),aid,rid::text,code,n);
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload) SELECT 'listing:'||rid,u.email,'LISTING_'||upper(target),'dj',jsonb_build_object('accountId',aid,'reviewId',rid,'from',a.listing_state,'reasonCode',code,'note',trim(n))
 FROM users u WHERE u.id=a.user_id;
 RETURN target;
END $$;
CREATE FUNCTION staff_listings(state_filter text) RETURNS TABLE(id uuid,slug text,stage_name text,parish text,bio text,published boolean,listing_state text,created_at timestamptz,email text,email_verified boolean,active_bookings integer,total_bookings integer,last_review jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT (staff_can('listings') OR staff_can('support')) THEN RAISE EXCEPTION 'Listings or support staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT a.id,a.slug,a.stage_name,a.parish,a.bio,a.published,a.listing_state,a.created_at,u.email,u.verified_at IS NOT NULL,
  (SELECT count(*)::int FROM bookings b WHERE b.account_id=a.id AND (b.status IN ('AWAITING_SIGNATURE','AWAITING_DEPOSIT','VERIFICATION_PENDING','PROOF_REJECTED','PARTIAL_VERIFIED') OR (b.status='CONFIRMED_LOCKD' AND b.ends_at>clock_timestamp()))),
  (SELECT count(*)::int FROM bookings b WHERE b.account_id=a.id),
  (SELECT jsonb_build_object('toState',r.to_state,'reasonCode',r.reason_code,'note',r.note,'createdAt',r.created_at) FROM listing_reviews r WHERE r.account_id=a.id ORDER BY r.id DESC LIMIT 1)
 FROM accounts a JOIN users u ON u.id=a.user_id
 WHERE (state_filter IS NULL OR a.listing_state=state_filter) AND a.user_id<>actor_id()
 ORDER BY CASE a.listing_state WHEN 'pending' THEN 0 WHEN 'restricted' THEN 1 ELSE 2 END,a.created_at;
END $$;
-- Directory needs approval; the shared booking page and new holds are blocked only by restriction.
CREATE OR REPLACE FUNCTION public_profiles(s text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'slug',slug,'stageName',stage_name,'parish',parish,'bio',bio,
 'packages',(SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'priceMinor',p.price_minor,'depositMinor',p.deposit_minor,'durationMinutes',p.duration_minutes)) FROM packages p WHERE p.account_id=a.id))),'[]'::jsonb)
 FROM accounts a WHERE published AND listing_state<>'restricted' AND (slug=s OR (s IS NULL AND listing_state='approved'))
$$;
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('lockd.create_hold(jsonb,text,text)'::regprocedure);
 IF position('AND published FOR UPDATE' IN source)=0 THEN RAISE EXCEPTION 'Expected hold account predicate not found'; END IF;
 source:=replace(source,'AND published FOR UPDATE','AND published AND listing_state<>''restricted'' FOR UPDATE');
 EXECUTE source;
END $$;

-- Notification operations: metadata only (masked recipient, no bodies or link secrets).
CREATE FUNCTION staff_notifications(status_filter text) RETURNS TABLE(id uuid,kind text,audience text,recipient text,status text,attempts integer,last_error text,provider text,created_at timestamptz,delivered_at timestamptz,next_attempt_at timestamptz,stage_name text,requeueable boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT staff_can('notifications') THEN RAISE EXCEPTION 'Notifications staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT o.id,o.kind,o.audience,left(o.recipient,1)||'•••@'||split_part(o.recipient,'@',2),o.status,o.attempts,o.last_error,o.provider,o.created_at,o.delivered_at,o.next_attempt_at,a.stage_name,
  o.status='failed' AND o.kind NOT IN ('verify','reset','booking_link')
 FROM outbox o LEFT JOIN accounts a ON a.id=o.account_id
 WHERE (status_filter IS NULL OR o.status=status_filter) AND o.created_at>clock_timestamp()-interval '30 days'
 ORDER BY o.created_at DESC LIMIT 200;
END $$;
CREATE FUNCTION staff_notification_counts() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT staff_can('notifications') THEN RAISE EXCEPTION 'Notifications staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('pending',count(*) FILTER(WHERE status='pending'),'failed',count(*) FILTER(WHERE status='failed'),
  'sent24h',count(*) FILTER(WHERE status='sent' AND delivered_at>clock_timestamp()-interval '24 hours'),
  'oldestPending',min(created_at) FILTER(WHERE status='pending')) FROM outbox WHERE created_at>clock_timestamp()-interval '30 days');
END $$;
-- A requeue grants one more delivery attempt. Link emails cannot be requeued: their encrypted
-- token was erased on failure, so the user must request a new link instead.
CREATE FUNCTION requeue_notification(oid uuid,code text,n text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE o outbox;
BEGIN
 IF NOT staff_can('notifications') THEN RAISE EXCEPTION 'Notifications staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 IF code NOT IN ('provider_outage','configuration_fixed','recipient_corrected','other') THEN RAISE EXCEPTION 'Choose a requeue reason'; END IF;
 SELECT * INTO o FROM outbox WHERE id=oid FOR UPDATE;
 IF NOT FOUND OR o.status<>'failed' THEN RAISE EXCEPTION 'Only failed messages can be requeued'; END IF;
 IF o.kind IN ('verify','reset','booking_link') THEN RAISE EXCEPTION 'Link emails cannot be resent; ask the person to request a new link'; END IF;
 IF o.account_id IS NOT NULL AND owns(o.account_id) THEN RAISE EXCEPTION 'Staff cannot requeue their own account messages' USING ERRCODE='42501'; END IF;
 PERFORM staff_event('notifications','NOTIFICATION_REQUEUED',o.account_id,oid::text,code,n,jsonb_build_object('kind',o.kind,'attempts',o.attempts,'lastError',o.last_error));
 UPDATE outbox SET status='pending',next_attempt_at=clock_timestamp(),lease_until=NULL,attempts=greatest(o.attempts,7) WHERE id=oid;
END $$;

-- Super Admin: grant/revoke operational scopes to existing MFA-enrolled staff, never to oneself.
CREATE FUNCTION set_staff_scope(target uuid,s text,grant_it boolean,n text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
BEGIN
 IF NOT staff_can('admin') THEN RAISE EXCEPTION 'Super Admin with fresh MFA required' USING ERRCODE='42501'; END IF;
 IF target=actor_id() THEN RAISE EXCEPTION 'Staff cannot change their own scopes' USING ERRCODE='42501'; END IF;
 IF s NOT IN ('listings','support','notifications','admin') THEN RAISE EXCEPTION 'Unknown scope'; END IF;
 PERFORM 1 FROM billing_staff_members WHERE user_id=target AND enabled FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Target must be an enabled, MFA-enrolled staff member'; END IF;
 IF grant_it THEN
  INSERT INTO staff_scopes(user_id,scope,granted_by,reason) VALUES(target,s,actor_id(),trim(n)) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
 ELSE
  DELETE FROM staff_scopes WHERE user_id=target AND scope=s;
  IF NOT FOUND THEN RETURN; END IF;
 END IF;
 PERFORM staff_event('admin',CASE WHEN grant_it THEN 'SCOPE_GRANTED' ELSE 'SCOPE_REVOKED' END,NULL,target::text,s,n);
END $$;
CREATE FUNCTION staff_directory() RETURNS TABLE(user_id uuid,email text,enabled boolean,scopes text[],created_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT staff_can('admin') THEN RAISE EXCEPTION 'Super Admin with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT m.user_id,u.email,m.enabled,coalesce((SELECT array_agg(s.scope ORDER BY s.scope) FROM staff_scopes s WHERE s.user_id=m.user_id),'{}'),m.created_at
 FROM billing_staff_members m JOIN users u ON u.id=m.user_id ORDER BY u.email;
END $$;
-- Unified, read-only staff audit trail across billing and operations.
CREATE FUNCTION staff_audit(lim integer) RETURNS TABLE(at timestamptz,actor text,scope text,kind text,stage_name text,reason_code text,note text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT staff_can('admin') THEN RAISE EXCEPTION 'Super Admin with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT * FROM (
  SELECT e.created_at,u.email,e.scope,e.kind,a.stage_name,e.reason_code,e.note FROM staff_events e JOIN users u ON u.id=e.actor_id LEFT JOIN accounts a ON a.id=e.account_id
  UNION ALL
  SELECT e.created_at,u.email,'billing',e.kind,a.stage_name,NULL,e.reason FROM billing_events e JOIN billing_staff_members m ON m.user_id=e.actor_id JOIN users u ON u.id=e.actor_id LEFT JOIN accounts a ON a.id=e.account_id
 ) x ORDER BY 1 DESC LIMIT least(greatest(lim,1),500);
END $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['staff_scopes','staff_events','listing_reviews'] LOOP
  EXECUTE format('ALTER TABLE lockd.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
-- The DJ sees their own listing decisions (reason and note) but not the reviewer identity.
CREATE FUNCTION my_listing_reviews() RETURNS TABLE(to_state text,reason_code text,note text,created_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT r.to_state,r.reason_code,r.note,r.created_at FROM listing_reviews r JOIN accounts a ON a.id=r.account_id WHERE a.user_id=actor_id() ORDER BY r.id DESC LIMIT 10
$$;
REVOKE ALL ON FUNCTION staff_event(text,text,uuid,text,text,text,jsonb) FROM PUBLIC,lockd_runtime;
GRANT EXECUTE ON FUNCTION staff_can(text),staff_scope_list(),review_listing(uuid,text,text,text),staff_listings(text),staff_notifications(text),staff_notification_counts(),requeue_notification(uuid,text,text),set_staff_scope(uuid,text,boolean,text),staff_directory(),staff_audit(integer),my_listing_reviews() TO lockd_runtime;
COMMIT;
