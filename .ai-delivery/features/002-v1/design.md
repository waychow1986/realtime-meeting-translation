# 企业实时翻译 · 系统声音实时翻译 技术方案

> 依据：已确认的意图第 2 版（含 Q-01、Q-02 人工答案）、`spec.md`（FR-101～FR-145、IQA-101～IQA-123，含 PQ-001～PQ-004 人工答案）、项目宪章，以及第 1 版技术方案 `.ai-delivery/features/001-v1/design.md`（下称“第 1 版方案”）与仓库现有代码。
> 本方案只决定“怎么做”，不改变已确认的产品行为。沿用第 1 版技术基线（TypeScript + Node.js 22 + Fastify 单服务、原生 DOM + esbuild、Speech SDK、pino 白名单日志、Vitest + Playwright），不引入新的运行时依赖、外部服务或依赖实例。

## 技术上下文（Technical Context）

| 项 | 选择（相对第 1 版的变化以 **粗体** 标出） |
| --- | --- |
| 语言 / 运行时 | TypeScript；服务端 Node.js 22；浏览器端 ES2022，目标桌面 Chrome / Edge 最新版 |
| 服务端 | Fastify 5 单服务 `web`（静态页面 + `/api/speech-token` + `/api/translations`）。**仅两处改动**：`Permissions-Policy` 增加 `display-capture=(self)`；翻译请求增加可选枚举字段 `inputSource` 并写入白名单日志 |
| 浏览器端音源 | 麦克风：`getUserMedia`（不变）；**系统声音：`navigator.mediaDevices.getDisplayMedia`（共享标签页 / 窗口 / 整个屏幕并带音频）+ Web Audio 下混为单声道**，再交给同一个 Speech SDK 识别会话 |
| 识别 / 翻译 | 不变：Speech SDK 连续识别 + 连续语言识别（`universal/v2`）、断句 800 ms；大模型流式翻译 `reasoning_effort: "none"` |
| 悬浮字幕小窗 | **Document Picture-in-Picture API（`documentPictureInPicture.requestWindow`）**，Chrome / Edge 116+ 支持；不支持时按钮不可用 |
| 界面 | **重做为统一视觉设计**：输入方式单选、开始/停止、五值状态（含“出错”）、4 档字号、首次引导 `<dialog>`、系统声音说明与支持列表、响应式布局 |
| 浏览器内偏好 | **`localStorage`**：`rtmt.guideSeen`、`rtmt.captionSize`（只存界面偏好，不含客户内容，FR-144） |
| 测试 | Vitest（单元、集成）；**Playwright 以有界面（headed）Chromium 在 `xvfb-run` 虚拟显示中运行**（系统声音采集的硬性前提，见 TD-108）；Firefox 用于“不支持”场景 |
| 依赖 | **沿用**第 1 版已绑定的 `speech`、`chat-model` 实例（dev / test），不新建 |
| 存储 | 无 |

## 治理与技术约束

| 约束（来源） | 设计响应 |
| --- | --- |
| 宪章·最简单架构；规则 1 沿用技术基线 | 不新增服务、依赖、框架或 npm 运行时包；系统声音与麦克风共用识别会话、字幕管线、翻译接口；小窗复用同一字幕视图（TD-104）。 |
| 宪章·凭据留在服务端、least privilege | 系统声音模式与麦克风模式使用同一个短时语音令牌接口；不新增任何凭据；只请求所选的一种媒体权限（TD-101）；`Permissions-Policy` 只对本源开放 `microphone` 与 `display-capture`。 |
| 宪章·绝不记录客户内容 | 共享画面轨道从不连接任何输出、从不编码或上传（TD-103）；音频仍由浏览器直送语音服务、不经服务端；服务端新增日志字段只有枚举 `inputSource`。 |
| 宪章·外部集成以真实测试服务验证，Mock 不替代 | 端到端测试在真实 `dev` 实例上运行，系统声音来自真实的浏览器标签页共享（headed Chromium + Xvfb，TD-108），不以假设备替代共享。 |
| 客户约束：沿用 Azure Foundry 语音（实时 + 自动语言识别）与大模型（关闭 reasoning）及现有依赖实例 | 识别与翻译代码路径与第 1 版相同；依赖声明的推荐改为“沿用第 1 版已绑定的实例”（见“依赖声明摘要”）。 |
| 意图·不装插件/驱动；只用浏览器共享能力 | 只使用标准 Web API `getDisplayMedia` 与 Document PiP；无扩展、无虚拟声卡。 |
| 意图·不混合两路输入（FR-104） | 一次运行只持有一个音源；系统声音模式代码路径中不存在 `getUserMedia` 调用（单元测试 + e2e 计数断言）。 |
| 意图·麦克风模式不退化（AC-09，PQ-004） | 麦克风采集、识别、翻译、停止逻辑不改；只改界面呈现（状态名称、“出错”状态、视觉、字号、引导、小窗），第 1 版 e2e 全部保留并按新状态名更新断言。 |
| 平台：候选部署网络默认拒绝 | 无新增出站目标；浏览器仍只连 `STT_HOST`（CSP `connect-src` 不变）。 |

## 架构概览（Architecture）

```
┌──────────────────────────── 浏览器（Chrome / Edge 桌面版） ─────────────────────────────┐
│ 控制区：输入方式(麦克风|系统声音) 开始 停止 状态 字号 弹出字幕小窗 使用引导              │
│                                                                                          │
│  ┌ AudioSource（按所选输入二选一，TD-101）───────────────┐                               │
│  │ MicrophoneSource: getUserMedia（第1版不变）             │                               │
│  │ DisplayAudioSource: getDisplayMedia → 只取音频轨       │ MediaStream(单声道)           │
│  │   → AudioContext 下混单声道 → MediaStreamDestination   │──────────┐                    │
│  │   视频轨：不接任何输出，只为保持浏览器共享会话（TD-103）│          ▼                    │
│  └────────────────────────────────────────────────────────┘  RecognitionSession(第1版)   │
│                                                    Speech SDK 连续识别+连续LID ──WSS──▶ STT_HOST
│                                                              │ recognizing/recognized     │
│                                                              ▼                            │
│                                                CaptionPipeline(第1版) ── /api/translations│
│                                                              │                            │
│                                     MirroredCaptionView（TD-104）                         │
│                                       ├─ 主页面字幕区 DomCaptionView                       │
│                                       └─ 字幕小窗 DomCaptionView（Document PiP，可选）     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
          │ POST /api/speech-token      │ POST /api/translations (NDJSON)
          ▼                             ▼
   服务 web（Fastify，第 1 版不变，另加 display-capture 权限策略与 inputSource 日志字段）
          ├─▶ 依赖 speech（STS 令牌）     └─▶ 依赖 chat-model（流式，reasoning none）
```

要点：

1. **音源可插拔，下游不变**：两种输入都产出一个“音频 MediaStream”交给第 1 版的 `createRecognitionSession`；字幕管线、翻译、epoch 丢弃、停止语义全部复用，AC-03/AC-04/AC-10 在系统声音模式下自然与麦克风模式一致。
2. **共享画面不离开浏览器**：`getDisplayMedia` 必须带视频（浏览器规定），视频轨不连接任何元素、画布、编码器或网络，只为保持浏览器原生的共享会话与“停止共享”按钮（TD-103）。
3. **小窗与主页面同源同数据**：字幕管线只有一个，视图层把每次变更同步写到两个 DOM（TD-104），因而两处内容、顺序、更新时刻天然一致。
4. **服务端几乎不变**：系统声音不经服务端；服务端只增加权限策略与一个枚举日志字段。

## 技术决策与替代方案

| 决策 ID | 选择 | 理由 | 已考虑替代方案 | 来源 |
|---|---|---|---|---|
| TD-101 | 新增 `AudioSource` 抽象：`MicrophoneSource`（封装第 1 版 `openMicrophone`，不改行为）与 `DisplayAudioSource`；`start()` 只按开始时所选输入创建一个音源，运行中输入方式控件禁用 | 一次只持有一种音源（FR-103、FR-104、不变量 2）；下游代码不感知音源类型 | 同时打开两路再按选择静音一路（违反“不混合”与 least privilege） | AC-01；FR-101～FR-104 |
| TD-102 | 系统声音用 `navigator.mediaDevices.getDisplayMedia(options)`，在点击“开始”的同步调用栈内、任何 `await` 之前调用（满足瞬时用户激活要求）。`options = { video: { frameRate: { max: 1 }, width: { max: 640 }, height: { max: 360 } }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include', preferCurrentTab: false }` | 标准 Web API，无需插件或驱动（AC-08）；`systemAudio:'include'` 让 Windows 整屏共享出现“同时分享系统音频”选项（Q-01）；`suppressLocalAudioPlayback:false` 保证使用者仍听到原声（A-03、FR-109）；关闭回声消除/降噪/自动增益，避免对播放内容做语音通话处理而损伤识别；`selfBrowserSurface:'exclude'` 不让使用者误选本应用标签页（本页无声）；画面参数取最低以减少无用开销 | 浏览器扩展 `tabCapture`（需安装插件，违反 AC-08）；虚拟声卡（违反不做的事）；`getUserMedia` 选“立体声混音”设备（依赖系统驱动设置，多数机器不可用） | AC-02、AC-08；FR-105、FR-109、FR-110；Q-01 |
| TD-103 | 共享得到的视频轨**保留但不消费**：不挂到 `<video>`、画布、`MediaRecorder`、`RTCPeerConnection` 或任何网络通道；停止时与音频轨一起 `stop()` | 保留视频轨可使浏览器原生共享会话（共享提示条、“停止共享”按钮、共享指示）的行为最标准，AC-05 的“浏览器停止共享”与 FR-116“共享指示随之消失”都依赖该会话；不消费即满足 A-02 / FR-108（不显示、不上传、不保存）。原型实测（见“可行性验证”）：停止视频轨后音频轨仍保持 `live` 且有信号，因此若后续发现保留视频轨有副作用，可改为取得后立即停止视频轨，属实现级回退，不改变行为 | 取得后立即停止视频轨（各浏览器对“只剩音频轨”时共享提示条的处理未逐一验证，作为回退） | AC-05、AC-10；A-02；FR-108、FR-116 |
| TD-104 | 字幕小窗用 Document Picture-in-Picture：点击“弹出字幕小窗”→ `documentPictureInPicture.requestWindow({ width: 560, height: 260 })`；小窗文档引入同源 `/styles.css`，放入状态与字幕列表；新增 `MirroredCaptionView`（实现第 1 版 `CaptionView` 接口），把 `append/setText/setStatus/remove` 同步写入主页面与小窗两个 `DomCaptionView`；打开时以主页面列表克隆初始化小窗 | Document PiP 窗口由浏览器保持在其它窗口（含全屏视频、桌面会议软件）之上，且是本页同源文档，可直接写 DOM，无需消息通道；单一字幕管线 + 同步写两个视图，保证“同一份字幕、同时更新”（FR-137）；主页面卸载时浏览器自动关闭小窗（FR-138） | 视频 PiP（把字幕画到 canvas 再 `captureStream` 进 `<video>` 的画中画：字号/样式/换行受限、文字非 DOM，难以满足对比度与可测性）；`window.open` 弹窗（不能悬浮在其它应用之上）；BroadcastChannel 同步两个页面（多一套状态与时序） | AC-12；FR-136～FR-140；Q-02 |
| TD-105 | 能力检测（不做浏览器版本白名单）：<br>**系统声音**：`navigator.mediaDevices?.getDisplayMedia` 存在，且 `navigator.userAgentData` 存在、`mobile === false`、`brands` 含 `Chromium` / `Google Chrome` / `Microsoft Edge` 之一 → 支持；否则不支持。平台取 `userAgentData.platform`（`Windows`/`macOS`/`Linux`/其它）用于突出对应的说明行与无声音时的针对性提示。<br>**字幕小窗**：`'documentPictureInPicture' in window` → 支持 | Firefox、Safari 虽有 `getDisplayMedia` 但不提供共享音频，只能按引擎识别；Chromium 系浏览器都提供标签页音频；`userAgentData` 只在 Chromium 系提供，Firefox/Safari 下天然判为不支持（FR-119）；小窗以特性检测最可靠（FR-139） | 解析 UA 字符串（易误判）；先调用一次 `getDisplayMedia` 再判断（会弹窗，违反“选择即说明”） | AC-06、AC-12；FR-118、FR-119、FR-139 |
| TD-106 | 系统声音音频先经 Web Audio 下混为单声道再交给 Speech SDK：`AudioContext`（在点击处理函数中同步创建并 `resume()`）→ `createMediaStreamSource(displayStream)` → `GainNode{channelCount:1, channelCountMode:'explicit', channelInterpretation:'speakers'}` → `createMediaStreamDestination()`（`channelCount=1`）；**不连接 `ctx.destination`** | 共享音频通常为 48 kHz 立体声，显式按“扬声器”规则下混可避免只取左声道丢失偏右声道的人声；不连接输出，避免页面再播放一遍造成回声或音量变化（FR-109）；在用户点击时创建上下文，避免自动播放策略把上下文置为 `suspended` | 直接把共享流交给 SDK（下混方式取决于 SDK 内部实现，不可控）；在服务端转码（音频需经服务端，违反第 1 版 TD-002 的架构） | AC-02、AC-04；FR-109 |
| TD-107 | 共享结束检测：对共享流的**每一条轨道**监听 `ended`，任一触发即 `stopRun('share-ended')` → 状态“已停止”+ 提示“共享已结束”；该处理先于 SDK 可能随后报告的 `canceled`/`sessionStopped`，后者因 `run` 已失效被忽略 | 浏览器“停止共享”、被共享标签页/窗口关闭都会使轨道 `ended`（原型实测关闭被共享标签页即触发）；FR-116 第 2、3 种情况需提示且归为“已停止”而非“出错” | 轮询轨道状态（延迟、耗电）；依赖 SDK 报错（会被误判为“出错”） | AC-05；FR-116；E-104 |
| TD-108 | 端到端测试改为 **headed Chromium（Playwright `channel: 'chromium'`, `headless: false`）在 `xvfb-run` 虚拟显示中运行**；系统声音素材在测试打开的另一个标签页中播放，用 Chromium 启动参数 `--auto-select-tab-capture-source-by-title=<素材标签页标题>` 让共享弹窗自动选中该标签页（含音频）；麦克风干扰仍用 `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`；**禁止使用 `--use-fake-ui-for-media-stream`** | 原型实测（Agent Pod 同镜像）：headless shell 调用 `getDisplayMedia` 返回 `NotSupportedError`；新 headless 能取得音频轨但信号恒为 0；headed + Xvfb 取得真实“Tab audio”且有信号，并可与假麦克风同时使用；`--use-fake-ui-for-media-stream` 会把共享替换成“假屏幕 + 假麦克风音频”（实测音轨标签为 `Fake audio`），会让“麦克风不混入”测试失去意义 | 继续 headless（系统声音无信号，无法取得真实证据）；用假设备替代共享（Mock，宪章不接受） | 宪章·测试与质量；IQA-102～IQA-117 |
| TD-109 | 取消共享与无音频共享的自动化方式：**取消**——共享弹窗打开后用 X11 XTest 向虚拟显示发送 `Escape`（`python3 -I tests/support/xkey.py Escape`，经 `ctypes` 调用系统已有的 `libX11`/`libXtst`，不新增包），浏览器返回真实的 `NotAllowedError: Permission denied by user`；**无音频**——另起浏览器以 `--auto-select-desktop-capture-source=Entire screen` 共享整个屏幕，Linux 上返回 0 条音频轨（真实的“共享内容不含声音”）；**浏览器停止共享**——关闭被共享的素材标签页（与浏览器“停止共享”同样以轨道 `ended` 呈现，TD-107） | 均为浏览器真实行为而非替身，原型已逐一实测；浏览器自身提示条上的“停止共享”按钮属于浏览器界面，自动化无法点击，以同一事件路径覆盖 | 只做单元测试（不是端到端证据） | AC-05、AC-07；IQA-107、IQA-110、IQA-111 |
| TD-110 | 状态模型扩为 `idle | starting | running | stopped | error`，中文为“未开始 / 正在启动… / 正在听 / 已停止 / 出错”；所有“不能产生字幕”的失败（麦克风被拒/无设备、共享取消/被拒/无声音/失败、令牌失败、识别或翻译中断）一律进入 `error` 并显示中文原因与恢复方法；“开始”在 `idle/stopped/error` 可用 | FR-128 规定的四种状态 + 过渡提示；第 1 版麦克风被拒时回到原状态，按 FR-126 允许改为“出错”，功能行为（提示、可恢复、无字幕）不变 | 保留第 1 版“回到原状态”（与 FR-128 不一致） | AC-07、AC-11；FR-121～FR-123、FR-126、FR-128 |
| TD-111 | 共享被拒的两类提示：`NotAllowedError` 且从调用到失败 < 400 ms（未出现弹窗，通常是浏览器策略或操作系统屏幕录制权限阻止）→ “浏览器或系统阻止了共享”提示，含浏览器站点设置与 macOS“系统设置 → 隐私与安全性 → 屏幕与系统录音”的恢复说明；否则 → “未选择共享内容/共享授权被拒绝”提示。其它异常（`NotFoundError`/`NotReadableError`/`AbortError`/`InvalidStateError`/其它）→ “无法开始共享”通用提示 | Chrome 不记住对 `getDisplayMedia` 的拒绝，但策略或系统权限会使其立即失败；原型实测用户取消发生在弹窗出现之后（约 2 s）。两类提示都给出可操作的恢复方法（FR-121） | 只给一种提示（被策略阻止时使用者无从下手） | AC-07；FR-121 |
| TD-112 | 翻译请求增加可选字段 `inputSource: 'microphone' | 'system'`（严格枚举），服务端写入 `translation_completed` 日志字段 `inputSource` | 为 AC-10 / IQA-114 提供“系统声音模式的翻译经同一部署完成”的服务侧证据，同时便于运维区分两种模式的用量；字段是枚举，不是客户内容；可选字段保持对旧页面兼容 | 不记录（无法从服务侧区分模式） | AC-10；FR-141 |
| TD-113 | 界面偏好存 `localStorage`：`rtmt.guideSeen = '1'`（关闭引导时写入）、`rtmt.captionSize ∈ {s,m,l,xl}`；读写包在 `try/catch` 中，存储不可用时退化为“每次都显示引导、默认字号” | FR-133 “同一浏览器再次打开不自动显示”；FR-144 允许保留界面偏好 | Cookie（会随请求发往服务端，无必要） | AC-11；FR-133、FR-144 |
| TD-114 | 字号 4 档用 CSS 变量 `--caption-size`：小 24 px、中 32 px（默认）、大 40 px、特大 52 px；`line-height: 1.5`；主页面与小窗共用同一 CSS，切换时同时改两处 `data-caption-size` 属性 | 满足“中 ≥ 28、特大 ≥ 48、行距 ≥ 1.4 倍、逐档增大”（PQ-003）；只改 CSS 变量不触碰字幕管线，不中断采集（FR-132） | 用 `zoom`/`transform` 缩放（影响布局与换行） | AC-11；FR-129、FR-132 |
| TD-115 | 不改服务端识别/翻译/令牌/限流逻辑与依赖声明的约束；限流阈值沿用（单页临时 ≤ 120 次/分，系统声音模式连续播放时同样由 TD-006 单飞节流约束） | 系统声音模式的调用模式与麦克风模式相同（只是内容来源不同），连续播放视频时临时翻译频率仍受单飞 + 500 ms 节流上限约束 | 为系统声音单独调阈值（无依据） | AC-10；第 1 版 TD-006、TD-010 |

## 可行性验证（原型实测）

方案编写时在与 Agent Pod 相同的镜像中（Playwright 1.65 自带 Chromium，Linux，`xvfb-run`）用一次性原型（未入库）实测，结论直接决定 TD-103、TD-108、TD-109：

| 场景 | 结果 |
| --- | --- |
| headless shell 调用 `getDisplayMedia` | `NotSupportedError` —— 不可用 |
| 新 headless（`channel:'chromium'`）+ 自动选中素材标签页 | 得到 1 条音频轨，但峰值恒为 0 —— 无真实声音 |
| headed + Xvfb + 自动选中素材标签页 | 音频轨标签 `Tab audio`，峰值 ≈ 1.0（素材为满幅正弦）—— 可用 |
| 同上 + 假麦克风参数（不含 fake-ui） | 共享仍为 `Tab audio`，与假麦克风互不干扰 —— 可同时做“麦克风干扰”测试 |
| 同上 + `--use-fake-ui-for-media-stream` | 共享被替换为假屏幕，音频轨为 `Fake audio` —— 禁用该参数 |
| 停止视频轨后的音频轨 | 仍为 `live`，峰值不变 |
| 关闭被共享的标签页 | 音频轨触发 `ended` |
| `--auto-select-desktop-capture-source=Entire screen` | `displaySurface=monitor`，音频轨 0 条（无声音共享） |
| 共享弹窗中按 Esc（XTest） | `NotAllowedError: Permission denied by user`，约 2 s 后返回 |
| `documentPictureInPicture.requestWindow`（点击触发） | headless 与 headed 下均成功打开 |

## 领域与数据模型

仍不持久化任何业务数据。浏览器端模型（只在页面内存）：

```ts
type InputSource = 'microphone' | 'system';                     // 默认 'microphone'，每次加载重置（FR-102）
type AppState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';
// 文案：未开始 / 正在启动… / 正在听 / 已停止 / 出错（TD-110）
type CaptionSize = 's' | 'm' | 'l' | 'xl';                      // 小/中/大/特大，默认 'm'

type StopReason = 'user' | 'share-ended' | 'error' | 'unload';

interface Run {                                                  // 第 1 版 Run 扩展
  epoch: number;
  source: InputSource;                                           // 开始时锁定（FR-103）
  audio?: AcquiredAudio;                                         // 见下
  session?: RecognitionSession;
  refreshTimer?: ReturnType<typeof setTimeout>;
  tokenAbort: AbortController;
}

interface AcquiredAudio {
  stream: MediaStream;        // 交给 Speech SDK 的音频流（麦克风原始流，或系统声音下混后的单声道流）
  release(): void;            // 停止全部原始轨道（含共享视频轨）、断开并关闭 AudioContext；幂等
}

interface SupportInfo {
  systemAudio: 'supported' | 'unsupported';
  platform: 'windows' | 'macos' | 'linux' | 'other';
  pip: boolean;
}
```

`CaptionSegment`、句段状态机、节流与定稿规则与第 1 版完全相同（`src/web/captionPipeline.ts` 不改逻辑）。

浏览器存储（TD-113）：`localStorage['rtmt.guideSeen']`、`localStorage['rtmt.captionSize']`，不含客户内容。

服务端：无新增模型；`TranslationRequest` 增加可选 `inputSource`。

## Component 边界与项目结构

Coding 会创建或修改的路径（写路径白名单）：

- `./package.json`、`./package-lock.json`、`./tsconfig.json`、`./tsconfig.web.json`、`./eslint.config.js`、`./vitest.config.ts`、`./vitest.integration.config.ts`、`./playwright.config.ts`
- `./Dockerfile`、`./.dockerignore`、`./.gitignore`、`./README.md`
- `scripts/`
- `src/server/`
- `src/web/`
- `src/shared/`
- `tests/unit/`、`tests/integration/`、`tests/e2e/`、`tests/fixtures/`、`tests/support/`

技术方案拥有、Coding 不得修改：`docs/dependencies.json`、`docs/deployment.json`、`infra/`、本 Feature 目录下的 `runtime/deployment.json`。

```
src/
  shared/contracts.ts            # 改：TranslationRequest.inputSource（可选枚举）、INPUT_SOURCES 常量
  server/
    http/app.ts                  # 改：Permissions-Policy 增加 display-capture=(self)；schema 增加 inputSource；日志带 inputSource
    logger.ts                    # 改：白名单增加 inputSource（只接受枚举值）
    （其余文件不改）
  web/
    index.html                   # 改：新版页面结构（控制区、说明面板、字幕区、引导 dialog），见“页面 DOM 契约”
    styles.css                   # 改：统一视觉设计、字号档、响应式布局、小窗样式（body.pip）
    main.ts                      # 改：页面装配；输入方式；状态机（TD-110）；start/stopRun 按音源分派
    messages.ts                  # 改：状态文案、全部中文提示、引导文案
    audioSource.ts               # 新：AudioSource 抽象；MicrophoneSource（包装 recognition.ts 的 openMicrophone）
    displayAudio.ts              # 新：getDisplayMedia 选项（TD-102）、无音频判定、下混（TD-106）、ended 监听（TD-107）、错误分类（TD-111）
    support.ts                   # 新：能力检测（TD-105）
    supportMatrix.ts             # 新：支持列表数据（浏览器/系统 × 标签页/窗口/整个屏幕），渲染为表格
    pip.ts                       # 新：字幕小窗打开/关闭、样式注入、状态同步（TD-104）
    captionView.ts               # 改：li 增加 data-segment-id；新增 MirroredCaptionView；滚动保持最新可见（FR-130）
    preferences.ts               # 新：localStorage 偏好读写（TD-113）
    guide.ts                     # 新：首次引导 dialog
    recognition.ts               # 不改逻辑（openMicrophone、令牌、识别会话保持原样）
    captionPipeline.ts           # 不改逻辑
    translateClient.ts           # 改：请求体带 inputSource
tests/
  unit/                          # 新增：support、displayAudio 错误分类与无音频判定、MirroredCaptionView、preferences、状态机；更新 app/translateClient
  integration/                   # 不变（另加 inputSource 日志断言）
  e2e/                           # 改：headed + Xvfb；新增系统声音、小窗、界面、引导、布局、不支持浏览器各用例；第 1 版用例改新状态名
  fixtures/sentences.en.json     # 改：增加“麦克风干扰”句组（interference，含参考译文）
  support/xkey.py                # 新：XTest 发送按键（TD-109），只用 python3 标准库 ctypes + 系统 libX11/libXtst
  support/player.ts              # 新：素材播放页（Playwright route 提供 HTML + WAV，标题唯一，记录播放起点）
```

### 页面 DOM 契约（供测试与独立测试使用，Coding 必须保持）

| 元素 | 选择器 / 属性 | 说明 |
| --- | --- | --- |
| 页面状态 | `body[data-state]` ∈ `idle/starting/running/stopped/error`；`body[data-source]` ∈ `microphone/system` | 与 `#status` 文本一致 |
| 输入方式 | `fieldset#input-source` 内两个 `input[type=radio][name=input-source]`：`#source-microphone`（标签“麦克风”）、`#source-system`（标签“系统声音”） | `starting/running` 时 `disabled` |
| 开始 / 停止 | `#start-button`（“开始”）、`#stop-button`（“停止”） | 第 1 版 id 不变 |
| 状态 | `#status`（`role=status`，文本为五种中文之一），`#status-indicator`（图标） | |
| 提示 | `#notice`（`role=alert`），`data-kind` ∈ `error/info` | 第 1 版 id 不变 |
| 字幕 | `#captions > li.caption[data-status][data-segment-id]` | 第 1 版结构不变，增加 `data-segment-id` |
| 字号 | `fieldset#caption-size` 内 `input[type=radio][name=caption-size]`，值 `s/m/l/xl`，标签“小/中/大/特大”；字幕区 `[data-caption-size]` | |
| 系统声音说明 | `#system-help`（操作步骤、隐私说明、背景声提示），`table#support-matrix`；不支持时 `#system-unsupported` | 仅 `data-source=system` 时可见 |
| 字幕小窗 | `#pip-button`（“弹出字幕小窗”/打开后“关闭字幕小窗”）；不支持时 `disabled` 且 `#pip-unsupported`（可见中文原因） | 小窗文档：`body.pip`、`#pip-status`、`#pip-captions > li.caption[...]` |
| 引导 | `dialog#guide`、关闭按钮 `#guide-close`（“知道了”）、重新打开入口 `#guide-open`（“使用引导”） | |

## 数据流、状态、并发与生命周期

### 状态机（TD-110）

```
idle/stopped/error ──开始──▶ starting ──音源就绪且识别已启动──▶ running
starting ──麦克风被拒/无设备、共享取消/被拒/无声音/失败、令牌失败、识别启动失败──▶ error
starting/running ──停止(用户)──▶ stopped
running ──任一共享轨道 ended（浏览器停止共享/被共享内容关闭）──▶ stopped（提示“共享已结束”）
running ──识别 canceled(Error)/sessionStopped、翻译不可用──▶ error（提示“翻译已中断”）
任意 ──pagehide──▶ （释放全部资源）
```

`setState` 同步更新：`#status` 文本、`body[data-state]`、开始/停止/输入方式的可用性、字幕小窗中的 `#pip-status`。`stopped` 与 `error` 下保留已显示字幕（FR-116、FR-123）。

### 选择输入方式（FR-101～FR-103、FR-118、FR-119）

- 页面加载：`input-source` 设为 `microphone`（不从存储恢复）；`body[data-source]=microphone`。
- 改选 `system`：显示 `#system-help` 与 `#support-matrix`（按 `SupportInfo.platform` 高亮当前平台行）；若 `systemAudio=unsupported`，显示 `#system-unsupported`（“当前浏览器不支持采集系统声音……请使用 Windows / macOS 上最新版 Chrome 或 Edge”），`#start-button` 禁用。
- 改选 `microphone`：隐藏系统声音说明，开始按钮按状态恢复。

### 开始：系统声音（FR-105、FR-106、FR-121、FR-122）

点击“开始”的处理函数中，以下 1～3 步**同步**执行（保证用户激活仍有效）：

1. `showNotice(null)`；`setState('starting')`；`run = { epoch: pipeline.beginRun(), source: 'system', … }`。
2. `ctx = new AudioContext()`；`void ctx.resume()`。
3. `const t0 = performance.now(); const p = navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS)`（TD-102）。

随后异步：

4. `await p`：
   - 失败 → `ctx.close()`；按 TD-111 分类 → `failStart(kind)`：`run = null; pipeline.endRun(); setState('error'); showNotice(MESSAGES[kind])`。
   - 若此时 `run !== current`（使用者在弹窗期间点了“停止”）→ 停止全部轨道、关闭 `ctx`，结束。
5. `stream.getAudioTracks().length === 0` → 停止全部轨道（共享指示随即消失）、关闭 `ctx` → `failStart('share-no-audio')`（提示按平台给出能带声音的方式，FR-122）。
6. 为 `stream.getTracks()` 每条轨道注册 `ended` → `stopRun('share-ended')`（TD-107）。
7. 下混（TD-106）得到 `mono = dest.stream`；`AcquiredAudio = { stream: mono, release }`，`release` 停止原始全部轨道、断开节点、`ctx.close()`。
8. 与麦克风模式相同：`fetchSpeechToken` → `createRecognitionSession(mono, token, handlers)` → `start()` → `setState('running')` → 令牌续取。任一步失败 → `release()` 后 `setState('error')` + `MESSAGES.interrupted`（与第 1 版“错误停止”一致）。

视频轨（TD-103）：除第 1、7 步中被 `stop()` 外，代码中不得出现对视频轨的任何读取或连接；单元测试对 `displayAudio.ts` 断言只调用 `getAudioTracks()` 构建音频图。

### 开始：麦克风

与第 1 版相同（`openMicrophone` → 令牌 → 识别），只把失败后的状态从“回到原状态”改为 `error`（TD-110），提示文案不变。系统声音模式与麦克风模式的分派只在“取得音源”这一步。

### 识别与翻译

完全沿用第 1 版（`recognizing` / `recognized` → `CaptionPipeline` → `/api/translations` → 视图）。唯一变化：`requestTranslation` 的请求体带 `inputSource`（TD-112）。断句（800 ms）、候选语言、节流、定稿重试、乱序处理不变，因此 AC-03、AC-04 的流式时序、顺序与一一对应在系统声音模式下沿用第 1 版已验证的机制。

### 停止（FR-116、FR-117）

`stopRun(reason)` 沿用第 1 版的同步顺序：失效 epoch → `audio.release()`（系统声音：停止共享的音频与视频轨，浏览器共享指示随即消失；关闭 `AudioContext`）→ 中止翻译与定时器 → `setState(reason === 'error' ? 'error' : 'stopped')` → 提示（`share-ended` 显示“共享已结束……再次点击开始可重新选择共享内容”；`error` 显示“翻译已中断”）→ 异步释放 SDK。重复调用幂等。再次开始时第 1 版的 `interrupted` 处理保证新字幕接在已有字幕之后（FR-117）。系统声音每次开始都重新调用 `getDisplayMedia`（FR-117 每次都经过共享弹窗）。

### 字幕小窗（FR-136～FR-140）

- 打开（`#pip-button` 点击，同步调用 `requestWindow`）：在小窗文档中创建 `<link rel="stylesheet" href="{location.origin}/styles.css">`、`body.pip`（`data-caption-size` 同主页面）、`#pip-status`、`#pip-captions`；把主页面 `#captions` 的子节点 `cloneNode(true)` 复制进去并以 `data-segment-id` 建立节点表；把 `MirroredCaptionView` 的第二视图指向它；按钮文字改为“关闭字幕小窗”。
- 同步：`MirroredCaptionView` 每个方法先写主视图、再写小窗视图（同一事件循环任务内完成）；`setState` 与字号切换同时写小窗。
- 关闭：小窗 `pagehide` → 移除第二视图、按钮复原；主页面字幕继续更新，采集不受影响（FR-138）。再次弹出即重新克隆当前字幕。
- 主页面 `pagehide` 时浏览器自动关闭小窗；`stopRun('unload')` 照常执行。
- 小窗中不放任何媒体元素（FR-108）。
- 不支持（`!('documentPictureInPicture' in window)`）：`#pip-button.disabled = true`，`#pip-unsupported` 显示“当前浏览器不支持悬浮字幕小窗，请使用 Windows / macOS 上最新版 Chrome 或 Edge”。

### 界面细节

- 首次引导：`DOMContentLoaded` 后若 `rtmt.guideSeen` 不为 `'1'` 则 `guide.showModal()`；“知道了”关闭并写入；`#guide-open` 随时 `showModal()`。引导内容覆盖 FR-133 全部要点；不支持小窗时引导中该条写明不支持。
- 字号：切换 `caption-size` → 主页面字幕区与小窗 `data-caption-size` 同步更新并写入存储（TD-114）。
- 最新字幕可见（FR-130）：字幕区为独立滚动容器；仅当使用者当前已在底部附近（距底 ≤ 48 px）时，新内容到来自动滚到底部；使用者向上翻看时不强制拉回，出现“回到最新”按钮（`#jump-latest`）。小窗总是滚到底部。

### 视觉与布局（FR-127～FR-135）

- 配色：字幕区背景 `#0d1117`；定稿字幕 `#ffffff`（对比度 ≈ 19:1）；临时字幕 `#b6c2cf`（≈ 10:1），另以左侧 4 px 虚线标记与 CSS `::after` 省略号区分（不改变 `textContent`）；页面其余区域浅色背景 `#f6f7f9`、正文 `#1f2328`。
- 状态标识（文字 + 颜色 + 图标，两两不同）：未开始 灰 `#57606a` ○；正在启动… 琥珀 `#9a6700` ◔；正在听 绿 `#1a7f37` ●（缓慢脉动）；已停止 蓝灰 `#424a53` ■；出错 红 `#cf222e` ⚠。
- 字号：标题 20 px，控件 15～16 px，说明 14～15 px；字幕最小档 24 px 仍大于其它所有文字（FR-129“字幕为最大文字”对每档成立）。
- 布局（CSS Grid，`min-width: 0`、字幕 `overflow-wrap: anywhere`，全局不设固定宽度）：
  - 宽 ≥ 1100 px：顶部控制区一行；主体两列 `minmax(0,1fr) 360px`，右列为系统声音说明（仅系统声音模式显示，内部可滚动），字幕区占左列全部高度。
  - 宽 < 1100 px：单列；控制区自动换行；系统声音说明为 `<details>`，非 `running` 时展开、进入 `running` 时自动收起（可手动展开），字幕区 `min-height: 55vh`。
  - 页面高度固定为视口高度（`100dvh`），只有字幕区与说明面板内部滚动，因此控制区四项任何时候都不需滚动即可见。
- 验收尺寸 1366×768、1440×900、1600×900、1920×1080、480×800 在 e2e 中逐一测量 `scrollWidth ≤ clientWidth`、控件包围盒不重叠、字幕区面积最大。

### 服务端并发与生命周期

不变（第 1 版）。系统声音模式不改变每页请求模式。

## Interface 与契约（Contract）

第 1 版接口全部保持（`GET /healthz`、`GET /` 与静态资源、`POST /api/speech-token`、`POST /api/translations`、依赖调用），只有下列变化：

### `POST /api/translations` 请求体

```json
{ "kind": "partial" | "final", "text": "<1..2000 字符>", "sourceLanguage": "<可选>", "inputSource": "microphone" | "system" }
```

`inputSource` 可选；出现时必须为两个枚举值之一，否则 400 `invalid_request`（`additionalProperties: false` 不变）。响应格式不变。

### 静态资源响应头

- `Permissions-Policy: microphone=(self), display-capture=(self)`（其余头与 CSP 不变；小窗文档继承本页策略，`style-src 'self'` 允许引入同源 `/styles.css`）。

### 浏览器 → 浏览器 API

| API | 用法 | 不支持时 |
| --- | --- | --- |
| `getDisplayMedia` | TD-102 选项；只在系统声音模式、点击“开始”时调用 | `#system-unsupported`，开始禁用 |
| `documentPictureInPicture.requestWindow` | 点击“弹出字幕小窗”时调用 | 按钮禁用 + `#pip-unsupported` |
| `AudioContext` / `MediaStreamAudioDestinationNode` | 仅系统声音下混 | Chromium 系均支持 |
| `HTMLDialogElement.showModal` | 引导 | Chromium / Firefox / Safari 均支持 |

### 依赖 `realInstance`

`speech`、`chat-model` 在 `dev`、`test` 均为真实实例，不需要模拟服务契约。

## 安全、隐私、身份与 Secret

| 主题 | 设计 |
| --- | --- |
| 长期凭据不进浏览器（FR-142） | 与第 1 版相同：浏览器只拿 10 分钟 STS 令牌；字幕小窗是同源文档，不额外请求任何接口。e2e 与独立测试扫描页面源码、脚本、小窗文档、全部网络请求与 WebSocket 消息。 |
| 共享画面（FR-108、A-02） | 视频轨不连接任何 sink（TD-103）；CSP 不变（`connect-src` 只有本源与 STT 主机），即使代码有误也无法把画面发往他处；e2e 统计全部请求与 WebSocket 帧的内容类型与大小，断言无图像/视频数据。 |
| 客户内容不入日志（FR-143） | 服务端只新增枚举字段 `inputSource`；日志白名单在类型层与运行时双重限制（第 1 版 TD-009）。 |
| 最小权限（宪章） | 每次开始只请求一种媒体权限；`Permissions-Policy` 只为本源开放 `microphone`、`display-capture`；结束即释放全部轨道与 `AudioContext`。 |
| 用户授权 | 系统声音只在使用者在浏览器原生弹窗中确认后取得；应用不使用任何自动选择参数（自动选择参数只出现在测试的浏览器启动参数中）。 |
| 输入校验 | `inputSource` 严格枚举；其余同第 1 版。 |
| 本地存储 | 只存 `rtmt.guideSeen`、`rtmt.captionSize`，不含客户内容。 |
| Secret | 不新增应用机密（顶层 `secrets` 仍为空）。 |
| 访问控制 | 仍不登录（A-06）；同源 + 可信地址限流（第 1 版 TD-010）。 |

## 配置、可观测性与运维

### 配置

无新增环境变量；第 1 版全部配置（`AIDH_DEP_SPEECH_*`、`AIDH_DEP_CHAT_MODEL_*`、`PORT`、`LOG_LEVEL`、`CANDIDATE_LANGUAGES`、`SEGMENTATION_SILENCE_MS`、`TRUSTED_PROXY_HOPS`）保持不变。

### 可观测性

- 日志白名单新增 `inputSource`（仅 `microphone` / `system`），出现在 `translation_completed` 事件中；其余事件与字段不变。
- 运维可按 `inputSource` 统计两种模式的翻译量、`ttfbMs`、`reasoningTokens` 与 `sourceLanguage` 分布。
- 浏览器端错误类别（共享被拒/无声音/识别中断等）只在控制台 `debug` 级别输出类别名，不上报、不含内容。

### 错误日志识别规则（`docs/deployment.json` → `operations.errorLogRules`）

应用日志写法不变，沿用第 1 版三条规则：

| 规则 | 类型 | 匹配 | 严重度 | 阈值 |
| --- | --- | --- | --- | --- |
| `app-error-or-fatal` | structured | `level` ∈ {`error`,`fatal`}，messageField `msg` | high | 出现即报 |
| `upstream-errors-burst` | structured | `event` = `upstream_error`，messageField `errorCode` | medium | 5 分钟内 10 次 |
| `node-crash-output` | pattern | 非 JSON 的 Node 崩溃输出 | high | 出现即报 |

## SLO、限制、扩缩容、重试与恢复

- 无获批准的时延、可用率、并发与时长要求；不设对外 SLO。内部观察目标与第 1 版相同。
- 系统声音内容常为连续播放：识别连接与令牌续取机制同第 1 版（每 4 分钟续取，SDK 重连时使用新令牌）；服务对超长不间断语音会强制切分，产生多条定稿（不丢失、不乱序），属 PQ-002 尽力而为范围。
- 带背景音乐或多人重叠说话时识别质量下降：按 PQ-002 尽力而为，页面提示。
- 限流沿用第 1 版阈值（TD-115）。
- 恢复：共享结束、出错后再次点击“开始”即可；服务无状态。

## 部署拓扑、迁移、Rollout 与 Rollback

- `docs/deployment.json`：仍为单服务 `web`（`.`/`Dockerfile`，端口 8080，`/healthz`，对外）；只更新描述文字，`errorLogRules` 不变。
- Dockerfile 不变（构建产物仍为 `dist/server/main.js` 与 `dist/web/{index.html,app.js,styles.css}`）。
- 依赖：沿用第 1 版已绑定实例，不执行任何 IaC，不新增云资源。
- 迁移：无。浏览器本地偏好为新增键，旧版本不受影响。
- Rollout：平台按候选 SHA 构建并部署到 `cand-{deliveryShortId}`。HTTPS 安全上下文满足 `getDisplayMedia` 与 Document PiP 的要求。
- Rollback：无状态，重新部署上一个通过的候选；第 1 版页面不认识新增的 `localStorage` 键，无副作用。

## 系统声音说明与支持列表内容

页面文案以 `src/web/messages.ts`、`src/web/supportMatrix.ts` 为准，Coding 按下列要点落实（措辞可润色，含义不得改变）。弹窗中选项名称按 Chrome / Edge 简体中文界面实际出现的名称书写，Coding 在 headed Chromium（`--lang=zh-CN`）中核对标签页共享时的音频选项名称。

**操作步骤（`#system-help`）**

1. 先在其它标签页或软件中准备好要翻译的视频或会议；
2. 点击“开始”，浏览器会弹出共享选择窗口；
3. 看网页视频或网页版会议：选择“标签页”，选中正在播放的标签页，并保持“同时分享标签页中的音频”处于打开状态；
4. 看桌面会议软件或本地播放器（Windows）：选择“整个屏幕”，并打开“同时分享系统音频”；
5. 点击“分享”，状态变为“正在听”后即开始出字幕；
6. 结束：点击本页“停止”，或点击浏览器提示条上的“停止共享”。

附加说明：共享时浏览器附带的画面不会被显示、上传或保存，只使用声音；你仍能照常听到原声；背景音乐、音效或多人同时说话时，字幕可能不完整或不准确；可点击“弹出字幕小窗”在全屏观看时查看字幕。

**支持列表（`table#support-matrix`）**

| 浏览器 / 系统 | 支持程度 | 选“标签页” | 选“窗口” | 选“整个屏幕” |
| --- | --- | --- | --- | --- |
| Windows · Chrome / Edge 最新版 | 支持 | 只有该标签页的声音 | 采集不到声音 | 电脑播放的全部声音，包括会议软件和本地播放器（需打开“同时分享系统音频”） |
| macOS · Chrome / Edge 最新版 | 部分支持 | 只有该标签页的声音 | 采集不到声音 | 取决于系统与浏览器版本：弹窗中出现分享系统音频的选项时可采集电脑播放的全部声音，否则采集不到声音 |
| Linux · Chrome / Edge 最新版 | 部分支持 | 只有该标签页的声音 | 采集不到声音 | 通常采集不到声音 |
| Firefox（Windows / macOS / Linux） | 不支持 | 采集不到声音 | 采集不到声音 | 采集不到声音 |
| Safari（macOS） | 不支持 | 采集不到声音 | 采集不到声音 | 采集不到声音 |
| 手机和平板上的浏览器 | 不支持 | — | — | — |

“标签页”一行在验收环境（Linux · Chromium）中由 IQA-102 实测；其余各行以交付时主流浏览器实际行为为准（A-07、PQ-001）。

**主要提示文案键（`MESSAGES`）**

| 键 | 场景 | 要点 |
| --- | --- | --- |
| `shareCancelled` | E-102，用户取消/拒绝 | 未选择共享内容或共享授权被拒绝；再次点击“开始”，在弹窗中选择标签页或整个屏幕、打开共享音频并点击“分享” |
| `shareBlocked` | E-102，未出现弹窗即被拒（TD-111） | 浏览器或系统阻止了共享；检查地址栏左侧站点设置；macOS 在“系统设置 → 隐私与安全性 → 屏幕与系统录音”中允许浏览器，然后重新开始 |
| `shareNoAudio` | E-103 | 所选共享内容没有包含声音；按当前平台说明能带声音的方式（Windows：标签页 + 共享标签页音频，或整个屏幕 + 共享系统音频；macOS/Linux：标签页 + 共享标签页音频），再次点击“开始” |
| `shareFailed` | 其它共享异常 | 无法开始共享，请重试或改用标签页共享 |
| `shareEnded` | E-104 | 共享已结束；如需继续，点击“开始”并重新选择共享内容 |
| `systemUnsupported` | E-101 | 当前浏览器不支持采集系统声音；请使用 Windows 或 macOS 上最新版 Chrome 或 Edge；也可改选“麦克风” |
| `pipUnsupported` | E-108 | 当前浏览器不支持悬浮字幕小窗；请使用 Windows 或 macOS 上最新版 Chrome 或 Edge |
| `micDenied` / `micNotFound` / `micUnavailable` / `interrupted` / `unsupported` | 第 1 版 | 文案不变 |

## 验证环境责任矩阵（Verification Environment）

| 验证类型 | 责任阶段 | 环境来源 | 依赖/凭据 | Coding 证据 | 下游结果 |
|---|---|---|---|---|---|
| 静态检查 | Coding、候选验证 | Agent Pod / 同镜像 Runner | 无 | `npm run lint`、`npm run typecheck` | 候选验证记录 |
| 构建 | 同上 | 同上 | 无 | `npm run build` | 候选验证记录 |
| 单元测试（developerTests） | 同上 | 同上 | 无外部调用（纯逻辑） | `npm test`：能力检测（各 `userAgentData`/特性组合）；共享错误分类（`NotAllowedError` 快/慢、其它异常）；无音频轨判定与释放；轨道 `ended` → `share-ended`；系统声音路径不调用 `getUserMedia`；`MirroredCaptionView` 两视图同序同文；状态机与按钮/输入方式可用性；偏好读写与存储不可用退化；`inputSource` 校验与日志白名单 | 候选验证记录 |
| 集成/契约测试 | 同上 | 同上 | `speech`、`chat-model` 的 `dev` 实例 | 第 1 版全部集成测试保持；新增：带 `inputSource:'system'` 的翻译请求成功且 `translation_completed` 日志含 `inputSource=system`、不含文本；非法 `inputSource` 返回 400 | 候选验证记录 |
| 功能/端到端（functionalTests） | 同上 | 本地 `localhost` 服务 + **headed Chromium（Xvfb）**（TD-108）；Firefox（不支持场景） | `dev` 实例 | 见下表“端到端用例设计” | 候选验证记录 |
| 独立测试（IQA-101～IQA-123） | 独立测试 | 候选部署 `cand-*`，QA Pod（与 Agent Pod 同工具，含 `xvfb-run` 与 Playwright Chromium/Firefox） | `test` 实例；TTS 合成素材 | — | QA 结果与证据；QA 脚本同样须以 headed + Xvfb 运行 Chromium 并按 TD-108、TD-109 取得共享、取消与无音频 |
| 依赖探测 | 依赖与机密任务 | 平台隔离环境 | 单个依赖 | — | 沿用第 1 版探测脚本与约束 |

### 端到端用例设计（开发者版本，对应规格验收场景）

公共夹具（`tests/e2e/fixtures.ts`）：每个 worker 启动本地服务；浏览器 `chromium.launch({ channel: 'chromium', headless: false, args: [...] })`，参数含 `--autoplay-policy=no-user-gesture-required`、`--lang=zh-CN`、`--auto-select-tab-capture-source-by-title=RTMT 素材 {workerIndex}`，需要麦克风输入的用例再加假麦克风参数；默认 `addInitScript` 写入 `rtmt.guideSeen='1'`（引导用例除外）；仪表脚本在第 1 版基础上增加 `getDisplayMedia` 调用计数、所得轨道与其 `label`，以及字幕小窗文档的字幕时间线。素材播放页（`tests/support/player.ts`）经 `context.route('http://rtmt-player.test/**')` 提供 HTML 与合成 WAV，标题为 `RTMT 素材 {workerIndex}`，`<audio>` 播放并在 `playing` 事件记录 `Date.now()` 作为素材时间零点。

| 用例 | 覆盖 | 方法与判定 |
| --- | --- | --- |
| 输入选择 | IQA-101 | 默认 `#source-microphone` 选中；麦克风开始：`gumCalls=1`、`displayCalls=0`；系统声音开始：`displayCalls=1`、`gumCalls=0`；`running` 时两单选 `disabled`；刷新后回到麦克风 |
| 系统声音出字幕 + 麦克风干扰 | IQA-102、IQA-117 | 素材页播放 multi 组，假麦克风播放 interference 组；所得音频轨 `label` 为 `Tab audio`；定稿字幕与 multi 参考译文逐句比对；与 interference 参考译文关键信息点命中 0；全部请求与 WebSocket 帧无 `image/*`/`video/*` 内容类型、页面与小窗中无 `video`/`canvas` 元素 |
| 流式时序 | IQA-103 | 长句素材；首条字幕时间 < 该句结束时间，句末前至少再变化一次，句末后定稿；临时/定稿计算样式不同 |
| 语言与含义、顺序 | IQA-104、IQA-105、IQA-114 | 无语言控件；定稿条数 = 句数、顺序一致；识别 WebSocket 消息中检出语言 `en-US`；服务端日志 `translation_completed` 含 `inputSource=system`、`sourceLanguage=en-US`、`reasoningTokens=0` |
| 点击停止 | IQA-106 | 句中停止；所有共享轨道 `readyState=ended`；30 s 内字幕区无变化；改选麦克风开始出字幕；再选系统声音开始 `displayCalls` 增加 1 |
| 共享结束 | IQA-107 | 关闭素材标签页（TD-109）→ `stopped` + `#notice` 含“共享已结束”；30 s 无变化；重新打开素材页并开始可再出字幕 |
| 说明与支持列表 | IQA-108 | 选系统声音后 `#system-help`、`#support-matrix` 可见，行覆盖 Windows/macOS Chrome·Edge、Firefox、Safari；Linux 标签页一行写“只有该标签页的声音”，与 IQA-102 实测一致 |
| 不支持的浏览器 | IQA-109、IQA-123 | Playwright Firefox：选系统声音即显示 `#system-unsupported`，开始禁用；改选麦克风开始可用（Firefox 假麦克风偏好 `media.navigator.streams.fake`）；`#pip-button` 禁用且 `#pip-unsupported` 可见 |
| 取消共享 | IQA-110 | 素材标题不匹配的浏览器实例中点“开始”，等待 1.5 s 后 `python3 -I tests/support/xkey.py Escape`；状态“出错”+ `shareCancelled`；无字幕、无活动轨道；随后在匹配的实例中正常开始可出字幕 |
| 共享无声音 | IQA-111 | 以 `--auto-select-desktop-capture-source=Entire screen` 启动；状态“出错”+ `shareNoAudio`；所得轨道均已 `ended` |
| 无需安装 | IQA-112 | 干净上下文（无扩展），全流程无额外窗口/下载 |
| 麦克风回归 | IQA-113 | 第 1 版全部 e2e 保留，状态断言 `翻译中`→`正在听`，麦克风被拒后状态断言改为“出错” |
| 凭据扫描 | IQA-115 | 两种模式（含小窗文档）扫描页面源码、脚本、请求、WebSocket 帧，命中 0 |
| 日志无内容 | IQA-116 | 系统声音多句用例后以原文与定稿检索服务端日志，命中 0 |
| 状态与控制区 | IQA-118 | 依次进入五种状态截图；`#status` 文本、指示器颜色两两不同；按钮可用性 |
| 字幕样式与字号 | IQA-119 | `getComputedStyle` 测字号、行距、颜色并计算对比度；字幕区面积最大；4 档逐档增大、中 ≥ 28、特大 ≥ 48；运行中切换字号，小窗同步、字幕持续更新 |
| 首次引导 | IQA-120 | 不预写存储：首次出现 `dialog#guide[open]`；关闭后开始可点；重载不出现；`#guide-open` 可打开 |
| 布局尺寸 | IQA-121 | 视口 1366×768、1440×900、1600×900、1920×1080、480×800 × 五种状态：`documentElement.scrollWidth ≤ clientWidth`、控制区四项在视口内且包围盒不重叠、字幕元素 `scrollWidth ≤ clientWidth` |
| 字幕小窗 | IQA-122 | 运行中点 `#pip-button`；经 `documentPictureInPicture.window` 读取 `#pip-captions` 时间线，与主页面逐次一致；关闭小窗后主页面继续更新；再次弹出内容一致；麦克风模式同样可用 |

执行与资源：Playwright `workers: 1`（同一虚拟显示上多个 headed 浏览器与自动选择参数互不干扰）；`npm run test:e2e` 为 `npm run build && xvfb-run -a --server-args="-screen 0 1920x1080x24" playwright test`。

**验证限制**：AC-12 中“小窗悬浮在全屏视频 / 桌面会议软件之上”的视觉层级由浏览器的 Document PiP 实现保证；Agent Pod 与 QA Pod 的 Xvfb 中没有窗口管理器，也没有 Windows / macOS 桌面（已核实无 WM 与窗口检查工具），自动化只能证明“以 Document PiP 方式打开且内容同步”，无法证明“在其它应用的全屏窗口之上可见”。如何取得该点的验收证据需要人决定（见“开放决策”）。

### 测试素材

沿用 `tests/fixtures/sentences.en.json` 与第 1 版合成规则（TD-015 的停顿约束、TTS 合成、缓存到仓库外临时目录）。新增 `interference` 句组（≥ 2 句，与 `multi` 组内容和关键信息点不重叠，含参考译文），用作 IQA-102 的麦克风干扰。素材只含英语、均为合成，非客户内容。

## 快速验证指南（Quickstart）

开发者命令在本 Feature 目录 `runtime/deployment.json` 中声明（技术方案拥有）：

```bash
npm ci                               # developerSetupCommands
npm run lint && npm run typecheck    # staticAnalysis
npm run build                        # build
npm test                             # developerTests：单元测试
npm run test:integration             # integrationTests：真实 dev 实例
npm run test:e2e                     # functionalTests：build + xvfb-run headed Chromium（含 Firefox 不支持用例）
```

本地手动验证（Agent Pod 已注入 `dev` 实例的 `AIDH_DEP_*`）：

1. `npm run build && node dist/server/main.js`，用桌面 Chrome / Edge 打开 `http://localhost:8080`（localhost 为安全上下文）。
2. 首次打开出现中文引导 → “知道了”。
3. 选“系统声音”，右侧/下方出现操作步骤与支持列表；在另一个标签页播放英文视频；点“开始”→ 弹窗选中该标签页并打开共享音频 → “分享”；状态“正在听”，中文临时字幕持续更新、句末定稿。
4. 点“弹出字幕小窗”，把视频切到全屏，小窗仍可见且与主页面一致；关闭小窗，主页面继续更新。
5. 点浏览器提示条“停止共享”→ 状态“已停止”，提示“共享已结束”。
6. `curl -s -X POST -H 'Origin: http://localhost:8080' -H 'content-type: application/json' localhost:8080/api/translations -d '{"kind":"final","text":"Good morning.","inputSource":"system"}'` → `delta` 行后 `{"type":"done"}`；服务日志 `translation_completed` 含 `"inputSource":"system"`。

## 支持 Runbook

第 1 版 Runbook 全部适用，新增：

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| 选“系统声音”即提示不支持 | 浏览器是否为 Chrome / Edge 桌面版（Firefox、Safari、移动端不支持） | 改用 Chrome / Edge，或改选“麦克风” |
| 共享后提示“没有包含声音” | 是否选择了窗口、未打开共享音频，或 macOS/Linux 整屏共享 | 按提示改选标签页并打开共享音频；Windows 可选整个屏幕 + 共享系统音频 |
| 点“开始”后没有弹窗直接提示被阻止 | 浏览器站点设置、企业策略、macOS 屏幕录制权限 | 按提示在设置中允许后重启浏览器再试 |
| 正在听但没有字幕 | 被共享的标签页是否在播放、是否被静音；日志是否有 `translation_completed inputSource=system` | 确认播放有声；无翻译日志时按第 1 版“翻译已中断”排查 |
| 字幕小窗按钮不可用 | `documentPictureInPicture` 是否存在（Chrome / Edge 116+） | 升级浏览器或使用主页面字幕 |
| 端到端测试中系统声音无信号 | 是否用了 headless 或 `--use-fake-ui-for-media-stream`；是否在 `xvfb-run` 下运行 | 按 TD-108 使用 headed + Xvfb 与按标题自动选择标签页 |

## 依赖声明摘要

完整声明见 `docs/dependencies.json`（本版只更新 `purpose` 与 `recommendation.reason` 的文字，约束、接入字段、探测脚本、IaC 不变）。

| 依赖 | 推荐 | 约束（探测逐条报告） | 本交付用途 |
| --- | --- | --- | --- |
| `speech` | 沿用第 1 版已绑定的 dev / test 实例（声明形态仍为 `cloud`，IaC 仅在需要重建时使用） | `realtime-streaming-stt`、`language-auto-detection` | 两种输入的实时识别 + 连续语言识别；测试素材合成 |
| `chat-model` | 沿用第 1 版已绑定的 dev / test 实例（`gpt-5.1` 部署） | `reasoning-disabled` | 两种输入的流式中文翻译 |

意图“不新建语音或大模型依赖实例”：在依赖与机密任务中为每个依赖、每个环境选择“沿用”。系统声音模式不增加新的外部服务；Document PiP 与 `getDisplayMedia` 是浏览器能力，不是依赖。

## 开放决策

1. **AC-12“悬浮在全屏视频 / 会议软件之上”的验收证据**（需要决定，见结果信封 `asks`）：
   - 推荐：与 PQ-001 的处理一致——自动化验收以“通过 Document PiP 打开、与主页面同一份字幕同步更新、关闭后主页面继续、不支持浏览器按钮不可用”为证据；“在其它应用全屏窗口之上可见”由浏览器 Document PiP 能力保证，由业务负责人发布后在模拟运行环境用 Windows 上的 Chrome / Edge 亲自试用确认，问题走后续修改交付。
   - 备选 A：提供带真实桌面（Windows 或 macOS）的测试机，由独立测试执行该检查（需确认环境与工期）。
   - 备选 B：在 QA 环境中安装窗口管理器做近似验证（Linux 虚拟显示，不等同于 Windows / macOS 的全屏行为，证据价值有限）。
2. 沿用第 1 版尚在生效的决定：TD-001 技术基线；依赖认证方式（推荐 `platform-identity`）；不登录仅部署测试环境。本版不改变这些决定。
