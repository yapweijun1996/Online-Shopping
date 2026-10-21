#!/usr/bin/env bash
# Prints a fresh one-time SuperAdmin claim link for the GCP shop. Run it on YOUR computer (needs a logged-in gcloud with IAP SSH access).
#
#   scripts/gcp-claim-link.sh
#
# It restarts ONLY the backend container (stop-before-start, so older links are invalidated and exactly one live link exists), waits until it is
# healthy, then prints the single `platform.claim.issued` log line. Open the printed URL yourself within 30 minutes; whoever opens it first can claim.
# Never paste the link anywhere else. Nothing is stored locally. It does not touch the database container or any password.
set -euo pipefail
PROJECT="${GCP_PROJECT:-cloudops-mcp-175269}"
ZONE="${GCP_ZONE:-asia-southeast1-b}"
INSTANCE="${GCP_INSTANCE:-cloudops-host}"
exec gcloud compute ssh "$INSTANCE" --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet --command '
set -eu
R=/opt/online-shopping-gcp
C="sudo docker compose -p online-shopping-gcp --env-file $R/runtime.env --env-file $R/images.env -f $R/compose.yaml"
grep -q "^PLATFORM_ADMIN_CLAIM_ENABLED=1" <(sudo cat $R/runtime.env) || { echo "Claim mode is off in runtime.env" >&2; exit 2; }
$C stop backend </dev/null >/dev/null 2>&1
$C up -d --no-deps --no-build backend </dev/null >/dev/null 2>&1
for i in $(seq 1 60); do
  [ "$(sudo docker inspect -f "{{.State.Health.Status}}" online-shopping-gcp-backend-1 </dev/null 2>/dev/null)" = healthy ] && break
  sleep 3
done
sudo docker logs --since 5m online-shopping-gcp-backend-1 2>&1 </dev/null | grep "platform.claim.issued" | tail -1 || { echo "No claim line found (an administrator may already exist)" >&2; exit 3; }
' 2>/dev/null
