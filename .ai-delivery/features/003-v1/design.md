# 企业实时翻译 · 修复：韩语字幕显示原文与中止请求误报错误 技术方案

> 依据：已确认的意图第 2 版（AC-1～AC-13，含 Q-1～Q-4 人工答案）、`spec.md`（FR-301～FR-320、IQA-301～IQA-313，含 PQ-301 人工答案）、项目宪章、技术基线（`.ai-delivery/features/002-v1/design.md`，下称“第 2 版方案”；其沿用的第 1 版方案下称“第 1 版方案”）与仓库现有代码。
> 本方案只决定“怎么做”，不改变已确认的产品行为。沿用技术基线（TypeScript + Node.js 22 + Fastify 5 单服务 `web`、原生 DOM + esbuild、Speech SDK、pino 白名单日志、Vitest + Playwright headed Chromium/Xvfb），不引入新的运行时依赖、外部服务、依赖实例或配置项。
> 本次会话中没有 `dev` 依赖实例的接入变量（设计会话不注入 `AIDH_DEP_*`），因此根因调查只能使用代码证据、已入库的第 2 版独立测试证据，以及在本地用真实 `buildApp` + 受控翻译器做的复现实验（见“根因调查”）；需要真实模型才能得到的证据在 Coding 阶段以集成测试补齐（TD-311）。

## 技术上下文（Technical Context）

| 项 | 选择（相对第 2 版的变化以 **粗体** 标出） |
| --- | --- |
| 语言 / 运行时 | TypeScript；服务端 Node.js 22；浏览器端 ES2022，目标桌面 Chrome / Edge 最新版（不变） |
| 服务端 | Fastify 5 单服务 `web`（不变）。**改动**：`/api/translations` 识别“客户端中止/断开”并不再记 error（TD-301、TD-302）；`main.ts` 的 `unhandledRejection` 排除客户端中止类错误（TD-303）；翻译提示词收紧“只输出简体中文”，新增可选请求字段 `retranslate` 对应的重译说明（TD-307、TD-308） |
| 浏览器端字幕 | `CaptionPipeline` 状态机不变的部分全部保留。**改动**：新增共享的中文判定 `isChineseTranslation`（TD-304）；临时与定稿译文都“先完整收齐、判定为中文再显示”（TD-305、TD-306）；定稿非中文时重译一次，仍非中文显示中文提示（TD-306）；视图新增“提示”条目（TD-309） |
| 识别 / 翻译 | 不变：Speech SDK 连续识别 + 连续语言识别（候选 en-US、zh-CN、ja-JP、ko-KR 不变）；大模型流式翻译 `reasoning_effort: "none"` |
| 测试 | Vitest（单元、集成）+ Playwright headed Chromium（Xvfb）。**新增**：韩语 / 日语合成素材（同一 `speech` 资源 TTS）；浏览器内 `fetch` 包装做受控触发（TD-310）；`/api/translations` 中止与异常的服务端测试 |
| 依赖 | **沿用**已绑定的 `speech`、`chat-model` 实例（dev / test），不新建；声明只更新用途文字（测试素材增加韩语、日语） |
| 存储 | 无（不变） |

## 治理与技术约束

| 约束（来源） | 设计响应 |
| --- | --- |
| 宪章·最简单架构；规则 1 沿用技术基线 | 不新增服务、依赖、npm 包或配置项；中文判定是一个无依赖的纯函数（`src/shared/`），客户端字幕状态机与测试共用；服务端日志修复只改中止的分类，不改日志框架与格式。 |
| 宪章·绝不记录客户内容 | 中止相关记录沿用现有 `client_aborted` 字段，不新增字段（FR-315）；中文判定只在浏览器内存中进行，判定结果不上报；服务端新增的唯一日志字段是布尔 `retranslate`，只出现在成功与上游错误记录中（TD-312），不出现在 `client_aborted` 记录中。 |
| 宪章·外部集成以真实测试服务验证，Mock 不替代 | AC-1～AC-3 的端到端测试只用真实语音与翻译服务；只有 AC-4/AC-5/AC-12（“翻译结果非中文”）与 AC-9（未预期异常）按意图授权受控触发（TD-310、TD-311）。 |
| 意图·不改变客户端“中止被取代的翻译请求”设计 | 客户端中止逻辑（`AbortController`、单飞节流）一行不改；只改服务端对中止的分类。 |
| 意图·不改告警规则、不降低真正异常的级别 | `docs/deployment.json` 的 `errorLogRules` 不变；只有“请求已被客户端关闭 **且** 错误属于中止类”同时成立时才不记 error（TD-301），其余一律仍记 error（AC-9）。 |
| 意图·两种输入、流式字幕、小窗、界面不退化（AC-11） | 改动集中在字幕状态机的“何时显示”与新增提示条目；音源、识别、小窗同步机制（`MirroredCaptionView`）、布局与配色不改；第 1、2 版全部自动化验收测试保留并须通过。 |
| 规格 FR-303“任何时刻不显示非中文结果或其任何片段” | 临时与定稿都不再逐片显示流式增量，整段收齐判定后才显示（TD-305、TD-306）；视图写入只有一个入口 `show()`，入口处再做一次判定作为不变量守卫。 |

## 根因调查（AC-13、IQA-313）

### 问题一：韩语字幕显示韩文（业务负责人试用反馈）

**结论**：已确定的根因是**显示链路对翻译结果没有任何“是否为中文”的校验**——服务端把大模型的流式增量原样转发，浏览器把每个增量直接写进字幕（临时字幕逐片显示，定稿字幕在不短于当前显示内容后逐片替换）。因此只要大模型某一次“正常完成”的输出是韩文（照抄原文或夹带韩文），界面就会把它当作字幕显示，且请求日志里没有任何错误码。**界面显示识别原文**这一可能已排除。**大模型为何偶发输出韩文**（触发条件）无法在本次设计中唯一确定，下表列出已排除与未排除的可能及依据。修复针对已确定的根因（在显示前判定、重译、提示，TD-304～TD-306），并对未排除的触发条件做针对性收敛（TD-307、TD-308），使修复不依赖于哪一个触发条件成立。

| # | 可能原因 | 结论 | 依据（证据） |
| --- | --- | --- | --- |
| R1 | 界面显示了语音识别原文 | **已排除** | 代码证据：识别文本只进入 `CaptionSegment.sourceText`（`src/web/captionPipeline.ts:17-18` 注释“never rendered”）；全部字幕写入都经 `show()`（`captionPipeline.ts:179-183`）→ `view.setText`，其参数只有三种来源：临时译文缓冲（`:240`、`:249`）、定稿译文缓冲（`:273`、`:278`）、句末时已显示的译文 `preFinalText`（`:152`、`:289`，它本身来自 `shownText`）；`main.ts:230-231` 只把识别事件交给管线；`DomCaptionView`/`MirroredCaptionView` 只写调用方给的文本。全仓 `src/web` 中没有任何把 `onRecognizing/onRecognized` 文本写入 DOM 的路径（`grep setText/textContent` 已核对）。 |
| R2 | 翻译请求失败后显示了别的内容 | **已排除** | 业务负责人反馈同一时段韩语翻译请求“正常完成、无错误码”；且失败路径的既有行为是把该句从字幕区移除（`captionPipeline.ts:313` `dropSegment`），不会留下任何文字。 |
| R3 | 大模型的正常完成输出本身是韩文（照抄或夹带），显示链路无校验 | **已确认为根因（必要且充分的显示条件）** | 由 R1 排除可知，字幕上出现的韩文只能来自 `/api/translations` 的增量；服务端 `app.ts:230` 把 `onDelta` 原样写出，`translator.ts:192-198` 不检查内容；客户端 `captionPipeline.ts:239-240、273` 不检查内容即显示。现象“请求正常完成”“换片或重放又正常（模型输出非确定）”“连续几条后恢复”均与此一致。 |
| T1 | 触发：提示词中“如果内容已经是简体中文，原样输出”给了模型“照抄”的出口；对实时识别出的短句、感叹、拟声、歌词、人名等，模型选择照抄原文 | 未排除（可能性最高） | `translator.ts:42` 的提示词原文；`reasoning_effort: none` 下模型不做推理，更依赖提示词字面；电影对白比会议发言短句、口语与歌曲更多，与“英文、日文电影没有出现”不矛盾但也不能证明。确认需要试用时段的模型输出，按宪章日志不记录内容，无法事后取得。 |
| T2 | 触发：连续语言识别给出的 `sourceLanguage` 与文本不一致（例如文本是谚文而标注为 `zh-CN`），提示词中 `<source lang="zh-CN">` 加上“已是中文则原样输出”使模型照抄 | 未排除（可能性较低） | 连续语言识别在语言切换边界上可能滞后；业务负责人描述为“韩语翻译请求”，说明当时日志的 `sourceLanguage` 多为 `ko-KR`，但未提供逐条记录。运维可用 `translation_completed.sourceLanguage` 对该时段复核（只是元数据，不含内容）。 |
| T3 | 触发：临时翻译附加说明“只翻译已有部分、不要补全”使模型对残缺片段照抄 | 未排除 | `translator.ts:45`；试用截图中出现的是定稿还是临时字幕无法从现有材料判断。 |

修复如何针对根因：

1. **针对 R3（根因）**：所有译文在显示前按 FR-301 判定；临时译文非中文不显示，定稿译文非中文重译一次、仍非中文显示中文提示（TD-304～TD-306）。无论 T1～T3 哪一个（或其它未知原因）触发了非中文输出，字幕都不再出现非中文内容——这是 AC-1～AC-6、AC-12 的保证来源。
2. **针对 T1、T3**：提示词去掉“原样输出”的出口，明确“只输出简体中文、不得照抄原文、不得输出谚文或假名”，并在重译请求中加入更强的说明（TD-307、TD-308），以减少需要重译和出现提示的次数（PQ-301 要求清晰素材上不出现提示）。
3. **针对 T2**：服务端在 `sourceLanguage` 标为中文而文本含谚文或假名（或不含汉字）时，以 `lang="auto"` 发给模型，避免“已是中文”的误导（TD-307）。
4. **补齐证据**：Coding 在第 2 批以集成测试对真实 `dev` 模型发送韩语、日语句子（含短句与片段），记录首次结果为非中文的条数与重译后结果（只记条数，不记内容），作为 T1～T3 收敛效果的证据（TD-311）。

### 问题二：IR-001 客户端中止被记为 `unhandled_error / internal_error`

**结论（已确定唯一根因，并已本地复现）**：Fastify 发送流式响应时**不立即写出响应头**，只调用 `setHeader`，响应头随第一段数据写出（`node_modules/fastify/lib/reply.js` 5.12.8 `sendStream`：“we cannot use writeHead, and we need to resort to setHeader, which will trigger a writeHead when there is data to send”）。客户端在服务端写出首个片段**之前**中止或断开时：

1. `eos(res)` 触发 → Fastify 调用 `payload.destroy()` 销毁我们交给它的 `PassThrough`；
2. `eos(payload)` 收到 `ERR_STREAM_PREMATURE_CLOSE`；此时 `res.headersSent === false` 且请求体已完整收到（`req.aborted === false`），Fastify 走 `onErrorHook(reply, err)`；
3. 进入应用的 `setErrorHandler`（`src/server/http/app.ts:142-156`），该错误不是 4xx，于是按“未预期异常”记 `logger.error('unhandled_error', …, errorCode: 'internal_error')`；
4. 同时翻译任务因 `controller.abort()` 得到 `client_aborted`，记一条信息级 `translation_completed errorCode=client_aborted`。

首个片段写出**之后**中止时，响应头已发出，Fastify 走自身的 `logStreamError`（应用以 `logger: false` 关闭了 Fastify 日志），因此不产生 error。

证据：

- 第 2 版独立测试补充评审（`.ai-delivery/features/002-v1/evidence/supplementary-review.md` 第 3 节）：34 条 `unhandled_error`（route `/api/translations`，`internal_error`）**全部**与同一 reqId 的 `client_aborted` 记录对应，其中 partial 29 条、final 5 条——partial 请求最常在首个片段前被新结果取代，与上面的机制一致。
- 本地复现（本方案编写时，用仓库的 `buildApp` 与真实 pino 日志写入内存，翻译器为受控替身：首个片段在 600 ms 或 50 ms 后写出）：

  | 中止时机 / 方式 | 修复前日志 | 按 TD-301 原型修改后 |
  | --- | --- | --- |
  | 首个片段前 / 客户端 `req.destroy()` | `error unhandled_error internal_error` + `info translation_completed client_aborted` | 只有 `info … client_aborted` |
  | 首个片段前 / 断开 socket | 同上 | 只有 `info … client_aborted` |
  | 首个片段后 / 客户端 `req.destroy()` | 只有 `info … client_aborted` | 同左 |
  | 首个片段后 / 断开 socket | 只有 `info … client_aborted` | 同左 |

  原型中进入错误处理器的错误为 `name=Error, code=ERR_STREAM_PREMATURE_CLOSE`，此时 `reply.raw.destroyed === true`。

- `src/server/main.ts:38-39` 的 `unhandledRejection → fatal + exit` 在复现中没有被触发（翻译任务的 `async` 包装有完整的 `try/catch/finally`）；按意图假设仍对其做防御性排除（TD-303）。

## 架构概览（Architecture）

```
┌──────────────────────────── 浏览器（Chrome / Edge 桌面版） ──────────────────────────────┐
│ AudioSource(麦克风|系统声音，不变) → RecognitionSession(不变) → recognizing / recognized   │
│                                                         │                                │
│   CaptionPipeline（改：先判定后显示）                     ▼                                │
│   ├─ 临时：整段收齐 → isChineseTranslation? ──是──▶ show()   否──▶ 丢弃（不重译、不提示）    │
│   └─ 定稿：整段收齐(含既有失败重试) → 中文? ──是──▶ show() + final                          │
│                         │否                                                               │
│                         └─▶ 重译一次(retranslate:true) → 中文? ──是──▶ show() + final       │
│                                             │否──▶ setNotice(“（此句未能翻译成中文）”) + final│
│   show() 入口守卫：非中文文本一律不写入视图（不变量 1）                                       │
│                                                         │                                │
│   MirroredCaptionView（不变机制，新增 setNotice 同步）→ 主页面 DomCaptionView / 小窗        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
          │ POST /api/translations {kind,text,sourceLanguage?,inputSource?,retranslate?}
          ▼
   服务 web（Fastify）
     ├─ 提示词：只输出简体中文；retranslate 时附加重译说明；lang 与文字不符时用 auto（TD-307/308）
     ├─ 客户端关闭响应 → 标记 clientClosed + abort 上游；错误处理器对“已关闭且中止类错误”不记 error（TD-301）
     └─ 翻译任务异常：已关闭且中止类 → client_aborted（info）；否则 unhandled_error（error，不变）（TD-302）
   进程：unhandledRejection 中止类 → warn 且不退出；其它 → fatal + 退出（不变）（TD-303）
```

要点：

1. **判定放在显示端（浏览器字幕状态机）**：显示是唯一会让使用者看到非中文的地方；主页面与小窗共用一个管线和 `MirroredCaptionView`，判定一次、两处天然一致（AC-6）。服务端仍是“透传 + 提示词”，不在流中做判定，因而不需要缓冲整段、也不新增日志内容。
2. **服务端只修分类，不改流程**：客户端中止仍由客户端发起（不改既有设计），服务端识别“响应已被客户端关闭”这一事实，用它而不是错误类型单独决定日志级别，避免把真正的异常降级。
3. **提示词收紧是“减少触发”，判定是“保证”**：PQ-301 要求清晰素材上不出现提示，因此两者都需要。

## 技术决策与替代方案

| 决策 ID | 选择 | 理由 | 已考虑替代方案 | 来源 |
|---|---|---|---|---|
| TD-301 | `/api/translations` 处理函数在注册监听前先检查 `reply.raw.destroyed`，并在 `reply.raw` 的 `close` 事件中（`!writableFinished` 时）把 `request.raw` 记入模块级 `WeakSet<IncomingMessage>`（`clientClosedRequests`）后再 `controller.abort()`；全局 `setErrorHandler` 在记 error 之前判断：`clientClosedRequests.has(request.raw) && isClientAbortError(error)` 同时成立时**不写任何日志**，仍按原样 `sendError(reply, 500, 'internal_error')`（写往已关闭的连接，无副作用）。`isClientAbortError` 见 TD-303 | 根因是 Fastify 把“首个片段前客户端关闭”导致的 `ERR_STREAM_PREMATURE_CLOSE` 交给应用错误处理器（见根因调查）；以“响应确实已被客户端关闭”为必要条件，错误类型为第二条件，二者同时成立才不记，真正的异常（包括恰好发生在中止附近、但不是中止类的异常）仍记 error（AC-9）。该请求唯一的 `client_aborted` 记录由翻译任务写出（FR-315），错误处理器不再另写，避免一个请求两条记录。本地原型已验证（见根因调查表） | ① 在发送流之前 `reply.raw.flushHeaders()` 提前写出响应头，使 Fastify 走自身（已关闭）日志——改变响应时序与错误语义（首个片段前的上游失败将无法再返回 4xx/5xx 状态），且依赖 Fastify 内部分支，不采用；② 把错误处理器中所有 `ERR_STREAM_PREMATURE_CLOSE` 都降级——没有“客户端已关闭”的事实依据，可能掩盖真正问题，不采用；③ 改用 `reply.hijack()` 自己写 NDJSON——偏离现有写法，改动大 | AC-7、AC-8、AC-9；FR-314～FR-317；IR-001 |
| TD-302 | 翻译任务 `async` 包装的 `catch` 分支：若 `clientClosedRequests.has(request.raw) && isClientAbortError(err)` → 按现有格式写**一条** `logger.info('translation_completed', 'translation aborted by client', { ...baseFields, deltaCount: 0, errorCode: 'client_aborted', durationMs })`（字段与现有 `client_aborted` 记录完全相同，`deltaCount` 取已写出的增量数）；否则保持现有 `logger.error('unhandled_error', 'translation failed unexpectedly', …)` 与写出 `{"type":"error","code":"upstream_unavailable"}`。处理函数用局部计数 `deltasWritten` 记录已写出的增量数 | 当前复现中此分支未被触发，但写出增量时连接被关闭可能令后续实现抛出中止类异常；在这里统一归类，保证“每个中止请求恰好一条 `client_aborted`、无 error”这一不变量不依赖翻译器的实现细节（FR-314、FR-315） | 不处理（依赖翻译器永不抛出，脆弱） | AC-7、AC-8；FR-314、FR-315 |
| TD-303 | 新增 `src/server/clientAbort.ts`：`isClientAbortError(err: unknown): boolean`——`err` 为对象且 `name === 'AbortError'`，或 `code` ∈ {`ABORT_ERR`, `ERR_STREAM_PREMATURE_CLOSE`, `ERR_STREAM_DESTROYED`}；其它（含 `TimeoutError`、`ECONNRESET`、普通 `Error`）一律为 false。`main.ts` 的 `unhandledRejection` 处理改为：`isClientAbortError(reason)` → `logger.warn('unhandled_error', 'unhandled rejection after client abort', { errorClass })`，**不退出**；否则保持 `fatal` + `flush` + `exit(1)`。`uncaughtException` 不变（仍 `fatal` + 退出：同步异常后进程状态不可信） | 意图假设要求进程级路径也排除客户端中止（FR-316 不因中止退出）；分类集合只含“中止/流被提前关闭”类，`TimeoutError`（上游超时）与网络错误不在其中，不降低真正异常的级别；`warn` 不命中 `app-error-or-fatal` 规则，也不是第二条 `client_aborted` 记录 | 对所有 `unhandledRejection` 只记 warn（降低真正异常，违反意图）；把 `ECONNRESET`/`EPIPE` 也算中止（上游连接错误也会产生这些码，可能掩盖上游问题） | AC-7、AC-8、AC-9；FR-316 |
| TD-304 | 新增 `src/shared/chineseText.ts`：`isChineseTranslation(text: string): boolean`，按 FR-301 实现：①文本中至少一个 `\p{Script=Han}` 字符；②不存在任何“字母”（`\p{L}`）属于 Han、Latin、Bopomofo 以外的文字，即正则 `/(?=\p{L})[^\p{Script=Han}\p{Script=Latin}\p{Script=Bopomofo}]/u` 不命中（谚文、平假名、片假名含半角片假名、西里尔、泰文、阿拉伯文、希腊字母等都会命中）；数字、标点、空白、符号、组合附加符不参与判定。另导出 `containsForbiddenScript(text)`（②的单独判断，供测试与服务端 TD-307 使用）。只用 ES2018 Unicode 属性转义，无依赖 | FR-301 的四条规则可逐条映射；`Script`（而非 `Script_Extensions`）使 `。`、`、`、`ー`、`・` 这类中日共用符号不被误判（它们属于 Common）；放在 `src/shared/` 使浏览器、服务端与测试判定（IQA-301/302 的判定方法）用同一实现，避免测试与产品判定不一致 | 汉字比例阈值（如第 1 版测试的 `hanRatio ≥ 0.7`：拉丁专名多的句子会被误判，且不符合 FR-301）；调用语言检测库（新依赖，且对短句不可靠） | AC-1、AC-2、AC-4、AC-12；FR-301、FR-302 |
| TD-305 | **临时译文先收齐再判定**：`sendPartial` 的 `onDelta` 只累积缓冲、不显示；请求成功且缓冲非空后：`isChineseTranslation(buffer)` 为真且 `rev >= seg.shownRev` → `showInterim`；为假 → 不显示、不重译、不提示，但仍把 `seg.partialSource = text`（同一识别文本不会被再次发送，即不构成重译），随后照常 `maybeSendPartial`（新的识别文本到来时继续发送）。临时字幕的节流（单飞 + 500 ms）、取代即中止的既有逻辑不变 | FR-303 禁止显示非中文结果的“任何片段”，FR-304 要求“判定为中文时”才显示，判定必须基于完整结果；单飞节流使临时字幕在说话过程中仍每 0.5～1 s 左右更新一次，第 1 版 IQA-002 的“句中出现并至少再变化一次”（`tests/e2e/streaming.spec.ts`）仍成立。代价：单次临时译文不再逐 token 增长，而是整段出现（每段仅数百毫秒的生成时间），属于判定的必然结果 | 逐片显示“目前为止仍是中文”的前缀，出现非中文字符再撤回（会显示非中文结果的片段，违反 FR-303，且撤回造成闪动） | AC-12；FR-303、FR-304；Q-3 |
| TD-306 | **定稿先收齐再判定、重译一次**：`attempt()` 不再在 `onDelta` 中显示，只累积缓冲；`finalize()` 改为：`r1 = translateWithRetry(seg, false)`（即现有“一次请求 + 可重试失败时等待后再试一次”的逻辑，原样抽成函数）→ 失败按现有规则处理（移除、计数、`checkAvailability`）；成功且 `isChineseTranslation` → 显示并定稿（`failedSegments = 0`，现有）；成功但非中文且 `!seg.retranslated` → `seg.retranslated = true`，`r2 = translateWithRetry(seg, true)`（请求体带 `retranslate: true`）→ 失败按现有规则（FR-311）；成功且中文 → 显示并定稿（`failedSegments = 0`）；成功仍非中文 → `view.setNotice(seg.id, UNTRANSLATED_NOTICE)`、`setStatus(final)`、`release(seg)`，**不改变** `failedSegments`（既不加一也不清零，FR-309）。整个过程中该句保持句末时显示的中文临时译文 `preFinalText`（没有显示过任何临时译文时保持空，FR-305 与规格假设）。`trackNetwork` 对每个请求结果照旧调用（成功响应清零网络失败计数，属于网络层语义，不受内容判定影响） | 一一对应 FR-305～FR-311 与状态表；把“请求失败重试”与“内容重译”分成两层，保证 FR-311 所说“重新翻译这一次请求失败按既有处理”自然成立，且每句最多一次内容重译（不变量 2）；停止（`endRun`）时 `isLive` 为假，任何后续结果被丢弃（FR-313，与现有停止语义相同） | 服务端判定并在流尾返回“非中文”标记（需要服务端缓冲整段才能保证不先发出非中文片段，且两端各有一份状态）；对非中文结果再重试多次（违反“只重试一次”） | AC-4、AC-5；FR-305～FR-311、FR-313；Q-1、Q-4 |
| TD-307 | **提示词收紧**（`src/server/translation/translator.ts`）：`SYSTEM_PROMPT` 中“如果内容已经是简体中文，原样输出；繁体中文转换为简体。”改为：“无论原文是什么语言，都只输出简体中文译文。不得照抄原文，不得输出韩文（谚文）、日文假名或其它非中文文字；人名、品牌、缩写可以音译成中文或保留拉丁字母。原文本身是中文时，输出其简体中文形式（繁体转换为简体）。”`buildChatRequestBody` 中：当 `sourceLanguage` 以 `zh` 开头而文本不含汉字或 `containsForbiddenScript(text)` 为真时，`lang` 属性写 `auto`（不改变请求中的语言字段，也不改变候选语言范围） | 针对未排除的触发条件 T1、T2：去掉“原样输出”的出口，并让模型不被错误的语言标注误导；中文原文仍得到中文输出，英语等语言翻译不受影响（第 1、2 版含义一致性 e2e 作为回归，AC-11） | 不改提示词，只靠显示端判定（清晰素材上仍可能出现提示，违反 PQ-301 的通过标准）；加大 `temperature` 或换模型（不在范围，且模型/部署为客户沿用约束） | AC-1、AC-2、AC-13；PQ-301 |
| TD-308 | **重译请求**：`TranslationRequest` 新增可选 `retranslate?: boolean`；JSON schema `retranslate: { type: 'boolean' }`；`kind === 'partial'` 且 `retranslate === true` 时返回 400 `invalid_request`（临时译文不重译，FR-304）。`retranslate === true` 时系统提示末尾追加 `RETRANSLATE_NOTE`：“上一次的输出不是简体中文。这一次必须把 <source> 中的内容完整翻译成简体中文，只输出中文译文，不得包含原文语言的文字。”客户端只在 TD-306 的第二次内容翻译时设置 | 同一提示词对同一输入再次调用，照抄的概率仍高；明确告知“上次不是中文”能显著提高第二次成功的概率，从而减少提示句（PQ-301）；可选字段对旧页面兼容；严格校验保持 `additionalProperties: false` 的既有风格 | 重译时复用相同请求（成功率无改善）；把重译放在服务端自动进行（服务端需判定并缓冲，见 TD-306 替代方案） | AC-4、AC-5；FR-307 |
| TD-309 | **中文提示条目**：`CaptionView` 接口新增 `setNotice(id: number, text: string): void`；`DomCaptionView.setNotice` 设置 `textContent = text` 与 `data-kind="notice"`；`MirroredCaptionView` 同步到小窗（同一任务内先主后小窗，与既有方法相同）。提示文字常量 `UNTRANSLATED_NOTICE = '（此句未能翻译成中文）'` 放在 `src/web/messages.ts`。样式（`src/web/styles.css`）：`.caption[data-kind='notice'] { color: var(--caption-notice); font-size: calc(var(--caption-size) * 0.75); border-left: 4px solid var(--caption-notice); font-style: normal; }`，`--caption-notice: #c9b48f`（与字幕区背景 `#0d1117` 对比度约 9.4:1，高于 FR-129 对临时字幕的 4.5:1，也高于定稿的 7:1）；不使用红色、闪烁、动画；字号随 4 档 `--caption-size` 变化且始终小于正常字幕。小窗打开时克隆主页面列表（既有机制）会复制 `data-kind` | FR-308 的可判定条件逐条满足：颜色、字号、左侧实线标记三项可见差异（正常定稿为白色、无标记；临时为灰蓝色虚线标记加省略号；中断为斜体），不依赖悬停；`data-status` 仍为 `final`，使“每句恰一条定稿条目”的既有计数（FR-310）与测试工具不变 | 用新的 `data-status` 值（会破坏既有测试与 DOM 契约中 `final` 的计数）；在状态区提示（Q-1 未采用） | AC-5、AC-6；FR-308、FR-310、FR-312；Q-1 |
| TD-310 | **受控触发“翻译结果非中文”的方式**：端到端测试与独立测试在浏览器中用初始化脚本包装 `window.fetch`：只对匹配规则的 `/api/translations` 请求返回由测试构造的 NDJSON 流（`{"type":"delta","text":"<非中文内容>"}` 若干行 + `{"type":"done"}`，状态 200、`application/x-ndjson`，可设延迟）；其余请求调用原始 `fetch`，走真实服务。规则按“第 n 句的首次定稿请求 / 重译请求（请求体 `retranslate === true`）/ 第 n 个临时请求”匹配，并记录每句的请求次数。**生产代码中不加任何测试开关** | 意图与规格授权受控触发（AC-4、AC-5、AC-12）；只替换被测分支的一次响应，识别、页面、小窗仍真实运行；不使用 Playwright `route`：第 2 版独立测试补充评审实测 `context.route` 会使字幕小窗不载入 `/styles.css`（`002-v1/evidence/supplementary-review.md`），会破坏 AC-5/AC-6 的样式判定；浏览器内包装同样适用于修复前的版本（AC-4 要求修复前运行失败） | 服务端故障注入开关（生产代码含测试路径，且候选部署无法按测试打开，见“开放决策”）；Playwright `route.fulfill`（见左） | AC-4、AC-5、AC-6、AC-12；IQA-303～IQA-307、IQA-312 |
| TD-311 | **AC-9 与真实模型证据的取得方式**：AC-9（未预期异常仍记 error）在服务端测试中以构造的翻译器依赖注入异常（`buildApp({ translator: throwingTranslator })`，真实 pino 日志写入内存），由 Coding 的开发者测试与候选验证（Runner 在不可变候选提交上执行，属平台证据）给出；独立测试对已部署候选无法注入服务端异常，处理方式见“开放决策 D-301”。根因收敛证据：集成测试对真实 `dev` 模型发送韩语、日语句子（含短句、感叹、片段，partial 与 final），记录首次非中文条数与重译后结果（只输出条数） | 生产代码不为测试增加可被外部触发的异常入口（宪章·最小权限）；构造依赖是 `buildApp` 已有的注入点（`AppDeps.translator`），不改变生产装配 | 生产代码加环境变量/请求头触发的故障注入（见 D-301） | AC-9、AC-13 |
| TD-312 | 日志：`LogFields` 新增 `retranslate?: boolean`（校验器：`typeof v === 'boolean'`），只写入 `translation_completed`（成功）与 `upstream_error` 记录，且只在请求带 `retranslate: true` 时出现；**不加入 `baseFields`**，因此 `client_aborted` 记录的字段集合不变（FR-315）。其余事件、字段、级别不变 | 运维可按 `retranslate=true` 统计重译次数（即“首次结果非中文”的频率），用于观察 TD-307 的效果，且不含任何内容 | 不记录（无法在运行环境观察非中文输出的频率）；在 `client_aborted` 中也记录（违反“不新增字段”） | AC-10、AC-13；FR-315、FR-318 |
| TD-313 | 测试素材：新增 `tests/fixtures/sentences.ko.json`（`voice: ko-KR-SunHiNeural`）与 `tests/fixtures/sentences.ja.json`（`voice: ja-JP-NanamiNeural`），各含 `drama` 句组 6 句清晰的影视对白式句子（每句 ≥ 6 个词/音节组、无专名歧义、句间 2 s 停顿，沿用第 1 版合成规则），每句附中文关键要素（只用于诊断输出，不作为通过条件）；`tests/support/tts.ts` 改为按语言读取对应文件、SSML `xml:lang` 取文件中的 `locale` 字段，缓存键包含语言 | 同一 `speech` 资源的神经语音，无新依赖；“清晰素材上每句都应得到中文译文”（PQ-301）要求素材本身清晰、可稳定识别为一句一段 | 使用真实电影片段（版权与客户内容问题，且不可稳定复现） | AC-1、AC-2、AC-3 |

## 领域与数据模型

仍不持久化任何业务数据。变化只在内存模型与请求契约：

```ts
// src/shared/contracts.ts
export interface TranslationRequest {
  kind: 'partial' | 'final';
  text: string;                 // 1..2000
  sourceLanguage?: string;
  inputSource?: 'microphone' | 'system';
  retranslate?: boolean;        // 新增（TD-308）：仅 kind='final' 时可为 true
}

// src/shared/chineseText.ts（新增，TD-304）
export function isChineseTranslation(text: string): boolean;
export function containsForbiddenScript(text: string): boolean;

// src/web/captionPipeline.ts
interface CaptionSegment {
  /* 既有字段不变 */
  retranslated: boolean;        // 新增：本句是否已做过一次内容重译（每句最多一次）
}
export interface CaptionView {
  append(id: number): void;
  setText(id: number, text: string): void;
  setStatus(id: number, status: SegmentStatus): void;
  remove(id: number): void;
  setNotice(id: number, text: string): void;   // 新增（TD-309）
}
// SegmentStatus 不变：'interim' | 'finalizing' | 'final' | 'interrupted' | 'dropped'
```

每句字幕状态与规格状态表的对应：

| 规格状态 | `data-status` | `data-kind` | 显示内容 |
| --- | --- | --- | --- |
| 临时 | `interim` | （无） | 最近一条判定为中文的临时译文（无则为空，`li:empty` 不显示） |
| 定稿中（含重译中） | `finalizing` | （无） | `preFinalText`（句末时的中文临时译文） |
| 定稿（译文） | `final` | （无） | 中文定稿译文 |
| 定稿（提示） | `final` | `notice` | `（此句未能翻译成中文）` |
| 中断（停止后再开始） | `interrupted` | （无） | 停止时显示的中文临时译文（既有） |

服务端：`translateFn` 接口不变；`buildChatRequestBody` 读取 `retranslate` 与 `sourceLanguage`/文本文字的一致性（TD-307、TD-308）。

## Component 边界与项目结构

Coding 会创建或修改的路径（写路径白名单）：

- `./package.json`、`./package-lock.json`、`./tsconfig.json`、`./tsconfig.web.json`、`./eslint.config.js`、`./vitest.config.ts`、`./vitest.integration.config.ts`、`./playwright.config.ts`
- `./README.md`
- `src/server/`
- `src/web/`
- `src/shared/`
- `tests/unit/`、`tests/integration/`、`tests/e2e/`、`tests/fixtures/`、`tests/support/`
- `docs/verification/`（只放 AC-4 修复前失败运行的测试报告摘要，见“验证环境责任矩阵”）

技术方案拥有、Coding 不得修改：`docs/dependencies.json`、`docs/deployment.json`、`infra/`、本 Feature 目录下的 `runtime/deployment.json`。`Dockerfile`、`.dockerignore`、`scripts/` 本次不需要修改。

```
src/
  shared/
    contracts.ts                 # 改：TranslationRequest.retranslate（可选布尔）
    chineseText.ts               # 新：isChineseTranslation / containsForbiddenScript（TD-304）
  server/
    clientAbort.ts               # 新：isClientAbortError（TD-303）
    main.ts                      # 改：unhandledRejection 排除中止类（TD-303）
    logger.ts                    # 改：LogFields.retranslate（布尔校验，TD-312）
    http/app.ts                  # 改：clientClosedRequests、错误处理器与翻译任务 catch 的中止分类（TD-301、TD-302）；
                                 #     schema 增加 retranslate，partial+retranslate → 400（TD-308）；成功/上游错误记录带 retranslate
    translation/translator.ts    # 改：SYSTEM_PROMPT 收紧、RETRANSLATE_NOTE、lang 不一致时用 auto（TD-307、TD-308）
    （其余文件不改）
  web/
    captionPipeline.ts           # 改：临时/定稿先收齐后判定；translateWithRetry；重译一次；提示；show() 守卫（TD-305、TD-306）
    captionView.ts               # 改：DomCaptionView.setNotice（TD-309）
    mirroredCaptionView.ts       # 改：setNotice 同步（TD-309）
    messages.ts                  # 改：UNTRANSLATED_NOTICE
    styles.css                   # 改：--caption-notice 与 .caption[data-kind='notice']（TD-309）
    （audioSource、displayAudio、recognition、pip、main、translateClient 等不改；translateClient 透传请求对象，
      retranslate 字段随请求体发送，无需改代码）
tests/
  unit/                          # 新：chineseText.test.ts、clientAbort.test.ts；改：captionPipeline、translator、app、logger、
                                 #     mirroredCaptionView（setNotice）
  integration/                   # 新：translationAbort.int.test.ts（AC-7/8/10，真实 chat-model）、
                                 #     translationFailure.int.test.ts（AC-9，注入异常）、translationChinese.int.test.ts（TD-311）
  e2e/                           # 新：chinese-only.spec.ts（韩语/日语 ×3，AC-1～AC-3）、non-chinese.spec.ts（受控触发 AC-4/5/6/12、IQA-312）；
                                 #     translationOverride.ts（fetch 包装初始化脚本，TD-310）；fixtures.ts 增加按语言的素材与提示条目查询
  fixtures/sentences.ko.json、sentences.ja.json   # 新（TD-313）
  support/tts.ts                 # 改：按语言读取素材文件与 locale（TD-313）
docs/verification/003-ac4-prefix-run.txt          # 新：AC-4 受控触发测试在修复前提交上的失败运行摘要
```

### 页面 DOM 契约（在第 2 版基础上新增，Coding 必须保持）

| 元素 | 选择器 / 属性 | 说明 |
| --- | --- | --- |
| 字幕条目 | `#captions > li.caption[data-status][data-segment-id]`（不变） | 小窗为 `#pip-captions > li.caption[...]`（不变） |
| 中文提示条目 | `li.caption[data-status="final"][data-kind="notice"]`，`textContent` 恰为 `（此句未能翻译成中文）` | 主页面与小窗相同；正常条目没有 `data-kind` |
| 提示样式 | `getComputedStyle`：颜色 `rgb(201, 180, 143)`、`font-size` = 正常字幕字号 × 0.75、左边框 4 px 实线 | 供 IQA-305 样式测量 |

## 数据流、状态、并发与生命周期

### 临时译文（TD-305）

```
recognizing → maybeSendPartial（单飞 + 500 ms 节流，不变）
  → sendPartial: translate(kind=partial) —— onDelta 只累积 buffer
  → 结果：
     被取代/已中止/句子已不在 interim → 丢弃（不变）
     ok 且 buffer 非空：
        isChineseTranslation(buffer) → rev >= shownRev 时 showInterim(buffer)
        否则                         → 不显示（保留上一条中文临时译文）
        两种情况都设 partialSource = text（同一识别文本不再发送 → 不重译）
     失败 → 静默、不计数（不变）
  → maybeSendPartial（新的识别文本到来时继续）
```

### 定稿（TD-306）

```
recognized → stopPartials、中止在途定稿 → preFinalText = shownText → status=finalizing → finalize()

finalize():
  r1 = translateWithRetry(seg, retranslate=false)        // 现有：请求 → 可重试失败则等待(≤2 s)再试一次
  if !isLive → return                                     // 停止/新一轮：不再改变（FR-313）
  if r1 失败 → 现有处理：aborted 直接返回；否则 dropSegment + 按 NOT_COUNTED 计数 + checkAvailability
  if isChineseTranslation(r1.text) → finalizeWith(r1.text)          // show + final + release + failedSegments=0
  // 非中文：保持 preFinalText 不变
  seg.retranslated = true
  r2 = translateWithRetry(seg, retranslate=true)
  if !isLive → return
  if r2 失败 → 同 r1 失败的现有处理（FR-311）
  if isChineseTranslation(r2.text) → finalizeWith(r2.text)
  else → view.setNotice(id, UNTRANSLATED_NOTICE); setStatus(final); release(seg)    // failedSegments 不变（FR-309）
```

`translateWithRetry` 返回 `{ outcome, text }`：`text` 为该次成功请求的完整缓冲；`outcome.ok && !text.trim()` 仍按现有规则视为 `upstream_unavailable`（可重试）。`attempt()` 中不再调用 `show()`。

### 显示守卫（不变量 1）

`show(seg, text)` 入口增加：`if (text !== '' && !isChineseTranslation(text)) return;`。正常流程中所有调用都已判定过，守卫只防止未来改动引入新的显示路径；`preFinalText` 只可能是此前通过守卫显示过的文本。

### 停止与重新开始（FR-313）

不改：`endRun()` 同步使 epoch 失效并中止在途请求（含重译请求与重试等待），之后 `isLive` 为假，任何结果都不再写入视图；该句保留停止时显示的 `preFinalText`，状态保持 `finalizing`，下一次 `beginRun()` 时按既有规则变为 `interrupted`。

### 主页面与小窗（FR-312）

不改同步机制：`MirroredCaptionView` 对 `setNotice` 与其它方法一样，同一任务内先写主页面、再写小窗；小窗打开时克隆主页面列表（含 `data-kind`）。

### 服务端：`/api/translations` 生命周期（TD-301、TD-302）

```
handler:
  校验 → 限流 → controller = new AbortController()
  const markClosed = () => { if (!reply.raw.writableFinished) { clientClosedRequests.add(request.raw); controller.abort(); } }
  if (reply.raw.destroyed) markClosed(); else reply.raw.on('close', markClosed)
  reply.send(PassThrough)          // Fastify 在首个片段写出时才发响应头（根因）
  async 任务：
    try   translator.translate(...)
          ok            → done 行 + info translation_completed（含 retranslate 时带该字段）
          client_aborted→ info translation_completed errorCode=client_aborted（不变，唯一记录）
          其它失败       → error 行 + warn upstream_error（不变）
    catch err：
          clientClosedRequests.has(request.raw) && isClientAbortError(err) → info client_aborted（同上格式）
          否则 → error 行 + error unhandled_error（不变，AC-9）
    finally stream.end()

setErrorHandler(error, request, reply):
  413 / 4xx 分支不变
  clientClosedRequests.has(request.raw) && isClientAbortError(error) → 不记日志，sendError(500)（连接已关闭，无输出）
  否则 → error unhandled_error（不变）
```

`WeakSet` 以 `IncomingMessage` 为键，请求对象回收后自动释放，无内存增长。

## Interface 与契约（Contract）

第 1、2 版接口全部保持（`GET /healthz`、`GET /` 与静态资源、`POST /api/speech-token`、`POST /api/translations`、依赖调用），只有下列变化。

### `POST /api/translations` 请求体

```json
{ "kind": "partial" | "final", "text": "<1..2000 字符>", "sourceLanguage": "<可选>", "inputSource": "microphone" | "system", "retranslate": true | false }
```

- `retranslate` 可选，布尔；`kind: "partial"` 且 `retranslate: true` → 400 `{"error":"invalid_request"}`；其它组合照常处理。`additionalProperties: false` 不变。
- 响应格式不变：NDJSON 行 `{"type":"delta","text":…}`、`{"type":"done"}`、`{"type":"error","code":…}`。
- 客户端在首个片段前或后中止/断开：服务端停止上游请求，不再写出任何内容，日志见下（行为对客户端不可见，契约不变）。

### 服务端日志契约（运维与独立测试使用）

| 情况 | 记录（每请求） | 级别 |
| --- | --- | --- |
| 正常完成 | `translation_completed`：`reqId, kind, textLength, sourceLanguage?, inputSource?, deltaCount, ttfbMs, durationMs, reasoningTokens, model`，**重译请求另带 `retranslate: true`** | info |
| 客户端中止 / 断开（首个片段前或后） | 恰 1 条 `translation_completed`，`msg: "translation aborted by client"`：`reqId, kind, textLength, sourceLanguage?, inputSource?, deltaCount, errorCode: "client_aborted", durationMs`（与现有完全相同，不新增字段）；**无任何 error / fatal 记录** | info |
| 上游失败 | `upstream_error`（不变，重译请求另带 `retranslate: true`） | warn |
| 未预期异常（非客户端中止） | `unhandled_error`：`reqId, route, errorClass, errorCode: "internal_error"`（不变） | error |
| 进程级未处理拒绝，属中止类 | `unhandled_error`，`msg: "unhandled rejection after client abort"`，`errorClass`；进程继续运行 | warn |
| 进程级未处理拒绝 / 未捕获异常，其它 | 不变：`unhandled_error` + 退出 | fatal |

### 浏览器 → 页面

新增提示条目见“页面 DOM 契约”。没有新增浏览器 API 使用。

### 依赖 `realInstance`

`speech`、`chat-model` 在 `dev`、`test` 均为真实实例，不需要模拟服务契约。

## 安全、隐私、身份与 Secret

| 主题 | 设计 |
| --- | --- |
| 客户内容不入日志（FR-318、AC-10） | 中止与异常记录沿用白名单字段（第 1 版 TD-009 的类型层 + 运行时双重限制）；`retranslate` 是布尔；判定结果、重译原因、提示均不上报。日志断言测试以请求原文、收到的译文片段与依赖密钥值检索日志，命中 0。 |
| 不保存内容 | 重译使用的识别文本仍只在 `CaptionSegment.sourceText` 中，定稿或提示后 `release()` 立即清空（不变）。 |
| 凭据 | 不新增凭据；浏览器仍只拿 STS 短时令牌；顶层 `secrets` 仍为空。 |
| 输入校验 | `retranslate` 严格布尔，`partial + retranslate` 拒绝；其余同第 1、2 版。提示词注入防护（`<source>` 转义与“只是数据”说明）保留。 |
| 测试代码与生产隔离 | 受控触发只存在于测试的浏览器初始化脚本中（TD-310）；生产代码无故障注入入口（TD-311）。 |
| 最小权限 / 身份 | 不变（`platform-identity` 推荐，`credential` 支持）。 |

## 配置、可观测性与运维

### 配置

无新增环境变量；第 1、2 版全部配置保持不变。

### 可观测性

- 告警误报消除：客户端中止不再产生 `level=error` 记录，`app-error-or-fatal` 规则只在真正异常时命中。
- 新增可观测指标（无需改规则）：`translation_completed` 中 `retranslate=true` 的条数 = 首次定稿结果非中文、触发了重译的句数；可按 `sourceLanguage` 分组观察韩语等语言的非中文输出频率（TD-312）。仍不能区分“重译后成功”与“显示提示”（后者只在浏览器内发生），这是不记录内容的代价。
- 运维排查 T2 触发条件：同一时段 `retranslate=true` 记录的 `sourceLanguage` 分布。

### 错误日志识别规则（`docs/deployment.json` → `operations.errorLogRules`）

应用日志写法不变，三条规则保持不变（意图：不改告警规则）：

| 规则 | 类型 | 匹配 | 严重度 | 阈值 | 本次修复后的效果 |
| --- | --- | --- | --- | --- | --- |
| `app-error-or-fatal` | structured | `level` ∈ {`error`,`fatal`}，messageField `msg` | high | 出现即报 | 客户端中止不再命中；未预期异常、启动失败、配置错误仍命中 |
| `upstream-errors-burst` | structured | `event` = `upstream_error`，messageField `errorCode` | medium | 5 分钟内 10 次 | 不变 |
| `node-crash-output` | pattern | 非 JSON 的 Node 崩溃输出 | high | 出现即报 | 不变 |

## SLO、限制、扩缩容、重试与恢复

- 无获批准的时延、可用率要求。意图已接受“定稿先判定再显示”的显示延迟：定稿字幕在整段译文收齐后一次性出现（通常比逐片显示晚数百毫秒）；需要重译的句子再加一次定稿翻译的时间（通常 1～3 s），期间显示句末临时译文。
- 调用量：每句最多多一次定稿请求（仅首次非中文时）；限流阈值不变（单页定稿 1200 次/分的上限远高于实际）；上游 TPM 影响可忽略。
- 重试分层：请求失败的重试（现有，最多一次）与内容重译（新增，最多一次）相互独立，最坏情况每句 4 次定稿请求。
- 恢复：提示句不计入连续失败，翻译继续；请求失败按既有规则（连续 3 句停止并提示“翻译已中断”，再次“开始”恢复）。

## 部署拓扑、迁移、Rollout 与 Rollback

- `docs/deployment.json`：仍为单服务 `web`（`.`/`Dockerfile`，端口 8080，`/healthz`，对外）；`errorLogRules` 不变；只更新服务描述文字。
- Dockerfile、构建脚本不变。
- 依赖：沿用已绑定实例，不执行任何 IaC，不新增云资源；`docs/dependencies.json` 只更新 `speech` 的用途文字（测试素材增加韩语、日语）。
- 迁移：无。请求新增可选字段：发布后仍打开着的旧页面不发送该字段，照常工作；回滚到旧服务后仍打开着的新页面发出的重译请求会得到 400，客户端按既有“不计数的失败”移除该句，刷新页面即恢复。
- Rollout：平台按候选 SHA 构建并部署到 `cand-{deliveryShortId}`。
- Rollback：无状态，重新部署上一个通过的候选即可。

## 验证环境责任矩阵（Verification Environment）

| 验证类型 | 责任阶段 | 环境来源 | 依赖/凭据 | Coding 证据 | 下游结果 |
|---|---|---|---|---|---|
| 静态检查 | Coding、候选验证 | Agent Pod / 同镜像 Runner | 无 | `npm run lint`、`npm run typecheck` | 候选验证记录 |
| 构建 | 同上 | 同上 | 无 | `npm run build` | 候选验证记录 |
| 单元测试（developerTests） | 同上 | 同上 | 无外部调用 | 见下“单元测试设计” | 候选验证记录 |
| 集成/契约测试（integrationTests） | 同上 | 同上 | `chat-model`、`speech` 的 `dev` 实例 | 第 1、2 版全部集成测试保持；新增 `translationAbort`（AC-7、AC-8、AC-10，真实模型）、`translationFailure`（AC-9，注入异常）、`translationChinese`（TD-311） | 候选验证记录（AC-9 的平台证据） |
| 功能/端到端（functionalTests） | 同上 | 本地 `localhost` 服务 + headed Chromium（Xvfb，第 2 版 TD-108） | `dev` 实例 | 第 1、2 版全部 e2e 保留（AC-11）；新增 `chinese-only.spec.ts`、`non-chinese.spec.ts`；AC-4 修复前失败运行摘要 `docs/verification/003-ac4-prefix-run.txt` | 候选验证记录 |
| 独立测试（IQA-301～IQA-313） | 独立测试 | 候选部署 `cand-*`，QA Pod（headed Chromium + Xvfb） | `test` 实例；TTS 合成韩语、日语素材；服务日志 `QA_SERVICE_LOGS_DIR` | — | IQA-301/302 真实服务各 ≥ 3 次；IQA-303～307、312 以浏览器内 `fetch` 包装受控触发（TD-310，不要用 `context.route`）；IQA-308/309 直接向候选 HTTPS 地址发流式请求并中止，按服务日志判定；IQA-310 见 D-301；IQA-311 由候选验证的全量 e2e 结果与 QA 的回归场景共同给出；IQA-313 检查本方案“根因调查” |
| 依赖探测 | 依赖与机密任务 | 平台隔离环境 | 单个依赖 | — | 沿用现有探测脚本与约束 |

### 单元测试设计（`npm test`）

| 文件 | 覆盖 | 要点 |
| --- | --- | --- |
| `chineseText.test.ts`（新） | FR-301、FR-302 | 中文句 → 真；含谚文（音节、兼容字母）、平假名、片假名、半角片假名、西里尔、泰文、阿拉伯文 → 假；纯拉丁 / 纯数字标点 / 空串 → 假（无汉字）；汉字夹 `iPhone`、`OK`、`Q3`、数字、全角拉丁 → 真；含 `。、・ー` 的中文 → 真；全汉字日文 → 真（已接受局限） |
| `captionPipeline.test.ts`（改） | FR-304～FR-311、FR-313 | 临时：中文整段显示、增量期间不显示；非中文不显示且保留上一条、不重发同一文本；定稿：增量期间不显示、只在判定后显示；非中文 → 恰一次 `retranslate:true` 请求；重译中文 → 定稿；重译仍非中文 → `setNotice` + `final`，`failedSegments` 不变（与请求失败交替的序列：失败、提示、失败、失败 → 第 3 次失败才停止）；重译请求失败 → 按既有重试后移除并计数；重译期间 `endRun` → 无后续写入；`show()` 守卫拒绝非中文；既有用例全部保留（调整“定稿逐片替换”相关断言为“判定后一次替换”，G4 S30 意见“不先变短”仍成立） |
| `captionView`/`mirroredCaptionView.test.ts`（改） | FR-312 | `setNotice` 设置文本与 `data-kind`，主页面与小窗同序同文 |
| `translator.test.ts`（改） | TD-307、TD-308 | 新提示词不含“原样输出”；`retranslate:true` 时系统消息含重译说明；`sourceLanguage=zh-CN` 且文本含谚文/假名/无汉字 → `lang="auto"`；其它语言保持原值 |
| `app.test.ts`（改） | TD-301、TD-302、TD-308、TD-312 | `retranslate` 校验（布尔、partial+true → 400）；在真实 HTTP 监听上用受控翻译器复现首个片段前/后 × `AbortController`/断开 socket 四种中止：内存日志中 error/fatal 0 条、`client_aborted` 恰 1 条且字段集合与现有一致；翻译器抛出普通异常 → `unhandled_error` error 1 条；翻译器抛出 `AbortError` 但客户端**未**关闭 → 仍记 error（证明分类依赖“已关闭”）；成功记录在重译时带 `retranslate` |
| `clientAbort.test.ts`（新） | TD-303 | `isClientAbortError` 真值表（`AbortError`、`ABORT_ERR`、`ERR_STREAM_PREMATURE_CLOSE`、`ERR_STREAM_DESTROYED` 为真；`TimeoutError`、`ECONNRESET`、普通 `Error`、非对象为假）；`main.ts` 的拒绝处理函数抽成可测函数 `handleUnhandledRejection(logger, exit)`：中止类 → warn、不调用 exit；其它 → fatal、调用 exit(1) |
| `logger.test.ts`（改） | TD-312 | `retranslate` 只接受布尔 |

### 集成测试设计（`npm run test:integration`，真实 `dev` 实例）

| 文件 | 覆盖 | 方法与判定 |
| --- | --- | --- |
| `translationAbort.int.test.ts`（新） | AC-7、AC-8、AC-10；IQA-308/309 的开发者版本 | 用真实配置 `buildApp`（真实翻译器与 `chat-model`），日志写入内存，监听随机端口。四个用例：首个片段前 × {`fetch` + `AbortController.abort()`、底层 socket `destroy()`}（请求发出后立即中止，断言客户端未收到任何字节）；首个片段后 × 同两种方式（读到第一行 `delta` 后中止）。每个用例等待该请求的 `client_aborted` 记录出现（≤ 10 s），然后断言：该时间窗内 error/fatal 记录 0 条；`client_aborted` 恰 1 条，键集合等于现有格式；日志全文检索请求原文、已收到的译文片段、`AIDH_DEP_CHAT_MODEL_KEY`/`AIDH_DEP_SPEECH_KEY`（存在时）命中 0；随后一次正常请求成功返回中文（`isChineseTranslation`） |
| `translationFailure.int.test.ts`（新） | AC-9；IQA-310 的开发者版本 | `buildApp` 注入在首个片段前抛出 `Error` 的翻译器 → 客户端收到 `{"type":"error","code":"upstream_unavailable"}`，日志恰 1 条 `unhandled_error`（error）且不含原文；注入在写出 1 个片段后抛出的翻译器 → 同样 1 条 error |
| `translationChinese.int.test.ts`（新） | TD-311、AC-13 证据 | 韩语、日语各约 20 句（影视对白式短句、感叹、片段，partial 与 final 两种 `kind`，并含 `sourceLanguage=zh-CN` 的错标样本）：final 首次结果非中文时以 `retranslate:true` 重发一次；断言重译后全部为中文；测试输出只打印“首次非中文条数 / 重译后非中文条数”，不打印内容 |
| 既有 `translation.int.test.ts` | AC-11 | 保持；英语译文含义一致性断言在新提示词下仍须通过 |

### 端到端用例设计（`npm run test:e2e`，开发者版本，对应规格验收场景）

公共夹具沿用第 2 版（headed Chromium + Xvfb、`--auto-select-tab-capture-source-by-title=RTMT-player-{workerIndex}`、仪表脚本记录字幕时间线）。时间线记录每次变化的 `status`、`kind`（`data-kind`）与文本；小窗打开时同时记录小窗时间线。判定一律使用 `src/shared/chineseText.ts`。

| 用例 | 覆盖 | 方法与判定 |
| --- | --- | --- |
| 韩语素材 ×3 | IQA-301；AC-1、AC-3 | `chinese-only.spec.ts`：系统声音播放 `sentences.ko.json` 的 `drama` 组，同一素材连续 3 个独立测试（新浏览器上下文，`retries: 0` 不变）。每次：定稿条数 = 句数；每条定稿 `isChineseTranslation` 为真、无 `data-kind=notice`；时间线中任何时刻任何条目都不含谚文、也不等于素材任一原句；结束时无 `interim/finalizing` 残留 |
| 日语素材 ×3 | IQA-302；AC-2、AC-3 | 同上，`sentences.ja.json`；判定“不含假名” |
| 定稿非中文 → 重译得到中文（系统声音、麦克风各一） | IQA-303、IQA-304；AC-4 | `non-chinese.spec.ts`：`fetch` 包装（TD-310）使第 2 句的首次定稿请求返回谚文内容，重译请求走真实服务。判定：时间线中该句任何时刻不出现谚文或该句原文；从句末到定稿之间该句文本始终等于句末时的临时译文（非空、不缩短）；该句 `retranslate:true` 请求恰 1 次；最终为 `final`、中文、无 `data-kind`。麦克风用第 2 版假麦克风参数输入同一素材 |
| 修复前失败 | IQA-303；AC-4 | Coding 在第 2 批开始改动前，先提交本用例并在修复前提交上运行（预期失败于“出现谚文”断言），把 Playwright 列表报告摘要（用例名、失败断言、提交 SHA，不含任何依赖凭据）写入 `docs/verification/003-ac4-prefix-run.txt` |
| 重译仍非中文 → 提示，翻译继续（小窗打开） | IQA-305、IQA-307；AC-5、AC-6 | 6 句素材；第 2～4 句的首次与重译请求都返回谚文内容，其余真实。判定：这 3 句为 `final` + `data-kind=notice` + 文本恰为提示语；`getComputedStyle` 颜色 ≠ 正常定稿、非红色系（色相不在 345°～15°）、`font-size` ≤ 正常字幕、对比度 ≥ 4.5:1、无 `animation`/`transition`；切换 4 档字号时提示字号随之变化；状态始终“正在听”，`#notice` 未出现“翻译已中断”；第 5、6 句为中文定稿；定稿条目数 = 6、顺序一致；主页面与小窗时间线逐条一致（内容与 `data-kind`） |
| 临时译文非中文（两种输入） | IQA-306；AC-12 | 长句素材（≥ 8 s）；在该句已显示过中文临时译文后的下一个 `partial` 请求返回谚文。判定：谚文从未出现；其间文本保持上一条；该句无 `retranslate:true` 请求、无提示；该句最终中文定稿 |
| 停止发生在重译期间 | IQA-312；AC-4、AC-11 | 第 1 句首次定稿返回谚文，重译请求延迟 20 s；在重译完成前点“停止”，观察 30 s：该句文本不再变化、等于停止时的临时译文，不出现定稿、提示或非中文 |
| 小窗与主页面（真实素材） | IQA-307；AC-6 | 韩语素材第 1 次运行时打开小窗，比对两份时间线 |
| 既有用例 | IQA-311；AC-11 | 第 1、2 版全部 e2e 原样保留；只调整依赖“定稿逐片出现”的时序断言（若有）为“判定后一次出现”，不放宽任何判定 |

执行与资源：`workers: 1`、`retries: 0` 不变；新增用例约 6 次 ×（素材约 40 s + 启动）加受控用例，`npm run test:e2e` 增加约 8～10 分钟。

### 测试素材

韩语、日语素材按 TD-313 由同一 `speech` 资源 TTS 合成并缓存到仓库外临时目录；只含合成对白，非客户内容。独立测试脚本自行合成（可用同一资源 TTS 或其它本地 TTS），不依赖仓库文件。

## 快速验证指南（Quickstart）

开发者命令在本 Feature 目录 `runtime/deployment.json` 中声明（技术方案拥有，与第 2 版相同）：

```bash
npm ci                               # developerSetupCommands
npm run lint && npm run typecheck    # staticAnalysis
npm run build                        # build
npm test                             # developerTests：单元测试
npm run test:integration             # integrationTests：真实 dev 实例
npm run test:e2e                     # functionalTests：build + xvfb-run headed Chromium
```

本地手动验证（Agent Pod 已注入 `dev` 实例的 `AIDH_DEP_*`）：

1. `npm run build && node dist/server/main.js`；浏览器打开 `http://localhost:8080`，选“系统声音”，在另一标签页播放韩语视频并共享该标签页：字幕只出现中文；临时字幕整段更新，定稿在句末后整段替换。
2. 中止误报：`curl -sN -X POST -H 'Origin: http://localhost:8080' -H 'content-type: application/json' localhost:8080/api/translations -d '{"kind":"final","text":"Good morning everyone, welcome to the meeting."}' --max-time 0.2`（首个片段前中止）→ 服务日志只有一条 `"errorCode":"client_aborted"` 的 info 记录，没有 `"level":"error"`。
3. 重译接口：同上请求体加 `"retranslate":true` → 正常返回；`"kind":"partial","retranslate":true` → 400 `invalid_request`。

## 支持 Runbook

第 1、2 版 Runbook 全部适用，新增：

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| 字幕中出现“（此句未能翻译成中文）” | 同一时段 `translation_completed` 中 `retranslate=true` 的条数与 `sourceLanguage` 分布 | 偶发属预期兜底；某语言持续大量出现时，记录 `sourceLanguage` 与时段，作为提示词或模型调整的依据（另开交付） |
| 告警 `app-error-or-fatal` 再次出现 `unhandled_error` | 看 `msg`：`unhandled error`/`translation failed unexpectedly` 为真正异常（本次修复后中止不会再产生）；`errorClass` 指示异常类型 | 按真正缺陷处理；若同一 `reqId` 也有 `client_aborted`，说明出现了新的中止形态，报告产品缺陷并附 `errorClass` |
| 日志出现 warn `unhandled rejection after client abort` | 进程级出现了未在请求内处理的中止类拒绝（防御路径） | 不影响服务；记录频率，作为代码改进线索 |
| 句末后定稿出现得比以前稍晚 | 预期：定稿需整段收齐并判定（意图已接受） | 无需处理 |

## 依赖声明摘要

完整声明见 `docs/dependencies.json`。本版只更新 `speech` 的 `purpose` 与 `TTS_HOST` 字段用途文字（测试素材增加韩语、日语合成）；约束、接入字段、探测脚本、IaC、推荐形态与“沿用已绑定实例”的建议均不变。

| 依赖 | 推荐 | 约束（探测逐条报告） | 本交付用途 |
| --- | --- | --- | --- |
| `speech` | 沿用已绑定的 dev / test 实例（声明形态仍为 `cloud`，IaC 仅在需要重建时使用） | `realtime-streaming-stt`、`language-auto-detection` | 两种输入的实时识别 + 连续语言识别（不变）；测试素材合成（英语，新增韩语 `ko-KR-SunHiNeural`、日语 `ja-JP-NanamiNeural`） |
| `chat-model` | 沿用已绑定的 dev / test 实例（`gpt-5.1` 部署） | `reasoning-disabled` | 流式中文翻译（提示词收紧、重译说明，调用方式与参数不变） |

## 决策记录与开放决策

1. 沿用的已生效决定：技术基线（第 1 版 TD-001）；依赖认证方式（推荐 `platform-identity`）；不登录、仅部署测试环境；DD-101、PQ-005（验收证据范围）。本版不改变这些决定。
2. 计划（S2）提出的两项技术选择，本方案的决定：① 受控触发不在生产代码中加测试开关——AC-4/AC-5/AC-12 用浏览器内 `fetch` 包装（TD-310，未采用计划推荐中的 Playwright 响应拦截，原因是第 2 版实测其会破坏小窗样式载入），AC-9 用构造依赖注入异常（TD-311）；② 中文判定放在客户端字幕状态机，服务端按根因修正提示词与语言标注、不新增日志内容（TD-304～TD-308；唯一新增的布尔字段 `retranslate` 见 TD-312）。
3. **D-301 · IQA-310（AC-9）在独立测试中的证据方式（待人决定，技术类）**：已部署候选无法从外部触发“非客户端中止的未预期异常”，除非在生产代码中加入可被外部触发的故障注入入口。
   - 推荐：生产代码不加入口；AC-9 以候选验证中执行的 `translationFailure.int.test.ts`（Runner 在不可变候选提交上运行，平台证据）为证据，独立测试将 IQA-310 按测试缺口处理（结果写 `unverifiable` 并注明本决定），其余场景照常验证。
   - 备选 A：新增应用机密（例如 `FAULT_INJECTION_TOKEN`，只为 test 环境提供），服务端在该机密存在且请求头携带相同值时于翻译任务中抛出一次异常；独立测试即可在已部署候选上验证 IQA-310。代价：生产代码多一条受机密保护的故障路径、依赖声明新增应用机密、需要人在项目机密中提供该值，并需确认平台会把应用机密注入候选部署的容器。
   - 备选 B：同备选 A，但用环境变量开关（候选部署无法按服务设置环境变量，实际不可行，不推荐）。
   - 对方案的影响：选推荐时本方案无需修改；选备选 A 时补充 TD、依赖声明 `secrets` 与安全分析，Coding 第 1 批增加该入口。
4. 当前没有待人决定的业务事项。
