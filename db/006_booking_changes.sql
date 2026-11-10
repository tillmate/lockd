BEGIN;
SET search_path=lockd,public;
ALTER TABLE accounts ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
CREATE TABLE account_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts,
 actor_id uuid NOT NULL REFERENCES users, revision integer NOT NULL, snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(account_id,revision)
);
CREATE TRIGGER account_changes_immutable BEFORE UPDATE OR DELETE ON account_changes FOR EACH ROW EXECUTE FUNCTION immutable();
ALTER TABLE account_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_changes_owner ON account_changes FOR SELECT USING(owns(account_id));
GRANT SELECT ON account_changes TO lockd_runtime;

CREATE FUNCTION update_profile(d jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE a accounts;
BEGIN
 SELECT * INTO a FROM accounts WHERE user_id=actor_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 IF (d->>'revision')::integer IS DISTINCT FROM a.revision THEN RAISE EXCEPTION 'Profile changed. Reload before saving'; END IF;
 IF d->>'slug' IS DISTINCT FROM a.slug THEN RAISE EXCEPTION 'Shared booking address cannot be changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM packages WHERE id=(d->>'packageId')::uuid AND account_id=a.id) THEN RAISE EXCEPTION 'Package access required' USING ERRCODE='42501'; END IF;
 IF length(d->>'bio') NOT BETWEEN 10 AND 1500 OR length(d->>'description') NOT BETWEEN 10 AND 500
 OR d->>'parish' NOT IN ('Kingston','St. Andrew','St. Thomas','Portland','St. Mary','St. Ann','Trelawny','St. James','Hanover','Westmoreland','St. Elizabeth','Manchester','Clarendon','St. Catherine') THEN RAISE EXCEPTION 'Invalid profile'; END IF;
 INSERT INTO account_changes(account_id,actor_id,revision,snapshot)
 VALUES(a.id,actor_id(),a.revision,jsonb_build_object('account',to_jsonb(a),'packages',(SELECT jsonb_agg(p) FROM packages p WHERE account_id=a.id)));
 UPDATE accounts SET stage_name=d->>'stageName',parish=d->>'parish',bio=d->>'bio',deposit_instructions=d->>'depositInstructions',agreement_template=d->>'agreement',published=(d->>'published')::boolean,revision=revision+1 WHERE id=a.id;
 UPDATE packages SET name=d->>'packageName',description=d->>'description',price_minor=(d->>'priceMinor')::integer,deposit_minor=(d->>'depositMinor')::integer,duration_minutes=(d->>'durationMinutes')::integer,buffer_before=(d->>'bufferBefore')::integer,buffer_after=(d->>'bufferAfter')::integer WHERE id=(d->>'packageId')::uuid AND account_id=a.id;
END $$;

ALTER TABLE agreements DROP CONSTRAINT agreements_booking_id_key;
ALTER TABLE agreements ADD UNIQUE(booking_id,version);
ALTER TABLE agreements ADD UNIQUE(id,booking_id,account_id);
ALTER TABLE signatures DROP CONSTRAINT signatures_booking_id_key;
ALTER TABLE signatures ADD FOREIGN KEY(agreement_id,booking_id,account_id) REFERENCES agreements(id,booking_id,account_id);
ALTER TABLE bookings ADD COLUMN agreement_version integer NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN reschedules_used integer NOT NULL DEFAULT 0 CHECK(reschedules_used BETWEEN 0 AND 1);
ALTER TABLE bookings ADD FOREIGN KEY(id,agreement_version) REFERENCES agreements(booking_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE amendments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL, account_id uuid NOT NULL,
 agreement_id uuid NOT NULL UNIQUE, proposed_by text NOT NULL CHECK(proposed_by IN ('client','dj')),
 old_start timestamptz NOT NULL, new_start timestamptz NOT NULL, new_end timestamptz NOT NULL CHECK(new_end>new_start),
 reserved_range tstzrange NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','declined','withdrawn','expired','cancelled')),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 UNIQUE(id,booking_id,account_id), FOREIGN KEY(agreement_id,booking_id,account_id) REFERENCES agreements(id,booking_id,account_id),
 CHECK(expires_at=created_at+interval '48 hours'), CHECK(new_start<>old_start)
);
CREATE UNIQUE INDEX one_pending_amendment ON amendments(booking_id) WHERE state='pending';
CREATE FUNCTION amendment_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=lockd,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable proposal'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'pending' OR NEW.state='pending' THEN RAISE EXCEPTION 'Immutable proposal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER amendments_history BEFORE UPDATE OR DELETE ON amendments FOR EACH ROW EXECUTE FUNCTION amendment_history_guard();
CREATE TABLE amendment_acceptances (
 amendment_id uuid NOT NULL, booking_id uuid NOT NULL, account_id uuid NOT NULL,
 party text NOT NULL CHECK(party IN ('client','dj')), signer text NOT NULL CHECK(length(signer) BETWEEN 2 AND 120),
 content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(amendment_id,party), FOREIGN KEY(amendment_id,booking_id,account_id) REFERENCES amendments(id,booking_id,account_id)
);
CREATE TRIGGER amendment_acceptances_immutable BEFORE UPDATE OR DELETE ON amendment_acceptances FOR EACH ROW EXECUTE FUNCTION immutable();

-- Narrow helper, intentionally not executable by the runtime: all callers authenticate first.
CREATE FUNCTION change_event(b bookings,k text,who text,details jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE eid bigint;
BEGIN
 INSERT INTO booking_events(account_id,booking_id,kind,actor,details) VALUES(b.account_id,b.id,k,who,details) RETURNING id INTO eid;
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('change:'||eid||':client',b.client_email,k,jsonb_build_object('bookingId',b.id,'eventId',eid));
 INSERT INTO outbox(dedupe_key,recipient,kind,payload) SELECT 'change:'||eid||':dj',u.email,k,jsonb_build_object('bookingId',b.id,'eventId',eid) FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=b.account_id;
END $$;

CREATE FUNCTION propose_amendment(bid uuid,party text,st timestamptz,r text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp SET timezone='UTC' AS $$
DECLARE b bookings; prev agreements; aid uuid; mid uuid; en timestamptz; oldslot tstzrange; newslot tstzrange; body text; stamp timestamptz; ver integer;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR party IS NULL OR NOT ((party='dj' AND owns(b.account_id)) OR (party='client' AND guest_can(bid))) THEN RAISE EXCEPTION 'Booking access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=b.account_id FOR UPDATE;
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 stamp:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM cancellation_requests q WHERE q.booking_id=bid AND NOT EXISTS(SELECT 1 FROM cancellation_decisions d WHERE d.request_id=q.id)) THEN RAISE EXCEPTION 'Resolve the cancellation request first'; END IF;
 IF b.status<>'CONFIRMED_LOCKD' OR b.reschedules_used<>0 OR b.starts_at<stamp+interval '14 days' THEN RAISE EXCEPTION 'One complimentary date change requires a confirmed booking and at least 14 days notice'; END IF;
 IF st IS NULL OR st<=stamp+interval '72 hours' OR st>b.starts_at+interval '90 days' OR st<b.starts_at-interval '90 days' OR st=b.starts_at OR length(r) NOT BETWEEN 3 AND 1000 OR r IS NULL THEN RAISE EXCEPTION 'Choose a different date within 90 days of the original event, more than 72 hours away'; END IF;
 UPDATE amendments SET state='expired' WHERE booking_id=bid AND state='pending' AND expires_at<=stamp;
 IF EXISTS(SELECT 1 FROM amendments WHERE booking_id=bid AND state='pending') THEN RAISE EXCEPTION 'Resolve the pending date change first'; END IF;
 SELECT slot INTO oldslot FROM occupied_slots WHERE booking_id=bid;
 IF oldslot IS NULL THEN RAISE EXCEPTION 'Original reservation is missing'; END IF;
 en:=st+(b.ends_at-b.starts_at);
 newslot:=tstzrange(st-(b.starts_at-lower(oldslot)),en+(upper(oldslot)-b.ends_at),'[)');
 PERFORM expire_account(b.account_id);
 IF EXISTS(SELECT 1 FROM occupied_slots WHERE account_id=b.account_id AND booking_id IS DISTINCT FROM bid AND slot && newslot) THEN RAISE EXCEPTION 'Proposed time is unavailable, including travel buffers'; END IF;
 SELECT * INTO prev FROM agreements WHERE booking_id=bid AND version=b.agreement_version;
 SELECT max(version)+1 INTO ver FROM agreements WHERE booking_id=bid;
 body:='DATE AMENDMENT — effective only after both client and DJ accept this exact version.'||E'\nNew starts (UTC): '||st::text||E'\nNew ends (UTC): '||en::text||E'\nNo additional fee. Venue, service, payment and all other signed terms remain unchanged. The dates above supersede only the dates in the prior agreement below.'||E'\nPrior signed version: '||prev.version||E'\nPrior SHA-256: '||prev.content_hash||E'\n\nPRESERVED PRIOR AGREEMENT\n'||prev.body;
 INSERT INTO agreements(booking_id,account_id,version,body,content_hash,payment_instructions) VALUES(bid,b.account_id,ver,body,encode(public.digest(body,'sha256'),'hex'),prev.payment_instructions) RETURNING id INTO aid;
 INSERT INTO amendments(booking_id,account_id,agreement_id,proposed_by,old_start,new_start,new_end,reserved_range,reason,created_at,expires_at) VALUES(bid,b.account_id,aid,party,b.starts_at,st,en,newslot,r,stamp,stamp+interval '48 hours') RETURNING id INTO mid;
 PERFORM change_event(b,'DATE_CHANGE_PROPOSED',CASE WHEN party='dj' THEN actor_id()::text ELSE 'client' END,jsonb_build_object('amendmentId',mid,'version',ver));
 RETURN mid;
END $$;

CREATE FUNCTION respond_amendment(bid uuid,mid uuid,party text,action text,h text,signer_name text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; m amendments; a agreements; previous amendment_acceptances;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR party IS NULL OR NOT ((party='dj' AND owns(b.account_id)) OR (party='client' AND guest_can(bid))) THEN RAISE EXCEPTION 'Booking access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=b.account_id FOR UPDATE;
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 SELECT * INTO m FROM amendments WHERE id=mid AND booking_id=bid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Date change not found'; END IF;
 SELECT * INTO a FROM agreements WHERE id=m.agreement_id;
 IF action='accept' THEN
  IF h IS DISTINCT FROM a.content_hash OR signer_name IS NULL OR length(trim(signer_name)) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'Accept the exact agreement with your full name'; END IF;
  SELECT * INTO previous FROM amendment_acceptances WHERE amendment_id=mid AND amendment_acceptances.party=respond_amendment.party;
  IF FOUND THEN
   IF previous.signer<>trim(signer_name) OR previous.content_hash<>h THEN RAISE EXCEPTION 'Signature already recorded differently'; END IF;
   IF m.state IN ('pending','applied') THEN RETURN; END IF;
  END IF;
 END IF;
 IF m.state<>'pending' OR m.expires_at<=clock_timestamp() OR b.status<>'CONFIRMED_LOCKD' OR b.starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'Date change is no longer pending; original reservation is unchanged'; END IF;
 IF action IN ('decline','withdraw') THEN
  IF action='withdraw' AND m.proposed_by<>party THEN RAISE EXCEPTION 'Only the proposer can withdraw'; END IF;
  UPDATE amendments SET state=CASE action WHEN 'decline' THEN 'declined' ELSE 'withdrawn' END WHERE id=mid;
 ELSIF action='accept' THEN
  IF EXISTS(SELECT 1 FROM cancellation_requests q WHERE q.booking_id=bid AND NOT EXISTS(SELECT 1 FROM cancellation_decisions d WHERE d.request_id=q.id)) THEN RAISE EXCEPTION 'Resolve the cancellation request first'; END IF;
  INSERT INTO amendment_acceptances(amendment_id,booking_id,account_id,party,signer,content_hash) VALUES(mid,bid,b.account_id,party,trim(signer_name),h);
  IF (SELECT count(*) FROM amendment_acceptances WHERE amendment_id=mid)=2 THEN
   IF b.reschedules_used<>0 OR b.starts_at<>m.old_start THEN RAISE EXCEPTION 'Booking changed; this amendment cannot apply'; END IF;
   PERFORM expire_account(b.account_id);
   UPDATE occupied_slots SET slot=m.reserved_range WHERE booking_id=bid;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original reservation is missing'; END IF;
   INSERT INTO signatures(agreement_id,booking_id,account_id,signer,content_hash,accepted_at) SELECT a.id,bid,b.account_id,x.signer,h,x.created_at FROM amendment_acceptances x WHERE amendment_id=mid AND x.party='client';
   UPDATE bookings SET starts_at=m.new_start,ends_at=m.new_end,agreement_version=a.version,reschedules_used=1,guest_expires_at=greatest(guest_expires_at,m.new_end+interval '90 days') WHERE id=bid;
   UPDATE amendments SET state='applied' WHERE id=mid;
   PERFORM change_event(b,'DATE_CHANGE_APPLIED','system',jsonb_build_object('amendmentId',mid,'oldStart',b.starts_at,'newStart',m.new_start));
  END IF;
 ELSE RAISE EXCEPTION 'Invalid date change response'; END IF;
 PERFORM change_event(b,'DATE_CHANGE_'||upper(action),CASE WHEN party='dj' THEN actor_id()::text ELSE 'client' END,jsonb_build_object('amendmentId',mid));
END $$;

CREATE TABLE cancellation_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL, account_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,booking_id,account_id), FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id)
);
CREATE TABLE cancellation_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL, account_id uuid NOT NULL,
 request_id uuid UNIQUE, initiated_by text NOT NULL CHECK(initiated_by IN ('client','dj')),
 decision text NOT NULL CHECK(decision IN ('approved','declined')), actor_id uuid NOT NULL REFERENCES users,
 verified_minor integer NOT NULL CHECK(verified_minor>=0), suggested_minor integer NOT NULL CHECK(suggested_minor>=0),
 refund_minor integer NOT NULL CHECK(refund_minor BETWEEN 0 AND verified_minor), reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 basis text NOT NULL CHECK(length(basis) BETWEEN 10 AND 1000), due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(id,booking_id,account_id),
 FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id), FOREIGN KEY(request_id,booking_id,account_id) REFERENCES cancellation_requests(id,booking_id,account_id),
 CHECK((initiated_by='client' AND request_id IS NOT NULL) OR (initiated_by='dj' AND request_id IS NULL AND decision='approved' AND refund_minor=verified_minor)),
 CHECK((decision='declined' AND refund_minor=0 AND due_at IS NULL) OR (decision='approved' AND ((refund_minor=0 AND due_at IS NULL) OR (refund_minor>0 AND due_at IS NOT NULL))))
);
CREATE UNIQUE INDEX one_final_cancellation ON cancellation_decisions(booking_id) WHERE decision='approved';
CREATE TABLE refund_records (
 decision_id uuid PRIMARY KEY, booking_id uuid NOT NULL, account_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, amount_minor integer NOT NULL CHECK(amount_minor>0),
 reference text NOT NULL CHECK(length(reference) BETWEEN 2 AND 100), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(decision_id,booking_id,account_id) REFERENCES cancellation_decisions(id,booking_id,account_id)
);
CREATE UNIQUE INDEX refund_reference_unique ON refund_records(account_id,lower(trim(reference)));
CREATE TABLE refund_acknowledgements (
 decision_id uuid PRIMARY KEY REFERENCES refund_records, booking_id uuid NOT NULL, account_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), FOREIGN KEY(decision_id,booking_id,account_id) REFERENCES cancellation_decisions(id,booking_id,account_id)
);
CREATE FUNCTION request_cancellation(bid uuid,r text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; rid uuid;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR NOT guest_can(bid) THEN RAISE EXCEPTION 'Client access required' USING ERRCODE='42501'; END IF;
 PERFORM expire_account(b.account_id);
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 IF b.status IN ('CANCELLED','COMPLETED','HOLD_EXPIRED') OR b.starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'Only upcoming active bookings can be cancelled here'; END IF;
 SELECT q.id INTO rid FROM cancellation_requests q WHERE q.booking_id=bid AND NOT EXISTS(SELECT 1 FROM cancellation_decisions d WHERE d.request_id=q.id);
 IF rid IS NOT NULL THEN RETURN rid; END IF;
 INSERT INTO cancellation_requests(booking_id,account_id,reason) VALUES(bid,b.account_id,r) RETURNING id INTO rid;
 PERFORM change_event(b,'CANCELLATION_REQUESTED','client',jsonb_build_object('requestId',rid));
 RETURN rid;
END $$;
CREATE FUNCTION decide_cancellation(bid uuid,rid uuid,approve boolean,refund integer,r text,basis_text text,attest boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; q cancellation_requests; d cancellation_decisions; suggested integer; stamp timestamptz; did uuid;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR NOT owns(b.account_id) THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 PERFORM expire_account(b.account_id);
 SELECT * INTO b FROM bookings WHERE id=bid FOR UPDATE;
 IF attest IS DISTINCT FROM true THEN RAISE EXCEPTION 'Review the signed agreement and refund obligation before deciding'; END IF;
 SELECT * INTO d FROM cancellation_decisions WHERE booking_id=bid AND (request_id=rid OR (rid IS NULL AND initiated_by='dj'));
 IF FOUND THEN
  IF d.refund_minor=refund AND d.reason=r AND d.basis=basis_text AND (d.decision='approved')=approve THEN RETURN; END IF;
  RAISE EXCEPTION 'Cancellation decision already recorded differently';
 END IF;
 stamp:=clock_timestamp();
 IF b.status IN ('CANCELLED','COMPLETED','HOLD_EXPIRED') OR b.starts_at<=stamp THEN RAISE EXCEPTION 'Only upcoming active bookings can be cancelled here'; END IF;
 IF rid IS NOT NULL THEN
  SELECT * INTO q FROM cancellation_requests WHERE id=rid AND booking_id=bid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation request not found'; END IF;
  suggested:=CASE WHEN b.starts_at-q.created_at>=interval '14 days' THEN (b.verified_minor+1)/2 ELSE 0 END;
 ELSE
  IF approve IS DISTINCT FROM true OR refund IS DISTINCT FROM b.verified_minor THEN RAISE EXCEPTION 'DJ cancellation requires a full return of verified funds'; END IF;
  suggested:=b.verified_minor;
 END IF;
 INSERT INTO cancellation_decisions(booking_id,account_id,request_id,initiated_by,decision,actor_id,verified_minor,suggested_minor,refund_minor,reason,basis,due_at)
 VALUES(bid,b.account_id,rid,CASE WHEN rid IS NULL THEN 'dj' ELSE 'client' END,CASE WHEN approve THEN 'approved' ELSE 'declined' END,actor_id(),b.verified_minor,suggested,refund,r,basis_text,CASE WHEN approve AND refund>0 THEN stamp+interval '7 days' ELSE NULL END) RETURNING id INTO did;
 IF approve THEN
  UPDATE bookings SET status='CANCELLED' WHERE id=bid;
  DELETE FROM occupied_slots WHERE booking_id=bid;
  UPDATE amendments SET state='cancelled' WHERE booking_id=bid AND state='pending';
 END IF;
 PERFORM change_event(b,CASE WHEN approve THEN 'CANCELLED' ELSE 'CANCELLATION_DECLINED' END,actor_id()::text,jsonb_build_object('decisionId',did,'refundMinor',refund,'requestId',rid));
END $$;
CREATE FUNCTION record_refund(bid uuid,did uuid,ref text,attest boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings; d cancellation_decisions; old refund_records;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR NOT owns(b.account_id) THEN RAISE EXCEPTION 'DJ access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=b.account_id FOR UPDATE;
 SELECT * INTO d FROM cancellation_decisions WHERE id=did AND booking_id=bid AND decision='approved' AND refund_minor>0;
 IF NOT FOUND OR attest IS DISTINCT FROM true THEN RAISE EXCEPTION 'A refund obligation and actual transfer attestation are required'; END IF;
 SELECT * INTO old FROM refund_records WHERE decision_id=did;
 IF FOUND THEN
  IF old.reference=trim(ref) THEN RETURN; END IF;
  RAISE EXCEPTION 'Refund attestation already recorded';
 END IF;
 INSERT INTO refund_records(decision_id,booking_id,account_id,actor_id,amount_minor,reference) VALUES(did,bid,b.account_id,actor_id(),d.refund_minor,trim(ref));
 PERFORM change_event(b,'REFUND_ATTESTED',actor_id()::text,jsonb_build_object('decisionId',did,'amountMinor',d.refund_minor));
END $$;
CREATE FUNCTION acknowledge_refund(bid uuid,did uuid,attest boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE b bookings;
BEGIN
 SELECT * INTO b FROM bookings WHERE id=bid;
 IF NOT FOUND OR NOT guest_can(bid) THEN RAISE EXCEPTION 'Client access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM accounts WHERE id=b.account_id FOR UPDATE;
 IF attest IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM refund_records WHERE decision_id=did AND booking_id=bid) THEN RAISE EXCEPTION 'Confirm actual receipt only after the DJ records the refund'; END IF;
 INSERT INTO refund_acknowledgements(decision_id,booking_id,account_id) VALUES(did,bid,b.account_id) ON CONFLICT DO NOTHING;
 IF FOUND THEN PERFORM change_event(b,'REFUND_RECEIPT_ACKNOWLEDGED','client',jsonb_build_object('decisionId',did)); END IF;
END $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['amendments','amendment_acceptances','cancellation_requests','cancellation_decisions','refund_records','refund_acknowledgements'] LOOP
  EXECUTE format('ALTER TABLE lockd.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_access ON lockd.%I FOR SELECT USING(lockd.owns(account_id) OR lockd.guest_can(booking_id))',t);
  EXECUTE format('GRANT SELECT ON lockd.%I TO lockd_runtime',t);
  IF t<>'amendments' AND t<>'amendment_acceptances' THEN EXECUTE format('CREATE TRIGGER history_immutable BEFORE UPDATE OR DELETE ON lockd.%I FOR EACH ROW EXECUTE FUNCTION lockd.immutable()',t); END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION change_event(bookings,text,text,jsonb) FROM PUBLIC,lockd_runtime;
GRANT EXECUTE ON FUNCTION update_profile(jsonb),propose_amendment(uuid,text,timestamptz,text),respond_amendment(uuid,uuid,text,text,text,text),request_cancellation(uuid,text),decide_cancellation(uuid,uuid,boolean,integer,text,text,boolean),record_refund(uuid,uuid,text,boolean),acknowledge_refund(uuid,uuid,boolean) TO lockd_runtime;
COMMIT;
