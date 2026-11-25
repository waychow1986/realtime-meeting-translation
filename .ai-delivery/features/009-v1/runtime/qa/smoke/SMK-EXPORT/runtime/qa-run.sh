#!/usr/bin/env bash
# Smoke case entry (single phase): 已停止时导出字幕。 Runs in an empty writable working directory.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(pwd)"
: "${QA_RESULT_PATH:=$WORK/qa-result.json}"
: "${QA_EVIDENCE_DIR:=$WORK/evidence}"
export QA_RESULT_PATH QA_EVIDENCE_DIR
mkdir -p "$QA_EVIDENCE_DIR"
rm -rf "$WORK/qa" && mkdir -p "$WORK/qa" && cp "$HERE"/qa/*.mjs "$HERE"/qa/*.js "$WORK/qa/"
cd "$WORK"
if [ ! -d node_modules/playwright-core ]; then
  [ -f package.json ] || echo '{"name":"qa-smoke","private":true,"type":"module"}' > package.json
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --silent playwright-core@1.65.1 > "$QA_EVIDENCE_DIR/npm-install.log" 2>&1
fi
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
xvfb-run -a --server-args="-screen 0 1920x1080x24" node qa/main.mjs
if [ ! -s "$QA_RESULT_PATH" ]; then
  printf '{"schemaVersion":2,"testedCommitSha":"%s","summary":"冒烟用例未能写出结果","scenarios":[],"externalServices":["speech","chat-model"]}\n' "${QA_CANDIDATE_SHA:-}" > "$QA_RESULT_PATH"
fi
exit 0
