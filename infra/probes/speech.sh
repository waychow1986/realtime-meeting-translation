#!/usr/bin/env bash
# Probe for dependency "speech" (Azure AI Foundry speech-to-text).
# Reports: reachable, authenticated, and constraints
#   realtime-streaming-stt, language-auto-detection
# Never prints secrets or tokens. Uses only bash/curl/jq/openssl/timeout/sed.
set -u

RESULT_PATH="${AIDH_PROBE_RESULT:?AIDH_PROBE_RESULT not set}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

reachable=false
authenticated=false
rt_status=unsatisfied
rt_evidence="not evaluated"
lid_status=unsatisfied
lid_evidence="not evaluated"

write_result() {
  jq -n \
    --argjson reachable "$reachable" \
    --argjson authenticated "$authenticated" \
    --arg rt_status "$rt_status" --arg rt_evidence "$rt_evidence" \
    --arg lid_status "$lid_status" --arg lid_evidence "$lid_evidence" \
    '{reachable: $reachable, authenticated: $authenticated, results: [
        {name: "realtime-streaming-stt", status: $rt_status, evidence: $rt_evidence},
        {name: "language-auto-detection", status: $lid_status, evidence: $lid_evidence}
     ]}' > "$RESULT_PATH"
}

host_of() { # "host:443" -> "host"; "host:8443" -> "host:8443"
  local v="${1#https://}"; v="${v#wss://}"; v="${v%%/*}"
  case "$v" in *:443) echo "${v%:443}";; *) echo "$v";; esac
}

ENDPOINT_HOST="$(host_of "${AIDH_DEP_SPEECH_ENDPOINT:-}")"
STT_HOST="$(host_of "${AIDH_DEP_SPEECH_STT_HOST:-}")"
AUTH_MODE="${AIDH_DEP_SPEECH_AUTH_MODE:-credential}"

if [ -z "$ENDPOINT_HOST" ] || [ -z "$STT_HOST" ]; then
  rt_evidence="ENDPOINT or STT_HOST access field is empty"
  lid_evidence="$rt_evidence"
  write_result; exit 0
fi

# --- Entra token for platform-identity (workload identity, then IMDS) ---
get_entra_token() {
  local scope="https://cognitiveservices.azure.com/.default" tok=""
  if [ -n "${AZURE_FEDERATED_TOKEN_FILE:-}" ] && [ -r "${AZURE_FEDERATED_TOKEN_FILE}" ] \
     && [ -n "${AZURE_CLIENT_ID:-}" ] && [ -n "${AZURE_TENANT_ID:-}" ]; then
    local authority="${AZURE_AUTHORITY_HOST:-https://login.microsoftonline.com/}"
    tok="$(curl -sS --max-time 15 -X POST "${authority%/}/${AZURE_TENANT_ID}/oauth2/v2.0/token" \
      --data-urlencode "client_id=${AZURE_CLIENT_ID}" \
      --data-urlencode "scope=${scope}" \
      --data-urlencode "grant_type=client_credentials" \
      --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
      --data-urlencode "client_assertion=$(cat "${AZURE_FEDERATED_TOKEN_FILE}")" 2>/dev/null \
      | jq -r '.access_token // empty' 2>/dev/null)"
  fi
  if [ -z "$tok" ]; then
    local cid=""; [ -n "${AZURE_CLIENT_ID:-}" ] && cid="&client_id=${AZURE_CLIENT_ID}"
    tok="$(curl -sS --max-time 5 -H 'Metadata: true' \
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://cognitiveservices.azure.com/${cid}" 2>/dev/null \
      | jq -r '.access_token // empty' 2>/dev/null)"
  fi
  printf '%s' "$tok"
}

# --- 1. Exchange for a short-lived speech token at the STS endpoint ---
HDR_FILE="$WORK/sts.hdr"
case "$AUTH_MODE" in
  credential)
    if [ -z "${AIDH_DEP_SPEECH_KEY:-}" ]; then
      rt_evidence="auth mode credential but KEY access field is empty"; lid_evidence="$rt_evidence"
      write_result; exit 0
    fi
    printf 'Ocp-Apim-Subscription-Key: %s\n' "$AIDH_DEP_SPEECH_KEY" > "$HDR_FILE" ;;
  platform-identity)
    ENTRA="$(get_entra_token)"
    if [ -z "$ENTRA" ]; then
      reachable=true
      rt_evidence="auth mode platform-identity but no identity token could be obtained in the probe environment"
      lid_evidence="$rt_evidence"
      # still check reachability of the STS host
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'Content-Length: 0' \
        "https://${ENDPOINT_HOST}/sts/v1.0/issueToken" 2>/dev/null || true)"
      [ "$code" = "000" ] || [ -z "$code" ] && reachable=false
      write_result; exit 0
    fi
    printf 'Authorization: Bearer %s\n' "$ENTRA" > "$HDR_FILE" ;;
  *)
    rt_evidence="unknown auth mode"; lid_evidence="$rt_evidence"; write_result; exit 0 ;;
esac

STS_CODE="$(curl -sS -o "$WORK/sts.token" -w '%{http_code}' --max-time 20 -X POST \
  -H @"$HDR_FILE" -H 'Content-Length: 0' \
  "https://${ENDPOINT_HOST}/sts/v1.0/issueToken" 2>/dev/null || true)"
rm -f "$HDR_FILE"

if [ -z "$STS_CODE" ] || [ "$STS_CODE" = "000" ]; then
  rt_evidence="STS endpoint did not respond"; lid_evidence="$rt_evidence"
  write_result; exit 0
fi
reachable=true
if [ "$STS_CODE" != "200" ] || [ ! -s "$WORK/sts.token" ]; then
  rt_evidence="STS issueToken returned HTTP ${STS_CODE}"; lid_evidence="$rt_evidence"
  write_result; exit 0
fi
authenticated=true

# --- 2. WebSocket upgrade on the real-time endpoints with the short-lived token ---
ws_handshake() { # $1 = path ; prints HTTP status of the upgrade response
  local key conn
  key="$(openssl rand -base64 16)"
  conn="$(openssl rand -hex 16)"
  printf 'Authorization: Bearer %s\n' "$(cat "$WORK/sts.token")" > "$WORK/ws.hdr"
  local code
  code="$(timeout 20 curl -sS --http1.1 -o /dev/null -w '%{http_code}' --max-time 8 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: ${key}" -H "X-ConnectionId: ${conn}" -H @"$WORK/ws.hdr" \
    "https://${STT_HOST}$1" 2>/dev/null || true)"
  rm -f "$WORK/ws.hdr"
  printf '%s' "${code:-000}"
}

RT_CODE="$(ws_handshake '/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=simple')"
if [ "$RT_CODE" = "101" ]; then
  rt_status=satisfied
  rt_evidence="real-time conversation recognition WebSocket accepted the token (HTTP 101 Switching Protocols)"
else
  rt_evidence="real-time recognition WebSocket upgrade returned HTTP ${RT_CODE}"
fi

LID_CODE="$(ws_handshake '/speech/universal/v2')"
if [ "$LID_CODE" = "101" ]; then
  lid_status=satisfied
  lid_evidence="universal/v2 endpoint (continuous language identification) accepted the token (HTTP 101 Switching Protocols)"
else
  lid_evidence="universal/v2 WebSocket upgrade returned HTTP ${LID_CODE}"
fi

write_result
exit 0
