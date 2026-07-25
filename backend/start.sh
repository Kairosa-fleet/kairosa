#!/usr/bin/env sh
# Container start: apply migrations, then serve.
#
# A script rather than an inline command because platform shells (Render, Fly,
# etc.) re-wrap an inline `sh -c "…"` and mangle the nested quotes — which is
# exactly what produced an "exited with status 127" on the first deploy. A file
# has no quoting for anything to mangle.
set -e

# `alembic upgrade head` is idempotent: a no-op when the schema is current, so
# re-running it on every restart/redeploy is safe. It needs DATABASE_URL — if
# that is unset or wrong the error surfaces here, clearly, instead of a cryptic
# start failure.
alembic upgrade head

# Bind to the port the platform injects ($PORT); fall back to 8000 for local
# `docker run`. Honour $WEB_CONCURRENCY when the platform sets it (Render sizes
# it to the instance), else default to 2 workers.
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers "${WEB_CONCURRENCY:-2}"
