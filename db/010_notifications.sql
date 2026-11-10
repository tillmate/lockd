BEGIN;
SET search_path=lockd,public;
-- Transactional email delivery: the existing outbox becomes a leased, retried, audited queue.
-- Rows queued before delivery existed were never intended for real recipients and are suppressed.
ALTER TABLE outbox ADD COLUMN status text NOT NULL DEFAULT 'pending',
 ADD COLUMN audience text, ADD COLUMN account_id uuid REFERENCES accounts,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN lease_until timestamptz, ADD COLUMN secret_cipher text,
 ADD COLUMN provider text, ADD COLUMN provider_message_id text;
UPDATE outbox SET status='suppressed',last_error='Queued before external delivery existed; never sent',
 audience=CASE WHEN kind IN ('verify','reset') THEN 'user' WHEN dedupe_key LIKE 'proof:%' OR dedupe_key LIKE 'billing:%' OR dedupe_key LIKE '%:dj' THEN 'dj' ELSE 'client' END;
ALTER TABLE outbox ADD CHECK(status IN ('pending','sent','failed','suppressed')),
 ADD CHECK(audience IN ('user','dj','client')), ALTER COLUMN audience SET NOT NULL,
 -- Encrypted link secrets exist only while a message can still be delivered.
 ADD CHECK(status='pending' OR secret_cipher IS NULL);
CREATE INDEX outbox_due ON outbox(next_attempt_at) WHERE status='pending';
CREATE INDEX outbox_account ON outbox(account_id,created_at);

CREATE FUNCTION outbox_classify() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
BEGIN
 NEW.recipient:=lower(trim(NEW.recipient));
 -- verify_payment reports late funds on an expired hold with the hold_expired status.
 IF NEW.kind='hold_expired' AND NEW.dedupe_key LIKE 'verification:%' THEN NEW.kind:='late_payment_recorded'; END IF;
 IF NEW.dedupe_key LIKE 'verification:%' AND NOT NEW.payload ? 'claimId' THEN NEW.payload:=NEW.payload||jsonb_build_object('claimId',substr(NEW.dedupe_key,14)); END IF;
 NEW.audience:=coalesce(NEW.audience,CASE WHEN NEW.kind IN ('verify','reset') THEN 'user'
  WHEN NEW.dedupe_key LIKE 'proof:%' OR NEW.dedupe_key LIKE 'billing:%' OR NEW.dedupe_key LIKE '%:dj' THEN 'dj' ELSE 'client' END);
 NEW.account_id:=coalesce(NEW.account_id,nullif(NEW.payload->>'accountId','')::uuid,
  (SELECT account_id FROM bookings WHERE id=nullif(NEW.payload->>'bookingId','')::uuid));
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_classify BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_classify();
CREATE FUNCTION outbox_wake() RETURNS trigger LANGUAGE plpgsql SET search_path=lockd,pg_temp AS $$ BEGIN PERFORM pg_notify('lockd_outbox',''); RETURN NULL; END $$;
CREATE TRIGGER outbox_wake AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_wake();

CREATE TABLE notification_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, outbox_id uuid NOT NULL REFERENCES outbox,
 attempt integer NOT NULL CHECK(attempt>0), outcome text NOT NULL CHECK(outcome IN ('sent','retry','failed','skipped')),
 provider text NOT NULL CHECK(length(provider) BETWEEN 2 AND 40), provider_message_id text CHECK(length(provider_message_id)<=200),
 error text CHECK(length(error)<=1000), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(outbox_id,attempt)
);
CREATE TRIGGER notification_attempts_immutable BEFORE UPDATE OR DELETE ON notification_attempts FOR EACH ROW EXECUTE FUNCTION immutable();
ALTER TABLE notification_attempts ENABLE ROW LEVEL SECURITY;

-- New booking communications reuse the immutable booking event stream.
CREATE FUNCTION booking_event_notifications() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; dj text;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=NEW.booking_id;
 SELECT u.email INTO dj FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=NEW.account_id;
 IF NEW.kind='HOLD_CREATED' THEN
  INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload) VALUES
   ('hold:'||b.id||':client',b.client_email,'hold_created','client',jsonb_build_object('bookingId',b.id,'eventId',NEW.id)),
   ('hold:'||b.id||':dj',dj,'booking_request','dj',jsonb_build_object('bookingId',b.id,'eventId',NEW.id)) ON CONFLICT DO NOTHING;
 ELSE
  INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload) VALUES
   ('signed:'||NEW.id||':client',b.client_email,'agreement_signed','client',jsonb_build_object('bookingId',b.id,'eventId',NEW.id)),
   ('signed:'||NEW.id||':dj',dj,'agreement_signed','dj',jsonb_build_object('bookingId',b.id,'eventId',NEW.id)) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER booking_event_notifications AFTER INSERT ON booking_events FOR EACH ROW
 WHEN (NEW.kind IN ('HOLD_CREATED','AGREEMENT_SIGNED')) EXECUTE FUNCTION booking_event_notifications();

-- Same audit behavior; payload now names the exact billing event for message rendering.
CREATE OR REPLACE FUNCTION billing_event(a uuid,i uuid,k text,r text,d jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE eid bigint;
BEGIN
 INSERT INTO billing_events(account_id,invoice_id,actor_id,kind,reason,details) VALUES(a,i,actor_id(),k,r,d) RETURNING id INTO eid;
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) SELECT 'billing:'||eid,u.email,k,jsonb_build_object('invoiceId',i,'accountId',a,'eventId',eid) FROM accounts ac JOIN users u ON u.id=ac.user_id WHERE ac.id=a;
END $$;

-- Additional client links for recovery. The original link keeps working; recovery cannot lock a client out.
CREATE TABLE guest_links (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64), booking_id uuid NOT NULL REFERENCES bookings,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX guest_links_booking ON guest_links(booking_id);
ALTER TABLE guest_links ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION guest_can(b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM bookings k WHERE k.id=b AND k.guest_expires_at>now() AND (
  k.guest_hash=nullif(current_setting('lockd.guest_hash',true),'')
  OR EXISTS(SELECT 1 FROM guest_links l WHERE l.booking_id=b AND l.token_hash=nullif(current_setting('lockd.guest_hash',true),''))))
$$;
-- Always returns true so callers cannot learn whether a booking/email pair exists.
CREATE FUNCTION request_guest_link(bid uuid,e text,h text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR b.client_email<>lower(trim(e)) OR b.guest_expires_at<=clock_timestamp() OR h IS NULL OR length(h)<>64 THEN RETURN true; END IF;
 PERFORM 1 FROM accounts WHERE id=b.account_id FOR UPDATE;
 IF (SELECT count(*) FROM guest_links WHERE booking_id=bid)>=10 THEN RETURN true; END IF;
 INSERT INTO guest_links(token_hash,booking_id) VALUES(h,bid);
 INSERT INTO booking_events(account_id,booking_id,kind,actor) VALUES(b.account_id,bid,'CLIENT_LINK_REISSUED','client');
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload) VALUES('link:'||h,b.client_email,'booking_link','client',jsonb_build_object('bookingId',bid));
 RETURN true;
END $$;

-- The web runtime may attach an encrypted link secret only to a message it just created
-- and only by proving knowledge of the secret's stored hash.
CREATE FUNCTION attach_notification_secret(k text,secret_hash text,cipher text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
BEGIN
 IF cipher IS NULL OR length(cipher) NOT BETWEEN 40 AND 400 OR secret_hash IS NULL OR length(secret_hash)<>64 THEN RAISE EXCEPTION 'Invalid notification secret'; END IF;
 UPDATE outbox o SET secret_cipher=cipher WHERE o.dedupe_key=k AND o.status='pending' AND o.attempts=0 AND o.secret_cipher IS NULL AND (
  (o.kind IN ('verify','reset') AND o.payload->>'tokenHash'=secret_hash AND EXISTS(SELECT 1 FROM email_tokens t WHERE t.token_hash=secret_hash AND t.used_at IS NULL))
  OR (o.kind='hold_created' AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=(o.payload->>'bookingId')::uuid AND b.guest_hash=secret_hash))
  OR (o.kind='booking_link' AND o.dedupe_key='link:'||secret_hash AND EXISTS(SELECT 1 FROM guest_links l WHERE l.token_hash=secret_hash)));
 RETURN FOUND;
END $$;

-- Reminders are idempotent by key: one per booking state/deadline or subscription term.
CREATE FUNCTION enqueue_due_reminders() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE n integer:=0; c integer; stamp timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload)
 SELECT 'remind:sign:'||b.id,b.client_email,'agreement_reminder','client',jsonb_build_object('bookingId',b.id)
 FROM bookings b WHERE b.status='AWAITING_SIGNATURE' AND b.created_at<=stamp-interval '12 hours' AND b.expires_at>stamp ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS c=ROW_COUNT; n:=n+c;
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload)
 SELECT 'remind:deposit:'||b.id||':'||floor(extract(epoch FROM b.expires_at))::bigint,b.client_email,'deposit_reminder','client',jsonb_build_object('bookingId',b.id)
 FROM bookings b WHERE b.status IN ('AWAITING_DEPOSIT','PROOF_REJECTED','PARTIAL_VERIFIED') AND b.expires_at>stamp AND b.expires_at<=stamp+interval '12 hours' ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS c=ROW_COUNT; n:=n+c;
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload)
 SELECT 'remind:verify:'||b.id||':'||floor(extract(epoch FROM b.expires_at))::bigint,u.email,'verification_reminder','dj',jsonb_build_object('bookingId',b.id)
 FROM bookings b JOIN accounts a ON a.id=b.account_id JOIN users u ON u.id=a.user_id
 WHERE b.status='VERIFICATION_PENDING' AND b.expires_at>stamp AND b.expires_at<=stamp+interval '12 hours' ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS c=ROW_COUNT; n:=n+c;
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload)
 SELECT 'remind:refund:'||d.id,u.email,'refund_due','dj',jsonb_build_object('bookingId',d.booking_id,'decisionId',d.id)
 FROM cancellation_decisions d JOIN accounts a ON a.id=d.account_id JOIN users u ON u.id=a.user_id
 WHERE d.decision='approved' AND d.refund_minor>0 AND d.due_at<=stamp+interval '2 days' AND d.due_at>stamp-interval '7 days'
 AND NOT EXISTS(SELECT 1 FROM refund_records r WHERE r.decision_id=d.id) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS c=ROW_COUNT; n:=n+c;
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload)
 SELECT 'remind:'||k.kind||':'||s.account_id||':'||floor(extract(epoch FROM s.ends_at))::bigint,u.email,k.kind,'dj',jsonb_build_object('accountId',s.account_id,'endsAt',s.ends_at)
 FROM subscriptions s JOIN accounts a ON a.id=s.account_id JOIN users u ON u.id=a.user_id
 CROSS JOIN LATERAL (SELECT CASE
  WHEN s.ends_at>stamp AND s.ends_at<=stamp+interval '7 days' AND NOT EXISTS(SELECT 1 FROM subscription_invoices i WHERE i.account_id=s.account_id AND i.state IN ('open','requires_resolution')) THEN 'renewal_due'
  WHEN s.ends_at<=stamp AND s.ends_at+interval '7 days'>stamp THEN 'renewal_overdue'
  WHEN s.ends_at+interval '7 days'<=stamp AND s.ends_at+interval '14 days'>stamp THEN 'pro_lapsed' END AS kind) k
 WHERE k.kind IS NOT NULL ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS c=ROW_COUNT; n:=n+c;
 RETURN n;
END $$;

-- Delivery functions for the separate notifier role. A claim leases rows; only the current
-- lease holder (matching attempt number) can record an outcome.
CREATE FUNCTION notifier_claim(batch integer,lease_seconds integer) RETURNS TABLE(id uuid,kind text,audience text,recipient text,payload jsonb,secret_cipher text,attempt integer,created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 UPDATE outbox o SET lease_until=clock_timestamp()+make_interval(secs=>least(greatest(lease_seconds,10),600)),attempts=o.attempts+1
 WHERE o.id IN (SELECT q.id FROM outbox q WHERE q.status='pending' AND q.next_attempt_at<=clock_timestamp() AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp())
  ORDER BY q.next_attempt_at LIMIT least(greatest(batch,1),100) FOR UPDATE SKIP LOCKED)
 RETURNING o.id,o.kind,o.audience,o.recipient,o.payload,o.secret_cipher,o.attempts,o.created_at
$$;
CREATE FUNCTION notifier_context(oid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE o outbox; r jsonb:='{}'; ev jsonb; bid uuid; aid uuid;
BEGIN
 SELECT * INTO o FROM outbox WHERE id=oid AND status='pending' AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN NULL; END IF;
 bid:=nullif(o.payload->>'bookingId','')::uuid; aid:=coalesce(o.account_id,nullif(o.payload->>'accountId','')::uuid);
 IF bid IS NOT NULL THEN
  r:=r||jsonb_build_object('booking',(SELECT jsonb_build_object('id',b.id,'status',b.status,'clientName',b.client_name,'venue',b.venue,'startsAt',b.starts_at,'endsAt',b.ends_at,
   'priceMinor',b.price_minor,'depositMinor',b.deposit_minor,'verifiedMinor',b.verified_minor,'expiresAt',b.expires_at,'originalExpiresAt',b.original_expires_at,'graceUsed',b.grace_used,
   'djName',a.stage_name,'djSlug',a.slug,'packageName',p.name) FROM bookings b JOIN accounts a ON a.id=b.account_id JOIN packages p ON p.id=b.package_id WHERE b.id=bid));
 END IF;
 IF o.payload ? 'eventId' THEN
  IF o.dedupe_key LIKE 'billing:%' THEN SELECT jsonb_build_object('kind',e.kind,'reason',e.reason,'details',e.details,'createdAt',e.created_at) INTO ev FROM billing_events e WHERE e.id=(o.payload->>'eventId')::bigint;
  ELSE SELECT jsonb_build_object('kind',e.kind,'actor',CASE WHEN e.actor IN ('client','system') THEN e.actor ELSE 'dj' END,'details',e.details,'createdAt',e.created_at) INTO ev FROM booking_events e WHERE e.id=(o.payload->>'eventId')::bigint AND e.booking_id=bid; END IF;
  r:=r||jsonb_build_object('event',ev);
 END IF;
 IF o.payload ? 'claimId' THEN
  r:=r||jsonb_build_object('claim',(SELECT jsonb_build_object('claimedMinor',c.claimed_minor,'onTime',c.on_time,'decision',v.decision,'amountMinor',v.amount_minor,'reason',v.reason)
   FROM claims c LEFT JOIN verifications v ON v.claim_id=c.id WHERE c.id=(o.payload->>'claimId')::uuid AND c.booking_id=bid));
 END IF;
 IF coalesce(o.payload->>'decisionId',ev->'details'->>'decisionId') IS NOT NULL THEN
  r:=r||jsonb_build_object('decision',(SELECT jsonb_build_object('initiatedBy',d.initiated_by,'decision',d.decision,'refundMinor',d.refund_minor,'verifiedMinor',d.verified_minor,'dueAt',d.due_at,'reason',d.reason,'refunded',EXISTS(SELECT 1 FROM refund_records x WHERE x.decision_id=d.id))
   FROM cancellation_decisions d WHERE d.id=coalesce(o.payload->>'decisionId',ev->'details'->>'decisionId')::uuid AND d.booking_id=bid));
 END IF;
 IF ev->'details'->>'amendmentId' IS NOT NULL THEN
  r:=r||jsonb_build_object('amendment',(SELECT jsonb_build_object('proposedBy',m.proposed_by,'oldStart',m.old_start,'newStart',m.new_start,'state',m.state,'expiresAt',m.expires_at)
   FROM amendments m WHERE m.id=(ev->'details'->>'amendmentId')::uuid AND m.booking_id=bid));
 END IF;
 IF nullif(o.payload->>'invoiceId','') IS NOT NULL THEN
  r:=r||jsonb_build_object('invoice',(SELECT jsonb_build_object('id',i.id,'number',i.number,'plan',i.plan,'amountMinor',i.amount_minor,'verifiedMinor',i.verified_minor,'dueAt',i.due_at,'state',i.state,'sellerName',i.seller_name,'renewalFor',i.renewal_for)
   FROM subscription_invoices i WHERE i.id=(o.payload->>'invoiceId')::uuid AND i.account_id=aid));
 END IF;
 IF o.audience='dj' AND aid IS NOT NULL THEN
  r:=r||jsonb_build_object('account',(SELECT jsonb_build_object('stageName',a.stage_name,'slug',a.slug,'plan',s.plan,'endsAt',s.ends_at,'graceEndsAt',s.ends_at+interval '7 days',
   'invoiceOpen',EXISTS(SELECT 1 FROM subscription_invoices i WHERE i.account_id=a.id AND i.state IN ('open','requires_resolution')))
   FROM accounts a LEFT JOIN subscriptions s ON s.account_id=a.id WHERE a.id=aid));
 END IF;
 RETURN r;
END $$;
CREATE FUNCTION notifier_finish(oid uuid,attempt_no integer,outcome text,provider_name text,message_id text,err text,retry_seconds integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE o outbox; final text;
BEGIN
 SELECT * INTO o FROM outbox WHERE id=oid FOR UPDATE;
 IF NOT FOUND OR o.status<>'pending' OR o.lease_until IS NULL OR o.attempts<>attempt_no THEN RETURN 'stale'; END IF;
 IF outcome NOT IN ('sent','retry','failed','skipped') THEN RAISE EXCEPTION 'Invalid delivery outcome'; END IF;
 final:=CASE WHEN outcome='sent' THEN 'sent' WHEN outcome='skipped' THEN 'suppressed' WHEN outcome='failed' OR o.attempts>=8 THEN 'failed' ELSE 'pending' END;
 INSERT INTO notification_attempts(outbox_id,attempt,outcome,provider,provider_message_id,error)
 VALUES(oid,attempt_no,CASE WHEN outcome='retry' AND final='failed' THEN 'failed' ELSE outcome END,provider_name,message_id,left(err,1000));
 UPDATE outbox SET status=final,lease_until=NULL,last_error=left(err,1000),provider=provider_name,
  provider_message_id=coalesce(message_id,provider_message_id),
  delivered_at=CASE WHEN final='sent' THEN clock_timestamp() ELSE delivered_at END,
  next_attempt_at=CASE WHEN final='pending' THEN clock_timestamp()+make_interval(secs=>least(greatest(coalesce(retry_seconds,60),5),86400)) ELSE next_attempt_at END,
  secret_cipher=CASE WHEN final='pending' THEN secret_cipher ELSE NULL END
 WHERE id=oid;
 RETURN final;
END $$;

DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lockd_notifier') THEN CREATE ROLE lockd_notifier LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
REVOKE ALL ON FUNCTION outbox_classify(),outbox_wake(),booking_event_notifications(),enqueue_due_reminders(),notifier_claim(integer,integer),notifier_context(uuid),notifier_finish(uuid,integer,text,text,text,text,integer) FROM PUBLIC,lockd_runtime;
-- 001's per-schema default-privilege REVOKE has no effect in PostgreSQL (per-schema defaults can
-- only add), so later functions were PUBLIC-executable. Pin the runtime's current function set
-- explicitly, then remove PUBLIC execution so a second schema user gets only its own grants.
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='lockd' AND p.prokind='f' AND has_function_privilege('lockd_runtime',p.oid,'EXECUTE') LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lockd_runtime',f);
 END LOOP;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lockd FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA lockd TO lockd_notifier;
GRANT EXECUTE ON FUNCTION enqueue_due_reminders(),notifier_claim(integer,integer),notifier_context(uuid),notifier_finish(uuid,integer,text,text,text,text,integer) TO lockd_notifier;
COMMIT;
