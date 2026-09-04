#!/usr/bin/env bash
# Generates a self-signed cert for local dev only.
# For production, use a real cert (e.g. from your internal CA or Let's Encrypt
# if the DB is reachable by hostname).
set -e
cd "$(dirname "$0")/certs" 2>/dev/null || { mkdir -p "$(dirname "$0")/certs"; cd "$(dirname "$0")/certs"; }

openssl req -new -x509 -days 365 -nodes \
  -out server.crt -keyout server.key \
  -subj "/CN=ministry-db-dev"

chmod 600 server.key
# Postgres refuses to start if the key is group/world readable, and the
# container runs as the postgres user, so relax ownership requirements
# by having Docker copy these in as read-only (see docker-compose.yml).
echo "Certs generated in db/certs/"
