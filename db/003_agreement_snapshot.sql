BEGIN;
ALTER TABLE lockd.agreements ADD COLUMN payment_instructions text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX verified_reference_canonical ON lockd.verifications(account_id,lower(btrim(bank_reference))) WHERE bank_reference IS NOT NULL;
CREATE OR REPLACE FUNCTION lockd.create_hold(d jsonb,g text,h text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp SET timezone='UTC' AS $$
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
 body:=a.agreement_template||E'\n\nBooking details (immutable version 1)\nDJ: '||a.stage_name||E'\nService: '||p.name||E'\nClient: '||(d->>'clientName')||E'\nVenue: '||(d->>'venue')||E'\nStarts (UTC): '||st::text||E'\nEnds (UTC): '||en::text||E'\nTotal JMD: '||to_char(p.price_minor/100.0,'FM999999990.00')||E'\nDeposit JMD: '||to_char(p.deposit_minor/100.0,'FM999999990.00')||E'\nPay the DJ directly. A receipt submission is not confirmation. Confirmation requires DJ verification of actual funds received.\nDirect payment instructions: '||a.deposit_instructions;
 INSERT INTO agreements(booking_id,account_id,body,content_hash,payment_instructions) VALUES(bid,a.id,body,encode(public.digest(body,'sha256'),'hex'),a.deposit_instructions);
 INSERT INTO booking_events(account_id,booking_id,kind,actor) VALUES(a.id,bid,'HOLD_CREATED','client');
 RETURN bid;
END $$;

COMMIT;
