# 企业实时翻译 · 修复：系统声音模式识别静默停滞时页面仍显示“正在听”（IR-003）技术方案

> 依据：已确认的意图第 2 版（AC-1～AC-8，含 Q-1～Q-5、R1～R4 的人工答案）、`spec.md`（FR-1～FR-19、假设 A-1～A-7）、项目宪章、技术基线第 2 版（本目录 `technical-baseline.md`，来源为交付 DLV-20261121-9919BA0E9588 的 `003-v1/design.md`；它是第 3 版的增量方案，沿用的第 1、2 版方案见 `.ai-delivery/features/001-v1/design.md`、`002-v1/design.md`）与仓库现有代码（提交 4a336c5）。
> 本次 `g2Decisions` 为空，没有需要沿用的 G2 决定。技术负责人已回答本方案上一版提出的 OD-1（AC-1 的验收证据方式），采纳推荐方案，本版据此修订（见开放决策 OD-1）。
> 本方案只决定“怎么做”，不改变已确认的产品行为。改动全部在浏览器端（`src/web/`），服务端、依赖、部署与日志规则不变。

## 当前技术基线

> 本节是项目的全量现状，已更新为本交付发布后的样子。相对技术基线第 2 版的变化以 **【本次】** 标出。基线第 2 版是一份增量方案，本节把它与第 1、2 版方案、仓库现状合并成一份完整的描述；第 2 版中属于“当次交付过程”的内容（根因调查、受控触发的取舍、当次决策表、当次修复前运行记录的写法等）不再作为基线条目保留，理由：它们是那次交付的过程记录，已在 `003-v1/design.md` 与 `docs/verification/003-*.txt` 中留档，不构成之后交付需要遵守的现状。其中仍然有效的约束（DOM 契约、日志契约、受控触发方式、证据方式 D-301）全部并入下面各小节。

### 产品与技术栈

| 项 | 现状 |
| --- | --- |
| 产品 | 会议 / 视频的外语发言实时翻译成中文字幕的 Web 应用。两种输入（麦克风、系统声音），流式临时字幕 + 定稿字幕，只显示判定为中文的译文，字幕小窗（Document Picture-in-Picture）。不登录，不持久化任何业务数据。 |
| 语言 / 运行时 | TypeScript；服务端 Node.js 22（ESM）；浏览器端 ES2022，构建目标 `chrome120`、`edge120`，支持桌面 Chrome / Edge 最新版（Firefox、Safari、移动端不支持系统声音，麦克风可用但不在自动化验收范围内）。 |
| 服务端框架 | Fastify 5 单服务 `web`；`@fastify/static` 提供页面；pino 10 JSON 行日志（白名单字段）；`@azure/identity` 获取托管身份令牌。 |
| 浏览器端 | 原生 DOM，无框架；esbuild 打包为单个 IIFE `app.js`；`microsoft-cognitiveservices-speech-sdk` 1.53.0（锁定于 `package-lock.json`）做连续识别 + 连续语言识别。 |
| 外部依赖 | `speech`（Azure AI Foundry 语音：STS 令牌、实时识别 WSS、测试用 TTS）、`chat-model`（Azure AI Foundry `gpt-5.1` 部署，流式 Chat Completions，`reasoning_effort: "none"`）。 |
| 测试 | Vitest 5（单元、集成），Playwright 1.65.1 + 完整版 Chromium（headed，`xvfb-run`）。 |
| 存储 | 无服务端存储；浏览器 `localStorage` 只存两项界面偏好。 |

### 服务与组件

只有一个可部署服务 `web`（`Dockerfile` 多阶段构建，运行用户 UID `10001`，监听 `PORT`，默认 8080）。

服务端（`src/server/`）：

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 读取配置、装配依赖、启动监听；`unhandledRejection` 中止类 → warn 且不退出，其它 → fatal + 退出；`uncaughtException` → fatal + 退出；SIGTERM 优雅停止。 |
| `config.ts` | 读取并校验环境变量（见“配置”）；缺失或不合法时 `config_invalid`（fatal，只列变量名）并退出。 |
| `http/app.ts` | 路由、安全响应头（CSP 等）、同源校验、按客户端地址的令牌桶限流（`http/rateLimit.ts`；默认每分钟：语音令牌 120、临时翻译 2400、定稿翻译 1200）、请求日志、错误处理器（客户端已关闭且属中止类错误时不记 error）。 |
| `speech/tokenService.ts` | 向 `speech` 的 STS 换取 10 分钟语音授权令牌（`credential` 用密钥，`platform-identity` 用托管身份），带缓存。 |
| `translation/translator.ts` | 调用 `chat-model` 流式翻译：系统提示词要求“只输出简体中文、不得照抄原文、不得输出谚文或假名”；`retranslate: true` 时追加重译说明；`sourceLanguage` 标为中文而文本不含汉字或含谚文/假名时 `lang="auto"`；原文以 `<source>` 包裹并转义。 |
| `auth/azureAuth.ts` | 两种认证方式（`credential`、`platform-identity`）。 |
| `logger.ts` | pino 封装，字段白名单 + 逐字段取值校验，不合格字段丢弃。 |
| `clientAbort.ts` | `isClientAbortError`：`AbortError`、`ABORT_ERR`、`ERR_STREAM_PREMATURE_CLOSE`、`ERR_STREAM_DESTROYED` 为中止类。 |
| `errors.ts` | `UpstreamError` 等错误类型。 |

浏览器端（`src/web/`）：

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 页面控制器：状态机（未开始 / 正在启动… / 正在听 / 已停止 / 出错）、开始与停止、一次“运行”（`Run`）的生命周期、令牌刷新（按 `refreshAfterSeconds`，失败 30 s 后重试）、提示区。**【本次】** 系统声音运行进入“正在听”后启动静默停滞检测（`StallWatchdog`），检测到停滞时以新的停止原因 `stalled` 结束运行。 |
| `audioSource.ts` | 采集结果的统一结构 `AcquiredAudio { stream, release(), monitor? }`；麦克风直接使用 `getUserMedia` 的流。**【本次】** 新增可选 `monitor`（音频处理链监视，只有系统声音提供）。 |
| `displayAudio.ts` | 系统声音：在点击处理中同步创建混音用 `AudioContext` 并调用 `getDisplayMedia`；只取音频轨道，经 `MediaStreamSource → Gain(单声道 explicit/speakers) → MediaStreamDestination` 混成单声道交给识别（不连到 `ctx.destination`，不二次播放）；任一共享轨道 `ended` → 共享结束。**【本次】** 在 Gain 上旁路接一个 `AnalyserNode`（`fftSize` 32768，不连接任何输出）测量共享音频电平，并提供 `monitor`：混音链状态（`AudioContext.state` 是否为 `running`、混音输出轨道是否仍为 `live`）、当前是否“有声音”、状态变化订阅。 |
| `recognition.ts` | 麦克风打开、语音令牌获取、Speech SDK 连续识别会话（`AudioConfig.fromStreamInput(MediaStream)`，SDK 内部再建一个 16 kHz `AudioContext` 读取该流）。识别错误取消（`CancellationReason.Error`）→ `onFailure`。**【本次】** 新增 `onSessionEnded(cause)`：`sessionStopped` → `'session_stopped'`，非错误取消（`CancellationReason.EndOfStream`）→ `'end_of_stream'`；原来 `sessionStopped` 直接调用 `onFailure('session_stopped')` 改由控制器按输入方式处理（麦克风行为不变）。 |
| `stallWatchdog.ts` **【本次新增】** | 与 DOM 无关的静默停滞判定：识别会话非错误结束、混音链挂起或中断、有声音累计 30 s 无识别结果三种情况，触发一次 `onStall(cause)`。 |
| `captionPipeline.ts` | 字幕状态机：临时译文（单飞 + 500 ms 节流，整段收齐判定为中文才显示）、定稿（整段收齐判定，非中文重译一次，仍非中文显示提示条目）、失败重试与连续失败计数（连续 3 句或 3 次网络失败 → `onTranslationUnavailable` → 控制器以“出错 + 翻译已中断，请稍后重新开始。”结束运行）；上游内容过滤拒绝（`upstream_rejected`）只丢弃该句、不计数。 |
| `captionView.ts`、`mirroredCaptionView.ts` | 字幕 DOM 视图；`MirroredCaptionView` 把每次变更先写主页面、再写小窗。 |
| `pip.ts` | 字幕小窗（Document PiP）：显示状态与字幕，状态随控制器 `setState` 同步。 |
| `translateClient.ts` | `POST /api/translations` 的 NDJSON 流读取、中止与失败分类，请求附带 `inputSource`。 |
| `messages.ts` | 状态名称与全部中文提示文字。**【本次】** 新增 `MESSAGES.stalled`。 |
| `uiState.ts`、`preferences.ts`、`guide.ts`、`support.ts`、`supportMatrix.ts` | 按钮可用性与状态图标、界面偏好、首次引导、平台与支持判定、系统声音支持列表。 |

共享（`src/shared/`）：`contracts.ts`（接口类型）、`chineseText.ts`（`isChineseTranslation`、`containsForbiddenScript`，浏览器、服务端与测试共用）。

### 接口契约

契约的权威位置：HTTP 请求与响应类型在 `src/shared/contracts.ts`，请求体 JSON schema 在 `src/server/http/app.ts`（`translationBodySchema`），日志字段白名单在 `src/server/logger.ts`，页面中文文字在 `src/web/messages.ts`。

| 接口 | 契约 |
| --- | --- |
| `GET /healthz` | 200 `{"status":"ok"}`，`Cache-Control: no-store`。 |
| `GET /`、静态资源 | `index.html`、`app.js`、`styles.css`；全部响应带安全头：CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://<STT_HOST> https://<STT_HOST>; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`，`Permissions-Policy: microphone=(self), display-capture=(self)`，`Referrer-Policy: no-referrer`，`X-Content-Type-Options: nosniff`，`X-Frame-Options: DENY`。 |
| `POST /api/speech-token` | 同源校验（`Origin` 与 `Sec-Fetch-Site`），限流；200 `SpeechTokenResponse { token, sttEndpoint, candidateLanguages, segmentationSilenceMs, refreshAfterSeconds: 240 }`；STS 失败 502 `upstream_unavailable`。 |
| `POST /api/translations` | 同源、限流（按 `kind` 分桶）、请求体 ≤ 8 KiB；`{ kind: 'partial'|'final', text: 1..2000 且含非空白, sourceLanguage?, inputSource?: 'microphone'|'system', retranslate?: boolean }`，`additionalProperties: false`；`partial` + `retranslate: true` → 400 `invalid_request`。响应 `application/x-ndjson`：`{"type":"delta","text"}`…`{"type":"done"}`，或 `{"type":"error","code":"upstream_unavailable"|"upstream_throttled"|"upstream_rejected"|"timeout"}`。客户端中止 / 断开时服务端停止上游请求。 |
| 错误响应 | `{ "error": ApiErrorCode }`：`invalid_request`(400)、`forbidden_origin`(403)、`payload_too_large`(413)、`rate_limited`(429，带 `Retry-After`)、`upstream_unavailable`(502)、`not_found`(404)、`internal_error`(500)。 |
| 浏览器 → 语音服务 | Speech SDK 经 `wss://<STT_HOST>/speech/universal/v2` 连续识别，授权为服务端签发的短时令牌，连续语言识别候选语言来自令牌响应。 |
| 浏览器 → 页面 | `getUserMedia`（麦克风，回声消除/降噪/自动增益开）或 `getDisplayMedia`（系统声音，视频轨道只为满足浏览器要求，从不读取；`suppressLocalAudioPlayback: false`）；`documentPictureInPicture.requestWindow`（小窗）。**【本次】** 新增使用 `AnalyserNode.getFloatTimeDomainData` 与 `AudioContext` 的 `statechange` 事件，只在浏览器内存中使用，不上报。 |

服务端日志契约（JSON 行，pino；运维与独立测试使用）：

| 事件（`event`） | 级别 | 字段 / 说明 |
| --- | --- | --- |
| `server_started`、`server_stopping` | info | 启动与停止。 |
| `request_completed` | info | `reqId, method, route, status, durationMs`。 |
| `translation_completed`（成功） | info | `reqId, kind, textLength, sourceLanguage?, inputSource?, deltaCount, ttfbMs, durationMs, reasoningTokens, model`，重译请求另带 `retranslate: true`。 |
| `translation_completed`（客户端中止） | info | `msg: "translation aborted by client"`，`errorCode: "client_aborted"`，每个中止请求恰 1 条，无 error。 |
| `upstream_error` | warn | `upstream, upstreamStatus, errorCode`（重译请求另带 `retranslate`）。 |
| `speech_token_failed` | error | `upstream: speech-sts, upstreamStatus, errorCode, authMode, errorClass`。 |
| `unhandled_error` | error / warn / fatal | 请求内未预期异常 error（`route, errorClass, errorCode: internal_error`）；进程级中止类拒绝 warn（`msg: "unhandled rejection after client abort"`，进程继续）；其它进程级异常 fatal + 退出。 |
| `config_invalid` | fatal | `configKeys`（只有变量名）。 |

白名单字段：`event, reqId, method, route, status, durationMs, kind, textLength, deltaCount, ttfbMs, reasoningTokens, upstream, upstreamStatus, errorCode, authMode, sourceLanguage, inputSource, model, errorClass, configKeys, retranslate`。从不记录识别原文、译文、令牌或密钥。**【本次】** 不变（静默停滞检测只在浏览器内进行，不向服务端发送任何新信息，FR-19）。

页面 DOM 契约（编码必须保持；测试按角色与可见名称定位，不按样式或页面结构）：

| 元素 | 角色与可见名称 / 属性 | 说明 |
| --- | --- | --- |
| 输入方式 | `radio` “麦克风” / “系统声音”（组 `fieldset#input-source`） | 运行中不可切换。 |
| 开始 / 停止 | `button` “开始” / “停止” | 正在启动…、正在听时只有“停止”可用；其余状态只有“开始”可用。 |
| 状态 | `status`（`#status`，`aria-live=polite`），文本为 `未开始`、`正在启动…`、`正在听`、`已停止`、`出错` 之一；`document.body[data-state]` 为 `idle/starting/running/stopped/error` | 图标 `○ ◔ ● ■ ⚠`（`aria-hidden`）。 |
| 提示 | `alert`（`#notice`），`data-kind` 为 `error` 或 `info`；无提示时 `hidden` | 文本取自 `MESSAGES`。共享结束为 `info`，其余为 `error`。**【本次】** 静默停滞提示 `MESSAGES.stalled` 为 `error`。 |
| 字幕区 | `region` “中文字幕”，其中 `#captions > li.caption[data-status][data-segment-id]`，`data-status` ∈ `interim/finalizing/final/interrupted/dropped`；提示条目另有 `data-kind="notice"`，文本恰为 `（此句未能翻译成中文）` | 提示样式：颜色 `rgb(201, 180, 143)`，字号为正常字幕 × 0.75，左边框 4 px 实线。 |
| 字号 | `radio` “小 / 中 / 大 / 特大”（`fieldset#caption-size`） | 24 / 32 / 40 / 52 px。 |
| 字幕小窗按钮 | `button` “弹出字幕小窗” / “关闭字幕小窗”（`aria-pressed`） | 不支持时不可用，旁边 `note` 说明原因。 |
| 字幕小窗 | 小窗文档中 `status`（`#pip-status`，文本同主页面状态）与 `#pip-captions > li.caption[...]` | 状态与字幕随主页面同步。**【本次】** 停滞后小窗状态同样为 `出错`（经既有 `CaptionWindow.setState` 同步），小窗不显示提示文字（FR-8）。 |
| 使用引导 | `dialog` “使用引导”，按钮 “使用引导” / “知道了” | 首次打开自动显示。 |
| 回到最新 | `button` “回到最新字幕 ↓” | 向上翻看时出现。 |

页面中文提示（`src/web/messages.ts`，原文以文件为准）：麦克风三种失败、`interrupted`（“翻译已中断，请稍后重新开始。”：翻译连续失败、识别错误取消、麦克风模式识别会话结束、启动失败）、`unsupported`、`shareCancelled`、`shareBlocked`、`shareFailed`、`shareNoAudio`（按平台）、`shareEnded`（“共享已结束，翻译已停止。如需继续，请点击“开始”并重新选择共享内容。”）、`systemUnsupported`、`pipUnsupported`，以及 **【本次】** `stalled`：“翻译已中断：语音识别已停止输出结果。请点击“开始”并重新选择共享内容，重新开始翻译。”（规格假设 A-2）。

运行结束原因与表现（一次运行只显示一条结束原因提示，先发生者为准，由控制器“`run` 置空后其余回调全部忽略”保证）：

| 结束原因 | 状态 | 提示 |
| --- | --- | --- |
| 用户点“停止” | 已停止 | 无 |
| 共享轨道结束（关闭被共享标签页、浏览器“停止共享”） | 已停止 | `shareEnded`（info） |
| 翻译连续失败达到阈值 | 出错 | `interrupted` |
| 识别错误取消；麦克风模式 `sessionStopped`；启动失败 | 出错 | `interrupted` |
| **【本次】** 系统声音模式静默停滞（`sessionStopped`、非错误取消、混音链挂起或中断、有声音累计 30 s 无识别结果） | 出错 | `stalled` |
| 页面卸载 | — | — |

### 数据

- 服务端不保存任何数据，无数据库，无迁移。
- 浏览器内存：字幕条目与识别原文（原文只用于翻译请求，定稿后立即释放），刷新即清空。**【本次】** 停滞检测只在内存中保存计数（有声音累计毫秒数、上次检查时刻），不保存音频与文本。
- 浏览器 `localStorage`：`rtmt.guideSeen`（`1`）、`rtmt.captionSize`（`s/m/l/xl`）；不保存字幕或发言内容。

### 配置

| 变量 | 说明 |
| --- | --- |
| `AIDH_DEP_SPEECH_ENDPOINT`、`AIDH_DEP_SPEECH_STT_HOST`、`AIDH_DEP_SPEECH_REGION`、`AIDH_DEP_SPEECH_AUTH_MODE`、`AIDH_DEP_SPEECH_KEY`（`TTS_HOST` 只供测试） | 语音依赖，平台注入；`credential` 时需要 `KEY`，`platform-identity` 用托管身份。 |
| `AIDH_DEP_CHAT_MODEL_ENDPOINT`、`AIDH_DEP_CHAT_MODEL_DEPLOYMENT`、`AIDH_DEP_CHAT_MODEL_AUTH_MODE`、`AIDH_DEP_CHAT_MODEL_KEY` | 大模型依赖，同上。 |
| `PORT`（8080）、`LOG_LEVEL`（info）、`CANDIDATE_LANGUAGES`（`en-US,zh-CN,ja-JP,ko-KR`，1～10 项）、`SEGMENTATION_SILENCE_MS`（800，300～2000）、`TRUSTED_PROXY_HOPS`（1，0～3） | 应用配置。 |

**【本次】** 无新增配置。停滞判定时长 30 s 是已确认的产品时限（Q-1），与其它判定常量一起写在 `src/web/stallWatchdog.ts`，不做成配置。

### 安全与隐私

- 凭据只在服务端；浏览器只拿 10 分钟 STS 令牌；支持托管身份（推荐 `platform-identity`）。依赖声明顶层 `secrets` 为空。
- POST 接口同源校验与限流；请求体严格校验；提示词注入防护（`<source>` 转义）。
- 日志白名单，不记录客户内容；测试以原文、译文片段与密钥值检索日志，命中须为 0。
- 生产代码中没有任何测试开关或故障注入入口（第 3 版 D-301、本次 R1）。

### 部署

- 部署声明 `docs/deployment.json`：单服务 `web`（构建上下文 `.`、`Dockerfile`，端口 8080，`/healthz`，对外）。
- 错误日志识别规则（`operations.errorLogRules`）：`app-error-or-fatal`（structured，`level` ∈ {error, fatal}，`msg`，high）、`upstream-errors-burst`（structured，`event` = `upstream_error`，`errorCode`，medium，5 分钟 10 次）、`node-crash-output`（pattern，非 JSON 的 Node 崩溃输出，high）。
- 依赖声明 `docs/dependencies.json`：`speech`、`chat-model`，推荐沿用已绑定的 dev / test 实例；探测脚本 `infra/probes/speech.sh`、`infra/probes/chat-model.sh`；IaC `infra/speech`、`infra/chat-model`（只在经人决定重建时使用）。
- 开发者命令：本 Feature 目录 `runtime/deployment.json`。
- 无状态：回滚即重新部署上一个通过的候选。

### 可测性约定

**契约位置**：见“接口契约”首段；页面行为以“页面 DOM 契约”与 `src/web/messages.ts` 为准。

**定位方式**：按上表的角色与可见名称定位（例如 `getByRole('button', { name: '开始' })`、`getByRole('status')`、`getByRole('alert')`、`getByRole('radio', { name: '系统声音' })`）；字幕条目用 `data-status`、`data-kind` 等语义属性；小窗经 `documentPictureInPicture.window` 读取。

**造数与清理**：应用无持久数据，无需造数与清理；每个测试使用新的浏览器上下文即可。测试素材（英语、韩语、日语语句）由 `speech` 依赖的 TTS 合成，缓存在系统临时目录（`tests/support/tts.ts`）。不需要也不允许测试直接改库（没有库）。

**时间与随机性**：产品没有随机性；判定时长等常量为真实时间（30 s、检查间隔 1 s），端到端与独立测试按真实时间等待。单元测试中 `StallWatchdog` 的时钟与定时器可注入（`now`、`setInterval`/`clearInterval`），也可用 Vitest 假定时器；`displayAudio` 沿用 `DisplayAudioDeps.now` 注入。

**受控触发（只在测试的浏览器初始化脚本中，生产代码无开关）**：

| 要触发的情况 | 方法（`context.addInitScript`） | 依据 |
| --- | --- | --- |
| 翻译结果非中文、翻译延迟或失败 | 包装 `window.fetch`，只替换匹配的 `/api/translations` 请求（`tests/e2e/translationOverride.ts`）；不要用 Playwright `route` 处理翻译请求（会使小窗样式不载入） | 第 3 版 TD-310 |
| 翻译连续失败达到阈值 | 同上，让连续 3 句的定稿请求返回 `{"type":"error","code":"upstream_unavailable"}` | 同上 |
| 上游内容过滤拒绝 | 同上，让某一句返回 `{"type":"error","code":"upstream_rejected"}` | 同上 |
| **【本次】** 识别器不再送出识别结果（不报错） | 包装 `window.WebSocket`：对 URL 主机为 STT 主机的连接，在测试触发后不再把服务端发来的消息交给 SDK（`onmessage` 属性与 `addEventListener('message')` 两种注册方式都要拦截），发出的音频照常发送 | 本次方案 TD-706 |
| **【本次】** 混音链挂起或中断 | 包装 `window.AudioContext` 构造函数并记录实例：页面混音用的实例是**不带构造参数**创建的那个（SDK 内部的实例带 `{ sampleRate: 16000 }`）；触发时对它调用 `suspend()` 或 `close()`，或对它 `createMediaStreamDestination()` 返回节点的 `stream.getAudioTracks()[0]` 调用 `stop()` | 本次方案 TD-706 |
| 共享内容静音 / 有声音 | 播放器标签页播放带长静音段或连续语音的 TTS 素材（`tests/support/player.ts`） | — |
| 关闭被共享标签页 | 关闭播放器标签页 | 第 2 版 |

**开发者命令与用时**（`runtime/deployment.json`；用时为全量运行一次的大致时间）：

| 类别 | 命令 | 验证什么 | 全量用时 |
| --- | --- | --- | --- |
| （安装） | `npm ci` | 安装锁定依赖 | 约 5 s（本会话实测，有缓存时） |
| `staticAnalysis` | `npm run lint`、`npm run typecheck` | ESLint；服务端与浏览器两套 tsconfig 的类型检查 | 约 30 s（估计） |
| `build` | `npm run build` | esbuild 生成 `dist/server/main.js`、`dist/web/{index.html,app.js,styles.css}` | 约 5 s（估计） |
| `developerTests` | `npm test` | 单元测试（Vitest，无外部调用；包括本次的停滞判定、混音链监视、识别会话事件映射） | 约 6 s（本会话实测：15 个文件 5.2 s；本次新增 2～3 个文件后仍在 10 s 内，估计） |
| `integrationTests` | `npm run test:integration` | 针对真实 `dev` 实例：语音令牌、流式识别、流式翻译、中止与日志、未预期异常日志（AC-9 证据）、韩语/日语只输出中文 | 约 3～5 分钟（估计），6 个文件 12 个用例，单个约 5～60 s（翻译中文统计用例最长） |
| `functionalTests` | `npm run test:e2e` | 构建后在 `xvfb-run` 下以 headed Chromium 跑端到端（真实 `dev` 实例） | 约 45～55 分钟（估计；本次之前 25 个用例约 35～40 分钟，本次新增约 6 个用例约 12～15 分钟，其中 AC-6 的 5 分钟连续运行用例单个约 6 分钟，其余停滞用例单个约 1.5～2.5 分钟） |

单独运行慢速用例：`npx playwright test tests/e2e/stall.spec.ts -g "<用例名片段>"`（需先 `npm run build`，在 `xvfb-run -a` 下执行）；集成测试 `npx vitest run --config vitest.integration.config.ts <文件>`。

**并行与隔离**：端到端 `workers: 1` 串行（共用一块 Xvfb 屏幕与依赖配额），每个 worker 在 `18180 + workerIndex` 端口启动构建产物，播放器标签页标题为 `RTMT-player-<workerIndex>`，服务日志写入 `test-results/server-logs/`，每个测试只读自己开始之后的日志（`readTestLog`）。集成测试在随机端口启动 `buildApp`，日志写入内存。应用无状态、依赖实例不保存数据，与其它使用同一 `dev` 实例的运行之间只共享配额与并发连接数。应用可在执行环境内的 `localhost` 启动（`npm run build && node dist/server/main.js`）。

**已知测试限制**：Playwright 路由启用后字幕小窗样式表不生效（涉及小窗样式的用例用麦克风输入）；Playwright Firefox 中 SDK 的 blob AudioWorklet 被 CSP 拦截，端到端只覆盖 Chromium；小窗能否悬浮在全屏之上无法自动化证明（DD-101）；**【本次】** Speech SDK 1.53.0 的“识别会话以非错误原因结束”事件（`canceled` 且 `EndOfStream`、`sessionStopped`）只在 SDK 内部音频源结束时发出，无法从页面外按需触发；该路径由单元测试 `tests/unit/recognition.test.ts`、`tests/unit/stallWatchdog.test.ts` 证明，端到端与独立测试以“识别器静默停止”（拦截入站消息）验证其可观察结果（证据方式已由技术负责人决定，见下条与本次方案 OD-1）。

**证据方式（已决定，沿用）**：AC-9（第 3 版，未预期异常仍记 error）在独立测试中记 `unverifiable`，证据为候选验证中运行的 `translationFailure.int.test.ts`（D-301）。**【本次】** 第 7 号交付 AC-1（识别会话以非错误原因结束）在独立测试中以“识别器静默停止”场景执行并判定：共享内容持续有声音，按“受控触发”拦截语音服务入站消息，判定 30 s 内转为“出错”并显示停滞提示；SDK 事件路径（`canceled`/`EndOfStream`、`sessionStopped` → 出错 + 停滞提示）以候选验证中运行的单元测试 `tests/unit/recognition.test.ts` 与 `tests/unit/stallWatchdog.test.ts` 为证据；独立测试报告须注明这一证据来源，G4 时由人确认。产品中不加测试开关（技术负责人对 OD-1 的决定）。

## 本次方案

## 技术上下文（Technical Context）

| 项 | 选择（相对基线的变化以 **粗体** 标出） |
| --- | --- |
| 改动范围 | 只改浏览器端：`displayAudio.ts`（**混音链监视与电平测量**）、`recognition.ts`（**识别会话结束事件上报**）、`main.ts`（**系统声音运行的停滞检测与新停止原因**）、`messages.ts`（**停滞提示文字**）、新增 `stallWatchdog.ts`。服务端、接口、日志、依赖、部署不变。 |
| 新的浏览器能力 | `AnalyserNode`（时域数据算 RMS）、`AudioContext.state` 与 `statechange` 事件、`MediaStreamTrack.readyState`；均为 Chrome / Edge 早已支持的 Web Audio / Media Capture 标准接口，不需要新权限，不受 CSP 影响（不加载任何新脚本或 worklet）。 |
| 测试 | **新增** 单元测试（停滞判定、混音链监视、识别事件映射）；**新增** 端到端 `stall.spec.ts`（含 AC-8 复现测试）与测试初始化脚本 `speechStall.ts`（`WebSocket`、`AudioContext` 包装）。 |
| 依赖 | 沿用 `speech`、`chat-model` 已绑定实例，声明不变。 |

### 不确定项与结论

只列会改变决定的事实。本会话没有依赖实例的接入变量（`AIDH_DEP_*` 为 0 个），不能连接真实语音服务；凡需要真实服务才能观察的，写成待验证假设。

| # | 不确定的事实 | 会影响的决定 | 结论 | 证据 |
| --- | --- | --- | --- | --- |
| U-1 | 翻译主页面通常在后台（用户停留在被共享的视频标签页），后台页面的定时器会被节流到什么程度？若被“强节流”（每分钟一次），1 s 检查会延迟到 1 分钟，超过 30 s 时限 | 检查时钟用主线程定时器还是 Worker / AudioWorklet | Chrome 的强节流只在“页面隐藏超过 5 分钟、静音 30 s、链式计数 ≥ 5、**且 WebRTC 未在使用**”时才生效，“WebRTC 在使用”的定义包含页面有处于 `live` 的 `MediaStreamTrack`；系统声音运行期间页面始终持有 `live` 的共享轨道，因此只受普通节流（每秒最多一次、对齐到整秒）。1 s 间隔的主线程定时器可用 | Chrome 官方文档 “Heavy throttling of chained JS timers beginning in Chrome 88”（developer.chrome.com/blog/timer-throttling-in-chrome-88，“WebRTC is not in use … a 'live' MediaStreamTrack”）；Edge 为 Chromium 内核 |
| U-2 | 混音用 `AudioContext` 被挂起后，混音输出轨道是否仍是 `live`、识别端是否会因此察觉？电平测量会读到什么？ | 是否必须显式检查 `AudioContext.state` | 挂起后输出轨道仍为 `live`、`muted=false`，Analyser 读数为 0（与静音无法区分）；`statechange` 事件依次给出 `suspended`、`running`、`closed`。因此只看电平会把挂起当作静音（AC-5 不提示），必须显式检查状态 | 实验 E-1 |
| U-3 | `AnalyserNode` 旁路接在 Gain 上、不连接任何输出时，是否能读到共享音频电平 | 电平测量节点接在旁路还是串在链路中 | 能：播放 0.1 增益正弦波时 RMS ≈ 0.0707，静音时恰为 0，恢复后读数恢复 | 实验 E-1 |
| U-4 | 对混音输出轨道调用 `stop()` 是否触发 `ended` 事件 | 混音链“中断”用事件还是轮询发现 | 不触发（W3C Media Capture 规范：`stop()` 不派发 `ended`），`readyState` 变为 `ended`；因此每次检查时轮询 `readyState` | W3C Media Capture and Streams §MediaStreamTrack.stop()；实验 E-1 复核 |
| U-5 | Speech SDK 1.53.0 何时发出“识别会话以非错误原因结束”的事件（`canceled` 且 `reason = EndOfStream`、`sessionStopped`），页面外能否按需触发 | 要处理哪些 SDK 事件；AC-1 如何验收 | 只有在本地音频流已经结束（`isSpeechEnded`）且收到 `turn.end` 时，SDK 才以 `EndOfStream`、`NoError` 取消并随后发出 `sessionStopped`；连续识别中若本地音频未结束，`turn.end` 只会重新连接，不发事件；WebSocket 以 1000 正常关闭也只会在下次发送时重连，只有 1002/1003/1007/4000 或重连次数超限才以 `Error` 取消。SDK 读取 `MediaStream` 时没有监听轨道结束。结论：两种事件都要处理（发生时立即判定停滞）；但它们无法从页面外按需触发（需要 SDK 内部的音频源结束），见开放决策 OD-1 | SDK 源码 `common.speech/ServiceRecognizerBase.js:98-108`（连接关闭的处理）、`:705-724`（`turn.end` → `EndOfStream` → `sessionStopped`）、`:875-892`（重连）；`common.browser/PCMRecorder.js`（不监听轨道结束） |
| U-6 | 语音服务不再回消息时，SDK 是否会自己报错（从而走既有错误路径，而不是“静默”）；测试能否在页面中拦截 SDK 的 WebSocket | 受控制造“识别器不再送出结果”的方法 | SDK 用全局 `new WebSocket(uri)` 建立连接，可以由初始化脚本包装；`ServiceRecognizerBase` 中没有等待服务端消息的超时（`setTimeout` 只用于音频发送节奏）。据此，拦截入站消息后 SDK 不会报错，页面会停在“正在听”——正是本问题的表现。该结论来自源码阅读，未用真实服务运行验证，列为待验证假设 H-1（后备做法见开放决策） | SDK 源码 `common.browser/WebsocketMessageAdapter.js:95`、`common.speech/ServiceRecognizerBase.js:1086`；待验证假设 H-1 |
| U-7 | SDK 内部的 16 kHz `AudioContext` 能否被页面拿到并监视 | 是否也监视 SDK 内部的音频链 | 不能：SDK 在 `MicAudioSource` 内部私有字段中创建（`AudioStreamFormatImpl.getAudioContext(16000)`），没有公开接口。决定只直接监视页面自己的混音链（意图 AC-2 所说的“混音用的音频处理链”），SDK 内部音频链的停止由“有声音 30 s 无识别结果”覆盖（见开放决策 OD-2 的残余风险） | SDK 源码 `common.browser/MicAudioSource.js:213-217`、`sdk/Audio/AudioStreamFormat.js:152-163` |

没有列为不确定项的事实（文档或项目代码已写明）：`AudioContext.state` 取值与 `statechange` 事件（MDN / Web Audio API 规范）；`AnalyserNode.fftSize` 最大 32768、`getFloatTimeDomainData` 返回最近 `fftSize` 个采样（Web Audio API 规范）；页面状态同步到小窗（`src/web/pip.ts:56`、`:146`）；一次运行只处理一个结束原因（`src/web/main.ts` `stopRun` 先把 `run` 置空，各回调以 `run !== current` 忽略）；`audio.release()` 先置 `released` 再停止轨道，因此不会触发“共享已结束”（`src/web/displayAudio.ts` `ended` 与 `release`）。

## 治理与技术约束

| 约束（来源） | 设计响应 |
| --- | --- |
| 宪章·最简单架构；规则 1 沿用技术基线 | 不新增服务、依赖、npm 包、配置项或脚本文件；只在现有混音图上加一个 `AnalyserNode`，判定逻辑为一个无 DOM 的类，沿用 `DisplayAudioDeps` 式的结构类型与依赖注入以便单元测试。 |
| 宪章·绝不记录客户内容；FR-19；Q-5 不新增健康信号 | 不向服务端发送任何新请求或字段，不新增日志；电平只在内存中取 RMS 数值，不保存音频；控制器只用 `console.debug` 记一个枚举原因（与现有 `speech recognition stopped` 一致，不含文本）。 |
| 宪章·外部集成用真实服务验证，Mock 不替代；R1 允许只在浏览器中受控制造停滞、生产代码不加开关 | 端到端与独立测试中页面、共享音频、语音与翻译服务全部真实，只用初始化脚本包装 `WebSocket` / `AudioContext` 制造停滞（TD-706）；产品代码没有测试开关。SDK 事件路径（AC-1）无法从页面外制造，按技术负责人对 OD-1 的决定以单元测试为证据，独立测试以“识别器静默停止”场景判定 AC-1。 |
| 意图·已有行为不变（AC-7、R3）；Q-3 不扩展到麦克风 | 停滞检测只在系统声音运行、状态为“正在听”时启动；麦克风模式的事件处理与修复前逐条相同（TD-703）；共享结束、停止、翻译连续失败、内容过滤的路径不改。 |
| 意图·Q-2 不自动恢复 | 检测到停滞即结束本次运行（释放共享、结束识别），由用户点“开始”重新开始。 |
| 项目已有 CI、部署脚本与基础设施保持原样 | `Dockerfile`、`scripts/`、`infra/` 不改；`docs/deployment.json` 只更新服务描述文字；`docs/dependencies.json` 不变。 |

## 根因：为什么识别停止后页面仍显示“正在听”

意图明确不查明“识别为什么停止”（触发点），只要求页面发现停滞并如实提示；但“页面为什么没有离开正在听”是本次要消除的已知问题，根因由代码与实验确定：

1. **非错误结束被丢弃**：`src/web/recognition.ts` 的 `canceled` 处理只在 `reason === CancellationReason.Error` 时上报，`EndOfStream`（非错误取消）被直接 `return`；SDK 在这种情况下随后发出 `sessionStopped`，现有代码虽会以“翻译已中断，请稍后重新开始。”结束，但若 SDK 只发出前者或两者都不发出，页面没有任何反应（U-5）。
2. **混音链状态无人监视**：`src/web/displayAudio.ts` 只监听共享轨道的 `ended`；混音用 `AudioContext` 被挂起时输出轨道仍为 `live`，识别端收不到音频也不会报错（实验 E-1，U-2）。
3. **没有“识别结果是否还在产生”的判断**：`src/web/main.ts` 进入“正在听”后只在收到错误、共享结束、翻译连续失败或用户操作时离开该状态；识别器静默不出结果（例如 SDK 不报错地停止送出结果，U-6）时页面永远停在“正在听”。

这三条都可由一条测试复现：AC-8 测试在修复前的代码上让识别器不再送出结果（TD-706 的 `WebSocket` 包装），页面持续停在“正在听”（预期失败）；修复后 30 s 有声音时长内转为“出错”。

## 架构概览（Architecture）

```
┌──────────────────────────── 浏览器（Chrome / Edge 桌面版），系统声音模式 ────────────────────────────┐
│ getDisplayMedia ─▶ 混音 AudioContext: MediaStreamSource ─▶ Gain(单声道) ─▶ MediaStreamDestination ──▶ Speech SDK ──▶ WSS 语音服务
│                                                         └─▶ AnalyserNode(旁路，新增)                  │  (SDK 内部 16 kHz AudioContext)
│                                                                │                                       │
│   AudioChainMonitor（新增，displayAudio.ts）                    │ isVoiced(): RMS ≥ −50 dBFS             │ recognizing / recognized（非空文本）
│     health(): ctx.state==='running' 且混音输出轨道 live ? ok : broken                                  │ sessionStopped / canceled(EndOfStream)
│     onChange(): ctx 'statechange'                                                                      ▼
│                     │                                                                 RecognitionSession（recognition.ts，新增 onSessionEnded）
│                     ▼                                                                                  │
│   StallWatchdog（新增，stallWatchdog.ts）◀───── noteResult() / noteSessionEnded() ───── main.ts 控制器 ┘
│     每 1 s 检查 + statechange 立即检查：
│       混音链 broken                      → onStall('audio-chain')
│       有声音时长（自上次识别结果）≥ 30 s → onStall('no-results')
│     noteSessionEnded()                    → onStall('session-ended')
│                     │
│                     ▼
│   main.ts stopRun('stalled')：pipeline.endRun()、释放共享与混音链、令牌刷新停止、session.dispose()
│     setState('error') ─▶ 主页面状态“出错” + #notice(MESSAGES.stalled) ；CaptionWindow.setState ─▶ 小窗状态“出错”
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
麦克风模式：无 monitor、不启动 StallWatchdog，事件处理与修复前相同。服务端不变。
```

要点：

1. **只在页面内发现，不上报**：三种停滞都能由页面自己观察到（SDK 事件、混音链状态、电平 + 识别结果），不需要服务端参与，符合 FR-19 与 Q-5。
2. **检查时钟用 1 s 主线程定时器，混音链挂起另用事件立即发现**：运行期间页面持有 `live` 的共享轨道，不受 Chrome 强节流（U-1）；`statechange` 事件不依赖定时器。
3. **“有声音”按时间累计、静音暂停计时**：每次检查把距上次检查的时间（最多计 2 s）在“有声音”时累加，收到识别结果清零，静音期间不累加也不清零（规格 A-1）。

## 技术决策与替代方案

| 决策 ID | 决定 | 理由 | 备选 | 证据 | 来源 |
|---|---|---|---|---|---|
| TD-701 | **混音链监视**：`requestDisplayAudio` 在建好 `source → gain → destination` 后，再建 `AnalyserNode`（`fftSize = 32768`，`smoothingTimeConstant` 不用），`gain.connect(analyser)`，analyser 不连接任何输出。返回的 `AcquiredAudio` 增加 `monitor: AudioChainMonitor`：`health()` —— `ctx.state === 'running'` 且混音输出轨道（`destination.stream.getAudioTracks()[0]`）`readyState === 'live'` 时为 `'ok'`，否则 `'broken'`；`isVoiced()` —— 取 `getFloatTimeDomainData` 的 RMS，≥ `VOICE_RMS_THRESHOLD = 0.00316`（−50 dBFS）为真；`onChange(listener)` —— 订阅 `ctx` 的 `statechange`，返回取消订阅函数。`release()` 额外断开 analyser 并取消全部订阅。`AudioContextLike` 增加 `state`、`createAnalyser()`、`addEventListener/removeEventListener('statechange')`，`TrackLike` 增加可选 `readyState`（保持 DOM 无关、可在 Node 下单元测试） | 挂起的混音链在电平上与静音无法区分，必须显式看状态（E-1）；`stop()` 不触发 `ended`，要看 `readyState`（U-4）；旁路 analyser 能读到电平且不改变送往识别的音频（E-1、U-3）；`fftSize` 取最大值使每次读数覆盖约 0.68～0.74 s 音频（48 / 44.1 kHz），1 s 一次的抽样能较好代表这一秒是否有声音；−50 dBFS 远高于数字静音（读数恰为 0，E-1）又远低于正常语音电平，符合“音量明显高于静音”（意图假设 4、规格 A-6） | ① AudioWorklet 在音频线程逐块累计有声样本（更精确，但要新增一个 worklet 脚本文件与构建入口；SDK 的 blob worklet 已有被 CSP 拦截的先例），不采用；② 把 analyser 串在链路中（没有必要，E-1 已证明旁路可读）；③ 只看电平不看状态（挂起会被当作静音，AC-2 无法满足） | 实验 E-1；U-2、U-3、U-4 | FR-2、FR-3、FR-4、FR-12；AC-2、AC-3、AC-5 |
| TD-702 | **停滞判定 `StallWatchdog`**（新文件 `src/web/stallWatchdog.ts`）：构造参数 `{ monitor, onStall(cause), now?, setInterval?, clearInterval? }`；常量 `STALL_THRESHOLD_MS = 30_000`、`CHECK_INTERVAL_MS = 1_000`、`MAX_CREDIT_PER_CHECK_MS = 2_000`。`start()`：`voicedMs = 0`、`lastCheck = now()`，启动 1 s 定时检查并订阅 `monitor.onChange(check)`。`check()`：若 `monitor.health() === 'broken'` → `fire('audio-chain')`；否则 `dt = min(now() − lastCheck, 2000)`，`lastCheck = now()`，`monitor.isVoiced()` 为真时 `voicedMs += dt`；`voicedMs ≥ 30000` → `fire('no-results')`。`noteResult()`：`voicedMs = 0`。`noteSessionEnded()`：`fire('session-ended')`。`fire()` 只生效一次：先 `stop()`（清定时器、取消订阅）再调用 `onStall`。`stop()` 幂等 | 三种情况在一个地方判定，“先发生者为准、只触发一次”由类本身保证（FR-9）；静音不累计也不清零、识别结果清零，正是规格 A-1；单次最多计 2 s 是为了在定时器偶发延迟（例如浏览器忙）时不把一次抽样放大成长时间“有声音”，避免误报（AC-5、AC-6 优先），代价是延迟时判定略晚于 30 s；混音链挂起与会话结束不需要等 30 s，发现即判定，满足“不超过 30 秒”（FR-1、FR-2，A-7） | ① 混音链挂起后再等 30 s 才判定（规格只要求“不超过”，无收益，且延长用户看错状态的时间）；② 用“距最近识别结果的墙钟时间”（不区分静音，违反 Q-1 答案）；③ 在 Web Worker 里计时（U-1 已证明不需要） | U-1；规格 A-1、A-7 | FR-1～FR-4、FR-9、FR-12、FR-13；AC-1～AC-3、AC-5、AC-6 |
| TD-703 | **识别会话事件**：`RecognitionHandlers` 增加 `onSessionEnded(cause: 'session_stopped' \| 'end_of_stream')`。`recognizer.canceled`：`reason === Error` → `onFailure(errorCode)`（不变）；`reason === EndOfStream` → `onSessionEnded('end_of_stream')`（原来直接忽略）。`recognizer.sessionStopped` → `onSessionEnded('session_stopped')`（原来是 `onFailure('session_stopped')`）。`disposed` 之后一律忽略（不变）。控制器（`main.ts`）中：**麦克风**运行 `session_stopped` → `stopRun('error')`（与修复前相同，提示 `interrupted`），`end_of_stream` → 忽略（与修复前相同）；**系统声音**运行（状态为正在听）两者都 → `watchdog.noteSessionEnded()` | 把“识别会话以非错误原因结束”作为独立事件交给控制器，系统声音按 FR-1 处理，麦克风保持原样（FR-17、Q-3）；`EndOfStream` 之后 SDK 会接着发出 `sessionStopped`（U-5），由 `fire()` 只生效一次与 `run !== current` 保证只处理一次 | 在 `recognition.ts` 内按输入方式分支（让识别模块知道输入方式，职责混乱）；继续让 `sessionStopped` 走 `onFailure`（系统声音会显示 `interrupted` 而不是规格要求的停滞提示） | U-5；`src/web/recognition.ts` 现状 | FR-1、FR-6、FR-17；AC-1 |
| TD-704 | **识别结果计入**：控制器在把 `onRecognizing` / `onRecognized` 交给字幕管线之前，若 `text.trim() !== ''` 则 `watchdog?.noteResult()`。空文本（SDK 的 `NoMatch` 整句结果在 `recognition.ts` 中被转成空字符串）不计入 | 规格把“识别结果”定义为“识别中”或“整句”结果；没有文字的 `NoMatch` 不是用户能看到字幕的结果，按规格 A-6，纯音乐、音效累计 30 s 无文字结果应提示中断；把它算作结果会让 A-6 不成立 | 把 `NoMatch` 也算作结果（更不易误报，但与规格 A-6 不符） | `src/web/recognition.ts` `recognized` 处理；规格 A-6 | FR-3、FR-13；AC-3、AC-6 |
| TD-705 | **停滞后的结束方式**：`StopReason` 增加 `'stalled'`。`StallWatchdog.onStall` → `if (run === current) stopRun('stalled')`。`stopRun`：既有步骤不变（`run = null`、`pipeline.endRun()`、`audio.release()`、令牌刷新停止、`session.dispose()`），另 `watchdog.stop()`；`setState('error')`，`showNotice(MESSAGES.stalled)`（`data-kind="error"`）。`MESSAGES.stalled = '翻译已中断：语音识别已停止输出结果。请点击“开始”并重新选择共享内容，重新开始翻译。'`。`console.debug('speech recognition stalled', cause)` 只记枚举原因。看门狗在 `setState('running')` 之后创建并 `start()`，保存在 `Run.watchdog`；任何其它结束原因经 `stopRun` 一并 `stop()` | 沿用页面现有“出错”结束方式（规格 FR-5、A-3）：按钮可用性、字幕保留（`endRun` 不清空字幕，FR-7）、释放共享（重新开始需重新选择共享内容，AC-4）、小窗状态经既有 `captionWindow.setState` 同步为“出错”（FR-8）；`audio.release()` 先置 `released` 再停止轨道，不会再触发“共享已结束”（FR-9、FR-10） | 新增状态名称（违反意图假设 1）；只改提示不结束运行（规格要求本次运行结束，A-3） | `src/web/main.ts` `stopRun`、`setState`；`src/web/pip.ts:56`；`src/web/displayAudio.ts` `release` | FR-5～FR-11、FR-14、FR-16；AC-1～AC-4、AC-7 |
| TD-706 | **受控制造停滞（只在测试初始化脚本中）**：新文件 `tests/e2e/speechStall.ts` 导出两个初始化脚本。① `WebSocket` 包装：记录 URL 主机等于 STT 主机的连接；页面上下文中暴露 `window.__rtmtTest.stallRecognizer()`，调用后这些连接收到的消息不再派发给 SDK（拦截 `onmessage` 赋值与 `addEventListener('message')`），发送不受影响。② `AudioContext` 包装：子类化 `window.AudioContext` 并记录实例，`window.__rtmtTest.mixContext()` 返回第一个不带构造参数创建的实例（页面混音用），测试对其调用 `suspend()` / `close()`，或对记录下的该实例 `createMediaStreamDestination()` 结果的轨道调用 `stop()`。生产代码不加任何开关 | R1 已允许“只在浏览器中受控制造停滞、其余真实”；SDK 用全局 `WebSocket` 建连（U-6），拦截入站消息即可让识别器不报错地停止送出结果——这正是 IR-003 的现象，也是 AC-8 复现测试在修复前代码上能稳定失败的方式；`AudioContext` 包装能区分页面混音实例与 SDK 实例（SDK 以 `{ sampleRate: 16000 }` 创建，U-7） | Playwright `routeWebSocket`（会替换真实连接为路由处理器，且第 2 版已发现启用路由影响小窗样式，不采用）；在生产代码中加测试开关（R1 不允许） | U-6、U-7；SDK 源码出处见 U-6；第 3 版 TD-310 | AC-1～AC-3、AC-8；R1 |
| TD-707 | **AC-8 复现测试与修复前运行记录**：`tests/e2e/stall.spec.ts` 中的“识别器静默停止”用例（系统声音，播放器播放连续英语素材）：等到出现第一条定稿中文字幕后调用 `stallRecognizer()`，断言在之后 45 s 内状态变为“出错”且提示为 `MESSAGES.stalled`（45 s = 30 s 有声音时长 + 句间 2 s 静音不计入 + 检查与节流余量）。编码先只提交这条用例与 `speechStall.ts`、不改产品代码，在该提交上运行这条用例，确认它失败于“状态仍为正在听”的断言，把 Playwright 列表报告摘要（用例名、失败断言、提交 SHA，不含任何依赖接入信息）写入 `docs/verification/007-ac8-prefix-run.txt`；修复后同一用例通过 | AC-8 要求修复前失败、修复后通过；沿用第 3 版 `docs/verification/003-ac4-prefix-run.txt` 的留档方式；测试只依赖公开 DOM 与初始化脚本，修复前后代码都能运行 | 只写单元测试（修复前不存在被测模块，无法证明“修复前失败”） | 第 3 版 `docs/verification/003-ac4-prefix-run.txt` | FR-18；AC-8 |
| TD-708 | **部署与声明**：`docs/deployment.json` 只更新 `web` 的 `description`（加上“系统声音模式识别静默停滞时转为出错并提示”）；`errorLogRules` 不变（服务端日志写法不变）；`docs/dependencies.json` 不变；本 Feature 目录 `runtime/deployment.json` 与第 3 版相同 | 改动只在浏览器端，服务端行为、依赖与日志都没有变化 | — | `docs/deployment.json`、`docs/dependencies.json` 现状 | FR-19 |

## 技术先后依赖

- `AudioChainMonitor` 接口与 `displayAudio.ts` 的实现（TD-701）必须先于 `StallWatchdog`（TD-702）的实现完成接口定义，因为看门狗只通过该接口读取混音链状态与电平；两者的单元测试可分别以假对象进行。
- `recognition.ts` 新增 `onSessionEnded`（TD-703）必须与 `main.ts` 中对它的处理在同一次改动中完成，因为 `sessionStopped` 不再调用 `onFailure`：若只改前者，麦克风模式的会话结束将不再结束运行，破坏 FR-17。
- AC-8 复现用例与 `tests/e2e/speechStall.ts`（TD-706、TD-707）必须先于任何产品代码改动提交并在该提交上运行，因为“修复前失败”的证据只能在未包含修复的提交上取得。
- `MESSAGES.stalled`（TD-705）必须先于引用它的端到端断言，因为测试从 `src/web/messages.ts` 读取提示原文（与现有用例相同，避免文字重复维护）。修复前运行 AC-8 用例时该常量尚不存在，用例在修复前只断言“状态离开正在听”这一条即会失败，提示文字的断言放在状态断言之后。

## 领域与数据模型

不新增持久数据与接口字段。新增的内存模型：

```ts
// src/web/audioSource.ts
export interface AudioChainMonitor {
  /** 'ok'：混音 AudioContext 为 running 且混音输出轨道为 live；否则 'broken'。 */
  health(): 'ok' | 'broken';
  /** 共享音频最近约 0.7 s 的 RMS ≥ −50 dBFS。 */
  isVoiced(): boolean;
  /** 混音 AudioContext 'statechange' 时回调；返回取消订阅函数。 */
  onChange(listener: () => void): () => void;
}
export interface AcquiredAudio<S extends StreamLike = StreamLike> {
  stream: S;
  release(): void;
  monitor?: AudioChainMonitor;          // 新增：只有系统声音提供
}

// src/web/stallWatchdog.ts（新增）
export type StallCause = 'session-ended' | 'audio-chain' | 'no-results';
export const STALL_THRESHOLD_MS = 30_000;
export const CHECK_INTERVAL_MS = 1_000;
export const MAX_CREDIT_PER_CHECK_MS = 2_000;
export const VOICE_RMS_THRESHOLD = 0.00316;   // −50 dBFS（也可放在 displayAudio.ts，二者择一，单处定义）
export class StallWatchdog {
  constructor(deps: { monitor: AudioChainMonitor; onStall(cause: StallCause): void;
                      now?(): number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval });
  start(): void; noteResult(): void; noteSessionEnded(): void; stop(): void;
}

// src/web/recognition.ts
export interface RecognitionHandlers {
  onRecognizing(text: string, language: string | undefined): void;
  onRecognized(text: string, language: string | undefined): void;
  onFailure(errorCode: string): void;                                   // 只剩错误取消
  onSessionEnded(cause: 'session_stopped' | 'end_of_stream'): void;     // 新增
}

// src/web/main.ts
type StopReason = 'user' | 'share-ended' | 'error' | 'stalled' | 'unload';   // 新增 'stalled'
interface Run { /* 既有字段 */ watchdog?: StallWatchdog }                   // 新增
```

状态变化只有一条新增：正在听 →（静默停滞）→ 出错。其余状态与转换不变。

## Component 边界与项目结构

编码会创建或修改的路径：

- `src/web/`（`stallWatchdog.ts` 新增；`displayAudio.ts`、`audioSource.ts`、`recognition.ts`、`main.ts`、`messages.ts` 修改）
- `tests/unit/`（`stallWatchdog.test.ts`、`recognition.test.ts` 新增；`displayAudio.test.ts` 修改）
- `tests/e2e/`（`stall.spec.ts`、`speechStall.ts` 新增；`fixtures.ts` 按需增加读取停滞提示与状态时间线的辅助）
- `tests/support/`（`tts.ts`、`player.ts`：按需增加“长静音段”与“连续多遍”素材的拼接方式）
- `tests/fixtures/`（如需新的英语句组，加在 `sentences.en.json`）
- `docs/verification/`（`007-ac8-prefix-run.txt`）
- `./README.md`（补充静默停滞检测的说明与测试方法）

技术方案拥有、编码不得修改：`docs/dependencies.json`、`docs/deployment.json`、`infra/`、本 Feature 目录 `runtime/deployment.json`。`src/server/`、`src/shared/`、`Dockerfile`、`.dockerignore`、`scripts/`、各配置文件（`package.json`、`tsconfig*.json`、`eslint.config.js`、`vitest*.config.ts`、`playwright.config.ts`）本次不需要修改（单个慢速用例用 `test.setTimeout` 放宽超时，不改全局配置）。

```
src/web/
  stallWatchdog.ts     # 新：StallWatchdog、StallCause、判定常量（TD-702）
  displayAudio.ts      # 改：AnalyserNode 旁路、AudioChainMonitor、AudioContextLike/TrackLike 扩展（TD-701）
  audioSource.ts       # 改：AudioChainMonitor 接口、AcquiredAudio.monitor（TD-701）
  recognition.ts       # 改：onSessionEnded；EndOfStream 上报；sessionStopped 改走 onSessionEnded（TD-703）
  main.ts              # 改：Run.watchdog、noteResult、按输入方式处理 onSessionEnded、stopRun('stalled')（TD-703～TD-705）
  messages.ts          # 改：MESSAGES.stalled（TD-705）
tests/unit/            # 新：stallWatchdog.test.ts、recognition.test.ts；改：displayAudio.test.ts
tests/e2e/             # 新：stall.spec.ts、speechStall.ts
docs/verification/007-ac8-prefix-run.txt   # 新（TD-707）
```

## 数据流、状态、并发与生命周期

### 系统声音一次运行

```
点击“开始” → setState(starting)
  requestDisplayAudio（同步建混音 ctx + getDisplayMedia）→ AcquiredAudio{stream, release, monitor}
  fetchSpeechToken → createRecognitionSession(stream, token, handlers) → session.start()
  setState(running)
  run.watchdog = new StallWatchdog({ monitor, onStall: c => run === current && stopRun('stalled') }); start()
运行中：
  onRecognizing/onRecognized(text) → text.trim() 非空时 watchdog.noteResult() → pipeline.handle…（不变）
  onSessionEnded(_)               → watchdog.noteSessionEnded()          → 立即 stalled
  ctx 'statechange'               → watchdog.check() → health broken      → 立即 stalled
  每 1 s check()                  → broken → stalled；有声音累计 ≥ 30 s → stalled
  onFailure(errorCode)            → stopRun('error')（不变）
  共享轨道 ended                   → stopRun('share-ended')（不变）
  翻译连续失败                      → stopRun('error')（不变）
  点击“停止” / pagehide            → stopRun('user'/'unload')（不变）
stopRun(reason)：run = null → pipeline.endRun() → audio.release()（断开 analyser、取消订阅、停止轨道、关闭 ctx）
                 → tokenAbort → 清令牌定时器 → watchdog.stop() → setState → showNotice → session.dispose()
```

`run = null` 在最前，之后到达的任何回调（包括看门狗、SDK 在 `dispose` 过程中发出的 `sessionStopped`、翻译失败回调）都因 `run !== current` 或 `disposed` 被忽略，保证一次运行只有一个结束原因（FR-9）。`release()` 中先置 `released`，`ctx.close()` 引发的 `statechange` 已无订阅者。

### 看门狗计时

- 只在状态为“正在听”期间存在；“正在启动…”期间不计时，重新开始时新建实例（FR-11 不继承计时）。
- `voicedMs` 只在 `isVoiced()` 为真的检查中增加 `min(dt, 2000)`；静音检查不变（暂停）；`noteResult()` 清零。
- 判定时刻：会话结束、混音链挂起 —— 事件到达即判定（挂起也会在下一次 1 s 检查时被发现）；混音输出轨道被 `stop()` —— 下一次检查（≤ 约 1 s，后台对齐到整秒）；有声音无结果 —— 有声音累计到 30 s 的那次检查（约 30～31 s 的有声音时长）。

### 主页面与小窗

不改同步机制：`setState('error')` 经 `captionWindow.setState` 同步小窗状态文字与图标；小窗不显示提示文字（R2 答案）。字幕在主页面与小窗中都保留。

## Interface 与契约（Contract）

- HTTP 接口、NDJSON 格式、日志契约：全部不变。
- 页面 DOM 契约：结构不变；新增“出错”状态下 `#notice` 的一种文本 `MESSAGES.stalled`（`data-kind="error"`）。
- 浏览器内部接口：`RecognitionHandlers.onSessionEnded`、`AcquiredAudio.monitor`、`StallWatchdog`（见“领域与数据模型”），只在 `src/web/` 内使用。

## 安全、隐私、身份与 Secret

| 主题 | 设计 |
| --- | --- |
| 客户内容 | 电平只取 RMS 数值用于比较，不保存音频；不读取、不保存识别文本（只判断是否非空）；不新增任何网络请求或日志字段（FR-19）。 |
| 测试代码与生产隔离 | 停滞的受控制造只存在于测试初始化脚本（TD-706）；生产包中没有 `__rtmtTest` 或任何开关。 |
| 凭据、身份、最小权限 | 不变；不需要新的浏览器权限（`AnalyserNode` 作用于已授权的共享音频）。 |

## 配置、可观测性与运维

- 配置：无新增。
- 可观测性：服务端看不到停滞（按 Q-5 不新增健康信号）。停滞后用户重新开始会产生新的 `/api/speech-token` 请求，这是既有日志中唯一可间接观察到的痕迹。
- 错误日志识别规则：不变（`docs/deployment.json` → `operations.errorLogRules` 三条规则保持原样，理由见 TD-708）。

## SLO、限制、扩缩容、重试与恢复

- 唯一时限：判定时长 30 s（Q-1）。实现的判定延迟：会话结束、混音链挂起约 0～1 s；混音输出轨道中断 ≤ 约 1 s；有声音无结果为 30 s 有声音时长（+ ≤ 1 s 检查间隔）。
- 资源：每秒一次读取 32768 个浮点采样并求 RMS，主线程开销约为亚毫秒级；`AnalyserNode` 在音频线程的开销可忽略。
- 不自动恢复（Q-2）：恢复方式是用户点“开始”重新共享。
- 已知局限：见开放决策 OD-2（SDK 内部音频链）、OD-3（音量判定把纯音乐也算作“有声音”，规格 A-6 已接受）。

## 部署拓扑、迁移、Rollout 与 Rollback

- 部署：单服务 `web` 不变；只有 `app.js` 变化。`docs/deployment.json` 只更新描述文字；`errorLogRules` 不变。
- 依赖：沿用已绑定的 `speech`、`chat-model` dev / test 实例，不执行 IaC、不新建资源；`docs/dependencies.json` 不变，探测脚本 `infra/probes/speech.sh`、`infra/probes/chat-model.sh` 不变。
- 迁移：无。发布后仍打开的旧页面照旧运行（没有停滞检测），刷新后得到新版本。
- Rollout：平台按候选 SHA 构建并部署到 `cand-{deliveryShortId}`。
- Rollback：无状态，重新部署上一个通过的候选即可。

## 验证环境责任矩阵（Verification Environment）

| 验证类型 | 责任阶段 | 环境来源 | 依赖/凭据 | 编码证据 | 下游结果 |
|---|---|---|---|---|---|
| 静态检查、构建 | 编码、候选验证 | Agent Pod / 同镜像 Runner | 无 | `npm run lint`、`npm run typecheck`、`npm run build` | 候选验证记录 |
| 单元测试（developerTests） | 同上 | 同上 | 无外部调用 | 见“单元测试设计” | 候选验证记录（AC-1 SDK 事件路径的证据，按 OD-1 的决定） |
| 集成测试（integrationTests） | 同上 | 同上 | `dev` 实例 | 既有全部保持，本次不新增（服务端未改） | 候选验证记录 |
| 端到端（functionalTests） | 同上 | 本地 `localhost` + headed Chromium（Xvfb） | `dev` 实例 | 既有全部保留；新增 `stall.spec.ts`；`docs/verification/007-ac8-prefix-run.txt` | 候选验证记录 |
| 独立测试 | 独立测试 | 候选部署 `cand-*`，QA Pod（headed Chromium + Xvfb） | `test` 实例 | — | AC-1～AC-7 以真实页面、共享音频、语音与翻译服务执行，停滞按“可测性约定·受控触发”制造；AC-1 以“识别器静默停止”（有声音）场景执行并判定，报告注明 SDK 事件路径的证据来源为候选验证中的单元测试（OD-1 的决定），G4 由人确认 |
| 依赖探测 | 依赖与机密任务 | 平台隔离环境 | 单个依赖 | — | 沿用现有探测脚本 |

### 单元测试设计（`npm test`）

| 文件 | 覆盖 | 要点 |
| --- | --- | --- |
| `stallWatchdog.test.ts`（新） | FR-1～FR-4、FR-9、FR-11～FR-13 | 假 monitor + 注入时钟/定时器：持续有声音、无结果 → 第 30 s 的检查触发 `no-results`、29 s 时未触发；每 10 s 一次 `noteResult` → 120 s 内不触发；有声 20 s + 静音 60 s + 有声 10 s → 在累计 30 s 时触发（静音暂停不清零）；全程静音 10 分钟 → 不触发；`health` 变为 broken（静音期间也一样）→ 下一次检查或 `onChange` 回调时立即触发 `audio-chain`；`noteSessionEnded` → 立即触发 `session-ended`；连续两种原因 → `onStall` 只调用一次；定时器延迟 10 s 的一次检查只计 2 s；`stop()` 后不再触发且已取消订阅 |
| `displayAudio.test.ts`（改） | TD-701 | 结构化假 `AudioContext`：analyser 从 gain 旁路连接、未连接输出；`health()` 在 `state` 为 `suspended`/`closed`/`interrupted` 或输出轨道 `readyState === 'ended'` 时为 broken；`isVoiced()` 对 RMS 0、−60 dBFS、−40 dBFS 的样本分别为假、假、真；`onChange` 订阅 `statechange` 并可取消；`release()` 断开 analyser、取消订阅、不触发 `onEnded`；既有用例保持 |
| `recognition.test.ts`（新） | TD-703、FR-17 | `vi.mock('microsoft-cognitiveservices-speech-sdk')` 提供假 `SpeechRecognizer`：`canceled(Error)` → `onFailure(errorCode)`；`canceled(EndOfStream)` → `onSessionEnded('end_of_stream')`；`sessionStopped` → `onSessionEnded('session_stopped')`；`dispose()` 后任何事件都不回调 |

控制器（`main.ts`）的接线不做单元测试（依赖完整 DOM），由端到端覆盖，与现有做法一致。

### 端到端用例设计（`npm run test:e2e` 中的 `tests/e2e/stall.spec.ts`）

公共做法沿用 `system.spec.ts`：系统声音、播放器标签页 `RTMT-player-<worker>`、`--auto-select-tab-capture-source-by-title`、真实 `dev` 语音与翻译服务；状态与提示按角色读取；状态时间线由页面内仪表脚本记录（`body[data-state]` 每次变化的时间）。

| 用例 | 覆盖 | 方法与判定 | 单个用时（估计） |
| --- | --- | --- | --- |
| 识别器静默停止（AC-8 复现） | AC-1（按 OD-1 的决定）、AC-3、AC-8 | 连续英语素材（`meeting` 组连续两遍以上，保证触发后仍有 ≥ 60 s 语音）；出现第一条中文定稿后 `stallRecognizer()`；45 s 内状态为“出错”、`alert` 文本等于 `MESSAGES.stalled`；字幕保留（定稿条数不减少）；“开始”可用、“停止”不可用；共享已结束（播放器标签页的捕获指示消失 / 页面无 live 轨道） | 约 2 分钟 |
| 混音链挂起（静音期间与有声期间各一次） | AC-2、FR-4 | 运行中对 `mixContext()` 调用 `suspend()`：有声期间与素材静音段中各一次；5 s 内状态“出错”、提示为 `MESSAGES.stalled`；另一用例对混音输出轨道 `stop()`，同样判定 | 约 1.5 分钟 × 2 |
| 停滞后重新开始 | AC-4、FR-11 | 接上一用例：点击“开始”，自动选中播放器标签页，回到“正在听”、提示消失、出现新的中文定稿 | 并入上一用例 |
| 小窗状态同步 | FR-8 | 识别器静默停止用例中打开字幕小窗（麦克风以外的小窗样式限制不影响状态文字）：小窗 `#pip-status` 文本变为“出错”，小窗中没有提示文字 | 并入第一个用例 |
| 静音不误报 | AC-5、FR-12 | 素材：2 句语音 → 45 s 静音 → 2 句语音；全程状态保持“正在听”、无 `alert`；静音后出现新的定稿 | 约 1.5 分钟 |
| 连续 5 分钟正常运行不误报 | AC-6、FR-13 | 连续英语素材播放 ≥ 5 分钟（多遍拼接）；全程“正在听”、无 `alert`；每 60 s 区间内都有新定稿 | 约 6 分钟（`test.setTimeout(420_000)`） |
| 已有结束路径 | AC-7、FR-9、FR-10、FR-14～FR-16 | 关闭播放器标签页 → “已停止” + `shareEnded`；点“停止” → “已停止”、无提示；`fetch` 包装让一句返回 `upstream_rejected` → 只丢该句、仍“正在听”；让连续 3 句定稿返回 `upstream_unavailable` → “出错” + `interrupted`；以上情况都不出现 `MESSAGES.stalled`，且之后 35 s 内提示不变（停滞检测已停止） | 约 2.5 分钟（合并为 2 个用例） |
| 麦克风不变 | FR-17 | 既有 `microphone.spec.ts`、`stop.spec.ts` 全部保留并通过 | — |

全部既有端到端、集成、单元测试保留并须通过。

## 快速验证指南（Quickstart）

开发者命令（本 Feature 目录 `runtime/deployment.json`）：

```bash
npm ci                               # developerSetupCommands
npm run lint && npm run typecheck    # staticAnalysis
npm run build                        # build
npm test                             # developerTests：单元测试（约 6 s）
npm run test:integration             # integrationTests：真实 dev 实例
npm run test:e2e                     # functionalTests：build + xvfb-run headed Chromium
xvfb-run -a npx playwright test tests/e2e/stall.spec.ts   # 只跑本次新增的停滞用例（先 npm run build）
```

本地手动验证（Agent Pod 已注入 `dev` 实例的 `AIDH_DEP_*`）：

1. `npm run build && node dist/server/main.js`，Chrome 打开 `http://localhost:8080`，选“系统声音”，共享一个正在播放英语演讲的标签页，等出现字幕。
2. 在翻译页面的开发者工具控制台无法直接访问混音 `AudioContext`（在闭包中）；手动验证时用 TD-706 的初始化脚本（Playwright）或在页面加载前通过 DevTools “Snippets”注入同样的 `AudioContext` 包装，再执行 `__rtmtTest.mixContext().suspend()`：1 s 内状态变为“出错”，提示为停滞提示；点“开始”重新共享后恢复。
3. 把被共享的标签页静音 60 s：状态保持“正在听”，取消静音后继续出字幕。

### 实验 E-1：混音链挂起、旁路 Analyser 与轨道 `stop()` 的行为（Chromium 159.0.8154.6，Playwright 1.65.1，headless，约 2 分钟）

在仓库外临时目录写一次性脚本，用 Playwright 打开空白页并在页面中执行（已删除）：

```js
// 声源：另一个 AudioContext 的振荡器 → 增益 0.1 → MediaStreamDestination（模拟共享音频轨道）
const src = new AudioContext(); const osc = src.createOscillator(); const og = src.createGain(); og.gain.value = 0.1;
const md = src.createMediaStreamDestination(); osc.connect(og); og.connect(md); osc.start();
// 与 displayAudio.ts 相同的混音链 + 旁路 Analyser（不连接任何输出）
const ctx = new AudioContext(); await ctx.resume();
const s = ctx.createMediaStreamSource(md.stream); const g = ctx.createGain(); g.channelCount = 1; g.channelCountMode = 'explicit';
const d = ctx.createMediaStreamDestination(); s.connect(g); g.connect(d);
const a = ctx.createAnalyser(); a.fftSize = 32768; g.connect(a);
// 依次：播放 1 s 读 RMS；静音 1 s 读 RMS；ctx.suspend() 1 s 后读 state / 轨道 / RMS；resume 1 s 读；对 d 的轨道 stop()；ctx.close()
```

观察结果：

| 步骤 | 结果 |
| --- | --- |
| 播放中 | `ctx.state = running`，`sampleRate = 44100`，RMS = 0.0707 |
| 声源增益置 0 | RMS = 0（恰为 0） |
| `ctx.suspend()` 后 1 s | `state = suspended`，混音输出轨道 `readyState = live`、`muted = false`，RMS = 0 |
| `ctx.resume()` 后 1 s | `state = running`，RMS = 0.0707 |
| 对混音输出轨道 `stop()` | `readyState = ended`，`ended` 事件**未**触发 |
| `statechange` 事件序列 | `suspended` → `running` → `closed` |

复现：`npx playwright install chromium` 后用 Node 运行上述脚本（`chromium.launch()` + `page.evaluate`）。

## 支持 Runbook

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| 用户报告“翻译已中断：语音识别已停止输出结果” | 服务端没有对应日志（按 Q-5 不上报）；询问用户浏览器、共享方式、出现前运行了多久、页面是否在后台、Edge 是否开启“睡眠标签页”/效率模式 | 点“开始”重新共享即可；频繁出现时另开交付考虑健康信号（Q-5）或自动恢复（Q-2） |
| 播放纯音乐或音效约 30 s 后出现上述提示 | 规格 A-6 已接受的行为（按音量判定有无声音） | 无需处理；需要区分人声时另开交付 |
| 静音时出现上述提示 | 不应发生（AC-5）；可能是混音链被浏览器挂起（`audio-chain`）或 SDK 发出了会话结束事件 | 按产品缺陷报告，附浏览器版本与操作步骤 |

## 开放决策

- **OD-1（已决定 · 技术负责人回答，采纳推荐方案）· AC-1 的验收证据方式**：AC-1 所说的“识别会话以非错误原因结束”在 SDK 1.53.0 中只有在 SDK 内部音频源结束时才会发出（U-5），页面外（包括测试的初始化脚本）无法按需制造，且 R1 不允许在产品中加测试开关。本方案对这两个 SDK 事件都立即判定停滞（TD-703）。决定：AC-1 在独立测试中以“识别器静默停止”场景执行并判定——共享内容持续有声音，按 TD-706 拦截语音服务入站消息（识别会话不再产生结果、不报错），判定 30 s 内转为“出错”并显示停滞提示（与 AC-3 同一路径；静音期间该路径不提示，这一点不作为 AC-1 的判定条件）；SDK 事件路径（`EndOfStream` / `sessionStopped` → 出错 + 停滞提示）以候选验证中运行的单元测试 `tests/unit/recognition.test.ts` 与 `tests/unit/stallWatchdog.test.ts` 为证据；独立测试报告注明这一证据来源，G4 时由人确认。产品中不加测试开关。对实施的影响：上述两个单元测试文件名与覆盖内容（见“单元测试设计”）须保持，作为 AC-1 的证据；端到端“识别器静默停止”用例同时标注 AC-1。
- **OD-2（残余风险，不需决定）· SDK 内部音频链**：SDK 自建的 16 kHz `AudioContext` 无法被页面监视（U-7）。它若在共享内容静音期间被挂起，页面要到声音恢复后累计 30 s 才提示；有声音时与“有声音无结果”相同，30 s 内提示。AC-2 指的“混音用的音频处理链”（页面自己的混音 `AudioContext`）已被直接监视。
- **OD-3（已由规格接受，记录）**：“有声音”按音量判定（−50 dBFS），纯音乐、音效也算作有声音（规格 A-6）。
- **H-1（待验证假设）· 拦截入站消息后 SDK 不报错**：依据是源码中没有等待服务端消息的超时（U-6）；本会话没有依赖接入变量，未用真实服务验证。已做：阅读 `ServiceRecognizerBase.js`、`WebsocketMessageAdapter.js`。还缺：在真实 `dev` 语音服务上运行一次。验证步骤：编码在提交 AC-8 用例时于修复前代码上运行它，观察触发后 60 s 内状态始终为“正在听”、无 `alert`（这正是修复前失败的预期）。后备做法：若 SDK 在拦截后以错误取消（页面显示 `interrupted`），改为同时丢弃页面发往语音服务的音频帧（拦截二进制 `send`），使服务端无从产生结果；若仍报错，改用“让识别器读不到声音”的方式——对 SDK 实例（`{ sampleRate: 16000 }`）调用 `suspend()`，此时混音链健康、电平有声，判定走 `no-results`，同样满足 AC-3 与 AC-8。
- 建议，未纳入，待 G2 决定：无（规格已列的“按原因分别提示”建议保持在规格中，本方案不另行增加）。
