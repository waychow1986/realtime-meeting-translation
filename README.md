# realtime-meeting-translation
AIDelivery Hub project: 会议中把外语发言实时翻译成中文字幕的 Web 应用

浏览器打开页面、点击“开始”并允许麦克风后，发言由 Azure 语音服务流式识别（连续语言自动识别，无需选择语言），说话过程中即按中间识别结果显示临时中文译文（同一句同时最多 1 个临时翻译请求、两次请求间隔 ≥ 500 ms、原文未变化不重发，失败静默），每句识别完成后由 Foundry 大模型（`gpt-5.1`，`reasoning_effort: "none"`）流式翻译成定稿中文字幕并替换临时译文；点击“停止”立即释放麦克风。字幕只保存在当前页面内存中，刷新即清空。设计依据见 `.ai-delivery/features/001-v1/design.md`。

只显示中文（第 3 版，设计依据见 `.ai-delivery/features/003-v1/design.md`）：

- 临时译文和定稿译文都不再逐片显示，而是整段收齐后先判定“是否为中文”，通过才显示。判定见 `src/shared/chineseText.ts`：至少含一个汉字，且字母只能是汉字、拉丁字母、注音或通用字符，所以出现谚文或假名就不算中文。
- 临时译文不是中文时不显示，继续保留上一条临时译文，也不重译。
- 定稿译文不是中文时，带 `retranslate: true` 恰好重译一次（服务端在提示词中加入更强的说明）。重译仍不是中文时，该句显示中文提示“（此句未能翻译成中文）”：`data-kind="notice"`，颜色为低饱和的 `--caption-notice`，字号是当前档的 0.75 倍，左侧有实线。翻译继续进行，不进入出错状态。
- 提示词已去掉“已是中文则原样输出”。`sourceLanguage` 标为中文、文本却不含汉字或含谚文、假名时，服务端以 `lang="auto"` 发送。
- 临时翻译请求带 `retranslate` 时返回 400 `invalid_request`。`retranslate: true` 只出现在 `translation_completed` 和 `upstream_error` 日志中。
- 根因证据见 `docs/verification/003-ac13-root-cause.txt`。

## 结构

| 路径 | 内容 |
| --- | --- |
| `src/server/` | Node.js 22 + Fastify 单服务：静态页面、`GET /healthz`、`POST /api/speech-token`（短时语音令牌）、`POST /api/translations`（NDJSON 流式翻译代理）、同源校验与限流、白名单日志 |
| `src/web/` | 浏览器端：输入采集（麦克风 / 系统声音，`audioSource.ts`、`displayAudio.ts`、平台识别 `support.ts`）、Speech SDK 连续识别、字幕状态机（`captionPipeline.ts`）、中文界面（状态与按钮可用性 `uiState.ts`、界面偏好 `preferences.ts`、首次使用引导 `guide.ts`） |
| `src/shared/` | 前后端共用的接口约定、中文判定（`chineseText.ts`） |
| `tests/unit/` | 单元测试（Vitest） |
| `tests/integration/` | 针对真实 `dev` 依赖实例的集成测试（语音令牌、流式识别、流式翻译） |
| `tests/e2e/` | Playwright + Chromium 假麦克风（TTS 合成的英语 WAV）的端到端测试 |
| `Dockerfile` | 多阶段构建，运行用户 `10001`，端口 `8080` |

## 配置（环境变量）

| 变量 | 说明 |
| --- | --- |
| `AIDH_DEP_SPEECH_ENDPOINT`、`AIDH_DEP_SPEECH_STT_HOST`、`AIDH_DEP_SPEECH_REGION`、`AIDH_DEP_SPEECH_AUTH_MODE`、`AIDH_DEP_SPEECH_KEY` | 语音依赖（平台注入）；`AUTH_MODE` 为 `credential` 时需要 `KEY`，为 `platform-identity` 时使用托管身份 |
| `AIDH_DEP_CHAT_MODEL_ENDPOINT`、`AIDH_DEP_CHAT_MODEL_DEPLOYMENT`、`AIDH_DEP_CHAT_MODEL_AUTH_MODE`、`AIDH_DEP_CHAT_MODEL_KEY` | 大模型依赖（平台注入），同上 |
| `PORT` | 监听端口，默认 `8080` |
| `LOG_LEVEL` | 默认 `info` |
| `CANDIDATE_LANGUAGES` | 连续语言识别候选语言，默认 `en-US,zh-CN,ja-JP,ko-KR`（1～10 项） |
| `SEGMENTATION_SILENCE_MS` | 断句静音阈值，默认 `800`（300～2000） |
| `TRUSTED_PROXY_HOPS` | 可信代理跳数（限流取网关追加的客户端地址），默认 `1`（0～3） |

配置缺失或不合法时进程以 `event=config_invalid` 退出，日志只列出变量名，不输出取值。密钥只在服务端使用，浏览器只拿到短时语音令牌。

## 界面（v1 产品化，设计依据见 `.ai-delivery/features/002-v1/design.md`）

- 顶部控制区：输入方式（麦克风 / 系统声音，默认麦克风）、“开始”/“停止”、当前状态、字幕字号、“弹出字幕小窗”、“使用引导”。宽度 ≥ 1100 px 时控制区占顶部一行左右，字幕区占据其余全部高度；更窄时控件自动换行、页面整体纵向滚动，始终无横向滚动。
- 五种状态，文字、图标与颜色两两不同：未开始 ○、正在启动… ◔、正在听 ●（脉动）、已停止 ■、出错 ⚠。启动中与正在听时只有“停止”可用、输入方式不可切换；其余状态只有“开始”可用。
- 字幕区：深色背景，定稿字幕为白色；临时字幕为浅灰、左侧虚线并以“…”结尾，被中断的句子为斜体。字号 4 档：小 24 px / 中 32 px（默认）/ 大 40 px / 特大 52 px，行高 1.5，运行中切换不会中断。新字幕到达时如果正停留在底部则自动滚动；向上翻看时不会被拉回，并显示“回到最新字幕 ↓”。
- 首次打开自动显示中文“使用引导”（Esc 或“知道了”关闭），之后不再自动出现，可随时点“使用引导”重新打开。
- 系统声音：选“系统声音”后点“开始”，浏览器弹出共享窗口（`getDisplayMedia`，只使用其中的音频轨道；浏览器附带的低帧率视频轨道从不被读取、显示、上传或保存，与音频轨道一起保留到停止或共享结束时才结束，以便感知“共享已结束”），翻译电脑正在播放的声音，原声照常播放（`suppressLocalAudioPlayback: false`）。选中时显示平台相关的操作说明与支持列表（`supportMatrix.ts`）：Windows 上的 Chrome / Edge 可共享整个屏幕并勾选“同时分享系统音频”或共享标签页；macOS 与 Linux 上的 Chrome / Edge 可靠的方式是共享标签页并勾选“同时分享标签页中的音频”（macOS 共享整个屏幕能否带上系统声音取决于系统与浏览器版本，Linux 共享整个屏幕通常采集不到声音）；Firefox、Safari 与移动端浏览器不支持（说明原因，“开始”不可用，麦克风照常可用）。取消共享、所选内容没有声音、被拒绝、共享中途结束（如关闭被共享的标签页）都会停止翻译并显示对应的中文说明（`messages.ts`）；停止时立即结束共享。翻译请求携带 `inputSource`（`microphone`/`system`），只用于日志统计。
- 字幕小窗：控制区“弹出字幕小窗”用 Document Picture-in-Picture（`documentPictureInPicture.requestWindow`，Chrome / Edge 116+）打开一个悬浮小窗（`pip.ts`），显示当前状态与字幕；字幕管线只有一份，`MirroredCaptionView`（`mirroredCaptionView.ts`）把每次变更先写主页面、再写小窗，两处内容与顺序一致，切换字号同时作用于小窗。打开后按钮变为“关闭字幕小窗”；关闭小窗（按钮或小窗自身的关闭）不影响采集，主页面继续更新，再次弹出会复制当前全部字幕。小窗中不放任何音视频元素，也不请求任何接口。按是否存在 `documentPictureInPicture` 判断支持；浏览器不支持（如 Safari，或不在安全上下文中）时按钮不可用并在旁边用中文说明原因。小窗能否在全屏视频或会议软件之上保持可见由浏览器保证，自动化测试无法证明（设计 DD-101），需在 Windows 上的 Chrome / Edge 中人工试用确认。
- 浏览器 `localStorage` 只保存两项界面偏好：`rtmt.guideSeen`（`1`）与 `rtmt.captionSize`（`s`/`m`/`l`/`xl`）；不保存任何字幕或发言内容，存储不可用时退回默认值。

## 开发者命令

```bash
npm ci                              # 安装依赖
npm run lint && npm run typecheck   # 静态检查
npm run build                       # 构建到 dist/
npm test                            # 单元测试
npm run test:integration            # 集成测试：真实 dev 依赖实例（需 AIDH_DEP_* 变量）
npm run test:e2e                    # 构建后用 Playwright 运行端到端测试（需 AIDH_DEP_* 变量）
```

本地运行：`npm run build && node dist/server/main.js`，访问 `http://localhost:8080`（localhost 为安全上下文，可使用麦克风）。

端到端测试说明：`npm run test:e2e` 在 `xvfb-run`（虚拟屏幕 1920×1080）下以有界面（headed）Chromium 运行，`workers: 1` 串行执行（各用例共用依赖实例的并发与配额）；本机需安装 `xvfb`。服务端在本机端口 `18180+` 启动构建产物，服务端输出写入 `test-results/server-logs/`（用于检查日志不含客户内容）；浏览器使用完整版 Chromium（`channel: 'chromium'`，headless shell 不支持假音频采集），以 `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture` 把 TTS 合成的英语 WAV 作为麦克风输入。测试素材见 `tests/fixtures/sentences.en.json`（`meeting` 组为 6 句会议发言，附参考译文、关键要素与唯一锚点，用于流式临时字幕、含义一致与多句不重不漏的测试）。TTS 按句合成后拼接（前导静音 1 秒、句间 2 秒、末尾 4 秒），WAV 与每句起止时间（`.json`）缓存在系统临时目录；TTS 鉴权与应用相同，按 `AIDH_DEP_SPEECH_AUTH_MODE` 签发短时令牌后以 `Authorization: Bearer` 调用。假麦克风会循环播放 WAV，因此“字幕条数恰好等于句数”的断言在末尾静音之后、循环重放第一句之前进行。

系统声音验收在 `tests/e2e/system.spec.ts`（IQA-101～112、114～117）：每个 worker 用 Playwright 路由打开一个标题为 `RTMT-player-<worker 序号>` 的“播放器”标签页（`tests/support/player.ts`），播放 TTS 合成的 `multi` 组素材；Chromium 以 `--auto-select-tab-capture-source-by-title=…` 自动选中该标签页并共享其音频，同时假麦克风播放 `interference` 组（干扰句，用于验证只翻译所选来源）。取消共享用不存在的标题让共享窗口停留，再由 `tests/support/xkey.py`（Python 3 + `libX11`/`libXtst`，通过 XTest 发送 Esc）关闭；“共享内容没有声音”用 `--auto-select-desktop-capture-source=Entire screen`。默认设备模拟为 Windows Chrome，与 Linux 相关的断言用 `test.use({ userAgent })` 覆盖。IQA-109 需要 Playwright Firefox（`npx playwright install firefox`）；Playwright Firefox 中 Speech SDK 的 AudioWorklet（blob 脚本）被 CSP `script-src 'self'` 拦截，麦克风识别停在“正在启动…”，该用例只验证改回麦克风后可以发起采集（既有限制，v1 端到端测试只覆盖 Chromium）；同一用例也验证 IQA-123（“弹出字幕小窗”不可用并显示原因）。注意 Playwright 自带的 Firefox 159 在安全上下文（如 `http://localhost`）中已提供 Document Picture-in-Picture，该用例在页面脚本运行前移除这个 API 来模拟不支持的浏览器。

字幕小窗验收在 `tests/e2e/pip.spec.ts`（IQA-122）：麦克风与系统声音两种模式下运行中点击“弹出字幕小窗”，经 `documentPictureInPicture.window` 读取小窗文档；仪表脚本（`tests/e2e/fixtures.ts`）在主页面或小窗字幕每次变化时同时记录两处列表，断言逐次一致；另验证字号与状态同步、关闭后主页面继续更新、再次弹出内容一致、小窗无媒体元素且不含凭据。不判定“悬浮在全屏之上”（DD-101）。

界面验收在 `tests/e2e/ui.spec.ts`（IQA-118～121：五种状态、字幕样式与 4 档字号、首次引导、5 种窗口尺寸 × 4 种状态的布局；测量辅助见 `tests/e2e/ui.ts`），截图与测量 JSON 写入各用例的 `test-results/` 输出目录。用例默认通过初始化脚本标记“已看过引导”，`test.use({ guideSeen: false })` 可模拟首次打开。

只显示中文的验收（第 3 版）：

- `tests/e2e/chinese-only.spec.ts`（IQA-301、302）：韩语、日语的 `drama` 素材各运行 3 次，走真实服务。素材见 `tests/fixtures/sentences.ko.json` 和 `sentences.ja.json`，TTS 声音分别为 `ko-KR-SunHiNeural` 和 `ja-JP-NanamiNeural`。韩语第 1 次运行打开字幕小窗。
- `tests/e2e/non-chinese.spec.ts`（IQA-303～307、312）：受控触发。`tests/e2e/translationOverride.ts` 用初始化脚本包装页面的 `window.fetch`，只把指定句子的首次定稿、重译或第 n 个临时翻译替换为谚文流，或者延迟转发；其余请求都走真实服务。生产代码没有任何测试开关。
- 已知限制：上下文启用 Playwright 路由（系统声音的播放器标签页）后，字幕小窗的样式表在测试中不生效，所以提示样式与小窗一致性的用例（IQA-305/307）用麦克风输入。
- 集成测试 `tests/integration/translationChinese.int.test.ts`（TD-311）：向真实模型发送韩语、日语句子（含片段和误标为 zh-CN 的句子），只统计非中文的条数。

语音识别停滞检测（IR-003，设计见 `.ai-delivery/features/007-v1/design.md`）：

- 行为：仅系统声音模式。运行中由 `src/web/stallWatchdog.ts` 每秒检查一次（另在混音 AudioContext 状态变化时立即检查），出现以下任一情况即结束本次运行，页面与字幕小窗显示“出错”，提示“翻译已中断：语音识别已停止输出结果……”，已有字幕保留，可直接点击“开始”重新共享：识别会话意外结束；混音链路中断（AudioContext 不在运行，或送给识别器的混音输出轨道已结束，静音时同样检测）；混音有声音（RMS ≥ −50 dBFS）累计 30 秒仍没有任何识别结果（静音暂停计时、不清零）。停止、共享结束、翻译不可用等既有结束路径不变，结束后不会再出现停滞提示。麦克风模式不启用该检测。
- 测试：单元测试见 `tests/unit/stallWatchdog.test.ts`、`tests/unit/displayAudio.test.ts`（`npm test`）。端到端测试见 `tests/e2e/stall.spec.ts`，走真实服务，故障在浏览器中注入，生产代码没有测试开关：`tests/e2e/speechStall.ts` 包装 `WebSocket`，按需截住语音服务（`AIDH_DEP_SPEECH_STT_HOST`）的下行消息来模拟识别器静默停止；同一文件记录页面创建的混音 AudioContext 及其输出轨道，`breakAudioChain` 用来挂起、关闭它或停止输出轨道（AC-2）；`tests/e2e/translationOverride.ts` 的 `TRANSLATION_FAILURE_SCRIPT` 在运行中让接下来若干句的定稿翻译返回 `upstream_rejected` 或 `upstream_unavailable`（AC-7）。单独运行：`npm run build && xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test tests/e2e/stall.spec.ts -g "AC-2"`（约 1.5 分钟；`-g "AC-7"` 约 4 分钟；整个文件约 18 分钟，含 5 分钟不误报用例）。

## 日志

日志为 JSON 行（pino），只输出白名单字段，取值逐项校验，不合格的字段直接丢弃；从不记录识别原文、译文、令牌或密钥。

字段：`event`、`reqId`、`method`、`route`、`status`、`durationMs`、`kind`、`textLength`、`deltaCount`、`ttfbMs`、`reasoningTokens`、`upstream`、`upstreamStatus`、`errorCode`、`authMode`、`sourceLanguage`、`inputSource`（`microphone`/`system`），以及下述例外字段。

**白名单例外（相对设计 TD-009 新增，理由如下）：**

| 字段 | 取值约束 | 理由 |
| --- | --- | --- |
| `model` | `^[A-Za-z0-9._:-]{1,64}$` | 记录模型服务实际返回的模型名（如 `gpt-5.1-2025-11-13`），作为 AC-07“使用指定模型”的运行证据；不含客户内容 |
| `errorClass` | `^[A-Za-z][A-Za-z0-9_]{0,63}$` | 未处理异常只记录异常类名，便于排障，不记录异常消息（消息可能含上游返回内容） |
| `configKeys` | `^[A-Z0-9_]+(,[A-Z0-9_]+)*$` | `config_invalid` 时列出缺失/不合法的变量名，不含取值 |

## 模型说明

客户倾向的 `gpt-sol-6.1` 在测试环境新建部署时被 Azure 以 `DeploymentModelNotSupported` 拒绝，按设计 TD-016 改用 `gpt-5.1`（支持 `reasoning_effort: "none"`，`usage` 中 `reasoning_tokens` 为 0）。集成测试会核对实际模型名与推理令牌数。

## 待人工确认的事项

以下事项由技术方案提出、随设计确认决定（见设计“开放决策”），实现未替人选择：认证方式（两种方式均已实现）、是否仅部署测试环境、依赖 IaC 资源清单。
