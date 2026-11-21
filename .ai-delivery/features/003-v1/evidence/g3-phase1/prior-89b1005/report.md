# G3 独立测试报告（003-v1，第 1/1 阶段）

- 候选：`89b1005fd3c69a80f10dafa433025da4d9d1bac5`，地址 `AIDH_SERVICE_WEB_URL`（health=healthy）
- 测试计划：`tasks-qa.md` 第 1 版，指纹 `sha256:8375d08b3d238ebfcb12426f903d312fdb1de6daba4d1d2089a4980d793afb24`（已核对：计划与 `runtime/qa-run.sh` 拼接后的 SHA-256 与锁定值一致）
- 执行时间：2026-11-21 15:58–16:05 UTC

## 1. 锁定脚本执行结果（`qa-result.json`、`harness.log`、`run-*.json`、`*-nocontrol.png`）

脚本在空临时目录中运行并正常退出：11 个场景 0 个通过。全部失败都来自脚本自身，未到达被测行为：

1. **所有浏览器场景（IQA-301～307、311、312）**：页面首次打开时自动弹出模态对话框“使用引导”（`<dialog id="guide">`，`:modal` 为真，按钮“知道了”），覆盖整个页面。脚本没有关闭该对话框，因此找不到可点击的“系统声音”，或点击“开始”超时（`locator.click: Timeout … waiting for element to be visible, enabled and stable`）。所有运行都没有发出任何 `/api/translations` 请求（`run-*.json` 的 `req` 为空）。复核：`supp-guide-dialog-probe.txt`（打开页面后“开始”按钮中心点最上层元素为 `DIALOG#guide`；点击“知道了”后为 `BUTTON#start-button`）。“使用引导”是既有界面功能，并非本次缺陷。
2. **IQA-308/309**：由于浏览器场景未捕获到请求体模板，脚本使用退回格式 `{"text","sourceLanguage","targetLanguage"}`（依赖假设 A-1）；服务端对它立即返回 `400 {"error":"invalid_request"}`，流式翻译从未开始，因此“client_aborted 0 条”不是产品缺陷，而是测试没有触发中止。脚本把这 4 条列为 defects 属于误归类，本报告按测试计划问题处理。

归类：测试计划问题（`test-plan`）。需要测试计划修订（关闭首次使用引导；请求体模板缺失时不应以退回格式判定中止场景）。

## 2. 按测试计划 IQA-308/309 的补充执行（`supp-*`）

依据计划第 6 节 IQA-308/309 的操作与检查点、依赖假设 A-1（请求体模板取自浏览器实际发出的请求）手工执行：

- 模板捕获（`supp-capture.mjs`、`supp-browser-capture-mic-ko.json`）：关闭使用引导后选择“麦克风”，以合成韩语语音（edge-tts，5 句）作为音频输入，记录浏览器实际请求体为 `{"kind":"partial"|"final","text","sourceLanguage":"ko-KR","inputSource":"microphone"}`，响应为 `application/x-ndjson` 流（`delta`…`done`）。
- 中止执行（`supp-abort.mjs`、`supp-abort-cases.json`）：使用 `kind:"final"` 模板与约 6 句韩语长文本，主动取消（请求销毁）与断开连接（销毁套接字）两种方式 × 首个片段前（150 ms，收到 0 字节）/后（收到首个含汉字片段、响应未结束）两种时机；每次之后 1 秒发出正常短句请求；相邻时间窗间隔 8 秒以上。
- 日志判定（`supp-abort-logs-analyze.py`、`supp-abort-logs-summary.json`，不含日志正文）：`status.json` 为 `ok`、`logsReadAt`=16:04:44Z 晚于全部时间窗、`gaps` 为空。

| 时机 / 方式 | 中止时已收正文 | error/fatal | client_aborted（info） | 内容命中 | 凭据/`***` 命中 | 随后正常请求 |
| --- | --- | --- | --- | --- | --- | --- |
| 首片段前 / 主动取消 | 0 字节 | 0 | 1（deltaCount=0） | 0 | 0 / 0 | 200，含汉字，无谚文 |
| 首片段前 / 断开连接 | 0 字节 | 0 | 1（deltaCount=0） | 0 | 0 / 0 | 200，含汉字，无谚文 |
| 首片段后 / 主动取消 | 33 字节，含汉字，未结束 | 0 | 1（deltaCount=1） | 0 | 0 / 0 | 200，含汉字，无谚文 |
| 首片段后 / 断开连接 | 33 字节，含汉字，未结束 | 0 | 1（deltaCount=1） | 0 | 0 / 0 | 200，含汉字，无谚文 |

- `client_aborted` 记录在整个执行期间（9 条，含浏览器按设计中止被取代的临时请求）字段集完全一致：`deltaCount,durationMs,errorCode,event,inputSource,kind,level,msg,reqId,sourceLanguage,textLength,time`，不含原文、译文或凭据字段（依赖假设 A-7）。
- 整个会话期间全部 265 条服务日志均为 info 级，含浏览器真实运行（IQA-309 检查点 6 的参考）。

## 3. 其它观察（不作为验收结论）

- 模板捕获中的麦克风 + 韩语 5 句运行：主页面字幕为 5 条中文（“你好。”“感谢各位参加今天的会议。”等），无谚文。只是一次非受控的麦克风运行，不能替代 IQA-301（系统声音、3 次运行、小窗）。

## 4. AC-13（IQA-313）

本会话工作区的 Feature 目录中只有 `intent.md`、`spec.md`、`tasks-qa.md`、`runtime/`，没有 `design.md`，独立测试无法阅读技术方案，判为无法验证（环境或平台问题）。

## 5. 各验收标准结果

| AC | 结果 | 归类 | 依据 |
| --- | --- | --- | --- |
| AC-1、AC-2、AC-3、AC-4、AC-5、AC-6、AC-11、AC-12 | 无法验证 | 测试计划问题 | 第 1 节：脚本未关闭首次使用引导对话框 |
| AC-7、AC-8、AC-10 | 通过 | — | 第 2 节（依赖假设 A-1、A-7） |
| AC-9 | 无法验证 | 测试缺口 | G2 决定（I1） |
| AC-13 | 无法验证 | 环境或平台问题 | 第 4 节 |
