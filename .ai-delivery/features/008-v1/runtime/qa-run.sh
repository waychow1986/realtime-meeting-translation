#!/usr/bin/env bash
# Independent test entry for 008-v1 (caption line spacing). Runs in an empty writable working directory.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(pwd)"
: "${QA_RESULT_PATH:=$WORK/qa-result.json}"
: "${QA_EVIDENCE_DIR:=$WORK/evidence}"
export QA_RESULT_PATH QA_EVIDENCE_DIR
mkdir -p "$QA_EVIDENCE_DIR"

write_fallback() {
  # Only used when the driver could not produce any result at all.
  if [ ! -s "$QA_RESULT_PATH" ]; then
    printf '{"schemaVersion":2,"testedCommitSha":"%s","summary":"%s","scenarios":[]}\n' \
      "${QA_CANDIDATE_SHA:-}" "$1" > "$QA_RESULT_PATH"
  fi
}

# Driver files are copied next to the locally installed packages so that ESM resolution finds them.
rm -rf "$WORK/qa" && cp -r "$HERE/qa" "$WORK/qa"
cd "$WORK"
if [ ! -d node_modules/playwright-core ]; then
  [ -f package.json ] || echo '{"name":"qa-run","private":true,"type":"module"}' > package.json
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --silent playwright-core@1.65.1 \
    > "$QA_EVIDENCE_DIR/npm-install.log" 2>&1 || { write_fallback "测试脚本依赖安装失败（npm install playwright-core）"; exit 0; }
fi
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

xvfb-run -a --server-args="-screen 0 1920x1080x24" node qa/main.mjs
write_fallback "测试脚本未能写出结果"
exit 0
