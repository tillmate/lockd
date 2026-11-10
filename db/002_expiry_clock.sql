BEGIN;
-- Use wall-clock time after the account lock: a request queued before expiry must
-- not receive grace merely because its transaction began before the deadline.
CREATE OR REPLACE FUNCTION lockd.expire_account(a uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; n integer:=0;
BEGIN
 PERFORM 1 FROM accounts WHERE id=a FOR UPDATE;
 FOR b IN SELECT * FROM bookings WHERE account_id=a AND status IN ('AWAITING_SIGNATURE','AWAITING_DEPOSIT','VERIFICATION_PENDING','PROOF_REJECTED','PARTIAL_VERIFIED') AND expires_at<=clock_timestamp() FOR UPDATE LOOP
  UPDATE bookings SET status='HOLD_EXPIRED' WHERE id=b.id;
  DELETE FROM occupied_slots WHERE booking_id=b.id;
  INSERT INTO booking_events(account_id,booking_id,kind,actor) VALUES(a,b.id,'HOLD_EXPIRED','system');
  INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('expired:'||b.id,b.client_email,'hold_expired',jsonb_build_object('bookingId',b.id)) ON CONFLICT DO NOTHING;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
CREATE OR REPLACE FUNCTION lockd.submit_proof(bid uuid,r text,amount integer,img bytea,ih text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; c claims; cid uuid; timely boolean; accepted_at timestamptz;
BEGIN
 IF NOT guest_can(bid) THEN RAISE EXCEPTION 'Private booking access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM bookings WHERE id=bid;
 PERFORM expire_account(b.account_id);
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 accepted_at:=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM signatures WHERE booking_id=bid) THEN RAISE EXCEPTION 'Sign the agreement first'; END IF;
 SELECT * INTO c FROM claims WHERE account_id=b.account_id AND image_hash=ih;
 IF FOUND THEN
  IF c.booking_id=bid AND c.reference=r AND c.claimed_minor=amount THEN RETURN c.id; END IF;
  RAISE EXCEPTION 'Duplicate evidence: this image is already associated with a claim';
 END IF;
 IF b.status IN ('CONFIRMED_LOCKD','COMPLETED','CANCELLED') THEN RAISE EXCEPTION 'Booking no longer accepts proof'; END IF;
 IF (SELECT count(*) FROM claims WHERE booking_id=bid)>=10 THEN RAISE EXCEPTION 'Evidence limit reached; contact the DJ'; END IF;
 timely:=accepted_at<b.original_expires_at;
 INSERT INTO claims(booking_id,account_id,reference,claimed_minor,on_time,image_hash,image,mime,received_at) VALUES(bid,b.account_id,r,amount,timely,ih,img,'image/png',accepted_at) RETURNING id INTO cid;
 IF timely AND NOT b.grace_used THEN UPDATE bookings SET grace_used=true,expires_at=original_expires_at+interval '24 hours' WHERE id=bid; END IF;
 IF b.status<>'HOLD_EXPIRED' THEN UPDATE bookings SET status='VERIFICATION_PENDING' WHERE id=bid; END IF;
 INSERT INTO booking_events(account_id,booking_id,kind,actor,details) VALUES(b.account_id,bid,'PROOF_SUBMITTED','client',jsonb_build_object('claimId',cid,'onTime',timely));
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) SELECT 'proof:'||cid,u.email,'proof_submitted',jsonb_build_object('bookingId',bid,'claimId',cid) FROM users u JOIN accounts a ON a.user_id=u.id WHERE a.id=b.account_id;
 RETURN cid;
END $$;
COMMIT;
