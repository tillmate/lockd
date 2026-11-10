BEGIN;
SET search_path=lockd,public;
-- Case-scoped support access. Staff with the support scope open a case about one DJ account,
-- link specific bookings to it with a reason, and only then see those bookings' records, for a
-- limited window. Evidence images need a separate justification per view. Everything is audited.
CREATE TABLE support_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 account_id uuid NOT NULL REFERENCES accounts, opened_by uuid NOT NULL REFERENCES users,
 category text NOT NULL CHECK(category IN ('payment_discrepancy','cancellation_refund','date_change','no_show','fraud_report','account_access','delivery_problem','other')),
 requester text NOT NULL CHECK(requester IN ('client','dj','staff')),
 summary text NOT NULL CHECK(length(summary) BETWEEN 10 AND 1000),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 access_expires_at timestamptz NOT NULL, extensions integer NOT NULL DEFAULT 0 CHECK(extensions BETWEEN 0 AND 3),
 closed_at timestamptz, closed_by uuid REFERENCES users,
 outcome text CHECK(outcome IN ('resolved_between_parties','refund_confirmed','no_action_needed','listing_restricted','referred_externally','duplicate','other')),
 UNIQUE(id,account_id),
 CHECK((state='open' AND closed_at IS NULL AND outcome IS NULL) OR (state='closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND outcome IS NOT NULL))
);
-- Only lifecycle columns change; a closed case is final (open a new case instead).
CREATE FUNCTION support_case_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=lockd,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.state='closed' THEN RAISE EXCEPTION 'Immutable support case'; END IF;
 IF (to_jsonb(NEW)-'state'-'access_expires_at'-'extensions'-'closed_at'-'closed_by'-'outcome') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'access_expires_at'-'extensions'-'closed_at'-'closed_by'-'outcome') THEN RAISE EXCEPTION 'Immutable support case'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_case_history BEFORE UPDATE OR DELETE ON support_cases FOR EACH ROW EXECUTE FUNCTION support_case_guard();
CREATE TABLE support_case_bookings (
 case_id uuid NOT NULL, booking_id uuid NOT NULL, account_id uuid NOT NULL,
 linked_by uuid NOT NULL REFERENCES users, reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(case_id,booking_id),
 -- Both keys carry the account, so a case can only ever link bookings of its own DJ.
 FOREIGN KEY(case_id,account_id) REFERENCES support_cases(id,account_id), FOREIGN KEY(booking_id,account_id) REFERENCES bookings(id,account_id)
);
CREATE TRIGGER support_case_bookings_immutable BEFORE UPDATE OR DELETE ON support_case_bookings FOR EACH ROW EXECUTE FUNCTION immutable();
CREATE TABLE support_case_notes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, case_id uuid NOT NULL REFERENCES support_cases,
 author_id uuid NOT NULL REFERENCES users, body text NOT NULL CHECK(length(body) BETWEEN 10 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER support_case_notes_immutable BEFORE UPDATE OR DELETE ON support_case_notes FOR EACH ROW EXECUTE FUNCTION immutable();
ALTER TABLE support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_case_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_case_notes ENABLE ROW LEVEL SECURITY;

-- Loads a case for a support action: fresh MFA + support scope, never the staff member's own
-- account, and (when lock is true) re-checked after waiting for the row lock.
CREATE FUNCTION support_case_for(cid uuid,for_update boolean) RETURNS support_cases LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE c support_cases;
BEGIN
 IF NOT staff_can('support') THEN RAISE EXCEPTION 'Support staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 IF for_update THEN SELECT * INTO c FROM support_cases WHERE id=cid FOR UPDATE; ELSE SELECT * INTO c FROM support_cases WHERE id=cid; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Support case not found'; END IF;
 IF owns(c.account_id) THEN RAISE EXCEPTION 'Staff cannot handle cases about their own account' USING ERRCODE='42501'; END IF;
 IF for_update AND NOT staff_can('support') THEN RAISE EXCEPTION 'MFA expired while waiting; authenticate again' USING ERRCODE='42501'; END IF;
 RETURN c;
END $$;
CREATE FUNCTION support_case_open_for_records(c support_cases) RETURNS boolean LANGUAGE sql STABLE SET search_path=lockd,pg_temp AS $$
 SELECT c.state='open' AND c.access_expires_at>clock_timestamp()
$$;

CREATE FUNCTION open_support_case(aid uuid,cat text,req text,s text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE cid uuid; num bigint; dj text;
BEGIN
 IF NOT staff_can('support') THEN RAISE EXCEPTION 'Support staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 IF owns(aid) THEN RAISE EXCEPTION 'Staff cannot open cases about their own account' USING ERRCODE='42501'; END IF;
 SELECT u.email INTO dj FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=aid;
 IF NOT FOUND THEN RAISE EXCEPTION 'DJ account not found'; END IF;
 INSERT INTO support_cases(account_id,opened_by,category,requester,summary,access_expires_at)
 VALUES(aid,actor_id(),cat,req,trim(s),clock_timestamp()+interval '72 hours') RETURNING id,number INTO cid,num;
 PERFORM staff_event('support','CASE_OPENED',aid,cid::text,cat,s,jsonb_build_object('number',num,'requester',req));
 -- The DJ is told a case exists, except for fraud reports where notice could prejudice the review.
 IF cat<>'fraud_report' THEN
  INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload)
  VALUES('case:'||cid||':opened',dj,'SUPPORT_CASE_OPENED','dj',jsonb_build_object('accountId',aid,'caseNumber',num,'category',cat));
 END IF;
 RETURN cid;
END $$;
CREATE FUNCTION link_support_booking(cid uuid,bid uuid,r text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE c support_cases;
BEGIN
 c:=support_case_for(cid,true);
 IF NOT support_case_open_for_records(c) THEN RAISE EXCEPTION 'Case access has ended; extend it or open a new case'; END IF;
 IF NOT EXISTS(SELECT 1 FROM bookings WHERE id=bid AND account_id=c.account_id) THEN RAISE EXCEPTION 'That booking reference does not belong to this DJ'; END IF;
 INSERT INTO support_case_bookings(case_id,booking_id,account_id,linked_by,reason) VALUES(cid,bid,c.account_id,actor_id(),trim(r)) ON CONFLICT DO NOTHING;
 IF FOUND THEN PERFORM staff_event('support','CASE_BOOKING_LINKED',c.account_id,cid::text,'booking_linked',r,jsonb_build_object('bookingId',bid,'number',c.number)); END IF;
END $$;
-- The case view. Linked bookings' records are returned only while the case is open and access
-- has not expired, and each such view is audited. Bearer secrets (guest link hashes, request
-- hashes, encrypted link tokens) and evidence image bytes are never part of the projection.
CREATE FUNCTION support_case_view(cid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE c support_cases; live boolean; r jsonb;
BEGIN
 c:=support_case_for(cid,false);
 live:=support_case_open_for_records(c);
 r:=jsonb_build_object(
  'case',(SELECT jsonb_build_object('id',c.id,'number',c.number,'accountId',c.account_id,'stageName',a.stage_name,'slug',a.slug,'djEmail',u.email,'listingState',a.listing_state,
   'category',c.category,'requester',c.requester,'summary',c.summary,'state',c.state,'createdAt',c.created_at,'openedBy',(SELECT email FROM users WHERE id=c.opened_by),
   'accessExpiresAt',c.access_expires_at,'extensions',c.extensions,'closedAt',c.closed_at,'outcome',c.outcome,'recordsAvailable',live)
   FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=c.account_id),
  'notes',coalesce((SELECT jsonb_agg(jsonb_build_object('body',n.body,'author',u.email,'createdAt',n.created_at) ORDER BY n.id) FROM support_case_notes n JOIN users u ON u.id=n.author_id WHERE n.case_id=cid),'[]'),
  'linked',coalesce((SELECT jsonb_agg(jsonb_build_object('bookingId',l.booking_id,'reason',l.reason,'linkedBy',u.email,'createdAt',l.created_at) ORDER BY l.created_at) FROM support_case_bookings l JOIN users u ON u.id=l.linked_by WHERE l.case_id=cid),'[]'));
 IF NOT live THEN RETURN r; END IF;
 -- Candidates to link: dates and states only, no client details until a booking is linked.
 r:=r||jsonb_build_object('candidates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'startsAt',b.starts_at,'status',b.status,'createdAt',b.created_at) ORDER BY b.starts_at DESC)
  FROM bookings b WHERE b.account_id=c.account_id AND NOT EXISTS(SELECT 1 FROM support_case_bookings l WHERE l.case_id=cid AND l.booking_id=b.id)),'[]'));
 r:=r||jsonb_build_object('records',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'booking',jsonb_build_object('id',b.id,'status',b.status,'clientName',b.client_name,'clientEmail',b.client_email,'venue',b.venue,'startsAt',b.starts_at,'endsAt',b.ends_at,
    'priceMinor',b.price_minor,'depositMinor',b.deposit_minor,'verifiedMinor',b.verified_minor,'createdAt',b.created_at,'originalExpiresAt',b.original_expires_at,'expiresAt',b.expires_at,
    'graceUsed',b.grace_used,'agreementVersion',b.agreement_version,'reschedulesUsed',b.reschedules_used),
  'agreements',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'version',g.version,'body',g.body,'contentHash',g.content_hash,'createdAt',g.created_at,
    'signatures',(SELECT coalesce(jsonb_agg(jsonb_build_object('signer',s.signer,'acceptedAt',s.accepted_at) ORDER BY s.accepted_at),'[]') FROM signatures s WHERE s.agreement_id=g.id)) ORDER BY g.version),'[]')
    FROM agreements g WHERE g.booking_id=b.id),
  'claims',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',k.id,'reference',k.reference,'claimedMinor',k.claimed_minor,'receivedAt',k.received_at,'onTime',k.on_time,
    'decision',v.decision,'amountMinor',v.amount_minor,'bankReference',v.bank_reference,'reason',v.reason,'decidedAt',v.created_at) ORDER BY k.received_at),'[]')
    FROM claims k LEFT JOIN verifications v ON v.claim_id=k.id WHERE k.booking_id=b.id),
  'amendments',(SELECT coalesce(jsonb_agg(jsonb_build_object('proposedBy',m.proposed_by,'oldStart',m.old_start,'newStart',m.new_start,'reason',m.reason,
    'state',CASE WHEN m.state='pending' AND m.expires_at<=clock_timestamp() THEN 'expired' ELSE m.state END,'createdAt',m.created_at) ORDER BY m.created_at),'[]')
    FROM amendments m WHERE m.booking_id=b.id),
  'cancellations',(SELECT coalesce(jsonb_agg(jsonb_build_object('initiatedBy',d.initiated_by,'decision',d.decision,'requestReason',q.reason,'requestedAt',q.created_at,
    'verifiedMinor',d.verified_minor,'suggestedMinor',d.suggested_minor,'refundMinor',d.refund_minor,'reason',d.reason,'basis',d.basis,'dueAt',d.due_at,'decidedAt',d.created_at,
    'refundReference',x.reference,'refundedAt',x.created_at,'acknowledgedAt',k.created_at) ORDER BY d.created_at),'[]')
    FROM cancellation_decisions d LEFT JOIN cancellation_requests q ON q.id=d.request_id LEFT JOIN refund_records x ON x.decision_id=d.id
    LEFT JOIN refund_acknowledgements k ON k.decision_id=d.id WHERE d.booking_id=b.id),
  'openRequests',(SELECT coalesce(jsonb_agg(jsonb_build_object('reason',q.reason,'requestedAt',q.created_at)),'[]') FROM cancellation_requests q
    WHERE q.booking_id=b.id AND NOT EXISTS(SELECT 1 FROM cancellation_decisions d WHERE d.request_id=q.id)),
  'events',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'actor',CASE WHEN e.actor IN ('client','system') THEN e.actor ELSE 'dj' END,'createdAt',e.created_at) ORDER BY e.id),'[]')
    FROM booking_events e WHERE e.booking_id=b.id),
  'deliveries',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',o.kind,'audience',o.audience,'recipient',left(o.recipient,1)||'•••@'||split_part(o.recipient,'@',2),
    'status',o.status,'attempts',o.attempts,'lastError',o.last_error,'createdAt',o.created_at,'deliveredAt',o.delivered_at) ORDER BY o.created_at),'[]')
    FROM outbox o WHERE o.payload->>'bookingId'=b.id::text)
  ) ORDER BY l.created_at) FROM support_case_bookings l JOIN bookings b ON b.id=l.booking_id WHERE l.case_id=cid),'[]'));
 IF jsonb_array_length(r->'records')>0 THEN
  PERFORM staff_event('support','CASE_RECORDS_VIEWED',c.account_id,cid::text,'case_review','Viewed booking records linked to the case',
   jsonb_build_object('number',c.number,'bookings',(SELECT jsonb_agg(booking_id) FROM support_case_bookings WHERE case_id=cid)));
 END IF;
 RETURN r;
END $$;
-- One evidence image, only for a booking linked to this live case, with a written justification.
CREATE FUNCTION support_case_receipt(cid uuid,claim uuid,why text) RETURNS bytea LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE c support_cases; img bytea; bid uuid;
BEGIN
 c:=support_case_for(cid,false);
 IF NOT support_case_open_for_records(c) THEN RAISE EXCEPTION 'Case access has ended; extend it or open a new case'; END IF;
 IF why IS NULL OR length(trim(why)) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'Explain why you need to view this evidence'; END IF;
 SELECT k.image,k.booking_id INTO img,bid FROM claims k JOIN support_case_bookings l ON l.booking_id=k.booking_id AND l.case_id=cid WHERE k.id=claim;
 IF NOT FOUND THEN RAISE EXCEPTION 'Evidence is not part of a booking linked to this case'; END IF;
 PERFORM staff_event('support','CASE_EVIDENCE_VIEWED',c.account_id,cid::text,'evidence_review',why,jsonb_build_object('number',c.number,'bookingId',bid,'claimId',claim));
 RETURN img;
END $$;
CREATE FUNCTION add_support_note(cid uuid,body text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE c support_cases;
BEGIN
 c:=support_case_for(cid,true);
 IF c.state<>'open' THEN RAISE EXCEPTION 'Closed cases cannot be changed'; END IF;
 INSERT INTO support_case_notes(case_id,author_id,body) VALUES(cid,actor_id(),trim(body));
 PERFORM staff_event('support','CASE_NOTE_ADDED',c.account_id,cid::text,'case_note','Added a note to the case',jsonb_build_object('number',c.number));
END $$;
CREATE FUNCTION extend_support_access(cid uuid,r text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE c support_cases; new_expiry timestamptz;
BEGIN
 c:=support_case_for(cid,true);
 IF c.state<>'open' THEN RAISE EXCEPTION 'Closed cases cannot be changed'; END IF;
 IF c.extensions>=3 THEN RAISE EXCEPTION 'Access has been extended three times; open a new case if more time is needed'; END IF;
 new_expiry:=greatest(c.access_expires_at,clock_timestamp())+interval '72 hours';
 PERFORM staff_event('support','CASE_ACCESS_EXTENDED',c.account_id,cid::text,'access_extension',r,jsonb_build_object('number',c.number,'until',new_expiry));
 UPDATE support_cases SET access_expires_at=new_expiry,extensions=extensions+1 WHERE id=cid;
 RETURN new_expiry;
END $$;
CREATE FUNCTION close_support_case(cid uuid,result text,n text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE c support_cases;
BEGIN
 c:=support_case_for(cid,true);
 IF c.state<>'open' THEN RAISE EXCEPTION 'Case is already closed'; END IF;
 IF result NOT IN ('resolved_between_parties','refund_confirmed','no_action_needed','listing_restricted','referred_externally','duplicate','other') THEN RAISE EXCEPTION 'Choose an outcome'; END IF;
 PERFORM staff_event('support','CASE_CLOSED',c.account_id,cid::text,result,n,jsonb_build_object('number',c.number));
 UPDATE support_cases SET state='closed',closed_at=clock_timestamp(),closed_by=actor_id(),outcome=result WHERE id=cid;
 IF c.category<>'fraud_report' THEN
  INSERT INTO outbox(dedupe_key,recipient,kind,audience,payload)
  SELECT 'case:'||cid||':closed',u.email,'SUPPORT_CASE_CLOSED','dj',jsonb_build_object('accountId',c.account_id,'caseNumber',c.number,'category',c.category,'outcome',result)
  FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=c.account_id;
 END IF;
END $$;
CREATE FUNCTION staff_support_cases(state_filter text) RETURNS TABLE(id uuid,number bigint,state text,category text,requester text,stage_name text,slug text,opened_by text,created_at timestamptz,access_expires_at timestamptz,linked integer,notes integer,outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT staff_can('support') THEN RAISE EXCEPTION 'Support staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT c.id,c.number,c.state,c.category,c.requester,a.stage_name,a.slug,u.email,c.created_at,c.access_expires_at,
  (SELECT count(*)::int FROM support_case_bookings l WHERE l.case_id=c.id),(SELECT count(*)::int FROM support_case_notes n WHERE n.case_id=c.id),c.outcome
 FROM support_cases c JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=c.opened_by
 WHERE (state_filter IS NULL OR c.state=state_filter) AND a.user_id<>actor_id()
 ORDER BY c.created_at DESC LIMIT 200;
END $$;
-- The DJ sees cases about their account, except fraud reviews.
CREATE FUNCTION my_support_cases() RETURNS TABLE(number bigint,category text,state text,outcome text,created_at timestamptz,closed_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
 SELECT c.number,c.category,c.state,c.outcome,c.created_at,c.closed_at FROM support_cases c JOIN accounts a ON a.id=c.account_id
 WHERE a.user_id=actor_id() AND c.category<>'fraud_report' ORDER BY c.created_at DESC LIMIT 10
$$;
-- Messages about a staff member's own account are not offered for requeue (the function refuses).
CREATE OR REPLACE FUNCTION staff_notifications(status_filter text) RETURNS TABLE(id uuid,kind text,audience text,recipient text,status text,attempts integer,last_error text,provider text,created_at timestamptz,delivered_at timestamptz,next_attempt_at timestamptz,stage_name text,requeueable boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$ BEGIN
 IF NOT staff_can('notifications') THEN RAISE EXCEPTION 'Notifications staff with fresh MFA required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT o.id,o.kind,o.audience,left(o.recipient,1)||'•••@'||split_part(o.recipient,'@',2),o.status,o.attempts,o.last_error,o.provider,o.created_at,o.delivered_at,o.next_attempt_at,a.stage_name,
  o.status='failed' AND o.kind NOT IN ('verify','reset','booking_link') AND (o.account_id IS NULL OR NOT owns(o.account_id))
 FROM outbox o LEFT JOIN accounts a ON a.id=o.account_id
 WHERE (status_filter IS NULL OR o.status=status_filter) AND o.created_at>clock_timestamp()-interval '30 days'
 ORDER BY o.created_at DESC LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION support_case_guard(),support_case_for(uuid,boolean),support_case_open_for_records(support_cases) FROM PUBLIC,lockd_runtime;
GRANT EXECUTE ON FUNCTION open_support_case(uuid,text,text,text),link_support_booking(uuid,uuid,text),support_case_view(uuid),support_case_receipt(uuid,uuid,text),add_support_note(uuid,text),extend_support_access(uuid,text),close_support_case(uuid,text,text),staff_support_cases(text),my_support_cases() TO lockd_runtime;
COMMIT;
