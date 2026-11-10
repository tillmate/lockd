# Staging demo on DigitalOcean

A public demo of Lockd with **synthetic data only**: no email provider, no payments, no real bank details. It runs on DigitalOcean App Platform with a managed PostgreSQL cluster, defined in [`.do/app.yaml`](../.do/app.yaml) and built from the [`Dockerfile`](../Dockerfile).

## What you get

- The live demo: https://lockd-staging-niays.ondigitalocean.app. Share **/demo** on that link: it lists every demo login.
- 15 synthetic creatives across all six categories (DJs public; live music, hosts and MCs, comedians, creators, photo and film as the curated beta), with photos, illustrative ratings, two or three services and social links each. Category tiles open the filtered search page (/creatives); profiles follow Figma WEB 07. Photo credits: public/demo/CREDITS.md. A **demo DJ business** anyone can book as a client without an account.
- **Demo DJ login** `demo.dj@example.com` / `lockd-demo-dj-2026`: requests, deposit verification, availability, profile and subscription.
- **Demo Super Admin login** `demo.staff@example.com` / `lockd-demo-admin-2026` with every staff scope. On staging the unlock screen shows the demo authenticator's current code (the secret is published in `src/lib/env.ts`); the server still verifies it and rejects reuse.
- Sign-up and password reset are switched off (they need email). A banner marks every page as a staging demo and links to `/demo`; pages are not indexed by search engines.

These logins are public by design: anyone with the link can use them, so reviewers must use made-up details. Each release puts restricted or unpublished demo listings back on show.

## How it is wired

- **Database:** managed PostgreSQL 17 cluster `lockd-staging-db` (Basic, 1 GB, NYC3, about US$15/month). Its `doadmin` user is not a superuser but can create roles, which the release needs for the restricted `lockd_runtime` and `lockd_notifier` roles. App Platform dev databases cannot create schemas or roles, so they do not work.
- **App:** service `web` (Dockerfile, port 8080, 1 GB, about US$12/month) and a `release` pre-deploy job that runs `npm run staging:release`: migrations behind the explicit staging gate, restricted-role passwords, idempotent demo seed. A failed release stops the deploy.
- **Settings:** `LOCKD_ENV=staging`, `LOCKD_LOCAL_ONLY=0`, `APP_ORIGIN=${APP_URL}` and `MIGRATION_DATABASE_URL` (encrypted, the cluster's doadmin connection string with `sslmode=require`). On this account App Platform refuses to attach the cluster as a component (managed database limit), so the connection string is pasted once instead of bound; with a higher limit, bind `${db.DATABASE_URL}` and `DB_CA_CERT=${db.CA_CERT}` as in `.do/app.yaml`. The app derives the role passwords and its encryption keys from the owner password (`src/lib/env.ts`). Without a CA it encrypts the connection without verifying the certificate (libpq `require`); with `DB_CA_CERT` it verifies the chain. The run command is `npm run start:staging` (release, then serve).

## Create it

1. **Databases → Create Database Cluster:** PostgreSQL 17, NYC3, Basic 1 GB, name `lockd-staging-db`.
2. **Apps → Create App** from the public repository `https://github.com/tillmate/lockd` (branch `main`), then replace the app spec with `.do/app.yaml` (**Settings → App Spec → Edit**), or run `doctl apps create --spec .do/app.yaml`.
3. Wait for the deploy. The `release` job log ends with `Staging release complete`.
4. Open the app's live URL and share `/demo`.

A public Git source does not redeploy on push: use **Deploy** in the app (or connect GitHub for automatic deploys).

## Checks after a deploy

- **Console** tab on the `web` component: `npm run staging:smoke` confirms both restricted roles connect over TLS, the demo directory is seeded and the web role cannot read tables directly.
- Visit `/`, book the demo DJ business, sign and upload any image; sign in as the demo DJ and verify it; sign in as the demo Super Admin and unlock with the code shown.

## If something fails

- **`self-signed certificate` / TLS errors:** `DB_CA_CERT` must be bound to `${db.CA_CERT}` for every component.
- **`permission denied to create role`:** the database user is not `doadmin` (or is a dev database). Use the managed cluster's `doadmin`.
- **Forms say "Request origin is not allowed":** `APP_ORIGIN` must equal the exact public URL (`${APP_URL}`); update it after adding a custom domain.

## Later: real email

Add `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_ALLOWED_DOMAINS`, and a worker component running `npm run worker` with the same settings. Sign-up and password reset switch on automatically once `EMAIL_PROVIDER` is set.

## Not covered

This is a staging demo, not production. Production still needs the launch gates in `docs/SECURITY.md`: legal and privacy sign-off, real bank details, a strict content-security policy, backups and monitoring, private staff credentials, and a reviewed production release process.
