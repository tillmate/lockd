BEGIN;
SET search_path=lockd,public;
-- Fixes from the post-release review of 010/011. Applied migrations are never edited.

-- 1. outbox.account_id is informational. Its foreign key made every outbox insert take a KEY SHARE
--    lock on the DJ account, so the multi-account reminder job could deadlock with expire_all().
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='lockd.outbox'::regclass AND contype='f'
  AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='lockd.outbox'::regclass AND attname='account_id')];
 IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE lockd.outbox DROP CONSTRAINT %I',c); END IF;
END $$;

-- 2. Verification messages are classified by the DJ's decision, not the resulting booking status:
--    a rejection on an expired hold or after a partial verification is a rejection, never "payment
--    recorded" or "part of your deposit was verified". The decision is snapshotted in the payload.
CREATE OR REPLACE FUNCTION outbox_classify() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE d text;
BEGIN
 NEW.recipient:=lower(trim(NEW.recipient));
 IF NEW.dedupe_key LIKE 'verification:%' THEN
  IF NOT NEW.payload ? 'claimId' THEN NEW.payload:=NEW.payload||jsonb_build_object('claimId',substr(NEW.dedupe_key,14)); END IF;
  SELECT v.decision INTO d FROM verifications v WHERE v.claim_id=(NEW.payload->>'claimId')::uuid;
  NEW.payload:=NEW.payload||jsonb_build_object('decision',d);
  IF d='rejected' THEN NEW.kind:='proof_rejected';
  ELSIF NEW.kind='hold_expired' THEN NEW.kind:='late_payment_recorded'; END IF;
 END IF;
 -- Invoice totals as of the billing event, so a later reconciliation cannot change an earlier notice.
 IF NEW.dedupe_key LIKE 'billing:%' AND nullif(NEW.payload->>'invoiceId','') IS NOT NULL THEN
  NEW.payload:=NEW.payload||coalesce((SELECT jsonb_build_object('invoiceVerifiedMinor',i.verified_minor,'invoiceState',i.state)
   FROM subscription_invoices i WHERE i.id=(NEW.payload->>'invoiceId')::uuid),'{}'::jsonb);
 END IF;
 NEW.audience:=coalesce(NEW.audience,CASE WHEN NEW.kind IN ('verify','reset') THEN 'user'
  WHEN NEW.dedupe_key LIKE 'proof:%' OR NEW.dedupe_key LIKE 'billing:%' OR NEW.dedupe_key LIKE '%:dj' THEN 'dj' ELSE 'client' END);
 NEW.account_id:=coalesce(NEW.account_id,nullif(NEW.payload->>'accountId','')::uuid,
  (SELECT account_id FROM bookings WHERE id=nullif(NEW.payload->>'bookingId','')::uuid));
 RETURN NEW;
END $$;

-- 3. Leases are renewed per message when the worker starts on it, so a slow batch never silently
--    skips rows. `attempts` is now only the lease generation; the 8-attempt budget counts recorded
--    delivery attempts, so claims lost to a crash or shutdown never consume it.
DROP FUNCTION notifier_context(uuid);
-- UTC like the runtime, so date arithmetic (grace ends) matches pro_access exactly. The service
-- name comes from the signed agreement, not the editable package row.
CREATE FUNCTION notifier_context(oid uuid,attempt_no integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp SET timezone='UTC' AS $$
DECLARE o outbox; r jsonb:='{}'; ev jsonb; bid uuid; aid uuid;
BEGIN
 UPDATE outbox SET lease_until=clock_timestamp()+interval '120 seconds'
 WHERE id=oid AND status='pending' AND attempts=attempt_no AND lease_until IS NOT NULL RETURNING * INTO o;
 IF NOT FOUND THEN RETURN NULL; END IF;
 bid:=nullif(o.payload->>'bookingId','')::uuid; aid:=coalesce(o.account_id,nullif(o.payload->>'accountId','')::uuid);
 IF bid IS NOT NULL THEN
  r:=r||jsonb_build_object('booking',(SELECT jsonb_build_object('id',b.id,'status',b.status,'clientName',b.client_name,'venue',b.venue,'startsAt',b.starts_at,'endsAt',b.ends_at,
   'priceMinor',b.price_minor,'depositMinor',b.deposit_minor,'verifiedMinor',b.verified_minor,'expiresAt',b.expires_at,'originalExpiresAt',b.original_expires_at,'graceUsed',b.grace_used,
   'djName',a.stage_name,'djSlug',a.slug,
   'packageName',coalesce((SELECT substring(g.body FROM E'\nService: ([^\n]*)') FROM agreements g WHERE g.booking_id=b.id ORDER BY g.version LIMIT 1),p.name))
   FROM bookings b JOIN accounts a ON a.id=b.account_id JOIN packages p ON p.id=b.package_id WHERE b.id=bid));
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
  r:=r||jsonb_build_object('account',(SELECT jsonb_build_object('stageName',a.stage_name,'slug',a.slug,'published',a.published,'plan',s.plan,'endsAt',s.ends_at,'graceEndsAt',s.ends_at+interval '7 days',
   'invoiceOpen',EXISTS(SELECT 1 FROM subscription_invoices i WHERE i.account_id=a.id AND i.state IN ('open','requires_resolution')))
   FROM accounts a LEFT JOIN subscriptions s ON s.account_id=a.id WHERE a.id=aid));
 END IF;
 RETURN r;
END $$;
CREATE OR REPLACE FUNCTION notifier_finish(oid uuid,attempt_no integer,outcome text,provider_name text,message_id text,err text,retry_seconds integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE o outbox; final text; recorded integer;
BEGIN
 SELECT * INTO o FROM outbox WHERE id=oid FOR UPDATE;
 IF NOT FOUND OR o.status<>'pending' OR o.lease_until IS NULL OR o.attempts<>attempt_no THEN RETURN 'stale'; END IF;
 IF outcome NOT IN ('sent','retry','failed','skipped') THEN RAISE EXCEPTION 'Invalid delivery outcome'; END IF;
 SELECT count(*) INTO recorded FROM notification_attempts WHERE outbox_id=oid;
 final:=CASE WHEN outcome='sent' THEN 'sent' WHEN outcome='skipped' THEN 'suppressed' WHEN outcome='failed' OR recorded+1>=8 THEN 'failed' ELSE 'pending' END;
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
-- Hands a claimed but unstarted message back on graceful shutdown; no attempt is recorded.
CREATE FUNCTION notifier_release(oid uuid,attempt_no integer) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 UPDATE outbox SET lease_until=NULL WHERE id=oid AND status='pending' AND attempts=attempt_no
$$;

-- 4. Link recovery: the cap counts only links whose email is pending or was sent in the last 30
--    days, so failed deliveries never end recovery; a NULL address can never match.
CREATE OR REPLACE FUNCTION request_guest_link(bid uuid,e text,h text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR e IS NULL OR b.client_email IS DISTINCT FROM lower(trim(e)) OR b.guest_expires_at<=clock_timestamp() OR h IS NULL OR length(h)<>64 THEN RETURN true; END IF;
 PERFORM 1 FROM accounts WHERE id=b.account_id FOR UPDATE;
 IF (SELECT count(*) FROM guest_links l JOIN outbox o ON o.dedupe_key='link:'||l.token_hash
     WHERE l.booking_id=bid AND o.status IN ('pending','sent') AND l.created_at>clock_timestamp()-interval '30 days')>=10 THEN RETURN true; END IF;
 INSERT INTO guest_links(token_hash,booking_id) VALUES(h,bid);
 INSERT INTO booking_events(account_id,booking_id,kind,actor) VALUES(b.account_id,bid,'CLIENT_LINK_REISSUED','client');
 INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload) VALUES('link:'||h,b.client_email,'booking_link','client',jsonb_build_object('bookingId',bid));
 RETURN true;
END $$;

-- 5. Billing becomes an explicit, revocable scope. A fresh MFA step-up alone no longer carries
--    subscription reconciliation, founding approval or receipt access. Existing billing staff keep it.
ALTER TABLE staff_scopes DROP CONSTRAINT staff_scopes_scope_check;
ALTER TABLE staff_scopes ADD CONSTRAINT staff_scopes_scope_check CHECK(scope IN ('billing','listings','support','notifications','admin'));
INSERT INTO staff_scopes(user_id,scope,reason)
 SELECT user_id,'billing','Existing billing staff kept billing authority when billing became a separate scope' FROM billing_staff_members
 ON CONFLICT DO NOTHING;
CREATE FUNCTION staff_fresh() RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM billing_staff_sessions s JOIN billing_staff_members m ON m.user_id=s.user_id WHERE m.enabled AND s.session_hash=current_setting('lockd.session_hash',true) AND s.user_id=actor_id() AND s.expires_at>clock_timestamp())
$$;
-- billing_staff() keeps its name because RLS policies and billing functions call it.
CREATE OR REPLACE FUNCTION billing_staff() RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT staff_fresh() AND EXISTS(SELECT 1 FROM staff_scopes WHERE user_id=actor_id() AND scope='billing')
$$;
-- Admin implies the operational scopes, not billing.
CREATE OR REPLACE FUNCTION staff_can(s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT staff_fresh() AND EXISTS(SELECT 1 FROM staff_scopes WHERE user_id=actor_id() AND (scope=s OR (scope='admin' AND s<>'billing')))
$$;

-- 6. Scope changes are serialized and re-authorized after the lock, so two admins cannot revoke each
--    other into zero admins, and a revoked admin's in-flight grant fails. Revocation works for
--    disabled members so dormant scopes can be cleaned up. Audit rows name the scope in details.
CREATE OR REPLACE FUNCTION set_staff_scope(target uuid,s text,grant_it boolean,n text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
BEGIN
 IF NOT staff_can('admin') THEN RAISE EXCEPTION 'Super Admin with fresh MFA required' USING ERRCODE='42501'; END IF;
 IF target=actor_id() THEN RAISE EXCEPTION 'Staff cannot change their own scopes' USING ERRCODE='42501'; END IF;
 IF s NOT IN ('billing','listings','support','notifications','admin') THEN RAISE EXCEPTION 'Unknown scope'; END IF;
 PERFORM pg_advisory_xact_lock(717245);
 IF NOT staff_can('admin') THEN RAISE EXCEPTION 'Super Admin authority changed while waiting; authenticate again' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM billing_staff_members WHERE user_id=target AND (enabled OR NOT grant_it) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Target must be an enabled, MFA-enrolled staff member'; END IF;
 IF grant_it THEN
  INSERT INTO staff_scopes(user_id,scope,granted_by,reason) VALUES(target,s,actor_id(),trim(n)) ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM staff_scopes WHERE user_id=target AND scope=s;
 END IF;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM staff_event('admin',CASE WHEN grant_it THEN 'SCOPE_GRANTED' ELSE 'SCOPE_REVOKED' END,NULL,target::text,CASE WHEN grant_it THEN 'scope_grant' ELSE 'scope_revoke' END,n,jsonb_build_object('scope',s));
END $$;

-- 7. Requeue re-checks authority after its lock waits and no longer forges the attempt counter:
--    a requeued message gets at least one more recorded attempt under the shared 8-attempt budget.
CREATE OR REPLACE FUNCTION requeue_notification(oid uuid,code text,n text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE o outbox;
BEGIN
 IF NOT staff_can('notifications') THEN RAISE EXCEPTION 'Notifications staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 IF code NOT IN ('provider_outage','configuration_fixed','recipient_corrected','other') THEN RAISE EXCEPTION 'Choose a requeue reason'; END IF;
 SELECT * INTO o FROM outbox WHERE id=oid FOR UPDATE;
 IF NOT FOUND OR o.status<>'failed' THEN RAISE EXCEPTION 'Only failed messages can be requeued'; END IF;
 IF o.kind IN ('verify','reset','booking_link') THEN RAISE EXCEPTION 'Link emails cannot be resent; ask the person to request a new link'; END IF;
 IF o.account_id IS NOT NULL AND owns(o.account_id) THEN RAISE EXCEPTION 'Staff cannot requeue their own account messages' USING ERRCODE='42501'; END IF;
 PERFORM staff_event('notifications','NOTIFICATION_REQUEUED',o.account_id,oid::text,code,n,jsonb_build_object('kind',o.kind,'attempts',o.attempts,'lastError',o.last_error));
 IF NOT staff_can('notifications') THEN RAISE EXCEPTION 'MFA expired while waiting; authenticate again' USING ERRCODE='42501'; END IF;
 UPDATE outbox SET status='pending',next_attempt_at=clock_timestamp(),lease_until=NULL WHERE id=oid;
END $$;

-- 8. The audit trail names who or what each action affected, and shows only staff billing actions
--    (not a staff member's own DJ self-service billing).
DROP FUNCTION staff_audit(integer);
CREATE FUNCTION staff_audit(lim integer) RETURNS TABLE(at timestamptz,actor text,scope text,kind text,subject text,stage_name text,reason_code text,note text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT staff_can('admin') THEN RAISE EXCEPTION 'Super Admin with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT * FROM (
  SELECT e.created_at,u.email,e.scope,e.kind,
   CASE WHEN e.kind IN ('SCOPE_GRANTED','SCOPE_REVOKED','LOCAL_SCOPE_PROVISIONED')
     THEN coalesce((SELECT t.email FROM users t WHERE t.id::text=e.subject_id),e.subject_id)||' · '||coalesce(e.details->>'scope',e.reason_code)
    WHEN e.kind='NOTIFICATION_REQUEUED' THEN coalesce(e.details->>'kind','message')||' '||left(e.subject_id,8)
    WHEN e.kind LIKE 'LISTING_%' THEN 'listing review #'||e.subject_id
    ELSE e.subject_id END,
   a.stage_name,e.reason_code,e.note
  FROM staff_events e JOIN users u ON u.id=e.actor_id LEFT JOIN accounts a ON a.id=e.account_id
  UNION ALL
  SELECT e.created_at,u.email,'billing',e.kind,CASE WHEN i.number IS NOT NULL THEN 'invoice LKD-SUB-'||i.number END,a.stage_name,NULL,e.reason
  FROM billing_events e JOIN billing_staff_members m ON m.user_id=e.actor_id JOIN users u ON u.id=e.actor_id
  LEFT JOIN accounts a ON a.id=e.account_id LEFT JOIN subscription_invoices i ON i.id=e.invoice_id
  WHERE e.kind IN ('STAFF_MFA_VERIFIED','FOUNDING_APPROVED','SUBSCRIPTION_ACTIVATED','SUBSCRIPTION_RECONCILED','PAID_REQUIRES_RESOLUTION','LOCAL_BILLING_STAFF_PROVISIONED')
 ) x ORDER BY 1 DESC LIMIT least(greatest(lim,1),500);
END $$;

-- 9. Invoice notices also reach the billing email the DJ entered on the invoice, when different.
CREATE OR REPLACE FUNCTION billing_event(a uuid,i uuid,k text,r text,d jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE eid bigint; owner_email text; bill_to text;
BEGIN
 INSERT INTO billing_events(account_id,invoice_id,actor_id,kind,reason,details) VALUES(a,i,actor_id(),k,r,d) RETURNING id INTO eid;
 SELECT u.email INTO owner_email FROM accounts ac JOIN users u ON u.id=ac.user_id WHERE ac.id=a;
 IF owner_email IS NULL THEN RETURN; END IF;
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('billing:'||eid,owner_email,k,jsonb_build_object('invoiceId',i,'accountId',a,'eventId',eid));
 SELECT billing_email INTO bill_to FROM subscription_invoices WHERE id=i;
 IF bill_to IS NOT NULL AND lower(bill_to)<>lower(owner_email) THEN
  INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('billing:'||eid||':billing',bill_to,k,jsonb_build_object('invoiceId',i,'accountId',a,'eventId',eid));
 END IF;
END $$;
ALTER FUNCTION enqueue_due_reminders() SET timezone='UTC';

-- 10. The worker runs hold expiry under its own role, so the worker host needs no web-runtime
--    credentials (which can create sessions).
REVOKE ALL ON FUNCTION notifier_context(uuid,integer),notifier_release(uuid,integer),staff_fresh(),staff_audit(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifier_context(uuid,integer),notifier_release(uuid,integer),expire_all() TO lockd_notifier;
GRANT EXECUTE ON FUNCTION staff_fresh(),staff_audit(integer) TO lockd_runtime;
COMMIT;
