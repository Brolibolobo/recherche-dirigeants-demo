#!/usr/bin/env bash
set -euo pipefail

image="${POSTGRES_TEST_IMAGE:-postgres:16}"
name="recherche-dirigeants-pg-test-$$-$RANDOM"
password="local-test-only"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$password" "$image" >/dev/null
ready=false
for _ in $(seq 1 120); do
  logs="$(docker logs "$name" 2>&1 || true)"
  if [[ "$logs" == *"PostgreSQL init process complete; ready for start up."* ]] \
      && docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$name" >&2 || true
  echo "PostgreSQL local test container did not become ready" >&2
  exit 1
fi
docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < db/migrations/001_initial.sql
docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/postgres/001_initial.behavior.sql
mapped_address="$(docker port "$name" 5432/tcp)"
mapped_port="${mapped_address##*:}"
if [[ ! "$mapped_port" =~ ^[0-9]+$ ]]; then
  echo "Could not determine local PostgreSQL port" >&2
  exit 1
fi
POSTGRES_TEST_URL="postgres://postgres:${password}@127.0.0.1:${mapped_port}/postgres" \
  node tests/postgres/advisory-lock.integration.js

cleanup
trap - EXIT
if docker inspect "$name" >/dev/null 2>&1; then
  echo "PostgreSQL local test container cleanup failed" >&2
  exit 1
fi
echo "PostgreSQL local test container cleanup OK"
