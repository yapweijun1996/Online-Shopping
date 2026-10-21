#!/usr/bin/env bash
# Sets a new temporary password for a seller account of the GCP default shop. Run it on YOUR computer (needs a logged-in
# gcloud with IAP SSH access).
#
#   scripts/gcp-reset-seller-password.sh            # resets the default shop Owner "seller"
#   scripts/gcp-reset-seller-password.sh someuser   # resets another seller account of the default shop
#
# You type the password here; it is not echoed, never placed on a command line (local or remote) and only travels through
# the SSH session's standard input into the backend container's environment. The account must change it at the next
# sign-in and its open sessions are ended. Tenant shops: use "Reset seller password" in the SuperAdmin console instead.
set -euo pipefail
PROJECT="${GCP_PROJECT:-cloudops-mcp-175269}"
ZONE="${GCP_ZONE:-asia-southeast1-b}"
INSTANCE="${GCP_INSTANCE:-cloudops-host}"
USERNAME="${1:-seller}"
[[ "$USERNAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$ ]] || { echo "Invalid username." >&2; exit 2; }

read -rsp "New temporary password for $USERNAME (12-256 characters, not containing the username): " PASSWORD; echo
read -rsp "Repeat it: " AGAIN; echo
[ "$PASSWORD" = "$AGAIN" ] || { echo "The passwords do not match." >&2; exit 2; }
[ "${#PASSWORD}" -ge 12 ] && [ "${#PASSWORD}" -le 256 ] || { echo "Use 12 to 256 characters." >&2; exit 2; }
[[ "$PASSWORD" != *$'\n'* ]] || { echo "The password must be a single line." >&2; exit 2; }
unset AGAIN

printf '%s\n' "$PASSWORD" | gcloud compute ssh "$INSTANCE" --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet --command "
set -eu
IFS= read -r NEW_SELLER_PASSWORD
export NEW_SELLER_PASSWORD
R=/opt/online-shopping-gcp
sudo --preserve-env=NEW_SELLER_PASSWORD docker compose -p online-shopping-gcp --env-file \$R/runtime.env --env-file \$R/images.env -f \$R/compose.yaml \
  exec -T -e NEW_SELLER_PASSWORD backend node scripts/reset-seller-password.js '$USERNAME' </dev/null 2>&1
" 2>/dev/null
# The result line (success or "Could not reset: ...") arrives on standard output; gcloud's own IAP chatter is discarded.
