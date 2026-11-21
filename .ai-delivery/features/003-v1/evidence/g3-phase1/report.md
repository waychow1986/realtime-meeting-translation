# G3 独立测试报告（003-v1，第 1/1 阶段）

- 候选：`1e8b16438d4379f7a859dc1f6365b8f192e13585`，地址 `AIDH_SERVICE_WEB_URL`（health=healthy）
- 测试计划：`tasks-qa.md` 第 1 版，指纹 `sha256:8375d08b3d238ebfcb12426f903d312fdb1de6daba4d1d2089a4980d793afb24`（已核对：计划与 `runtime/qa-run.sh` 拼接后的 SHA-256 与锁定值一致）
- 执行时间：2026-11-21 16:26–16:32 UTC
- 上一次执行针对的是旧候选 `89b1005…`，其证据已移到 `prior-89b1005/` 留作参考，本报告的结论只依据对当前候选的重新执行。

## 1. 锁定脚本执行结果（`qa-result.json`、`harness.log`、`run-*.json`、`*-nocontrol.png`）

脚本在空临时目录中运行并以 0 退出：11 个场景通过 0 个。全部失败都出在脚本自身，没有测到被测行为：

1. **所有浏览器场景（IQA-301～307、311、312）**：页面首次打开时会自动弹出模态对话框“使用引导”（`dialog#guide`，modal=true），盖住整个页面。脚本没有关闭它，所以找不到可点击的“系统声音”，或者点击“开始”超时。这些运行都没有发出任何 `/api/translations` 请求。复核：`supp-guide-dialog-probe.txt`（当前候选上，“开始”按钮中心点最上层的元素是 `DIALOG#guide`；点击“知道了”后变为 `BUTTON#start-button`）。“使用引导”是既有界面功能，不是本次的缺陷。
2. **IQA-308/309**：浏览器场景没有捕获到请求体模板，脚本于是使用退回格式（依赖假设 A-1），服务端立即返回 `400 invalid_request`，流式翻译从未开始。因此“client_aborted 0 条”不是产品缺陷，而是测试没有触发中止。脚本把这 4 条写进 defects 属于误归类，本报告按测试计划问题处理。

归类：测试计划问题。测试计划需要修订：关闭首次使用引导；请求体模板缺失时，不应以退回格式判定中止场景。

## 2. 按测试计划 IQA-308/309 的补充执行（`supp-*`，针对当前候选）

- 模板捕获（`supp-capture.mjs` → `supp-browser-capture-mic-ko.json`）：关闭使用引导，选择“麦克风”，以合成的韩语语音（edge-tts，5 句）作为输入。浏览器实际发出的请求体为 `{"kind","text","sourceLanguage":"ko-KR","inputSource":"microphone"}`，响应为 `application/x-ndjson` 流。
- 中止执行（`supp-abort.mjs` → `supp-abort-cases.json`）：使用 `kind:"final"` 模板和约 6 句韩语长文本，主动取消与断开连接两种方式，各在首个片段前（150 ms，收到 0 字节）和首个片段后（已收到含汉字的片段、响应未结束）中止；每次之后发出一条正常请求。
- 日志判定（`supp-abort-logs-analyze.py` → `supp-abort-logs-summary.json`，不含日志正文）：`status`=ok，`logsReadAt`=16:31:40Z，晚于全部时间窗，`gaps` 为空。

| 时机 / 方式 | 中止时已收正文 | error/fatal | client_aborted（info） | 内容命中 | 凭据/`***` 命中 | 随后正常请求 |
| --- | --- | --- | --- | --- | --- | --- |
| 首片段前 / 主动取消 | 0 字节 | 0 | 1（deltaCount=0） | 0 | 0 / 0 | 200，含汉字，无谚文 |
| 首片段前 / 断开连接 | 0 字节 | 0 | 1（deltaCount=0） | 0 | 0 / 0 | 200，含汉字，无谚文 |
| 首片段后 / 主动取消 | 33 字节，含汉字，未结束 | 0 | 1（deltaCount=1） | 0 | 0 / 0 | 200，含汉字，无谚文 |
| 首片段后 / 断开连接 | 33 字节，含汉字，未结束 | 0 | 1（deltaCount=2） | 0 | 0 / 0 | 200，含汉字，无谚文 |

- 整个会话期间共有 9 条 `client_aborted` 记录（含浏览器按设计中止的临时请求），字段集完全一致：`deltaCount,durationMs,errorCode,event,inputSource,kind,level,msg,reqId,sourceLanguage,textLength,time`，没有原文、译文或凭据字段（依赖假设 A-7）。会话期间全部 187 条服务日志都是 info 级，凭据值命中 0 次。

## 3. 其它观察（不作为验收结论）

- 模板捕获时用麦克风跑了一次 5 句韩语：主页面字幕为 5 条中文，没有谚文。这只是一次非受控运行，不能替代 IQA-301。

## 4. AC-13（IQA-313）

工作区中找不到 `design.md`（Feature 目录只有 `intent.md`、`spec.md`、`tasks-qa.md`、`runtime/`），无法阅读技术方案，判为无法验证（环境或平台问题）。

## 5. 各验收标准结果

| AC | 结果 | 归类 | 依据 |
| --- | --- | --- | --- |
| AC-1、AC-2、AC-3、AC-4、AC-5、AC-6、AC-11、AC-12 | 无法验证 | 测试计划问题 | 第 1 节：脚本没有关闭首次使用引导对话框 |
| AC-7、AC-8、AC-10 | 通过 | — | 第 2 节（依赖假设 A-1、A-7） |
| AC-9 | 无法验证 | 测试缺口 | G2 决定（I1） |
| AC-13 | 无法验证 | 环境或平台问题 | 第 4 节 |
