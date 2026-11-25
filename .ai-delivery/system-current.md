# 系统现状：realtime-meeting-translation（会议实时中文字幕）

> 本文件只记录仓库代码中已有的事实，每条注明出处（仓库相对路径）。对应代码版本：交付 DLV-20261124-CDD1D5B4A4A5（第 8 号 Feature“字幕行距可调”）分支发布后的状态。

## 1. 系统概览

- 形态：单个 Web 服务 `web`，同时提供浏览器页面（静态文件）和两个 POST 接口；浏览器经 Azure Speech SDK 直接连接语音服务做流式识别，服务端只签发短时语音令牌并代理大模型流式翻译（出处：`src/server/http/app.ts`、`src/web/recognition.ts`、`docs/deployment.json`）。
- 用户可见能力：选择输入方式（麦克风 / 系统声音）→“开始”→ 识别外语发言 → 显示临时与定稿中文字幕；“停止”立即释放采集；可调字号与行距；可弹出字幕小窗；首次打开显示使用引导（出处：`src/web/index.html`、`src/web/main.ts`）。
- 状态与存储：服务端无状态、无数据库；字幕只保存在当前页面内存（DOM）中，刷新即清空；浏览器本地只保存三项界面偏好（见 §7.2）（出处：`src/web/captionView.ts`、`src/web/preferences.ts`、`src/web/index.html` 引导说明“字幕只显示在当前页面，刷新或关闭页面后即清空”）。

## 2. 技术栈和版本

| 项 | 现状 | 出处 |
| --- | --- | --- |
| 语言 | TypeScript（`typescript` ^6.0.3），ESM（`"type": "module"`） | `package.json` |
| 服务端运行时 | Node.js ≥ 22；容器基础镜像 `node:22-bookworm-slim` | `package.json` `engines`、`Dockerfile` |
| Web 框架 | `fastify` ^5.12.8，静态文件 `@fastify/static` ^10.1.12 | `package.json`、`src/server/http/app.ts` |
| 日志 | `pino` ^10.4.0（JSON 行，白名单字段） | `package.json`、`src/server/logger.ts` |
| 云身份 | `@azure/identity` ^4.14.1（`DefaultAzureCredential`，按需动态导入） | `package.json`、`src/server/auth/azureAuth.ts` |
| 语音识别（浏览器） | `microsoft-cognitiveservices-speech-sdk` ^1.53.0 | `package.json`、`src/web/recognition.ts` |
| 浏览器端 | 原生 DOM，无前端框架；esbuild 打包为 IIFE，目标 `chrome120`、`edge120` | `scripts/build.mjs` |
| 构建 | `esbuild` ^0.28.2：服务端打包到 `dist/server/main.js`（`target: node22`，`packages: external`）；浏览器端 `dist/web/app.js`、`dist/web/sdk-timer-worker.js`，并复制 `index.html`、`styles.css` | `scripts/build.mjs` |
| 静态检查 | `eslint` ^10.15.0、`typescript-eslint` ^8.73.0；两个 tsconfig（服务端 `tsconfig.json`、浏览器端 `tsconfig.web.json`） | `package.json`、`eslint.config.js` |
| 测试 | `vitest` ^5.1.1（单元、集成）；`@playwright/test` 1.65.1（端到端，headed Chromium + Xvfb） | `package.json`、`vitest.config.ts`、`vitest.integration.config.ts`、`playwright.config.ts` |

## 3. 模块结构

### 3.1 服务端 `src/server/`

| 模块 | 职责 | 出处 |
| --- | --- | --- |
| `main.ts` | 进程入口：加载配置（失败记 `config_invalid` 后退出码 1）、创建日志、组装令牌服务与翻译器、监听 `0.0.0.0:PORT`；`SIGTERM`/`SIGINT` 优雅关闭，宽限 10 秒；`uncaughtException` 记 fatal 后退出；`unhandledRejection` 交给 `handleUnhandledRejection`；静态根目录默认 `dist/web`，可由 `WEB_ROOT` 覆盖 | `src/server/main.ts` |
| `config.ts` | 读取并校验环境变量（见 §5.2），只在 `ConfigError.problems` 中列出变量名 | `src/server/config.ts` |
| `http/app.ts` | Fastify 应用：安全响应头、同源校验、限流、`/healthz`、`/api/speech-token`、`/api/translations`、静态文件、统一错误处理 | `src/server/http/app.ts` |
| `http/rateLimit.ts` | 按客户端地址的令牌桶限流，键用进程内随机盐哈希，不保存原始地址 | `src/server/http/rateLimit.ts` |
| `speech/tokenService.ts` | 向语音资源 STS `/sts/v1.0/issueToken` 换取令牌；缓存 240 秒、并发请求合并、失败重试 1 次（间隔 300 ms）、单次超时 10 秒 | `src/server/speech/tokenService.ts` |
| `translation/translator.ts` | 调用 `/openai/v1/chat/completions` 流式翻译（SSE 解析）、构造提示词、映射上游错误；超时：临时 10 秒、定稿 20 秒 | `src/server/translation/translator.ts` |
| `auth/azureAuth.ts` | 上游鉴权头：`credential` 模式（语音 `Ocp-Apim-Subscription-Key`、模型 `api-key`）或 `platform-identity` 模式（`DefaultAzureCredential`，作用域 `https://cognitiveservices.azure.com/.default`，`Authorization: Bearer`） | `src/server/auth/azureAuth.ts` |
| `clientAbort.ts` | 判定客户端中止类错误（`AbortError`、`ABORT_ERR`、`ERR_STREAM_PREMATURE_CLOSE`、`ERR_STREAM_DESTROYED`）；此类未处理拒绝记 warn 不退出，其余记 fatal 并退出 | `src/server/clientAbort.ts` |
| `errors.ts` | `UpstreamError`：只带上游名与状态码，不带上游消息 | `src/server/errors.ts` |
| `logger.ts` | pino 封装与字段白名单（见 §9.2） | `src/server/logger.ts` |

### 3.2 共享 `src/shared/`

| 模块 | 职责 | 出处 |
| --- | --- | --- |
| `contracts.ts` | 前后端共用的接口类型与常量（语言代码格式、文本最大 2000 字符、请求体最大 8 KiB、`InputSource`、NDJSON 行类型、错误码） | `src/shared/contracts.ts` |
| `chineseText.ts` | 中文判定：至少含一个汉字，且字母只能是汉字、拉丁、注音或通用（Common）字符（`isChineseTranslation`、`containsForbiddenScript`） | `src/shared/chineseText.ts` |

### 3.3 浏览器端 `src/web/`

| 模块 | 职责 | 出处 |
| --- | --- | --- |
| `index.html` | 页面结构：顶栏控制区、提示条、字幕区、系统声音说明栏、使用引导对话框 | `src/web/index.html` |
| `main.ts` | 页面装配：状态切换、开始/停止流程、令牌刷新、字号与行距的应用和保存、“字幕显示”弹出面板定位、输入方式切换 | `src/web/main.ts` |
| `captionPipeline.ts` | 字幕状态机：临时/定稿翻译请求、节流、重试、中文判定与重译、提示条目 | `src/web/captionPipeline.ts` |
| `captionView.ts` | `DomCaptionView`：只用 `textContent` 写字幕；停留在底部时自动跟随，否则显示“回到最新字幕 ↓” | `src/web/captionView.ts` |
| `mirroredCaptionView.ts` | `MirroredCaptionView`：每次变更先写主页面、再写字幕小窗；小窗写入异常时断开小窗 | `src/web/mirroredCaptionView.ts` |
| `pip.ts` | `CaptionWindow`：Document Picture-in-Picture 字幕小窗（560×260），同步状态、字号与行距 | `src/web/pip.ts` |
| `preferences.ts` | 界面偏好读写（`localStorage`），存储异常时退回默认值 | `src/web/preferences.ts` |
| `recognition.ts` | 打开麦克风、获取语音令牌、Speech SDK 连续识别会话 | `src/web/recognition.ts` |
| `audioSource.ts`、`displayAudio.ts` | 输入采集抽象；系统声音经 `getDisplayMedia` 获取并混音，提供链路健康与音量监测 | `src/web/audioSource.ts`、`src/web/displayAudio.ts` |
| `stallWatchdog.ts` | 系统声音模式的识别停滞检测 | `src/web/stallWatchdog.ts` |
| `sdkTimers.ts`、`sdkTimerWorker.ts` | 把 Speech SDK 的计时器改走同源 Worker `/sdk-timer-worker.js`（页面 CSP 拦截 SDK 自带的 `data:` Worker），Worker 不可用时退回主线程计时器 | `src/web/sdkTimers.ts`、`src/web/sdkTimerWorker.ts` |
| `translateClient.ts` | 调用 `/api/translations` 并解析 NDJSON；`withInputSource` 给请求附加输入方式 | `src/web/translateClient.ts` |
| `support.ts`、`supportMatrix.ts` | 平台与能力识别（系统声音仅在提供 `getDisplayMedia`、User-Agent Client Hints 为非移动端且品牌为 Chromium / Google Chrome / Microsoft Edge 时判为支持；字幕小窗按是否存在 `documentPictureInPicture` 判断）；渲染系统声音支持列表 | `src/web/support.ts`、`src/web/supportMatrix.ts` |
| `uiState.ts` | 各状态的按钮可用性、状态图标、“接近底部”判定（阈值 48 px） | `src/web/uiState.ts` |
| `messages.ts` | 状态名与全部中文提示文案 | `src/web/messages.ts` |
| `guide.ts` | 首次使用引导：未看过时自动打开；以“知道了”或 Esc 关闭都记为已看过 | `src/web/guide.ts` |
| `styles.css` | 全部样式，同时供主页面和字幕小窗使用 | `src/web/styles.css`、`src/web/pip.ts` |

### 3.4 其他目录

| 路径 | 内容 | 出处 |
| --- | --- | --- |
| `infra/speech/`、`infra/chat-model/` | 两个依赖的 Terraform（azurerm ≥ 4、< 5），只在平台注入的资源组中创建 `azurerm_cognitive_account`（模型另有 `azurerm_cognitive_deployment`） | `infra/speech/main.tf`、`infra/chat-model/main.tf` |
| `infra/probes/` | 依赖探测脚本 `speech.sh`、`chat-model.sh` | `docs/dependencies.json` |
| `docs/` | `dependencies.json`（依赖声明）、`deployment.json`（部署声明）、`verification/`（历史验证记录） | `docs/` |
| `tests/` | `unit/`、`integration/`、`e2e/`、`fixtures/`（英、日、韩测试句）、`support/`（测试辅助） | 仓库目录 |

## 4. 命令

| 命令 | 作用 | 出处 |
| --- | --- | --- |
| `npm ci` | 安装依赖 | `README.md` |
| `npm run lint` | `eslint .` | `package.json` |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.web.json` | `package.json` |
| `npm run build` | `node scripts/build.mjs`，先清空再输出到 `dist/` | `package.json`、`scripts/build.mjs` |
| `npm start` | `node dist/server/main.js` | `package.json` |
| `npm test` | 单元测试：`tests/unit/**/*.test.ts`，Node 环境，单测超时 10 秒 | `package.json`、`vitest.config.ts` |
| `npm run test:integration` | 集成测试：`tests/integration/**/*.test.ts`，针对真实依赖实例（需 `AIDH_DEP_*` 变量），文件串行，超时 120 秒 | `package.json`、`vitest.integration.config.ts` |
| `npm run test:e2e` | 先构建，再在 `xvfb-run`（1920×1080×24）下运行 Playwright；`workers: 1`、不重试、单用例超时 150 秒、`locale: zh-CN` | `package.json`、`playwright.config.ts` |

## 5. 外部依赖和配置

### 5.1 外部依赖（声明于 `docs/dependencies.json`，schemaVersion 3）

| 名称 | 类型 | 用途 | 接入字段（变量名 `AIDH_DEP_<依赖>_<字段>`） | 出处 |
| --- | --- | --- | --- | --- |
| `speech` | `azure-ai-foundry-speech` | 浏览器经 Speech SDK 做实时连续识别与连续语言自动识别；服务端向 STS 换取语音令牌；测试用同一资源 TTS 合成英、韩、日素材 | `ENDPOINT`、`STT_HOST`、`TTS_HOST`、`REGION`、`KEY`（`KEY` 为 secret，仅 `credential` 模式） | `docs/dependencies.json` |
| `chat-model` | `azure-ai-foundry-chat-model` | 服务端流式 Chat Completions 翻译成简体中文，`reasoning_effort: "none"` | `ENDPOINT`、`DEPLOYMENT`、`KEY`（`KEY` 为 secret，仅 `credential` 模式） | `docs/dependencies.json`、`src/server/translation/translator.ts` |

- 两个依赖均声明 `realInstance` dev、test 为 true，形态 `cloud`，IaC 分别为 `infra/speech`、`infra/chat-model`，探测脚本 `infra/probes/speech.sh`、`infra/probes/chat-model.sh`；托管身份角色分别为 “Cognitive Services Speech User”、“Cognitive Services OpenAI User”；`secrets` 为空数组（出处：`docs/dependencies.json`）。
- 应用不在依赖资源中创建或保存数据，共享实例无需隔离脚本（出处：`docs/dependencies.json` `sharing`）。

### 5.2 运行时配置（环境变量）

| 变量 | 规则 | 出处 |
| --- | --- | --- |
| `AIDH_DEP_SPEECH_ENDPOINT`、`AIDH_DEP_SPEECH_STT_HOST` | 必填，`主机[:端口]` 格式；`:443` 被去掉；STS 基址为 `https://<ENDPOINT>`，识别端点为 `wss://<STT_HOST>/speech/universal/v2` | `src/server/config.ts` |
| `AIDH_DEP_SPEECH_REGION` | 必填 | `src/server/config.ts` |
| `AIDH_DEP_SPEECH_AUTH_MODE`、`AIDH_DEP_CHAT_MODEL_AUTH_MODE` | 必填，`credential` 或 `platform-identity`；`credential` 时对应 `_KEY` 必填 | `src/server/config.ts` |
| `AIDH_DEP_CHAT_MODEL_ENDPOINT` | 必填，`主机[:端口]` 格式，基址 `https://<ENDPOINT>` | `src/server/config.ts` |
| `AIDH_DEP_CHAT_MODEL_DEPLOYMENT` | 必填，作为请求的 `model` 字段 | `src/server/config.ts`、`src/server/translation/translator.ts` |
| `PORT` | 整数 1～65535，默认 8080 | `src/server/config.ts` |
| `LOG_LEVEL` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`，默认 `info` | `src/server/config.ts` |
| `CANDIDATE_LANGUAGES` | 逗号分隔 1～10 个语言代码，默认 `en-US,zh-CN,ja-JP,ko-KR` | `src/server/config.ts` |
| `SEGMENTATION_SILENCE_MS` | 整数 300～2000，默认 800 | `src/server/config.ts` |
| `TRUSTED_PROXY_HOPS` | 整数 0～3，默认 1；只信任最右侧 N 个 `X-Forwarded-*` 条目 | `src/server/config.ts`、`src/server/http/app.ts` |
| `WEB_ROOT` | 可选，静态文件根目录 | `src/server/main.ts` |

- 配置不合法时抛出 `ConfigError`，进程记 `config_invalid`（`configKeys` 只含变量名）并以退出码 1 结束（出处：`src/server/config.ts`、`src/server/main.ts`）。
- 浏览器端没有运行时配置项，所需参数（识别端点、候选语言、断句静音、令牌刷新间隔）都来自 `/api/speech-token` 的响应（出处：`src/web/recognition.ts`、`src/web/main.ts`、`src/server/http/app.ts`）。

## 6. 接口

所有响应带安全头：CSP（`default-src 'self'`；`script-src 'self'`；`style-src 'self'`；`img-src 'self' data:`；`connect-src 'self' wss://<STT_HOST> https://<STT_HOST>`；`frame-ancestors 'none'`；`base-uri 'none'`；`form-action 'none'`）、`Permissions-Policy: microphone=(self), display-capture=(self)`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`（出处：`src/server/http/app.ts` `securityHeaders`）。

| 接口 | 行为 | 出处 |
| --- | --- | --- |
| `GET /healthz` | `{ "status": "ok" }`，`Cache-Control: no-store` | `src/server/http/app.ts` |
| `POST /api/speech-token` | 同源校验 → 限流（每客户端每分钟 120）→ 返回 `SpeechTokenResponse`：`token`、`sttEndpoint`、`candidateLanguages`、`segmentationSilenceMs`、`refreshAfterSeconds`（240）；STS 失败返回 502 `upstream_unavailable` | `src/server/http/app.ts`、`src/shared/contracts.ts` |
| `POST /api/translations` | 同源校验 → JSON Schema 校验（`kind`: `partial`/`final`；`text` 1～2000 字符且含非空白；可选 `sourceLanguage`、`inputSource`（`microphone`/`system`）、`retranslate`（布尔）；不允许其他字段）→ `partial` 带 `retranslate: true` 返回 400 → 限流（临时每分钟 2400、定稿每分钟 1200）→ 200 `application/x-ndjson`，逐行 `{"type":"delta","text"}`，以 `{"type":"done"}` 或 `{"type":"error","code"}` 结束 | `src/server/http/app.ts`、`src/shared/contracts.ts` |
| 静态文件 | `@fastify/static`，`index.html` 为首页，`Cache-Control: no-cache`，ETag，拒绝点文件；只提供 `dist/web` 下的 `index.html`、`app.js`、`sdk-timer-worker.js`、`styles.css` | `src/server/http/app.ts`、`scripts/build.mjs` |

- 同源校验：`Sec-Fetch-Site` 存在时必须为 `same-origin`，且 `Origin` 必须存在并与请求主机一致，否则 403 `forbidden_origin`（出处：`src/server/http/app.ts` `isSameOrigin`）。
- 错误响应体：`{ "error": <ApiErrorCode> }`，取值 `invalid_request`、`forbidden_origin`、`payload_too_large`（请求体超过 8 KiB）、`rate_limited`（带 `Retry-After`）、`upstream_unavailable`、`not_found`、`internal_error`（出处：`src/shared/contracts.ts`、`src/server/http/app.ts`）。
- NDJSON 错误行 `code` 取值：`upstream_unavailable`、`upstream_throttled`（上游 429）、`upstream_rejected`（内容过滤）、`timeout`（出处：`src/shared/contracts.ts`、`src/server/translation/translator.ts`）。
- 上游模型请求：`stream: true`、`stream_options.include_usage: true`、`reasoning_effort: "none"`、`max_completion_tokens: 512`；原文放在 `<source lang="…">` 中并转义 `& < >`；`partial` 追加“片段”说明，`retranslate: true` 追加重译说明；`sourceLanguage` 为 `zh*` 但文本不含汉字或含禁止文字时 `lang="auto"`（出处：`src/server/translation/translator.ts`）。
- 客户端中途断开：服务端中止上游请求，记一条 `translation_completed`（`errorCode: client_aborted`，info 级）（出处：`src/server/http/app.ts`）。

## 7. 数据模型

### 7.1 内存中的数据

- 服务端不保存任何业务数据；内存中只有语音令牌缓存（最长 240 秒）和限流桶（键为加盐哈希，空闲 10 分钟后清理）（出处：`src/server/speech/tokenService.ts`、`src/server/http/rateLimit.ts`）。
- 浏览器端字幕段 `CaptionSegment`：`id`、`runEpoch`、识别原文 `sourceText`（只用于请求翻译，从不渲染，字幕段不再变化时释放）、`sourceLanguage`、`status`（`interim`/`finalizing`/`final`/`interrupted`/`dropped`）、已显示译文等（出处：`src/web/captionPipeline.ts`）。
- 字幕 DOM：`<ol id="captions">` 下每条为 `li.caption`，属性 `data-segment-id`、`data-status`，提示条目另有 `data-kind="notice"`（出处：`src/web/captionView.ts`、`src/web/styles.css`）。

### 7.2 浏览器本地存储（`localStorage`）

| 键 | 取值 | 默认值（未保存、值无法识别或存储不可用时） | 出处 |
| --- | --- | --- | --- |
| `rtmt.guideSeen` | `1` | 未看过（自动打开引导） | `src/web/preferences.ts`、`src/web/guide.ts` |
| `rtmt.captionSize` | `s`/`m`/`l`/`xl` | `m` | `src/web/preferences.ts` |
| `rtmt.captionSpacing` | `compact`/`normal`/`loose` | `normal` | `src/web/preferences.ts` |

- 读写都包在 `try/catch` 中：读取异常按未保存处理，写入异常被忽略；因此存储被禁用时页面照常工作，选择只在本次打开期间生效（出处：`src/web/preferences.ts` `createPreferences`）。
- 输入方式不保存，每次打开都从“麦克风”开始（出处：`src/web/main.ts` 注释 “Input source is not restored from storage”）。
- 不保存任何字幕、识别原文或译文（出处：`src/web/preferences.ts` 文件注释 “Never stores caption content”，全部写入点只有上表三个键）。

## 8. 浏览器端行为

### 8.1 状态与控制

- 五种状态 `idle`/`starting`/`running`/`stopped`/`error`，文案依次为“未开始”“正在启动…”“正在听”“已停止”“出错”，图标 ○ ◔ ● ■ ⚠；`body[data-state]` 反映当前状态（出处：`src/web/messages.ts`、`src/web/uiState.ts`、`src/web/main.ts`）。
- `starting`、`running` 时只有“停止”可用且输入方式不可切换；其他状态只有“开始”可用；选“系统声音”但浏览器不支持时“开始”不可用（出处：`src/web/uiState.ts` `controlsFor`、`src/web/main.ts`）。
- 开始流程：在点击处理中同步发起采集（麦克风 `getUserMedia`，或系统声音 `getDisplayMedia`）→ 取语音令牌 → 创建识别会话 → `running`；令牌按 `refreshAfterSeconds` 刷新，失败 30 秒后重试（出处：`src/web/main.ts`）。
- 结束原因 `user`/`share-ended`/`error`/`stalled`/`unload`：`error`、`stalled` 进入“出错”并显示对应提示，其余进入“已停止”；`share-ended` 显示信息级提示；页面 `pagehide` 时结束运行（出处：`src/web/main.ts` `stopRun`）。

### 8.2 识别与翻译

- 识别：`SpeechConfig.fromEndpoint(sttEndpoint)` + 授权令牌，`LanguageIdMode` 为 `Continuous`，断句静音取 `segmentationSilenceMs`，候选语言取 `candidateLanguages`，音频来自 `MediaStream`（出处：`src/web/recognition.ts`）。
- 麦克风约束：`echoCancellation`、`noiseSuppression`、`autoGainControl` 均为 true（出处：`src/web/recognition.ts` `openMicrophone`）。
- 系统声音：`getDisplayMedia` 选项见 `DISPLAY_OPTIONS`（视频限 1 fps、640×360，只为满足浏览器要求，不读取；音频关闭回声消除等处理，`suppressLocalAudioPlayback: false`，`systemAudio: 'include'`）；`NotAllowedError` 在 400 ms 内返回判为“被阻止”，否则为“取消”（出处：`src/web/displayAudio.ts`）。
- 临时译文：每段同时最多 1 个请求、两次请求间隔 ≥ 500 ms、原文未变不重发；整段收齐且判定为中文才显示，否则保留上一条；失败静默（出处：`src/web/captionPipeline.ts`）。
- 定稿译文：整段收齐后判定；非中文时带 `retranslate: true` 重译一次，仍非中文显示提示“（此句未能翻译成中文）”；可重试错误延迟重试一次（1 秒，或 `Retry-After`，最多 2 秒）；连续 3 句失败或连续 3 次网络失败视为翻译不可用并结束运行（出处：`src/web/captionPipeline.ts`、`src/web/messages.ts`）。
- 识别停滞检测（仅系统声音模式）：每秒检查一次（混音 AudioContext 状态变化时立即检查）；识别会话意外结束、混音链路中断，或有声（RMS ≥ −50 dBFS，阈值 0.00316）累计 30 秒无识别结果时结束运行并进入“出错”（出处：`src/web/stallWatchdog.ts`、`src/web/displayAudio.ts`、`src/web/main.ts`）。

### 8.3 页面布局

- 顶栏 `.topbar` 内依次为：标题、输入方式分段按钮组（麦克风 / 系统声音）、“开始”“停止”、当前状态、“字幕显示”按钮（`#display-button`）、“弹出字幕小窗”按钮及不支持说明、“使用引导”按钮（出处：`src/web/index.html`）。
- 宽度 ≤ 1099.98 px 时页面改为纵向滚动、字幕区最小高度 55vh、系统声音说明栏排在字幕区之前；宽度 ≤ 640 px 时控制区按一个列表排布并缩小控件（高 34 px），顶栏分组标题与“当前状态”文字只对读屏可见，“使用引导”只显示图标（出处：`src/web/styles.css` 两个 `@media` 块）。
- 系统声音说明栏 `#system-panel`：选“系统声音”时显示；进入“正在听”时折叠，回到非运行状态（“正在启动…”除外）时展开（出处：`src/web/main.ts` `setState`、`selectSource`）。

### 8.4 字幕区与“字幕显示”设置

- 字幕区 `#caption-panel` 背景为 `--caption-bg`（`#0d1117`），定稿字幕白色 `--caption-final`；临时（`interim`/`finalizing`）为浅灰 `--caption-interim`、左侧虚线、末尾“…”；被中断（`interrupted`）为浅灰斜体；提示条目颜色 `--caption-notice`、字号为当前字号的 0.75 倍、左侧实线（出处：`src/web/styles.css`）。
- 字幕区只在 `.caption-scroll` 内滚动；停留在底部（距底 ≤ 48 px）时新字幕自动跟随，否则显示“回到最新字幕 ↓”（出处：`src/web/captionView.ts`、`src/web/uiState.ts`、`src/web/styles.css`）。
- “字幕显示”按钮通过 HTML `popover`（`popovertarget="display-panel"`）打开面板 `#display-panel`，面板内有两组单选：“字号”（`name="caption-size"`）与“行距”（`name="caption-spacing"`）；面板打开时由 `placeDisplayPanel` 以 `position: fixed` 定位在按钮下方 6 px 处，左右保持距视口边缘 ≥ 8 px；按钮的 `aria-expanded` 随面板开关更新；窗口尺寸变化时关闭面板；≤ 640 px 时面板内的“字号”“行距”分组标题仍然可见（出处：`src/web/index.html`、`src/web/main.ts`、`src/web/styles.css` `#display-panel`）。
- 字号 4 档：`s` 小 24 px、`m` 中 32 px（默认）、`l` 大 40 px、`xl` 特大 52 px，由字幕区与小窗 `body` 上的 `data-caption-size` 设置 CSS 变量 `--caption-size`（出处：`src/web/styles.css`、`src/web/preferences.ts`）。
- 行距 3 档，由 `data-caption-spacing` 设置三个 CSS 变量，`.caption` 的 `line-height` 取 `--caption-line-height`、上下内边距取 `--caption-pad-y`，相邻两条字幕（`.caption + .caption`）的上外边距取 `--caption-gap`（出处：`src/web/styles.css`）：

| 档位 | 值 | 文案 | `--caption-line-height` | `--caption-pad-y` | `--caption-gap` |
| --- | --- | --- | --- | --- | --- |
| 紧凑 | `compact` | 紧凑 | 1.4 | 2px | 0px |
| 标准（默认） | `normal` | 标准 | 1.5 | 4px | 6px |
| 宽松 | `loose` | 宽松 | 1.8 | 4px | 14px |

  `:root` 上三个变量的初始值与“标准”档相同；页面初始 HTML 中字幕区为 `data-caption-spacing="normal"`、“标准”单选为选中（出处：`src/web/styles.css` `:root`、`src/web/index.html`）。
- 生效方式：选择字号或行距的 `change` 事件中，先应用（改字幕区 `data-caption-*`、通知字幕小窗、同步单选选中状态；切换前停留在底部则切换后滚动到底），再写入本地存储；不重建字幕、不影响识别与翻译流程（出处：`src/web/main.ts` `applyCaptionSize`、`applyCaptionSpacing` 及其事件处理）。
- 页面加载时按本地存储中的字号与行距（无效或不可用时为默认值）应用一次，单选选中状态随之设置（出处：`src/web/main.ts` 末尾的 `applyCaptionSize(preferences.captionSize())`、`applyCaptionSpacing(preferences.captionSpacing())`）。
- 字幕区背景颜色不随任何设置变化（出处：`src/web/styles.css` 中 `--caption-bg` 只在 `:root` 定义）。

### 8.5 字幕小窗

- 用 `window.documentPictureInPicture.requestWindow({ width: 560, height: 260 })` 打开；不存在该 API 时按钮不可用并显示“当前浏览器不支持悬浮字幕小窗……”（出处：`src/web/pip.ts`、`src/web/messages.ts`）。
- 小窗文档：引用同源 `/styles.css`，`body.pip`（背景 `--caption-bg`），包含状态条与字幕列表 `#pip-captions`；打开时复制主页面当前全部字幕，之后由 `MirroredCaptionView` 同步每次变更；小窗内没有任何调整控件、音视频元素或接口请求（出处：`src/web/pip.ts`、`src/web/styles.css`、`src/web/mirroredCaptionView.ts`）。
- 小窗 `body` 在打开时写入主页面当前的 `data-caption-size` 与 `data-caption-spacing`；小窗打开期间主页面切换字号或行距时，`CaptionWindow.setCaptionSize`/`setCaptionSpacing` 直接更新小窗 `body` 的对应属性，切换行距后小窗滚动到最新字幕；小窗未打开时只记住最新值供下次打开使用（出处：`src/web/pip.ts`、`src/web/main.ts`）。
- 小窗始终跟随最新字幕（无“回到最新字幕”按钮）；关闭小窗（按钮或小窗自身 `pagehide`）不影响主页面与采集（出处：`src/web/captionView.ts` `alwaysFollow`、`src/web/pip.ts`）。

### 8.6 使用引导

- `<dialog id="guide">` 以 `showModal()` 打开；未看过时页面加载即打开；关闭（“知道了”或 Esc）后写入 `rtmt.guideSeen=1`；“使用引导”按钮可随时再次打开（出处：`src/web/guide.ts`、`src/web/index.html`）。
- 引导共 5 条；其中“调整字号”一条的文案为“点击‘字幕显示’，在‘字号’中选择‘小 / 中 / 大 / 特大’，字幕立即按新字号显示”，引导中没有关于行距的条目（出处：`src/web/index.html`）。

## 9. 安全与日志

### 9.1 安全

- 上游密钥只在服务端使用（鉴权头由 `auth/azureAuth.ts` 生成）；浏览器只拿到 `/api/speech-token` 返回的短时语音令牌（出处：`src/server/auth/azureAuth.ts`、`src/server/http/app.ts`）。
- 两个 POST 接口都要求同源并按客户端地址限流；请求体上限 8 KiB；翻译请求体严格按 Schema 校验，不做类型转换、不接受多余字段（出处：`src/server/http/app.ts`、`src/shared/contracts.ts`）。
- 页面脚本只来自同源（CSP `script-src 'self'`），浏览器端只用 `textContent` 渲染字幕（出处：`src/server/http/app.ts`、`src/web/captionView.ts`）。
- 发往模型的原文放在 `<source>` 标签中并转义，系统提示词声明其中内容只是待翻译的数据（出处：`src/server/translation/translator.ts`）。
- 容器以用户 `10001` 运行（出处：`Dockerfile`）。

### 9.2 日志

- 格式：pino JSON 行写到标准输出，`level` 为文字（如 `info`），时间为 ISO 格式，消息字段 `msg`，每条带 `event`（出处：`src/server/logger.ts`）。
- 事件：`server_started`、`server_stopping`、`request_completed`、`translation_completed`、`upstream_error`、`speech_token_failed`、`config_invalid`、`unhandled_error`（出处：`src/server/logger.ts` `LogEvent`）。
- 字段白名单：`reqId`、`method`、`route`、`status`、`durationMs`、`kind`、`textLength`、`deltaCount`、`ttfbMs`、`reasoningTokens`、`upstream`、`upstreamStatus`、`errorCode`、`authMode`、`sourceLanguage`、`inputSource`、`retranslate`、`model`、`errorClass`、`configKeys`；每个字段按正则或枚举校验，不在白名单或校验不通过的字段被丢弃；不记录原文、译文、令牌或密钥（出处：`src/server/logger.ts` `VALIDATORS`、`sanitizeFields`）。
- 浏览器端只有 `console.debug` 输出错误名或原因代码，不输出字幕内容（出处：`src/web/main.ts`、`src/web/pip.ts`）。

## 10. 部署

- 部署声明（`docs/deployment.json`，schemaVersion 2）：一个服务 `web`，以仓库根目录和 `Dockerfile` 构建，端口 8080，健康检查 `/healthz`，对外暴露；服务描述包含“字号与字幕行距可调并保存在本机浏览器”（出处：`docs/deployment.json`）。
- 错误日志规则：`app-error-or-fatal`（`level` 为 `error`/`fatal`，高）、`upstream-errors-burst`（`event=upstream_error` 5 分钟内 10 次，中）、`node-crash-output`（匹配 Node 崩溃输出，高）（出处：`docs/deployment.json` `operations.errorLogRules`）。
- 镜像：两阶段构建，构建阶段 `npm ci` + `npm run build`，运行阶段 `npm ci --omit=dev`、只复制 `dist/`，`NODE_ENV=production`，`CMD ["node", "dist/server/main.js"]`；`.dockerignore` 排除 `tests`、`.ai-delivery`、`infra`、`docs` 等（出处：`Dockerfile`、`.dockerignore`）。

## 11. 测试

| 层次 | 位置 | 说明 | 出处 |
| --- | --- | --- | --- |
| 单元 | `tests/unit/` | 覆盖 `app`、`captionPipeline`、`chineseText`、`clientAbort`、`config`、`displayAudio`、`logger`、`mirroredCaptionView`、`preferences`（含行距的默认值、无效值、存储异常）、`rateLimit`、`recognition`、`sdkTimers`、`stallWatchdog`、`support`、`tokenService`、`translateClient`、`translator`、`uiState` | `tests/unit/*.test.ts` |
| 集成 | `tests/integration/` | 真实依赖实例：语音令牌、流式识别、翻译、翻译中止、中文判定、翻译失败 | `tests/integration/*.int.test.ts` |
| 端到端 | `tests/e2e/` | Playwright + headed Chromium，假麦克风播放 TTS 合成 WAV，服务端为构建产物，走真实依赖实例；用例文件：`captions`、`captionSpacing`、`chinese-only`、`isolation`、`microphone`、`non-chinese`、`pip`、`stall`、`stop`、`streaming`、`system`、`topbar`、`ui` | `tests/e2e/*.spec.ts`、`playwright.config.ts`、`tests/e2e/fixtures.ts` |

- 行距端到端用例 `tests/e2e/captionSpacing.spec.ts`：三档与默认、实测行距与相邻字幕间距的大小关系、运行中切换、保存与恢复、无效保存值、存储不可用 / 只读、字幕小窗同步（出处：`tests/e2e/captionSpacing.spec.ts` 各 `test(...)` 标题）。
- 端到端辅助：`openCaptionDisplay`、`closeCaptionDisplay`（Esc 关闭）、`chooseCaptionDisplay`（打开“字幕显示”面板选择字号或行距后关闭）；布局测量辅助在 `tests/e2e/ui.ts`（含 `probeSpacing`、`lineDistance`、`captionDistance`）（出处：`tests/e2e/fixtures.ts`、`tests/e2e/ui.ts`）。
- 顶栏用例：宽屏顶栏 1 行、约 480 px 宽最多 2 行；“字幕显示”面板在宽屏与约 480 px 宽时完整位于视口内、两组名称可见、无横向滚动（出处：`tests/e2e/topbar.spec.ts`）。
- 生产代码中没有测试开关；故障注入通过浏览器初始化脚本包装 `fetch`、`WebSocket` 实现（出处：`tests/e2e/translationOverride.ts`、`tests/e2e/speechStall.ts`）。

## 12. 约定

- 文案：界面与提示全部为简体中文，集中在 `messages.ts` 与 `index.html`（出处：`src/web/messages.ts`、`src/web/index.html`）。
- 界面偏好：新增偏好使用 `rtmt.` 前缀的 `localStorage` 键，通过 `createPreferences` 读写，取值先用类型守卫（如 `isCaptionSize`、`isCaptionSpacing`）校验，无效时回落默认值（出处：`src/web/preferences.ts`）。
- 字幕显示选项：以字幕区 / 小窗 `body` 上的 `data-*` 属性切换 CSS 变量，样式只写在 `styles.css`，主页面与小窗共用同一份样式表（出处：`src/web/styles.css`、`src/web/main.ts`、`src/web/pip.ts`）。
- 字幕写入：唯一的 `CaptionPipeline` 通过 `CaptionView` 接口写入；主页面与小窗经 `MirroredCaptionView` 同步（出处：`src/web/captionPipeline.ts`、`src/web/mirroredCaptionView.ts`）。
- 前后端共用的类型与常量放在 `src/shared/`（出处：`src/shared/contracts.ts`、`src/shared/chineseText.ts`）。
- 代码注释中以 `TD-xxx`、`FR-xxx`、`IQA-xxx` 等编号引用各次交付的设计与规格条目（出处：如 `src/web/preferences.ts` `TD-801`、`src/web/pip.ts` `TD-104`）。
