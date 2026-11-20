#!/usr/bin/env bash
# Probe for dependency "chat-model" (Azure AI Foundry chat model deployment, gpt-5.1 by default).
# Reports: reachable, authenticated, and constraint
#   reasoning-disabled : a call with reasoning_effort "none" succeeds and uses 0 reasoning tokens
# Never prints secrets, tokens or model output text.
set -u

RESULT_PATH="${AIDH_PROBE_RESULT:?AIDH_PROBE_RESULT not set}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

reachable=false
authenticated=false
rd_status=unsatisfied
rd_evidence="not evaluated"

write_result() {
  jq -n \
    --argjson reachable "$reachable" --argjson authenticated "$authenticated" \
    --arg s "$rd_status" --arg e "$rd_evidence" \
    '{reachable: $reachable, authenticated: $authenticated, results: [
        {name: "reasoning-disabled", status: $s, evidence: $e}
     ]}' > "$RESULT_PATH"
}

host_of() {
  local v="${1#https://}"; v="${v%%/*}"
  case "$v" in *:443) echo "${v%:443}";; *) echo "$v";; esac
}

HOST="$(host_of "${AIDH_DEP_CHAT_MODEL_ENDPOINT:-}")"
DEPLOYMENT="${AIDH_DEP_CHAT_MODEL_DEPLOYMENT:-}"
AUTH_MODE="${AIDH_DEP_CHAT_MODEL_AUTH_MODE:-credential}"

if [ -z "$HOST" ] || [ -z "$DEPLOYMENT" ]; then
  rd_evidence="ENDPOINT or DEPLOYMENT access field is empty"; write_result; exit 0
fi

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

HDR_FILE="$WORK/auth.hdr"
case "$AUTH_MODE" in
  credential)
    if [ -z "${AIDH_DEP_CHAT_MODEL_KEY:-}" ]; then
      rd_evidence="auth mode credential but KEY access field is empty"; write_result; exit 0
    fi
    printf 'api-key: %s\n' "$AIDH_DEP_CHAT_MODEL_KEY" > "$HDR_FILE" ;;
  platform-identity)
    ENTRA="$(get_entra_token)"
    if [ -z "$ENTRA" ]; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${HOST}/openai/v1/models" 2>/dev/null || true)"
      if [ -n "$code" ] && [ "$code" != "000" ]; then reachable=true; fi
      rd_evidence="auth mode platform-identity but no identity token could be obtained in the probe environment"
      write_result; exit 0
    fi
    printf 'Authorization: Bearer %s\n' "$ENTRA" > "$HDR_FILE" ;;
  *)
    rd_evidence="unknown auth mode"; write_result; exit 0 ;;
esac

jq -n --arg model "$DEPLOYMENT" '{
  model: $model,
  messages: [
    {role: "system", content: "Translate the text inside <source> into Simplified Chinese. Output only the translation."},
    {role: "user", content: "<source lang=\"en-US\">Good morning, everyone. Let us review the quarterly results.</source>"}
  ],
  reasoning_effort: "none",
  max_completion_tokens: 128
}' > "$WORK/body.json"

CODE="$(curl -sS -o "$WORK/resp.json" -w '%{http_code}' --max-time 60 -X POST \
  -H @"$HDR_FILE" -H 'Content-Type: application/json' \
  --data-binary @"$WORK/body.json" \
  "https://${HOST}/openai/v1/chat/completions" 2>/dev/null || true)"
rm -f "$HDR_FILE"

if [ -z "$CODE" ] || [ "$CODE" = "000" ]; then
  rd_evidence="chat completions endpoint did not respond"; write_result; exit 0
fi
reachable=true
if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  rd_evidence="chat completions returned HTTP ${CODE}"; write_result; exit 0
fi
authenticated=true

if [ "$CODE" != "200" ]; then
  err_code="$(jq -r '.error.code // "unknown"' "$WORK/resp.json" 2>/dev/null | head -c 64)"
  rd_evidence="call with reasoning_effort=none returned HTTP ${CODE} (error code: ${err_code}); deployment missing or model does not support disabling reasoning"
  write_result; exit 0
fi

MODEL="$(jq -r '.model // "unknown"' "$WORK/resp.json" 2>/dev/null | head -c 64)"
RT="$(jq -r '.usage.completion_tokens_details.reasoning_tokens // "absent"' "$WORK/resp.json" 2>/dev/null)"
HAS_CJK="$(jq -r '.choices[0].message.content // ""' "$WORK/resp.json" 2>/dev/null \
  | python3 -c 'import sys,re; print("yes" if re.search(r"[一-鿿]", sys.stdin.read()) else "no")' 2>/dev/null || echo unknown)"

if [ "$RT" = "0" ] || [ "$RT" = "absent" ]; then
  rd_status=satisfied
  rd_evidence="HTTP 200 with reasoning_effort=none; model=${MODEL}; reasoning_tokens=${RT}; reply contains Chinese=${HAS_CJK}"
else
  rd_evidence="HTTP 200 but reasoning_tokens=${RT} with reasoning_effort=none; model=${MODEL}"
fi

write_result
exit 0
