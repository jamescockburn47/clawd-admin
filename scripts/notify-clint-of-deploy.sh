#!/usr/bin/env bash
# scripts/notify-clint-of-deploy.sh — post a signed knowledge-refresh
# webhook to Clint after a bot-council deploy.
#
# Install by adding one line at the END of bot-council's scripts/ship.sh:
#
#     ~/clawd-admin/scripts/notify-clint-of-deploy.sh "$(git rev-parse HEAD)" || true
#
# (trailing `|| true` keeps deploys green if Clint is down — the 15-min
# pull-based poll picks up the SHA change anyway.)
#
# Environment variables:
#   LQCOUNCIL_REFRESH_SECRET (required)
#       Shared secret. Same value as on Clint side. Set in the caller's
#       shell profile or /etc/bot-council.env.
#   CLINT_REFRESH_URL (optional)
#       Override the endpoint URL. Default is the Tailscale-internal
#       http://100.90.66.54:3000/api/lqcouncil-knowledge-refresh — which
#       is what James's laptop (on the tailnet) should use. Change only
#       if calling from a non-tailnet host with a public ingress.
#
# Arguments:
#   $1 — commit SHA (usually `$(git rev-parse HEAD)`).
#   $2 — optional reason string for the log (default: "ship.sh").
#
# Exits 0 on success OR when the endpoint dedupes the SHA (200 response).
# Exits 1 on signature rejection (401) or server error (5xx) so CI can
# fail loudly if the secret has drifted. Network errors are logged but
# exit 0 — deploy shouldn't be blocked by a flaky tailnet.

set -u

COMMIT_SHA="${1:-}"
REASON="${2:-ship.sh}"
ENDPOINT="${CLINT_REFRESH_URL:-http://100.90.66.54:3000/api/lqcouncil-knowledge-refresh}"

if [[ -z "${COMMIT_SHA}" ]]; then
  echo "notify-clint-of-deploy: missing commit SHA arg; skipping" >&2
  exit 0
fi
if [[ -z "${LQCOUNCIL_REFRESH_SECRET:-}" ]]; then
  echo "notify-clint-of-deploy: LQCOUNCIL_REFRESH_SECRET unset; skipping (Clint's 15-min poll will pick up the change)" >&2
  exit 0
fi

PAYLOAD=$(printf '{"commit_sha":"%s","reason":"%s","deploy_time":"%s"}' \
  "${COMMIT_SHA}" "${REASON}" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")")

# HMAC-SHA256 over the RAW body bytes. No prefix — matches what Clint's
# endpoint expects. Use openssl (ubiquitous) rather than shasum so this
# works on both macOS and Linux.
SIG=$(printf '%s' "${PAYLOAD}" | openssl dgst -sha256 -hmac "${LQCOUNCIL_REFRESH_SECRET}" -hex | awk '{print $NF}')
if [[ -z "${SIG}" ]]; then
  echo "notify-clint-of-deploy: HMAC computation failed; skipping" >&2
  exit 0
fi

# Fire-and-forget semantics: short timeouts so a broken Clint doesn't
# stall the deploy. `--fail-with-body` returns non-zero on 4xx/5xx so we
# can distinguish auth/secret failures from plain network errors.
HTTP_CODE=$(curl -sS -o /tmp/clint-refresh.out -w '%{http_code}' \
  --connect-timeout 5 --max-time 20 \
  -X POST "${ENDPOINT}" \
  -H 'Content-Type: application/json' \
  -H "x-clint-signature: ${SIG}" \
  --data-binary "${PAYLOAD}" || echo "000")

case "${HTTP_CODE}" in
  200|202)
    echo "notify-clint-of-deploy: ok (${HTTP_CODE}) — $(cat /tmp/clint-refresh.out)"
    exit 0
    ;;
  401)
    echo "notify-clint-of-deploy: signature rejected (401). LQCOUNCIL_REFRESH_SECRET mismatch between ship host and Clint." >&2
    exit 1
    ;;
  503)
    echo "notify-clint-of-deploy: Clint refresh disabled (503). Secret likely unset on Clint side." >&2
    exit 0
    ;;
  000)
    echo "notify-clint-of-deploy: network unreachable. Clint's 15-min poll will pick up the change." >&2
    exit 0
    ;;
  *)
    echo "notify-clint-of-deploy: unexpected ${HTTP_CODE} — $(cat /tmp/clint-refresh.out)" >&2
    [[ "${HTTP_CODE}" =~ ^5 ]] && exit 1 || exit 0
    ;;
esac
