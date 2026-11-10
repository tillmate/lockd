BEGIN;
CREATE OR REPLACE FUNCTION lockd.approve_founding(aid uuid,r text,attest boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
BEGIN
 IF NOT billing_staff() OR owns(aid) THEN RAISE EXCEPTION 'Independent billing staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=aid FOR UPDATE;
 IF NOT FOUND OR attest IS DISTINCT FROM true THEN RAISE EXCEPTION 'Attest review of Jamaican DJ eligibility'; END IF;
 IF NOT billing_staff() THEN RAISE EXCEPTION 'MFA expired while waiting; authenticate again' USING ERRCODE='42501'; END IF;
 INSERT INTO founding_approvals(account_id,actor_id,reason) VALUES(aid,actor_id(),r) ON CONFLICT DO NOTHING;
 IF FOUND THEN PERFORM billing_event(aid,NULL,'FOUNDING_APPROVED',r); END IF;
END $$;
CREATE OR REPLACE FUNCTION lockd.staff_step_up(counter_value bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE m billing_staff_members;
BEGIN
 SELECT * INTO m FROM billing_staff_members WHERE user_id=actor_id() AND enabled FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Billing staff access required' USING ERRCODE='42501'; END IF;
 IF counter_value IS NULL OR counter_value<=m.last_counter OR abs(counter_value-floor(extract(epoch FROM clock_timestamp())/30)::bigint)>1 THEN RAISE EXCEPTION 'Authenticator code expired or already used'; END IF;
 UPDATE billing_staff_members SET last_counter=counter_value WHERE user_id=m.user_id;
 INSERT INTO billing_staff_sessions VALUES(current_setting('lockd.session_hash'),m.user_id,clock_timestamp()+interval '10 minutes') ON CONFLICT(session_hash) DO UPDATE SET expires_at=excluded.expires_at;
 INSERT INTO billing_events(actor_id,kind,reason) VALUES(m.user_id,'STAFF_MFA_VERIFIED','Billing scope unlocked for ten minutes after one-time authenticator verification');
END $$;
COMMIT;
