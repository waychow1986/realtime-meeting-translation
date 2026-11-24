#!/usr/bin/env bash
# 独立测试脚本入口（交付 007-v1，IR-003 系统声音静默停滞检测）。
# 在平台给出的空工作目录中运行：安装 playwright，用 xvfb 启动有界面的 Chromium，
# 按测试计划 tasks-qa.md 执行脚本场景并把结果写到 QA_RESULT_PATH。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(pwd)"
: "${QA_RESULT_PATH:=$WORK/qa-result.json}"
: "${QA_EVIDENCE_DIR:=$WORK/evidence}"
: "${QA_TIMEOUT_SECONDS:=3600}"
export QA_RESULT_PATH QA_EVIDENCE_DIR QA_TIMEOUT_SECONDS
mkdir -p "$QA_EVIDENCE_DIR" "$(dirname "$QA_RESULT_PATH")"

if [ -z "${AIDH_SERVICE_WEB_URL:-}" ] && [ -n "${AIDH_SERVICE_1_URL:-}" ]; then
  export AIDH_SERVICE_WEB_URL="$AIDH_SERVICE_1_URL"
fi

if [ ! -d "$WORK/node_modules/playwright" ]; then
  [ -f "$WORK/package.json" ] || echo '{"private":true}' > "$WORK/package.json"
  npm i --no-audit --no-fund --silent playwright@1.65.1 > "$QA_EVIDENCE_DIR/npm-install.log" 2>&1 \
    || echo "npm install failed" >> "$QA_EVIDENCE_DIR/npm-install.log"
fi

node_rc=0
if command -v xvfb-run > /dev/null 2>&1; then
  xvfb-run -a -s "-screen 0 1600x1000x24" node "$HERE/qa/run.mjs" < /dev/null 2>&1 | tee "$QA_EVIDENCE_DIR/run.log"
  node_rc=${PIPESTATUS[0]}
else
  node "$HERE/qa/run.mjs" < /dev/null 2>&1 | tee "$QA_EVIDENCE_DIR/run.log"
  node_rc=${PIPESTATUS[0]}
fi

# 脚本主体异常退出且未写出结果时，写出不含场景的最小结果（平台按无法验证处理）。
if [ ! -s "$QA_RESULT_PATH" ]; then
  printf '{"schemaVersion":2,"testedCommitSha":"%s","summary":"测试脚本主体未能执行（退出码 %s），没有场景结果。","scenarios":[],"externalServices":["speech","chat-model"]}\n' \
    "${QA_CANDIDATE_SHA:-}" "$node_rc" > "$QA_RESULT_PATH"
fi
exit 0
