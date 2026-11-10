BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS lockd;
REVOKE ALL ON SCHEMA lockd FROM PUBLIC;
SET search_path = lockd, public;

CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL CHECK(email=lower(email)),
 password_hash text NOT NULL, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (token_hash text PRIMARY KEY CHECK(length(token_hash)=64), user_id uuid NOT NULL REFERENCES users, expires_at timestamptz NOT NULL);
CREATE TABLE email_tokens (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, purpose text NOT NULL CHECK(purpose IN ('verify','reset')), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE NOT NULL REFERENCES users,
 slug text UNIQUE NOT NULL CHECK(slug ~ '^[a-z0-9][a-z0-9-]{2,49}$'), stage_name text NOT NULL CHECK(length(stage_name) BETWEEN 2 AND 100),
 parish text NOT NULL, bio text NOT NULL CHECK(length(bio)<=1500), published boolean NOT NULL DEFAULT false,
 deposit_instructions text NOT NULL CHECK(length(deposit_instructions) BETWEEN 10 AND 2000),
 agreement_template text NOT NULL CHECK(length(agreement_template) BETWEEN 20 AND 12000), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE packages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120), description text NOT NULL,
 price_minor integer NOT NULL CHECK(price_minor BETWEEN 100 AND 100000000),
 deposit_minor integer NOT NULL CHECK(deposit_minor>0 AND deposit_minor<=price_minor),
 duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 30 AND 1440),
 buffer_before integer NOT NULL CHECK(buffer_before BETWEEN 0 AND 720), buffer_after integer NOT NULL CHECK(buffer_after BETWEEN 0 AND 720),
 UNIQUE(id,account_id)
);
CREATE TABLE bookings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts,
 package_id uuid NOT NULL, client_name text NOT NULL, client_email text NOT NULL, venue text NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 price_minor integer NOT NULL CHECK(price_minor>0), deposit_minor integer NOT NULL CHECK(deposit_minor>0 AND deposit_minor<=price_minor),
 status text NOT NULL CHECK(status IN ('AWAITING_SIGNATURE','AWAITING_DEPOSIT','VERIFICATION_PENDING','PROOF_REJECTED','PARTIAL_VERIFIED','CONFIRMED_LOCKD','HOLD_EXPIRED','COMPLETED','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT now(), original_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 grace_used boolean NOT NULL DEFAULT false, verified_minor integer NOT NULL DEFAULT 0 CHECK(verified_minor>=0 AND verified_minor<=price_minor),
 guest_hash text UNIQUE NOT NULL CHECK(length(guest_hash)=64), guest_expires_at timestamptz NOT NULL,
 request_id uuid NOT NULL, request_hash text NOT NULL,
 FOREIGN KEY(package_id,account_id) REFERENCES packages(id,account_id), UNIQUE(id,account_id), UNIQUE(account_id,request_id),
 CHECK(original_expires_at=created_at+interval '48 hours'),
 CHECK(expires_at=original_expires_at+CASE WHEN grace_used THEN interval '24 hours' ELSE interval '0 hours' END)
);
CREATE TABLE occupied_slots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts,
 booking_id uuid UNIQUE, slot tstzrange NOT NULL, reason text,
 FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id),
 CHECK(NOT isempty(slot) AND lower(slot) IS NOT NULL AND upper(slot) IS NOT NULL AND lower_inc(slot) AND NOT upper_inc(slot)),
 EXCLUDE USING gist(account_id WITH =, slot WITH &&)
);
CREATE TABLE agreements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid UNIQUE NOT NULL, account_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), body text NOT NULL, content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id)
);
CREATE TABLE signatures (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_id uuid UNIQUE NOT NULL REFERENCES agreements,
 booking_id uuid UNIQUE NOT NULL, account_id uuid NOT NULL, signer text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
 content_hash text NOT NULL, FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id)
);
CREATE TABLE claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL, account_id uuid NOT NULL,
 reference text NOT NULL CHECK(length(reference) BETWEEN 2 AND 100), claimed_minor integer NOT NULL CHECK(claimed_minor>0),
 received_at timestamptz NOT NULL DEFAULT now(), on_time boolean NOT NULL, image_hash text NOT NULL,
 image bytea NOT NULL CHECK(octet_length(image) BETWEEN 20 AND 5242880), mime text NOT NULL CHECK(mime='image/png'),
 UNIQUE(account_id,image_hash), UNIQUE(id,booking_id,account_id), FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id)
);
CREATE TABLE verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, booking_id uuid NOT NULL, claim_id uuid UNIQUE NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, decision text NOT NULL CHECK(decision IN ('received','rejected')),
 amount_minor integer NOT NULL CHECK(amount_minor>=0), bank_reference text, reason text NOT NULL,
 attested boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(claim_id,booking_id,account_id) REFERENCES claims(id,booking_id,account_id),
 CHECK((decision='received' AND attested AND amount_minor>0 AND length(bank_reference)>=2) OR (decision='rejected' AND amount_minor=0)),
 UNIQUE(account_id,bank_reference)
);
CREATE TABLE booking_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id uuid NOT NULL, booking_id uuid NOT NULL,
 kind text NOT NULL, actor text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id)
);
CREATE TABLE outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedupe_key text UNIQUE NOT NULL, recipient text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, last_error text, local_delivered_at timestamptz
);
CREATE TABLE rate_limits (key text PRIMARY KEY, started_at timestamptz NOT NULL, hits integer NOT NULL);

CREATE FUNCTION actor_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=nullif(current_setting('lockd.session_hash',true),'') AND s.expires_at>now() AND u.verified_at IS NOT NULL
$$;
CREATE FUNCTION owns(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM accounts WHERE id=a AND user_id=actor_id()) $$;
CREATE FUNCTION guest_can(b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM bookings WHERE id=b AND guest_hash=nullif(current_setting('lockd.guest_hash',true),'') AND guest_expires_at>now())
$$;
CREATE FUNCTION immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=lockd,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Immutable history'; END $$;
CREATE TRIGGER agreements_immutable BEFORE UPDATE OR DELETE ON agreements FOR EACH ROW EXECUTE FUNCTION immutable();
CREATE TRIGGER signatures_immutable BEFORE UPDATE OR DELETE ON signatures FOR EACH ROW EXECUTE FUNCTION immutable();
CREATE TRIGGER verifications_immutable BEFORE UPDATE OR DELETE ON verifications FOR EACH ROW EXECUTE FUNCTION immutable();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON booking_events FOR EACH ROW EXECUTE FUNCTION immutable();
CREATE TRIGGER claims_immutable BEFORE UPDATE OR DELETE ON claims FOR EACH ROW EXECUTE FUNCTION immutable();

-- All mutations run through narrow server-only functions. Runtime has no direct write grants.
CREATE FUNCTION register_user(e text,p text,t text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE u uuid;
BEGIN
 INSERT INTO users(email,password_hash) VALUES(lower(e),p) ON CONFLICT(email) DO NOTHING RETURNING id INTO u;
 IF u IS NOT NULL THEN
  INSERT INTO email_tokens VALUES(t,u,'verify',now()+interval '24 hours',NULL);
  INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('verify:'||t,e,'verify',jsonb_build_object('tokenHash',t));
 END IF;
 RETURN u;
END $$;
CREATE FUNCTION auth_lookup(e text) RETURNS TABLE(id uuid,password_hash text,verified boolean) LANGUAGE sql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ SELECT id,password_hash,verified_at IS NOT NULL FROM users WHERE email=lower(e) $$;
CREATE FUNCTION new_session(u uuid,t text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ INSERT INTO sessions SELECT t,id,now()+interval '12 hours' FROM users WHERE id=u AND verified_at IS NOT NULL $$;
CREATE FUNCTION logout() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ DELETE FROM sessions WHERE token_hash=current_setting('lockd.session_hash',true) $$;
CREATE FUNCTION consume_email_token(t text,p text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE v email_tokens;
BEGIN
 SELECT * INTO v FROM email_tokens WHERE token_hash=t AND used_at IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF v.purpose='verify' THEN UPDATE users SET verified_at=now() WHERE id=v.user_id;
 ELSIF p IS NOT NULL THEN UPDATE users SET password_hash=p WHERE id=v.user_id; DELETE FROM sessions WHERE user_id=v.user_id;
 ELSE RETURN false; END IF;
 UPDATE email_tokens SET used_at=now() WHERE token_hash=t; RETURN true;
END $$;
CREATE FUNCTION request_reset(e text,t text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE u uuid;
BEGIN
 SELECT id INTO u FROM users WHERE email=lower(e);
 IF u IS NOT NULL THEN
 INSERT INTO email_tokens VALUES(t,u,'reset',now()+interval '30 minutes',NULL);
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('reset:'||t,e,'reset',jsonb_build_object('tokenHash',t));
 END IF;
END $$;
CREATE FUNCTION rate_limit(k text, lim integer, seconds integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE n integer;
BEGIN
 INSERT INTO rate_limits VALUES(k,now(),1) ON CONFLICT(key) DO UPDATE SET
 hits=CASE WHEN rate_limits.started_at<now()-make_interval(secs=>seconds) THEN 1 ELSE rate_limits.hits+1 END,
 started_at=CASE WHEN rate_limits.started_at<now()-make_interval(secs=>seconds) THEN now() ELSE rate_limits.started_at END RETURNING hits INTO n;
 RETURN n<=lim;
END $$;
CREATE FUNCTION onboard(d jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a uuid; u uuid:=actor_id();
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'Sign in with a verified account' USING ERRCODE='42501'; END IF;
 INSERT INTO accounts(user_id,slug,stage_name,parish,bio,deposit_instructions,agreement_template,published)
 VALUES(u,d->>'slug',d->>'stageName',d->>'parish',d->>'bio',d->>'depositInstructions',d->>'agreement',true) RETURNING id INTO a;
 INSERT INTO packages(account_id,name,description,price_minor,deposit_minor,duration_minutes,buffer_before,buffer_after)
 VALUES(a,d->>'packageName',d->>'description',(d->>'priceMinor')::integer,(d->>'depositMinor')::integer,(d->>'durationMinutes')::integer,(d->>'bufferBefore')::integer,(d->>'bufferAfter')::integer);
 RETURN a;
END $$;
CREATE FUNCTION public_profiles(s text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'slug',slug,'stageName',stage_name,'parish',parish,'bio',bio,
 'packages',(SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'priceMinor',p.price_minor,'depositMinor',p.deposit_minor,'durationMinutes',p.duration_minutes)) FROM packages p WHERE p.account_id=a.id))),'[]'::jsonb)
 FROM accounts a WHERE published AND (s IS NULL OR slug=s)
$$;
CREATE FUNCTION expire_account(a uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; n integer:=0;
BEGIN
 PERFORM 1 FROM accounts WHERE id=a FOR UPDATE;
 FOR b IN SELECT * FROM bookings WHERE account_id=a AND status IN ('AWAITING_SIGNATURE','AWAITING_DEPOSIT','VERIFICATION_PENDING','PROOF_REJECTED','PARTIAL_VERIFIED') AND expires_at<=now() FOR UPDATE LOOP
  UPDATE bookings SET status='HOLD_EXPIRED' WHERE id=b.id;
  DELETE FROM occupied_slots WHERE booking_id=b.id;
  INSERT INTO booking_events(account_id,booking_id,kind,actor) VALUES(a,b.id,'HOLD_EXPIRED','system');
  INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('expired:'||b.id,b.client_email,'hold_expired',jsonb_build_object('bookingId',b.id)) ON CONFLICT DO NOTHING;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
CREATE FUNCTION expire_all() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a uuid; n integer:=0;
BEGIN FOR a IN SELECT id FROM accounts ORDER BY id LOOP n:=n+expire_account(a); END LOOP; RETURN n; END $$;
CREATE FUNCTION create_hold(d jsonb,g text,h text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a accounts; p packages; b bookings; bid uuid:=gen_random_uuid(); st timestamptz; en timestamptz; body text;
BEGIN
 SELECT * INTO a FROM accounts WHERE id=(d->>'creatorId')::uuid AND published FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DJ is not available'; END IF;
 SELECT * INTO b FROM bookings WHERE account_id=a.id AND request_id=(d->>'requestId')::uuid;
 IF FOUND THEN
  IF b.request_hash<>h OR b.guest_hash<>g THEN RAISE EXCEPTION 'Idempotency key already used'; END IF;
  RETURN b.id;
 END IF;
 PERFORM expire_account(a.id);
 IF (SELECT count(*) FROM bookings WHERE account_id=a.id AND (status IN ('AWAITING_SIGNATURE','AWAITING_DEPOSIT','VERIFICATION_PENDING','PROOF_REJECTED','PARTIAL_VERIFIED') OR (status='CONFIRMED_LOCKD' AND ends_at>now())))>=3 THEN RAISE EXCEPTION 'This DJ has reached the Free plan active booking limit'; END IF;
 SELECT * INTO p FROM packages WHERE id=(d->>'packageId')::uuid AND account_id=a.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Package does not belong to selected DJ'; END IF;
 st:=(d->>'startsAt')::timestamptz; en:=st+make_interval(mins=>p.duration_minutes);
 IF st<=now()+interval '72 hours' OR st>now()+interval '730 days' THEN RAISE EXCEPTION 'Choose an event more than 72 hours and less than two years away'; END IF;
 INSERT INTO bookings(id,account_id,package_id,client_name,client_email,venue,starts_at,ends_at,price_minor,deposit_minor,status,original_expires_at,expires_at,guest_hash,guest_expires_at,request_id,request_hash)
 VALUES(bid,a.id,p.id,d->>'clientName',lower(d->>'clientEmail'),d->>'venue',st,en,p.price_minor,p.deposit_minor,'AWAITING_SIGNATURE',now()+interval '48 hours',now()+interval '48 hours',g,en+interval '90 days',(d->>'requestId')::uuid,h);
 INSERT INTO occupied_slots(account_id,booking_id,slot) VALUES(a.id,bid,tstzrange(st-make_interval(mins=>p.buffer_before),en+make_interval(mins=>p.buffer_after),'[)'));
 body:=a.agreement_template||E'\n\nBooking details (immutable version 1)\nDJ: '||a.stage_name||E'\nService: '||p.name||E'\nClient: '||(d->>'clientName')||E'\nVenue: '||(d->>'venue')||E'\nStarts (UTC): '||st::text||E'\nEnds (UTC): '||en::text||E'\nTotal JMD minor units: '||p.price_minor||E'\nDeposit JMD minor units: '||p.deposit_minor||E'\nPay the DJ directly. A receipt submission is not confirmation. Confirmation requires DJ verification of actual funds received.\nDirect payment instructions: '||a.deposit_instructions;
 INSERT INTO agreements(booking_id,account_id,body,content_hash) VALUES(bid,a.id,body,encode(public.digest(body,'sha256'),'hex'));
 INSERT INTO booking_events(account_id,booking_id,kind,actor) VALUES(a.id,bid,'HOLD_CREATED','client');
 RETURN bid;
END $$;
CREATE FUNCTION sign_agreement(bid uuid,aid uuid,h text,n text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; a agreements;
BEGIN
 IF NOT guest_can(bid) THEN RAISE EXCEPTION 'Private booking access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM bookings WHERE id=bid;
 PERFORM expire_account(b.account_id);
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 SELECT * INTO a FROM agreements WHERE id=aid AND booking_id=bid AND content_hash=h;
 IF NOT FOUND THEN RAISE EXCEPTION 'Agreement version has changed'; END IF;
 IF EXISTS(SELECT 1 FROM signatures WHERE agreement_id=aid AND signer=n) THEN RETURN; END IF;
 IF b.status<>'AWAITING_SIGNATURE' THEN RAISE EXCEPTION 'Hold is no longer awaiting signature'; END IF;
 INSERT INTO signatures(agreement_id,booking_id,account_id,signer,content_hash) VALUES(aid,bid,b.account_id,n,h);
 UPDATE bookings SET status='AWAITING_DEPOSIT' WHERE id=bid;
 INSERT INTO booking_events(account_id,booking_id,kind,actor,details) VALUES(b.account_id,bid,'AGREEMENT_SIGNED','client',jsonb_build_object('agreementId',aid,'hash',h));
END $$;
CREATE FUNCTION submit_proof(bid uuid,r text,amount integer,img bytea,ih text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; c claims; cid uuid; timely boolean;
BEGIN
 IF NOT guest_can(bid) THEN RAISE EXCEPTION 'Private booking access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM bookings WHERE id=bid;
 PERFORM expire_account(b.account_id);
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM signatures WHERE booking_id=bid) THEN RAISE EXCEPTION 'Sign the agreement first'; END IF;
 SELECT * INTO c FROM claims WHERE account_id=b.account_id AND image_hash=ih;
 IF FOUND THEN
  IF c.booking_id=bid AND c.reference=r AND c.claimed_minor=amount THEN RETURN c.id; END IF;
  RAISE EXCEPTION 'Duplicate evidence: this image is already associated with a claim';
 END IF;
 IF b.status IN ('CONFIRMED_LOCKD','COMPLETED','CANCELLED') THEN RAISE EXCEPTION 'Booking no longer accepts proof'; END IF;
 IF (SELECT count(*) FROM claims WHERE booking_id=bid)>=10 THEN RAISE EXCEPTION 'Evidence limit reached; contact the DJ'; END IF;
 timely:=now()<b.original_expires_at;
 INSERT INTO claims(booking_id,account_id,reference,claimed_minor,on_time,image_hash,image,mime) VALUES(bid,b.account_id,r,amount,timely,ih,img,'image/png') RETURNING id INTO cid;
 IF timely AND NOT b.grace_used THEN UPDATE bookings SET grace_used=true,expires_at=original_expires_at+interval '24 hours' WHERE id=bid; END IF;
 IF b.status<>'HOLD_EXPIRED' THEN UPDATE bookings SET status='VERIFICATION_PENDING' WHERE id=bid; END IF;
 INSERT INTO booking_events(account_id,booking_id,kind,actor,details) VALUES(b.account_id,bid,'PROOF_SUBMITTED','client',jsonb_build_object('claimId',cid,'onTime',timely));
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) SELECT 'proof:'||cid,u.email,'proof_submitted',jsonb_build_object('bookingId',bid,'claimId',cid) FROM users u JOIN accounts a ON a.user_id=u.id WHERE a.id=b.account_id;
 RETURN cid;
END $$;
CREATE FUNCTION verify_payment(bid uuid,cid uuid,decision text,amount integer,ref text,reason text,attest boolean) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; v verifications; result text; total integer;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR NOT owns(b.account_id) THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 PERFORM expire_account(b.account_id);
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM claims WHERE id=cid AND booking_id=bid) THEN RAISE EXCEPTION 'Claim does not belong to booking'; END IF;
 SELECT * INTO v FROM verifications WHERE claim_id=cid;
 IF FOUND THEN
  IF v.decision=decision AND v.amount_minor=amount AND v.bank_reference IS NOT DISTINCT FROM nullif(ref,'') AND v.reason=reason AND v.attested=attest THEN RETURN b.status; END IF;
  RAISE EXCEPTION 'This evidence already has an immutable verification decision';
 END IF;
 IF b.status IN ('CONFIRMED_LOCKD','COMPLETED','CANCELLED') THEN RAISE EXCEPTION 'Booking no longer accepts verification'; END IF;
 IF decision NOT IN ('received','rejected') OR length(reason)<3 THEN RAISE EXCEPTION 'A valid decision and reason are required'; END IF;
 IF decision='received' AND (NOT attest OR amount<=0 OR length(coalesce(ref,''))<2) THEN RAISE EXCEPTION 'Attest actual funds received and record bank reference'; END IF;
 IF decision='rejected' AND amount<>0 THEN RAISE EXCEPTION 'Rejected claims cannot record received funds'; END IF;
 total:=b.verified_minor+amount;
 IF total>b.price_minor THEN RAISE EXCEPTION 'Verified funds exceed the service total; reconcile with the DJ'; END IF;
 INSERT INTO verifications(account_id,booking_id,claim_id,actor_id,decision,amount_minor,bank_reference,reason,attested) VALUES(b.account_id,bid,cid,actor_id(),decision,amount,nullif(ref,''),reason,attest);
 result:=CASE WHEN b.status='HOLD_EXPIRED' THEN 'HOLD_EXPIRED' WHEN total>=b.deposit_minor THEN 'CONFIRMED_LOCKD' WHEN total>0 THEN 'PARTIAL_VERIFIED' ELSE 'PROOF_REJECTED' END;
 IF result='CONFIRMED_LOCKD' AND (NOT EXISTS(SELECT 1 FROM occupied_slots WHERE booking_id=bid) OR NOT EXISTS(SELECT 1 FROM signatures WHERE booking_id=bid)) THEN RAISE EXCEPTION 'Cannot confirm without a signed agreement and active slot'; END IF;
 UPDATE bookings SET verified_minor=total,status=result WHERE id=bid;
 INSERT INTO booking_events(account_id,booking_id,kind,actor,details) VALUES(b.account_id,bid,CASE WHEN b.status='HOLD_EXPIRED' THEN 'LATE_PAYMENT_REQUIRES_RESOLUTION' ELSE result END,actor_id()::text,jsonb_build_object('claimId',cid,'decision',decision,'amountMinor',amount));
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('verification:'||cid,b.client_email,lower(result),jsonb_build_object('bookingId',bid,'status',result,'verifiedMinor',total));
 RETURN result;
END $$;
CREATE FUNCTION block_time(st timestamptz,en timestamptz,r text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a uuid; sid uuid;
BEGIN
 SELECT id INTO a FROM accounts WHERE user_id=actor_id();
 IF a IS NULL THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 IF en<=st OR st<now() OR length(r)<3 THEN RAISE EXCEPTION 'Invalid block'; END IF;
 PERFORM expire_account(a);
 INSERT INTO occupied_slots(account_id,slot,reason) VALUES(a,tstzrange(st,en,'[)'),r) RETURNING id INTO sid; RETURN sid;
END $$;
CREATE FUNCTION unblock_time(sid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a uuid;
BEGIN
 SELECT account_id INTO a FROM occupied_slots WHERE id=sid AND booking_id IS NULL;
 IF a IS NULL OR NOT owns(a) THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=a FOR UPDATE;
 DELETE FROM occupied_slots WHERE id=sid AND booking_id IS NULL;
END $$;
CREATE FUNCTION complete_booking(bid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR NOT owns(b.account_id) THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=b.account_id FOR UPDATE;
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 IF b.status='COMPLETED' THEN RETURN; END IF;
 IF b.status<>'CONFIRMED_LOCKD' OR b.ends_at>now() THEN RAISE EXCEPTION 'Only finished confirmed events can be completed'; END IF;
 UPDATE bookings SET status='COMPLETED' WHERE id=bid;
 DELETE FROM occupied_slots WHERE booking_id=bid;
 INSERT INTO booking_events(account_id,booking_id,kind,actor) VALUES(b.account_id,bid,'COMPLETED',actor_id()::text);
END $$;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE occupied_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_owner ON accounts FOR SELECT USING(user_id=actor_id());
CREATE POLICY packages_owner ON packages FOR SELECT USING(owns(account_id));
CREATE POLICY bookings_access ON bookings FOR SELECT USING(owns(account_id) OR guest_can(id));
CREATE POLICY slots_owner ON occupied_slots FOR SELECT USING(owns(account_id));
CREATE POLICY agreements_access ON agreements FOR SELECT USING(owns(account_id) OR guest_can(booking_id));
CREATE POLICY signatures_access ON signatures FOR SELECT USING(owns(account_id) OR guest_can(booking_id));
CREATE POLICY claims_access ON claims FOR SELECT USING(owns(account_id) OR guest_can(booking_id));
CREATE POLICY verifications_access ON verifications FOR SELECT USING(owns(account_id) OR guest_can(booking_id));
CREATE POLICY events_access ON booking_events FOR SELECT USING(owns(account_id) OR guest_can(booking_id));

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lockd_runtime') THEN CREATE ROLE lockd_runtime LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA lockd FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lockd FROM PUBLIC;
GRANT USAGE ON SCHEMA lockd TO lockd_runtime;
GRANT SELECT ON accounts,packages,bookings,occupied_slots,agreements,signatures,claims,verifications,booking_events TO lockd_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lockd TO lockd_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA lockd REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
