# Staging demo on Render

A public demo of Lockd with **synthetic data only**: no email provider, no payments, no real bank details. Everything is defined in [`render.yaml`](../render.yaml); you create it from your Render account, and nothing deploys without you.

## What you get

- A public HTTPS link such as `https://lockd-staging.onrender.com` (Render adds a suffix if the name is taken).
- Three demo DJs in the directory, a **demo DJ login** with its own booking page, and a **demo staff login** with every staff scope.
- Anyone can book a demo DJ as a client without an account, sign the agreement and upload a synthetic receipt.
- Sign-up and password reset are switched off (they need email). A banner marks every page as a staging demo; pages are not indexed by search engines.

Approximate cost on paid tiers: web service (Starter) about US$7/month plus Postgres (Basic 256 MB) about US$6/month. A paid web instance is required because migrations run as a pre-deploy command.

## Create it (about 10 minutes, once)

1. Sign in at [dashboard.render.com](https://dashboard.render.com) and connect your GitHub account if asked.
2. **New → Blueprint**, choose the `tillmate/lockd` repository, branch `main`.
3. Review the plan: one web service `lockd-staging`, one Postgres database `lockd-staging-db`, one environment group `lockd-staging-secrets`. Render generates every secret in that group. You don't need to type any.
4. Click **Apply**. The first deploy builds the app, applies all migrations, sets the database role passwords and seeds the demo data. The deploy log ends with `Staging release complete`.
5. Open the service URL shown at the top of the `lockd-staging` page. That is the demo link.

## Demo logins

- **Demo DJ:** `demo.dj@example.com`. Password: Render → **Environment Groups → lockd-staging-secrets → DEMO_DJ_PASSWORD**.
- **Demo staff:** `demo.staff@example.com`. Password: `DEMO_STAFF_PASSWORD` in the same group. Staff tools also need an authenticator code. On the `lockd-staging` service open **Shell** and run `npm run staging:enroll-staff`, then add the printed secret to an authenticator app (Google Authenticator, 1Password, etc.). Do this in the Shell, not in a build or start command, so the secret never lands in logs.

Share the demo link freely. Share the passwords only with people you trust. The staff login can approve and restrict demo listings and see case-scoped booking records.

## Checks after a deploy

- In **Shell**: `npm run staging:smoke`. It confirms both restricted database roles connect, the demo directory is seeded and the web role cannot read tables directly.
- Visit `/`, open a demo DJ, hold a date, sign, upload any image; then sign in as the demo DJ to verify it.

## If something fails

- **Pre-deploy step fails on `CREATE ROLE`:** the database user lacks CREATEROLE. CI tests a non-superuser owner with CREATEROLE on Postgres 16 and 17; if Render's user differs, tell me and we can switch the database to a provider that allows it.
- **`must be 32 bytes`:** a key secret is in an unexpected format. Replace it in the environment group with the output of `openssl rand -hex 32` and redeploy.
- **Forms say "Request origin is not allowed":** the app uses Render's `RENDER_EXTERNAL_URL` as its origin. If you add a custom domain, set `APP_ORIGIN` to that exact URL in the service's environment.

## Later: real email

Add `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_ALLOWED_DOMAINS` to the environment group, and add a Render **Background Worker** running `npm run worker` that uses the same group plus `DB_HOST`/`DB_PORT`/`DB_NAME`. Sign-up and password reset switch on automatically once `EMAIL_PROVIDER` is set.

## Not covered

This is a staging demo, not production. Production still needs the launch gates in `docs/SECURITY.md`: legal and privacy sign-off, real bank details, a strict content-security policy, backups and monitoring, and a reviewed production release process.
