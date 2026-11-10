BEGIN;
SET search_path=lockd,public;
CREATE TABLE billing_staff_members (
 user_id uuid PRIMARY KEY REFERENCES users, enabled boolean NOT NULL DEFAULT true,
 secret_cipher text NOT NULL, last_counter bigint NOT NULL DEFAULT -1,
 provision_reason text NOT NULL CHECK(length(provision_reason)>=10), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE billing_staff_sessions (
 session_hash text PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES billing_staff_members, expires_at timestamptz NOT NULL
);
CREATE TABLE billing_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
 business_name text NOT NULL DEFAULT '', instructions text NOT NULL DEFAULT '', verified_by text NOT NULL DEFAULT '',
 CHECK(NOT enabled OR (length(business_name)>=3 AND length(instructions)>=20 AND length(verified_by)>=10))
);
INSERT INTO billing_settings(singleton) VALUES(true);
CREATE FUNCTION billing_staff() RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM billing_staff_sessions s JOIN billing_staff_members m ON m.user_id=s.user_id WHERE m.enabled AND s.session_hash=current_setting('lockd.session_hash',true) AND s.user_id=actor_id() AND s.expires_at>clock_timestamp())
$$;
CREATE FUNCTION staff_secret() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ SELECT secret_cipher FROM billing_staff_members WHERE user_id=actor_id() AND enabled $$;
-- The trusted backend verifies TOTP cryptographically, as it verifies passwords before new_session.
CREATE FUNCTION staff_step_up(counter_value bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE m billing_staff_members;
BEGIN
 SELECT * INTO m FROM billing_staff_members WHERE user_id=actor_id() AND enabled FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Billing staff access required' USING ERRCODE='42501'; END IF;
 IF counter_value IS NULL OR counter_value<=m.last_counter OR abs(counter_value-floor(extract(epoch FROM clock_timestamp())/30)::bigint)>1 THEN RAISE EXCEPTION 'Authenticator code expired or already used'; END IF;
 UPDATE billing_staff_members SET last_counter=counter_value WHERE user_id=m.user_id;
 INSERT INTO billing_staff_sessions VALUES(current_setting('lockd.session_hash'),m.user_id,clock_timestamp()+interval '10 minutes') ON CONFLICT(session_hash) DO UPDATE SET expires_at=excluded.expires_at;
END $$;
CREATE TABLE subscription_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 account_id uuid NOT NULL REFERENCES accounts, plan text NOT NULL CHECK(plan IN ('monthly','annual','founding')),
 amount_minor integer NOT NULL, billing_name text NOT NULL CHECK(length(billing_name) BETWEEN 2 AND 120), billing_email text NOT NULL,
 seller_name text NOT NULL, instructions text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 due_at timestamptz NOT NULL, renewal_for timestamptz, state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','paid','requires_resolution','void')),
 verified_minor integer NOT NULL DEFAULT 0 CHECK(verified_minor>=0 AND verified_minor<=amount_minor),
 request_id uuid NOT NULL, UNIQUE(id,account_id),UNIQUE(account_id,request_id),
 CHECK(amount_minor=CASE plan WHEN 'monthly' THEN 350000 WHEN 'annual' THEN 3600000 ELSE 2500000 END)
);
CREATE UNIQUE INDEX one_open_invoice ON subscription_invoices(account_id) WHERE state IN ('open','requires_resolution');
CREATE TABLE subscription_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, account_id uuid NOT NULL,
 reference text NOT NULL CHECK(length(reference) BETWEEN 2 AND 100), claimed_minor integer NOT NULL CHECK(claimed_minor>0),
 image bytea NOT NULL CHECK(octet_length(image) BETWEEN 20 AND 5242880), image_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(account_id,image_hash),UNIQUE(id,invoice_id,account_id),
 FOREIGN KEY(invoice_id,account_id) REFERENCES subscription_invoices(id,account_id)
);
CREATE TABLE subscription_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, account_id uuid NOT NULL, claim_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL REFERENCES billing_staff_members, decision text NOT NULL CHECK(decision IN ('received','rejected')),
 amount_minor integer NOT NULL, bank_reference text, bank_received_at timestamptz, reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 attested boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(claim_id,invoice_id,account_id) REFERENCES subscription_claims(id,invoice_id,account_id),
 CHECK((decision='received' AND amount_minor>0 AND length(bank_reference) BETWEEN 2 AND 100 AND bank_received_at IS NOT NULL AND attested) OR (decision='rejected' AND amount_minor=0 AND bank_reference IS NULL AND bank_received_at IS NULL))
);
CREATE UNIQUE INDEX subscription_bank_reference ON subscription_payments(lower(trim(bank_reference))) WHERE bank_reference IS NOT NULL;
CREATE TABLE subscriptions (
 account_id uuid PRIMARY KEY REFERENCES accounts, plan text NOT NULL CHECK(plan IN ('monthly','annual','founding')),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at), invoice_id uuid UNIQUE NOT NULL REFERENCES subscription_invoices
);
CREATE TABLE subscription_grants (
 invoice_id uuid PRIMARY KEY REFERENCES subscription_invoices, account_id uuid NOT NULL REFERENCES accounts,
 plan text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE founding_approvals (
 account_id uuid PRIMARY KEY REFERENCES accounts, actor_id uuid NOT NULL REFERENCES billing_staff_members,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE founding_memberships (
 seat integer PRIMARY KEY CHECK(seat BETWEEN 1 AND 50),account_id uuid UNIQUE NOT NULL REFERENCES accounts,
 invoice_id uuid UNIQUE NOT NULL REFERENCES subscription_invoices,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE billing_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id uuid REFERENCES accounts, invoice_id uuid REFERENCES subscription_invoices,
 actor_id uuid REFERENCES users, kind text NOT NULL, reason text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION billing_event(a uuid,i uuid,k text,r text,d jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE eid bigint;
BEGIN
 INSERT INTO billing_events(account_id,invoice_id,actor_id,kind,reason,details) VALUES(a,i,actor_id(),k,r,d) RETURNING id INTO eid;
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) SELECT 'billing:'||eid,u.email,k,jsonb_build_object('invoiceId',i,'accountId',a) FROM accounts ac JOIN users u ON u.id=ac.user_id WHERE ac.id=a;
END $$;
CREATE FUNCTION pro_access(a uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM subscriptions WHERE account_id=a AND ends_at+interval '7 days'>clock_timestamp())
$$;
CREATE FUNCTION billing_configured() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ SELECT enabled FROM billing_settings WHERE singleton $$;
CREATE FUNCTION invoice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=lockd,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable invoice'; END IF;
 IF (to_jsonb(OLD)-'state'-'verified_minor') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'verified_minor') THEN RAISE EXCEPTION 'Immutable invoice'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_history BEFORE UPDATE OR DELETE ON subscription_invoices FOR EACH ROW EXECUTE FUNCTION invoice_guard();

CREATE FUNCTION issue_subscription_invoice(p text,bname text,email text,rid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a accounts; cfg billing_settings; sub subscriptions; existing subscription_invoices; iid uuid; due timestamptz; renewal timestamptz; stamp timestamptz;
BEGIN
 SELECT * INTO a FROM accounts WHERE user_id=actor_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO existing FROM subscription_invoices WHERE account_id=a.id AND request_id=rid;
 IF FOUND THEN
  IF existing.plan<>p OR existing.billing_name<>bname OR existing.billing_email<>lower(email) THEN RAISE EXCEPTION 'Invoice request key already used'; END IF;
  RETURN existing.id;
 END IF;
 SELECT * INTO cfg FROM billing_settings WHERE singleton;
 IF NOT cfg.enabled THEN RAISE EXCEPTION 'Subscription collection is not configured. No payment is requested'; END IF;
 IF p IS NULL OR p NOT IN ('monthly','annual','founding') OR email IS NULL OR email !~ '^[^ @]+@[^ @]+\.[^ @]+$' OR length(email)>254 THEN RAISE EXCEPTION 'Choose a valid plan and billing email'; END IF;
 SELECT * INTO existing FROM subscription_invoices WHERE account_id=a.id AND state IN ('open','requires_resolution');
 IF FOUND THEN RAISE EXCEPTION 'Resolve the existing invoice before requesting another'; END IF;
 stamp:=clock_timestamp();
 SELECT * INTO sub FROM subscriptions WHERE account_id=a.id;
 due:=stamp;
 IF FOUND AND sub.ends_at+interval '7 days'>stamp THEN
  IF sub.plan<>p THEN RAISE EXCEPTION 'Plan changes during an active term require billing review'; END IF;
  IF sub.ends_at>stamp+interval '15 days' THEN RAISE EXCEPTION 'Renewal invoices open 15 days before the due date'; END IF;
  renewal:=sub.ends_at;due:=sub.ends_at;
 END IF;
 IF p='founding' THEN
  IF NOT EXISTS(SELECT 1 FROM founding_approvals WHERE account_id=a.id) THEN RAISE EXCEPTION 'Founding DJ approval is required before a founding invoice'; END IF;
  IF EXISTS(SELECT 1 FROM founding_memberships WHERE account_id=a.id) AND renewal IS NULL THEN RAISE EXCEPTION 'Founding renewal grace has ended. Existing timely bank receipts need staff review; use a standard plan for a new term'; END IF;
  IF NOT EXISTS(SELECT 1 FROM founding_memberships WHERE account_id=a.id) AND (SELECT count(*) FROM founding_memberships)>=50 THEN RAISE EXCEPTION 'Founding cohort is full. No founding payment is requested'; END IF;
 END IF;
 INSERT INTO subscription_invoices(account_id,plan,amount_minor,billing_name,billing_email,seller_name,instructions,due_at,renewal_for,request_id)
 VALUES(a.id,p,CASE p WHEN 'monthly' THEN 350000 WHEN 'annual' THEN 3600000 ELSE 2500000 END,bname,lower(email),cfg.business_name,cfg.instructions,due,renewal,rid) RETURNING id INTO iid;
 PERFORM billing_event(a.id,iid,'INVOICE_ISSUED','DJ requested manual software invoice',jsonb_build_object('plan',p));
 RETURN iid;
END $$;
CREATE FUNCTION submit_subscription_claim(iid uuid,r text,amount integer,img bytea,ih text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE i subscription_invoices; old subscription_claims; cid uuid;
BEGIN
 SELECT * INTO i FROM subscription_invoices WHERE id=iid;
 IF NOT FOUND OR NOT owns(i.account_id) THEN RAISE EXCEPTION 'Invoice owner access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=i.account_id FOR UPDATE;
 SELECT * INTO i FROM subscription_invoices WHERE id=iid FOR UPDATE;
 SELECT * INTO old FROM subscription_claims WHERE account_id=i.account_id AND image_hash=ih;
 IF FOUND THEN IF old.invoice_id=iid AND old.reference=r AND old.claimed_minor=amount THEN RETURN old.id; END IF; RAISE EXCEPTION 'Duplicate invoice evidence'; END IF;
 IF i.state<>'open' THEN RAISE EXCEPTION 'This invoice no longer accepts evidence'; END IF;
 IF (SELECT count(*) FROM subscription_claims WHERE invoice_id=iid)>=10 THEN RAISE EXCEPTION 'Receipt limit reached; contact billing support'; END IF;
 INSERT INTO subscription_claims(invoice_id,account_id,reference,claimed_minor,image,image_hash) VALUES(iid,i.account_id,r,amount,img,ih) RETURNING id INTO cid;
 PERFORM billing_event(i.account_id,iid,'SUBSCRIPTION_PROOF_SUBMITTED','DJ submitted a claim; no paid access granted');
 RETURN cid;
END $$;
CREATE FUNCTION approve_founding(aid uuid,r text,attest boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
BEGIN
 IF NOT billing_staff() OR owns(aid) THEN RAISE EXCEPTION 'Independent billing staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=aid FOR UPDATE;
 IF NOT FOUND OR attest IS DISTINCT FROM true THEN RAISE EXCEPTION 'Attest review of Jamaican DJ eligibility'; END IF;
 INSERT INTO founding_approvals(account_id,actor_id,reason) VALUES(aid,actor_id(),r) ON CONFLICT DO NOTHING;
 IF FOUND THEN PERFORM billing_event(aid,NULL,'FOUNDING_APPROVED',r); END IF;
END $$;
CREATE FUNCTION reconcile_subscription(iid uuid,cid uuid,choice text,amount integer,ref text,received timestamptz,r text,attest boolean) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp SET timezone='UTC' AS $$
DECLARE i subscription_invoices; old subscription_payments; sub subscriptions; total integer; stamp timestamptz; paid_at timestamptz; st timestamptz; en timestamptz; seat_number integer; result text;
BEGIN
 IF NOT billing_staff() THEN RAISE EXCEPTION 'Billing staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM subscription_invoices WHERE id=iid;
 IF NOT FOUND OR owns(i.account_id) THEN RAISE EXCEPTION 'Independent invoice review required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=i.account_id FOR UPDATE;
 SELECT * INTO i FROM subscription_invoices WHERE id=iid FOR UPDATE;
 IF NOT billing_staff() THEN RAISE EXCEPTION 'MFA expired while waiting; authenticate again' USING ERRCODE='42501'; END IF;
 SELECT * INTO old FROM subscription_payments WHERE claim_id=cid;
 IF FOUND THEN
  IF old.invoice_id=iid AND old.decision=choice AND old.amount_minor=amount AND old.bank_reference IS NOT DISTINCT FROM nullif(trim(ref),'') AND old.bank_received_at IS NOT DISTINCT FROM received AND old.reason=r AND old.attested=attest THEN RETURN i.state; END IF;
  RAISE EXCEPTION 'Receipt decision already recorded differently';
 END IF;
 IF i.state<>'open' THEN RAISE EXCEPTION 'Invoice is not open for reconciliation'; END IF;
 stamp:=clock_timestamp();
 IF choice='received' AND (received IS NULL OR received>stamp OR received<i.created_at OR attest IS DISTINCT FROM true) THEN RAISE EXCEPTION 'Attest actual bank receipt with a valid timestamp after invoice issuance'; END IF;
 total:=i.verified_minor+amount;
 IF total>i.amount_minor THEN RAISE EXCEPTION 'Actual funds exceed the invoice; separate billing resolution is required'; END IF;
 INSERT INTO subscription_payments(invoice_id,account_id,claim_id,actor_id,decision,amount_minor,bank_reference,bank_received_at,reason,attested) VALUES(iid,i.account_id,cid,actor_id(),choice,amount,nullif(trim(ref),''),received,r,attest);
 result:='open';
 IF total=i.amount_minor THEN
  SELECT max(bank_received_at) INTO paid_at FROM subscription_payments WHERE invoice_id=iid AND decision='received';
  SELECT * INTO sub FROM subscriptions WHERE account_id=i.account_id;
  IF i.renewal_for IS NOT NULL AND (sub.ends_at IS DISTINCT FROM i.renewal_for OR sub.plan IS DISTINCT FROM i.plan) THEN result:='requires_resolution'; END IF;
  IF i.plan='founding' THEN
   -- One global allocator lock is always acquired after the tenant lock. Seats are never recycled.
   PERFORM pg_advisory_xact_lock(717244);
   IF NOT EXISTS(SELECT 1 FROM founding_approvals WHERE account_id=i.account_id) THEN result:='requires_resolution';
   ELSIF i.renewal_for IS NOT NULL THEN
    IF paid_at>i.renewal_for+interval '7 days' THEN result:='requires_resolution'; END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM founding_memberships WHERE account_id=i.account_id) THEN
    SELECT n INTO seat_number FROM generate_series(1,50) n WHERE NOT EXISTS(SELECT 1 FROM founding_memberships WHERE seat=n) ORDER BY n LIMIT 1;
    IF seat_number IS NULL THEN result:='requires_resolution'; ELSE INSERT INTO founding_memberships(seat,account_id,invoice_id) VALUES(seat_number,i.account_id,iid); END IF;
   ELSE result:='requires_resolution'; END IF;
  END IF;
  IF result<>'requires_resolution' THEN
   st:=CASE WHEN i.renewal_for IS NOT NULL AND paid_at<=i.renewal_for+interval '7 days' THEN i.renewal_for ELSE stamp END;
   en:=st+CASE WHEN i.plan='monthly' THEN interval '1 month' ELSE interval '1 year' END;
   INSERT INTO subscription_grants(invoice_id,account_id,plan,starts_at,ends_at) VALUES(iid,i.account_id,i.plan,st,en);
   INSERT INTO subscriptions(account_id,plan,starts_at,ends_at,invoice_id) VALUES(i.account_id,i.plan,st,en,iid) ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan,starts_at=excluded.starts_at,ends_at=excluded.ends_at,invoice_id=excluded.invoice_id;
   result:='paid';
  END IF;
 END IF;
 UPDATE subscription_invoices SET verified_minor=total,state=result WHERE id=iid;
 PERFORM billing_event(i.account_id,iid,CASE result WHEN 'paid' THEN 'SUBSCRIPTION_ACTIVATED' WHEN 'requires_resolution' THEN 'PAID_REQUIRES_RESOLUTION' ELSE 'SUBSCRIPTION_RECONCILED' END,r,jsonb_build_object('claimId',cid,'amountMinor',amount,'decision',choice));
 RETURN result;
END $$;
CREATE FUNCTION void_subscription_invoice(iid uuid,r text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE i subscription_invoices;
BEGIN
 SELECT * INTO i FROM subscription_invoices WHERE id=iid;
 IF NOT FOUND OR NOT owns(i.account_id) THEN RAISE EXCEPTION 'Invoice owner access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=i.account_id FOR UPDATE;
 SELECT * INTO i FROM subscription_invoices WHERE id=iid FOR UPDATE;
 IF i.state='void' THEN RETURN; END IF;
 IF i.state<>'open' OR i.verified_minor<>0 OR EXISTS(SELECT 1 FROM subscription_claims WHERE invoice_id=iid) THEN RAISE EXCEPTION 'Invoices with payment activity require billing review'; END IF;
 IF r IS NULL OR length(r) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;
 UPDATE subscription_invoices SET state='void' WHERE id=iid;
 PERFORM billing_event(i.account_id,iid,'INVOICE_VOIDED',r);
END $$;

-- Billing reviewers see only billing records and a minimal eligible-account projection.
CREATE FUNCTION billing_accounts() RETURNS TABLE(id uuid,stage_name text,parish text,approved boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT billing_staff() THEN RAISE EXCEPTION 'Billing staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT a.id,a.stage_name,a.parish,EXISTS(SELECT 1 FROM founding_approvals f WHERE f.account_id=a.id) FROM accounts a WHERE a.user_id<>actor_id() ORDER BY a.stage_name;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['billing_staff_members','billing_staff_sessions','billing_settings','subscription_invoices','subscription_claims','subscription_payments','subscriptions','subscription_grants','founding_approvals','founding_memberships','billing_events'] LOOP
  EXECUTE format('ALTER TABLE lockd.%I ENABLE ROW LEVEL SECURITY',t);
  IF t NOT IN ('billing_staff_members','billing_staff_sessions','billing_settings') THEN
   EXECUTE format('CREATE POLICY billing_access ON lockd.%I FOR SELECT USING(lockd.owns(account_id) OR lockd.billing_staff())',t);
   EXECUTE format('GRANT SELECT ON lockd.%I TO lockd_runtime',t);
   IF t NOT IN ('subscriptions','subscription_invoices') THEN EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON lockd.%I FOR EACH ROW EXECUTE FUNCTION lockd.immutable()',t); END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION billing_event(uuid,uuid,text,text,jsonb) FROM PUBLIC,lockd_runtime;
GRANT EXECUTE ON FUNCTION billing_staff(),staff_secret(),staff_step_up(bigint),pro_access(uuid),billing_configured(),issue_subscription_invoice(text,text,text,uuid),submit_subscription_claim(uuid,text,integer,bytea,text),approve_founding(uuid,text,boolean),reconcile_subscription(uuid,uuid,text,integer,text,timestamptz,text,boolean),void_subscription_invoice(uuid,text),billing_accounts() TO lockd_runtime;
-- Keep the exact existing hold function and replace only its fixed Free-cap predicate.
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('lockd.create_hold(jsonb,text,text)'::regprocedure);
 IF position('IF (SELECT count(*) FROM bookings' IN source)=0 THEN RAISE EXCEPTION 'Expected hold cap predicate not found'; END IF;
 source:=replace(source,'IF (SELECT count(*) FROM bookings','IF NOT pro_access(a.id) AND (SELECT count(*) FROM bookings');
 EXECUTE source;
END $$;
COMMIT;
