# G3 独立测试 · 结果复核与补充探测

- 候选：`353a3358f8e14986c047193ec679adedff79917e`，地址 `https://cand-42ad37e84bf9.eastus2.cloudapp.azure.com`
- 测试计划：`tasks-qa.md` v1 + `runtime/qa-run.sh`，指纹 `sha256:2f5df71150367e70e92d42b01d64720b40d37cdc95da32ca0f9cf9099aca7174`（已按“计划 + 脚本”拼接内容核对一致）
- 执行：2026-11-21 06:01–06:04 UTC，锁定脚本退出码 0，结果原文见 `qa-result.json`，逐检查点日志见 `run.log`
- 锁定脚本结论：23 个场景中 19 个通过；脚本记录 3 条产品缺陷、3 条未能完成验证。以下为对每项未通过检查点的复核。复核用的补充探测只读访问候选，不修改计划与脚本。

## 1. IQA-103 c4（临时与定稿样式不同）——脚本判定口径问题，不是产品缺陷

- `iqa-103-stream.json` 中第 1 句字幕的历史：临时状态样式为 `rgb(182,194,207)`、虚线边框；在 t=…923618 出现第一条带 final 标记的快照，样式仍是临时样式，文本与最后一条临时字幕相同；700 ms 后（t=…924318）替换为定稿译文，样式变为 `rgb(255,255,255)`、实线透明边框，与临时样式明显不同。
- 脚本只拿“第一条 final 快照”的样式和临时样式比较，正好取到切换瞬间的快照，所以判为“相同”。
- 同一候选在 IQA-119 c4（系统声音会话）中测得临时与定稿样式不同（PASS，见 `run.log`）。
- 结论：AC-03 要求的流式行为（句子结束前出字幕、持续更新、结束后替换为定稿）在 c1、c2、c3、c5 中都已通过；c4 未通过是脚本取样口径造成的。

## 2. IQA-119 c5（字号档在小窗中生效）——测试工具造成的误判，不是产品缺陷

- 锁定脚本测得小窗字幕始终是 16 px、黑色、无边框，也就是浏览器默认样式（`iqa-119-sizes.json`、`iqa-122-sync.json`）；主页面四档为 24/32/40/52 px，行距 1.5 倍，生效时间 ≤ 11 ms。
- 补充探测（Playwright Chromium，有头模式，Xvfb，假麦克风播放同一批合成素材，打开“弹出字幕小窗”，开始后切换字号）：
  - 不注册 Playwright `context.route`：小窗加载了 1 个样式表，背景 `rgb(13,17,23)`；字幕 `li.caption` 在“中/小/大/特大”四档下依次为 32/24/40/52 px，与主页面同步变化；临时字幕颜色 `rgb(182,194,207)`，与定稿不同。
  - 和锁定脚本一样注册 `context.route('/__qa__/…')` 后：小窗样式表数为 0，背景透明，全部文字为 16 px 黑色，切换到“特大”后仍为 16 px，完全复现脚本观测。
- 结论：脚本拦截请求，导致 Document Picture-in-Picture 小窗加载不到样式表；候选本身的小窗字号能随档位变化。AC-11 的其余检查点（IQA-118、IQA-119 c1–c4/c6/c7、IQA-120、IQA-121）全部通过。

## 3. IQA-123 c3（Firefox 麦克风模式出字幕）——执行环境问题，不是产品缺陷

- 补充探测：Firefox 159.0（Playwright），使用 `media.navigator.streams.fake`。点击“开始”后，页面一直停在“正在启动…”；已经和语音服务 `eastus2.stt.speech.microsoft.com` 建立 WebSocket，但 30 s 内状态不变（截图 `supp-firefox-mic.png`）。
- 同一环境下 Firefox `new AudioContext()` 调用 `resume()` 后状态仍为 `suspended`，原因是测试容器没有音频输出设备。锁定脚本也已注明这一限制（脚本第 196 行）。Chromium 中同类流程（IQA-113、IQA-122 c5）正常出字幕。
- Firefox 不在 A-01 的目标浏览器内。AC-06 只要求 Firefox 显示“不支持系统声音”的说明，IQA-109 c1/c2 已通过。

## 4. IQA-123 c1/c2（不支持的浏览器上小窗按钮不可用）——测试计划假设 T-A5 不成立

- Firefox 159.0 提供 `documentPictureInPicture`，候选在 Firefox 中启用了按钮，点击后能打开小窗。这说明 Firefox 在 AC-12 中属于“支持的浏览器”，所以 c1/c2 的前提不成立（脚本已记为测试计划问题）。
- 补充探测：WebKit 27.2（Playwright，不支持 Document PiP）中，“弹出字幕小窗”按钮为禁用状态，旁边显示“当前浏览器不支持悬浮字幕小窗。请使用 Windows 或 macOS 上最新版的 Chrome 或 Edge。”（截图 `supp-webkit-pip.png`）。这满足 AC-12 中“不支持的浏览器上该按钮不可用并用中文说明原因”。

## 5. IQA-114 c4（reasoning 关闭）——服务日志元数据中有正面证据

- 平台服务日志（`QA_SERVICE_LOGS_DIR`，`status=ok`，`gaps=[]`，`logsReadAt=2026-11-21T06:08:37Z`，覆盖整个测试时段，共 779 行）中，`translation_completed` 事件共 268 条：
  - 已完成的 215 条全部为 `reasoningTokens: 0`，`model: gpt-5.1-2025-11-13`，与注入依赖的部署 `gpt-5.1` 一致；
  - 其余 53 条为 `errorCode: client_aborted`，即被更新的临时译文取代而由客户端中止，未产生用量。
  - `inputSource` 中 `microphone` 163 条、`system` 105 条，两种模式都覆盖；`sourceLanguage` 为服务自动识别的结果（`en-US`）。
- 锁定脚本只检索 `reasoning_effort`/`reasoning: disabled` 等字样，没有认出 `reasoningTokens: 0` 这一字段，所以记为“未找到证据”。
- 观察（不影响验收标准）：45 条 `unhandled_error`（`/api/translations`，`internal_error`）与上述 `client_aborted` 中止一一对应，原因是客户端中止被同时记成了未处理错误。这些日志只含元数据，不含识别文本或译文（IQA-116 已通过）。

## 6. 证据凭据扫描

- 对本目录全部文件扫描注入依赖的密钥值（2 个，长度 ≥ 8）：命中 0 次。
