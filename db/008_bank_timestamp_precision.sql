BEGIN;
-- Manual bank timestamps and the browser picker have second precision. Compare at that precision,
-- rather than rejecting an otherwise valid same-second receipt on fractional microseconds.
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('lockd.reconcile_subscription(uuid,uuid,text,integer,text,timestamp with time zone,text,boolean)'::regprocedure);
 IF position('received>stamp OR received<i.created_at' IN source)=0 THEN RAISE EXCEPTION 'Expected bank timestamp guard not found'; END IF;
 source:=replace(source,'received>stamp OR received<i.created_at', 'date_trunc(''second'',received)>date_trunc(''second'',stamp) OR date_trunc(''second'',received)<date_trunc(''second'',i.created_at)');
 EXECUTE source;
END $$;
COMMIT;
