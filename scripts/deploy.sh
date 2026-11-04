#!/bin/bash
# Deploy: apply new D1 migrations to the live database, ship the Worker, then a smoke check.
# `land` runs this from a clean copy at the merge commit (never from a working tree with local changes).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || { echo "NAMED STOP [DIRTY_TREE] uncommitted changes here; deploy only from a clean checkout (land does this)." >&2; exit 1; }
echo "applying migrations to mrt-site (additive only)"
CI=true npx wrangler d1 migrations apply mrt-site --remote
echo "deploying the Worker"
out="$(npx wrangler deploy 2>&1)"; echo "$out"
url="$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$out" | head -1 || true)"
[ -n "$url" ] || { echo "NAMED STOP [NO_URL] the deploy printed no workers.dev address; check the output above." >&2; exit 9; }
code="$(node -e 'fetch(process.argv[1]+"/health").then(r=>console.log(r.status)).catch(()=>console.log(0))' "$url")"
[ "$code" = 200 ] || { echo "NAMED STOP [SMOKE_FAILED] $url/health answered $code after the deploy." >&2; exit 9; }
echo "deployed and answering: $url"
