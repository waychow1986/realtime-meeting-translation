# realtime-meeting-translation
AIDelivery Hub project: 会议中把外语发言实时翻译成中文字幕的 Web 应用

浏览器打开页面、点击“开始”并允许麦克风后，发言由 Azure 语音服务流式识别（连续语言自动识别，无需选择语言），说话过程中即按中间识别结果显示临时中文译文（同一句同时最多 1 个临时翻译请求、两次请求间隔 ≥ 500 ms、原文未变化不重发，失败静默），每句识别完成后由 Foundry 大模型（`gpt-5.1`，`reasoning_effort: "none"`）流式翻译成定稿中文字幕并替换临时译文；点击“停止”立即释放麦克风。字幕只保存在当前页面内存中，刷新即清空。设计依据见 `.ai-delivery/features/001-v1/design.md`。

## 结构

| 路径 | 内容 |
| --- | --- |
| `src/server/` | Node.js 22 + Fastify 单服务：静态页面、`GET /healthz`、`POST /api/speech-token`（短时语音令牌）、`POST /api/translations`（NDJSON 流式翻译代理）、同源校验与限流、白名单日志 |
| `src/web/` | 浏览器端：麦克风采集、Speech SDK 连续识别、字幕状态机（`captionPipeline.ts`）、中文界面 |
| `src/shared/` | 前后端共用的接口约定 |
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

端到端测试说明：每个 worker 在本机端口 `18180+` 启动构建产物，服务端输出写入 `test-results/server-logs/`（用于检查日志不含客户内容）；浏览器使用完整版 Chromium（`channel: 'chromium'`，headless shell 不支持假音频采集），以 `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture` 把 TTS 合成的英语 WAV 作为麦克风输入。测试素材见 `tests/fixtures/sentences.en.json`（`meeting` 组为 6 句会议发言，附参考译文、关键要素与唯一锚点，用于流式临时字幕、含义一致与多句不重不漏的测试）。TTS 按句合成后拼接（前导静音 1 秒、句间 2 秒、末尾 4 秒），WAV 与每句起止时间（`.json`）缓存在系统临时目录；TTS 鉴权与应用相同，按 `AIDH_DEP_SPEECH_AUTH_MODE` 签发短时令牌后以 `Authorization: Bearer` 调用。假麦克风会循环播放 WAV，因此“字幕条数恰好等于句数”的断言在末尾静音之后、循环重放第一句之前进行。

## 日志

日志为 JSON 行（pino），只输出白名单字段，取值逐项校验，不合格的字段直接丢弃；从不记录识别原文、译文、令牌或密钥。

字段：`event`、`reqId`、`method`、`route`、`status`、`durationMs`、`kind`、`textLength`、`deltaCount`、`ttfbMs`、`reasoningTokens`、`upstream`、`upstreamStatus`、`errorCode`、`authMode`、`sourceLanguage`，以及下述例外字段。

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
