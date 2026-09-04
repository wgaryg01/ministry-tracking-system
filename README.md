# Ministry Client Tracking System — Dev Quickstart

## First-time setup

```bash
# 1. Generate self-signed dev certs for Postgres SSL
chmod +x db/gen-dev-certs.sh
./db/gen-dev-certs.sh

# 2. Create your .env file
cp .env.example .env

# 3. Generate the two secrets it needs and paste them into .env
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
python3 -c "import secrets; print(secrets.token_hex(32))"

# 4. Also set DB_USER / DB_PASSWORD / DB_NAME in .env to whatever you want locally

# 5. Build and start everything
docker compose up --build
```

Then check http://localhost:8000/health — it should return `{"status":"ok"}`
once it can round-trip a query to Postgres over SSL.

## What's scaffolded so far

- **`app/models.py`** — the core separation-of-duties design:
  - `Identity` holds all PII, every field encrypted at rest (`encrypted_*` columns)
  - `ActivityRecord` holds the "helped on this date, spent this much" data with
    zero PII — only a foreign key `identity_id` (a UUID) linking back
  - `Role` enum: `ADMIN` / `CASEWORKER` can decrypt PII, `VOLUNTEER` cannot
- **`app/crypto.py`** — Fernet-based field encryption + a blind-index HMAC
  helper so authorized roles can search without decrypting the whole table
- **`app/config.py`** — pulls everything from `.env`, forces `sslmode=require`
  on the DB connection string
- **`db/`** — Postgres SSL cert generation + a minimal `postgresql.conf`

## Not yet built

- Auth endpoints (magic link request/verify, session handling)
- Role-gated API routes that actually enforce the decrypt boundary
- Alembic migrations (dependency's installed, no migration files yet)
- SMTP integration for sending the magic link emails
- The actual identity/activity CRUD endpoints and the responsive frontend

## Notes

- The `app` service mounts `./app` into the container for live-reload during
  dev. Drop that volume mount for production images.
- `db` port 5432 is bound to `127.0.0.1` only — not reachable from outside
  the host, even though it's "published." Confirm this matches your intent
  once this moves to the actual server.
- Swap in a real (non-self-signed) cert before this touches production data.
