BEGIN;
CREATE OR REPLACE FUNCTION lockd.consume_email_token(t text,p text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE v email_tokens;
BEGIN
 SELECT * INTO v FROM email_tokens WHERE token_hash=t AND used_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF (v.purpose='verify' AND p IS NOT NULL) OR (v.purpose='reset' AND p IS NULL) THEN RETURN false; END IF;
 IF v.purpose='verify' THEN UPDATE users SET verified_at=clock_timestamp() WHERE id=v.user_id;
 ELSE UPDATE users SET password_hash=p WHERE id=v.user_id; DELETE FROM sessions WHERE user_id=v.user_id;
 END IF;
 UPDATE email_tokens SET used_at=clock_timestamp() WHERE token_hash=t; RETURN true;
END $$;
CREATE OR REPLACE FUNCTION lockd.register_user(e text,p text,t text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=lockd,pg_temp AS $$
DECLARE u uuid;
BEGIN
 INSERT INTO users(email,password_hash) VALUES(lower(e),p) ON CONFLICT(email) DO NOTHING RETURNING id INTO u;
 -- Re-request a verification email without changing an existing account's password.
 IF u IS NULL THEN SELECT id INTO u FROM users WHERE email=lower(e) AND verified_at IS NULL; END IF;
 IF u IS NOT NULL THEN
  INSERT INTO email_tokens VALUES(t,u,'verify',clock_timestamp()+interval '24 hours',NULL);
  INSERT INTO outbox(dedupe_key,recipient,kind,payload) VALUES('verify:'||t,e,'verify',jsonb_build_object('tokenHash',t));
 END IF;
 RETURN u;
END $$;
COMMIT;
