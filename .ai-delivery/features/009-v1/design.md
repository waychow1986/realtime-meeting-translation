# 导出本次字幕 技术方案

> 依据：意图第 2 版（G1 已确认，含 Q1、Q2、R1、R2、R3 的人工答案）、规格 `spec.md`（FR-001～FR-019、假设 A-1～A-9）、系统现状 `.ai-delivery/system-current.md`（下文写作“现状 §n”）、仓库代码，以及人对本方案上一版 D-1、D-2 的回答（均选 A）。本次没有 `g2Decisions`。
> 只写本次改什么；现有模块、接口、部署与约定以系统现状为准。决策编号 TD-9xx；实验编号 E-n（命令与观察结果只写在“快速验证指南”）。
> **D-1、D-2 已由人决定（均为 A，见“开放决策”）**：D-1——保持页面顺序，被拖慢的那一句写成它后面各条中最早的定稿时刻，其余各条等于各自的定稿时刻（TD-903、TD-911）；D-2——按钮与不可用原因说明并排放在字幕区顶部的一条工具条中，顶栏完全不变（TD-905、TD-912）。D-2 的决定取代规格假设 A-2（“放在顶栏”）；A-1（说明在按钮旁边）照旧满足。本方案没有其他待人决定的事项。

## 技术上下文（Technical Context）

### 不确定项与结论

| # | 不确定项（会改变的决定） | 结论 | 证据 |
| --- | --- | --- | --- |
| U-1 | 在顶栏加入“导出字幕”按钮与不可用原因文字后，现有已验收的顶栏约束（1366 px 宽 1 行、约 480 px 宽最多 2 行，`tests/e2e/topbar.spec.ts`）是否仍满足（决定按钮与说明放在哪里，TD-905） | 只加按钮（不带说明）：1920/1366/1280 宽 1 行，480 宽 2 行，满足；按钮高度与其他控件相同（36 / 34 px）。加按钮和说明（A-1 的全文或缩短为“还没有可导出的字幕”）：1366 宽变为 2～3 行，480 宽变为 3～4 行，**不满足**。说明放在字幕区上方的工具条里（按钮与说明并排）时，顶栏行数不变，工具条高 53 px（480 宽折成 2 行时 77 px） | 实验 E-1 |
| U-2 | 页面现有 CSP（`default-src 'self'`、`form-action 'none'` 等，现状 §6）下，用 `Blob` + `URL.createObjectURL` + `<a download>` 触发下载是否可行；这种下载是否会产生 Playwright / CDP 可见的网络请求（决定下载做法 TD-904，以及 AC-7“不发出任何网络请求”的测法） | 可行：Chromium 触发下载、`download.failure()` 为 null；中文文件名 `字幕-20261125-160210.txt` 原样保留；文件内容为 UTF-8、无 BOM，含中文与 4 字节字符逐字节正确；点击到下载完成期间 Playwright `context.on('request')` 与 CDP `Network.requestWillBeSent` 都是 0 条；点击后同一任务内 `setTimeout(0)` 撤销 URL 不影响下载 | 实验 E-2 |
| U-3 | 中文定稿字幕的“页面顺序”和“成为定稿的先后”是否可能不同（决定导出时刻怎样同时满足 AC-2 的页面顺序与 AC-3 的“时刻等于定稿时刻、不倒序”） | **可能不同**。字幕条目在开始识别一句时按顺序追加到列表末尾（`createSegment` → `view.append`），但每句的定稿翻译各自独立异步进行（`handleRecognized` 中 `void this.finalize(seg)`，句与句之间没有先后约束）；一句遇到可重试错误时要等 1 秒（最多 2 秒）再请求一次（`translateWithRetry`），译文不是中文时还要整句重译一次（`finalize` 中 `retranslate`）。这期间下一句如果已经说完并很快译完，就会先成为定稿。此时按页面顺序列出的时刻会倒序，AC-2 与 AC-3 无法同时严格满足；人已决定按 D-1 选项 A 处理（TD-911） | `src/web/captionPipeline.ts`：`createSegment`、`handleRecognized`、`translateWithRetry`（`RETRY_DELAY_MS = 1000`、`MAX_RETRY_AFTER_MS = 2000`）、`finalize`；现有端到端受控触发 `tests/e2e/translationOverride.ts` 已支持把第 n 句的定稿请求延迟 `delayMs`（`action: 'delay'`），可以稳定复现这种情况 |
| U-4 | 端到端测试能否用 Playwright `page.clock` 固定页面时间来构造“出现时刻”（决定时间怎样控制，见“可测性约定”） | 不能用固定时间：临时译文节流按 `now()` 计算等待时间（`maybeSendPartial`：`wait = lastPartialAt + 500 − now()`），时间固定后 `wait` 永远等于 500，临时译文请求会被一直推迟。因此端到端用真实时钟，测试在页面内记录每条字幕变为定稿的时刻来对照；跨午夜等时刻相关的规则用单元测试注入时钟验证 | `src/web/captionPipeline.ts` `maybeSendPartial`（项目代码已写明，不另做实验） |

### 已由文档或代码写明、直接引用的事实

- 字幕区里中文定稿字幕、临时字幕、被中断字幕与“（此句未能翻译成中文）”提示的区分：`li.caption` 的 `data-status`（`interim`/`finalizing`/`final`/`interrupted`）与 `data-kind="notice"`；未能翻译的提示是先 `setNotice` 再 `setStatus(final)`（`src/web/captionView.ts`、`src/web/captionPipeline.ts` `finalize`；现状 §7.1、§8.4）。
- 中文定稿字幕的文字在 `finalize` 中经 `show(seg, text)` 写入，且只有通过 `isChineseTranslation` 的文字才会写入（`src/web/captionPipeline.ts` `show`）；定稿后的条目不会再被删除（只有非定稿条目会走 `dropSegment` → `view.remove`）。
- 定稿翻译失败的句子会被整条删除（`dropSegment`），不会留在页面上（`src/web/captionPipeline.ts` `finalize`）。
- 字幕区之外的提示（出错、共享结束等）写在 `#notice`，不进入字幕列表（`src/web/main.ts` `showNotice`）。
- 字幕小窗打开时只复制 `#captions` 的子元素，之后经 `MirroredCaptionView` 同步（`src/web/pip.ts`、`src/web/mirroredCaptionView.ts`）；字幕区里 `#captions` 之外的元素不会出现在小窗中。
- `.caption` 使用 `white-space: pre-wrap`（`src/web/styles.css`），所以字幕文字里如果有换行，页面上会显示为换行。
- Playwright 下载 API：`page.waitForEvent('download')`、`download.path()`、`download.suggestedFilename()`；浏览器上下文默认接受下载（Playwright 官方文档 *Downloads*）。

## 治理与技术约束

| 约束 | 出处 | 设计响应 |
| --- | --- | --- |
| 保持已批准的业务意图和范围；优先最简单架构 | 宪章“产品与架构” | 只改浏览器端：一个记录器、一个纯函数格式化、一个下载函数和页面装配；服务端、接口、依赖、部署形态都不变 |
| 绝不记录 secret 或客户内容 | 宪章“安全与隐私” | 字幕只在页面内存中；导出不发请求、不写任何浏览器存储、不输出到控制台（TD-904、TD-908） |
| 每项用户可见能力都有可独立执行的验收场景；外部集成用真实测试服务 | 宪章“测试与质量” | 端到端走真实依赖实例产生定稿字幕后导出（沿用现有 e2e 夹具）；故障只用现有初始化脚本注入（`translationOverride.ts`），不用 mock 替代 |
| 字幕写入只经唯一的 `CaptionPipeline` → `CaptionView`；主页面与小窗经 `MirroredCaptionView` 同步 | 现状 §12 | 新增的记录器同样实现 `CaptionView` 接口，套在 `MirroredCaptionView` 外层；`CaptionPipeline` 不改（TD-901） |
| 文案集中在 `messages.ts` 与 `index.html`；样式只写在 `styles.css`；CSP `style-src 'self'`（不能用内联 `style` 属性） | 现状 §6、§12 | 按钮名与原因说明写在 `index.html`；样式写在 `styles.css`，用 `hidden` 属性切换显示 |
| 生产代码中没有测试开关 | 现状 §11 | 不新增测试专用端点或开关；时间注入只用于单元测试的构造参数 |
| 顶栏 1366 px 宽 1 行、约 480 px 宽最多 2 行（已验收，`tests/e2e/topbar.spec.ts`） | 现状 §11 | 按钮与原因说明都不放进顶栏，放在字幕区顶部工具条（E-1、D-2 已决定 A，TD-912）；`topbar.spec.ts` 不改，原样回归 |
| 不改变现有开始、停止、字号、行距、小窗、引导的行为 | 意图“不做 8”、规格 FR-016 | `CaptionPipeline`、`DomCaptionView`、`MirroredCaptionView`、`pip.ts`、`preferences.ts` 都不改 |
| 不修改既有 CI、部署脚本与基础设施定义 | 平台边界 | `Dockerfile`、`infra/`、`docs/dependencies.json` 与探测脚本不变；`docs/deployment.json` 只更新服务描述文字 |

## 架构概览（Architecture）

只改浏览器端，服务端与接口不变。

```
CaptionPipeline ──CaptionView──▶ CaptionTranscript（新，记录中文定稿字幕与定稿时刻）
                                     │ 转发全部调用
                                     ▼
                                MirroredCaptionView ─▶ DomCaptionView（主页面 #captions）
                                                    └▶ 字幕小窗（不变）
CaptionTranscript.onChange ──▶ main.ts：更新“导出字幕”按钮 disabled 与原因说明 hidden
“导出字幕”点击 ──▶ main.ts：transcript.entries() → formatExport(entries, new Date()) → exportFileName(now)
                                 → downloadText(document, 文件名, 文本)（Blob + <a download>，不发请求）
```

## 技术决策与替代方案

| 决策 ID | 选择 | 理由 | 已考虑替代方案 | 证据 | 来源 |
|---|---|---|---|---|---|
| TD-901 | 新增 `CaptionTranscript`（`src/web/captionTranscript.ts`），实现 `CaptionView` 并包住 `MirroredCaptionView`：每个调用先原样转发，再记录：`setText` 记下该条最新文字；`setNotice` 把该条标为提示；`setStatus(id, 'final')` 时，若该条不是提示且文字非空，追加一条 `{ id, text, finalizedAt: now() }` 并通知监听者；`remove` 丢弃该条未定稿的记录。`main.ts` 把 `CaptionPipeline` 的 `view` 改为它 | 字幕写入只有 `CaptionView` 这一个口子（现状 §12），在这里记录不改 `CaptionPipeline`；记录的文字就是写进页面的同一个字符串，保证 AC-2 逐字一致；定稿时刻在页面变为定稿的同一个同步调用中取得（AC-3/R3）；不依赖 DOM，可以在 Node 环境单元测试 | ① 在 `CaptionPipeline.finalize` 中加回调：要改核心状态机，且提示与正常定稿的区分要重写一遍；② 导出时从 DOM 读取 `li.caption[data-status=final]:not([data-kind=notice])`，时刻另存：文字可以直接取，但时刻仍要在视图层记录，两处来源更易不一致；③ 在 `DomCaptionView` 上加 `data-final-at` 属性：会被复制进字幕小窗，且把时刻写进页面结构没有必要 | `src/web/captionPipeline.ts`（`CaptionView` 接口、`finalize`、`show`）、`src/web/main.ts` | FR-008、FR-009、FR-010、FR-012 |
| TD-902 | 记录器只保存“中文定稿字幕”：经 `setNotice` 标记过的条目（“（此句未能翻译成中文）”）不记录；未定稿就被删除的条目不记录；被中断（`interrupted`）的条目永远不会收到 `final`，自然不记录。识别原文从不经过 `CaptionView`，记录器拿不到 | 正好对应规格“中文定稿字幕”的定义与 FR-010 的排除项；`final` 且不是提示的条目，其文字一定经过 `isChineseTranslation` | 按文字内容判断（如比较 `UNTRANSLATED_NOTICE`）：脆弱，且其他提示文字将来可能变化 | `src/web/captionPipeline.ts` `show`、`finalize`、`beginRun`；`src/web/captionView.ts` `setNotice` | FR-010、Q2 |
| TD-903 | 导出文本由纯函数 `formatExport(entries, exportedAt)` 生成（`src/web/exportText.ts`）：第 1 行 `导出日期：YYYY-MM-DD`（导出时刻的本地日期），第 2 行空行，之后按页面顺序每条一行 `HH:MM:SS 字幕文字`（本地时钟，24 小时制，两位数，不足一秒舍去，用 `Date` 的本地 getter 计算），行尾 `\n`，最后一行之后也有 `\n`；字幕文字中如含换行（`\r\n`、`\r`、`\n`、U+2028、U+2029），每处换成 1 个空格；页面顺序 = 条目 `id` 升序；每行写的时刻按 TD-911 计算（通常就是该条的定稿时刻）。文件名由 `exportFileName(exportedAt)` 生成：`字幕-YYYYMMDD-HHMMSS.txt` | 格式按规格 FR-011、A-3、A-4、A-5；`id` 由 `CaptionPipeline.createSegment` 递增分配并同时 `append` 到列表末尾，所以 `id` 顺序就是页面顺序；规格 A-8 要求一条字幕占一行，模型输出偶尔带换行时页面按 `pre-wrap` 折行显示，导出时换成空格才能保持“一条一行”；行尾用 `\n`：Windows 10 1809 起的记事本、macOS 文本编辑都能正确显示，测试按 `/\r?\n/` 拆分即可 | 用 `toLocaleTimeString`：格式随浏览器语言变化，不保证两位数与 24 小时制；用 `\r\n`：没有需求依据；加 UTF-8 BOM：规格 A-3 要求文件中没有其他内容 | 规格 FR-011～FR-014、A-3～A-5、A-8；`src/web/captionPipeline.ts` `createSegment`；`src/web/styles.css` `.caption` | FR-011、FR-012、FR-013、FR-014 |
| TD-904 | 下载用 `downloadText(doc, fileName, text)`（`src/web/download.ts`）：`new Blob([text], { type: 'text/plain;charset=utf-8' })` → `URL.createObjectURL` → 临时创建 `<a download=文件名>`，`click()` 后移除 → `setTimeout(() => URL.revokeObjectURL(url), 0)`。不发任何请求，不写任何存储 | 在现有 CSP 下可行，下载期间没有任何网络请求，文件为 UTF-8 且文件名原样保留（E-2）；Blob 在撤销后由浏览器回收，页面之外的副本只有用户下载的文件（FR-017～FR-019） | ① `data:` URL：大文本时 URL 过长，且需要额外编码；② 由服务端生成文件：违反 FR-017/AC-7；③ File System Access API `showSaveFilePicker`：会弹出保存对话框，规格 A-7 要求直接触发下载 | 实验 E-2 | FR-007、FR-013、FR-014、FR-017 |
| TD-905 | “导出字幕”是原生 `<button type="button" id="export-button">`，不可用时设置 `disabled`；原因说明是 `<p id="export-hint" role="note">`，文字取规格 A-1 默认值“还没有可导出的字幕。出现中文定稿字幕后即可导出。”，按钮以 `aria-describedby="export-hint"` 关联它；可用时说明设 `hidden`。初始 HTML 中按钮即为 `disabled`、说明可见，脚本未运行前状态也正确。二者并排放在字幕区顶部的工具条中（位置与布局见 TD-912） | 沿用现有“不可用 + 旁边一段说明”的写法（`#pip-button` + `#pip-unsupported role="note"`，现状 §8.5）；原生 `disabled` 时点击不触发任何处理，满足“点击不会下载文件”；`aria-describedby` 让读屏用户在按钮上就能听到原因 | 用 `aria-disabled` 保留焦点：与项目其他不可用按钮的写法不一致；原因说明用提示气泡（`title`）：不是“页面上显示一段文字”（AC-6） | 实验 E-1；`src/web/index.html`（`pip-control`） | FR-001、FR-002、FR-004～FR-006、AC-6 |
| TD-906 | 可用性只看记录器条数：`main.ts` 订阅 `transcript.onChange`，`exportButton.disabled = transcript.count() === 0`，`exportHint.hidden = transcript.count() > 0`；与页面状态（`setState`）无关，不改 `controlsFor` | 规格 FR-002 明确“只取决于是否已有中文定稿字幕，与状态无关”；记录器在第 1 条定稿出现的同一调用中通知，满足 FR-003 的“随即” | 把导出放进 `controlsFor(state)`：会把可用性错误地绑在状态上 | 规格 FR-002、FR-003、A-6 | FR-002、FR-003、FR-006 |
| TD-907 | 定稿时刻用 `Date.now()`（构造参数 `now` 可注入，默认 `Date.now`）；导出日期与文件名用点击时的 `new Date()`（`main.ts` 中取一次，同时用于两者） | 规格要求“用户电脑本地时间”，浏览器 `Date` 即用户电脑时钟；可注入时钟让单元测试覆盖跨秒、跨午夜与倒序 | 用 `performance.now()`：是单调时间，不是时钟时间 | 规格 FR-011、FR-012、A-4 | FR-011、FR-012 |
| TD-908 | 记录器只在页面内存中（模块内数组），不写 `localStorage`/`sessionStorage`/IndexedDB，不在 `console` 输出文字；刷新或关闭页面时随页面消失；导出不清空记录 | 范围 5、FR-015、FR-018、FR-019；现状 §9.2 浏览器端只输出错误名 | — | 规格 FR-015、FR-018、FR-019 | FR-015、FR-018、FR-019 |
| TD-909 | 字幕小窗不变：工具条不在 `#captions` 内，不会被复制进小窗；`pip.ts` 不改 | FR-001、意图“不做 7”；小窗只复制 `#captions` 的子元素 | — | `src/web/pip.ts` | FR-001、FR-016 |
| TD-911 | （D-1 已决定 A）`formatExport` 在按 `id` 升序排好条目后，从最后一条往前计算每行写出的时刻：`shown[last] = finalizedAt[last]`，`shown[i] = min(finalizedAt[i], shown[i+1])`（毫秒级比较，之后再按本地时钟舍去到秒）。效果：页面顺序不变；没有被越过的条目，`shown` 等于自己的定稿时刻；被拖慢、晚于后面某条才定稿的那一句，写成它后面各条中最早的定稿时刻；整列时刻不倒序（毫秒不倒序，舍去到秒后同样不倒序）。导出时尚未定稿的句子不在记录器里，不参与计算；它之后定稿，下次导出时才出现并按同一规则计算。记录器保存的 `finalizedAt` 不改，只在生成文本时计算 | 人对 D-1 的回答；同时满足 AC-2（页面顺序、逐字相同）与 AC-3（不倒序），并让 R3 的“接近出现时刻”只在被拖慢的那一行上放宽为“不晚于自己的定稿时刻，且等于后面各条中最早的定稿时刻” | D-1 的 B（从前往后取较大值）、C（按定稿时刻排序）、D（改用说完的时刻）：人已选 A | U-3；人对 D-1 的回答 | FR-011、FR-012、AC-2、AC-3 |
| TD-912 | （D-2 已决定 A）在 `#caption-panel` 内、`#caption-scroll` 之前新增 `<div class="caption-toolbar">`，内含 `#export-button` 与 `#export-hint`（按钮在前、说明紧随其后，同一行；窄于 640 px 时允许折成两行）。`#caption-panel` 改为两行网格：`grid-template-rows: auto minmax(0, 1fr)`；`.caption-scroll` 从绝对定位改为占第 2 行（`position: relative; min-height: 0; overflow-y: auto`），仍是字幕区唯一的滚动容器，id 不变；`#jump-latest` 仍相对字幕区绝对定位在底部。工具条背景用 `--caption-bg`，按钮沿用顶栏按钮的高度、圆角与字号变量，说明文字字号不大于顶栏控件字号、颜色在深色背景上对比度 ≥ 4.5。工具条不在 `#captions` 内，不会被复制进字幕小窗；顶栏 `index.html`、样式与 `topbar.spec.ts` 都不改 | 人对 D-2 的回答；E-1 证实这种放法顶栏行数不变、页面无横向滚动；网格的 `minmax(0, 1fr)` 让字幕内容增多时只在 `#caption-scroll` 内滚动、不撑高页面，与现在绝对定位的效果相同（`styles.css` 中 `.caption-scroll` 注释说明的目的）；字号与对比度要求是为了不破坏现有已验收的字幕区用例（`tests/e2e/ui.spec.ts` IQA-119 要求定稿字幕字号大于页面上其他任何文字、IQA-121 检查无横向滚动与控件不重叠） | 保留 `.caption-scroll` 绝对定位、改 `top` 为工具条高度：工具条高度随宽度变化（53 / 77 px），要么写死、要么用脚本测量，不如网格稳妥；D-2 的 B、C：人已选 A | 实验 E-1；人对 D-2 的回答；`src/web/index.html`、`src/web/styles.css`（`.caption-panel`、`.caption-scroll`、`.jump-latest`）；`tests/e2e/ui.ts`、`tests/e2e/ui.spec.ts` | FR-001、FR-004、FR-016、AC-6 |
| TD-910 | `docs/deployment.json` 只在服务描述中加一句“可把本次中文定稿字幕导出为本地文本文件（在浏览器内生成，不经服务器）”；服务、端口、健康检查与 `errorLogRules` 不变；`docs/dependencies.json` 不变 | 服务端代码与日志都不变，现有错误日志规则仍然适用；没有新的外部依赖 | — | `docs/deployment.json`、`docs/dependencies.json`；现状 §5、§10 | — |

## 技术先后依赖

- `src/web/index.html` 中的工具条与其中的 `#export-button`、`#export-hint`（TD-912）必须先于 `main.ts` 的装配存在，因为 `main.ts` 以 `requireElement` 按 id 取这两个元素，缺失时页面初始化直接抛错，所有现有端到端用例都会失败。
- `styles.css` 中 `#caption-panel` 改为网格与 `.caption-scroll` 改为非绝对定位必须与工具条元素同时生效，因为只加工具条而 `.caption-scroll` 仍为 `inset: 0` 绝对定位时，滚动层会盖住工具条（E-1 中观察到），按钮无法点击。
- `formatExport` 依赖 `TranscriptEntry` 的结构（`id`、`text`、`finalizedAt`），因为 TD-911 按 `id` 排序并按 `finalizedAt` 计算时刻。
- `CaptionTranscript` 必须先于 `main.ts` 中“把 `CaptionPipeline` 的 `view` 换成记录器”的改动，因为后者依赖它的构造参数与 `onChange`。
- 端到端用例依赖按钮的无障碍名称“导出字幕”、`#export-hint` 的文字与导出文件格式（TD-903、TD-905），这些先定下来，用例才能断言。

## 领域与数据模型

只有页面内存中的数据，不新增持久化。

```ts
/** 一条中文定稿字幕（src/web/captionTranscript.ts）。 */
export interface TranscriptEntry {
  /** 与字幕段 id、DOM data-segment-id 相同；升序即页面顺序。 */
  id: number;
  /** 写进页面的同一个字符串。 */
  text: string;
  /** 页面上变为定稿的时刻（Date.now() 毫秒）。 */
  finalizedAt: number;
}
```

- 记录器内部另有 `Map<number, { text: string; notice: boolean }>` 暂存未定稿条目的最新文字，条目定稿或被删除后从中移除。
- 不变量：`entries()` 按 `id` 升序；每个 `id` 至多一条；条目一经记录不再改变（定稿后的条目不会再被 `setText`，见 `CaptionPipeline.show` 对 `final` 的判断）。

## Component 边界与项目结构

编码会创建或修改的路径：

- `src/web/captionTranscript.ts`（新增）：`CaptionTranscript`（TD-901、TD-902、TD-907、TD-908）。
- `src/web/exportText.ts`（新增）：`formatExport`、`exportFileName`（纯函数，TD-903、TD-911）。
- `src/web/download.ts`（新增）：`downloadText`（TD-904）。
- `src/web/main.ts`（修改）：创建 `CaptionTranscript` 并作为 `CaptionPipeline` 的 `view`；取 `#export-button`、`#export-hint`；订阅 `onChange` 更新可用性（TD-906）；点击时导出（TD-907）。
- `src/web/index.html`（修改）：`#caption-panel` 内新增工具条与按钮、原因说明（TD-905、TD-912）。
- `src/web/styles.css`（修改）：工具条、按钮与说明的样式；字幕区改为两行网格（TD-912）。
- `tests/unit/captionTranscript.test.ts`、`tests/unit/exportText.test.ts`（新增）。
- `tests/e2e/exportCaptions.spec.ts`（新增）：导出的端到端用例（由测试计划与编码按计划编写）。
- `tests/e2e/fixtures.ts`（修改，可选）：增加 `exportButton(page)` 之类的辅助函数。
- `docs/deployment.json`（修改）：只改服务描述（TD-910）。
- `README.md`（修改）：在功能说明中补一句导出字幕的用法与“不经服务器、不在浏览器保存”。

不改：`src/server/**`、`src/shared/**`、`src/web/captionPipeline.ts`、`captionView.ts`、`mirroredCaptionView.ts`、`pip.ts`、`preferences.ts`、`uiState.ts`、`messages.ts`（新文案只在 `index.html`）、`Dockerfile`、`infra/**`、`docs/dependencies.json`、`tests/e2e/topbar.spec.ts`、`tests/e2e/ui.spec.ts`、`tests/e2e/ui.ts`（现有用例原样回归，不为本次放宽）。

## 数据流、状态、并发与生命周期

- **记录**：`CaptionPipeline` 在 `finalize` 中同步调用 `view.setText(id, 中文)` → `view.setStatus(id, 'final')`；`CaptionTranscript` 依次转发给 `MirroredCaptionView`（主页面先写，再写小窗），然后记录并通知。因此在通知时主页面该条已经显示为定稿；按钮状态的更新与字幕变为定稿在同一个任务中完成。
- **导出**：点击时同步执行：取 `const at = new Date()` → `formatExport(transcript.entries(), at)` → `downloadText(document, exportFileName(at), text)`。在导出与下一条定稿之间没有并发问题（浏览器主线程单线程），导出内容即“点击时页面上的全部中文定稿字幕”（FR-008）。正在显示的临时字幕不在记录器里，不会写入（FR-010）。
- **状态无关**：导出不读写 `state`、`run`，不调用 `stopRun`、`beginRun`，不改变 `#notice`；正在听时导出，识别与翻译照常继续（FR-016）。
- **多轮开始/停止**：`beginRun` 不清空页面字幕，也不重置记录器；记录器的生命周期就是这次页面（FR-008、意图假设 1）。
- **刷新 / 关闭**：页面卸载后记录器随内存消失，重新加载时为空，按钮回到初始的不可用状态（FR-019）。
- **重复导出**：记录器不随导出清空，每次导出都是当时的全部条目（FR-015）。
- **布局约束（D-2 已决定 A，TD-912）**：字幕区 `#caption-panel` 改为两行网格（第 1 行工具条，第 2 行 `minmax(0, 1fr)` 放 `.caption-scroll`）；`.caption-scroll` 仍是字幕区里唯一的滚动容器，“回到最新字幕 ↓”仍定位在字幕区底部；工具条不随字幕滚动；工具条背景与字幕区相同（`--caption-bg`），按钮沿用顶栏按钮的高度与圆角，说明文字用浅色以保证在深色背景上可读；窄于 640 px 时工具条可以折成两行（E-1 中 77 px）。行距、字号只作用于 `.caption`，工具条不受影响。

## Interface 与契约（Contract）

- HTTP 接口、`src/shared/contracts.ts`、日志事件与字段都不变。
- 浏览器内模块接口（供编码与单元测试使用）：

```ts
// src/web/captionTranscript.ts
export class CaptionTranscript implements CaptionView {
  constructor(inner: CaptionView, now?: () => number);
  entries(): readonly TranscriptEntry[]; // id 升序的副本
  count(): number;
  onChange(listener: () => void): void;   // 每新增一条定稿记录调用一次
  // append / setText / setNotice / setStatus / remove：先转发 inner，再记录
}

// src/web/exportText.ts
export function formatExport(entries: readonly TranscriptEntry[], exportedAt: Date): string;
export function exportFileName(exportedAt: Date): string; // 字幕-YYYYMMDD-HHMMSS.txt

// src/web/download.ts
export function downloadText(doc: Document, fileName: string, text: string): void;
```

- 导出文件格式（规格 A-3；时刻按 TD-911）：

```
导出日期：2026-11-25

14:05:32 我们下午三点开始讨论预算。
14:05:40 下一项是人员安排。
```

- TD-911 的例子：页面顺序第 1～3 条的定稿时刻依次为 14:05:41（第 1 条重试被拖慢）、14:05:38、14:05:45，导出写作 `14:05:38`、`14:05:38`、`14:05:45`。

## 可测性约定

现状 §11 已有的约定（e2e 夹具、`INSTRUMENTATION` 字幕时间线、`translationOverride.ts` 受控触发、`workers: 1`、端口 `18180 + workerIndex`）沿用，不重写。本次新增或涉及的：

**关键控件（按无障碍角色与可见名称定位）**

| 控件 | 定位方式 | 说明 |
| --- | --- | --- |
| 导出字幕 | `page.getByRole('button', { name: '导出字幕', exact: true })` | 只在主页面；字幕小窗中查询同一角色与名称应为 0 个（FR-001）。不可用时为原生 `disabled`，可用 `toBeDisabled()` / `toBeEnabled()` 断言；不可用时要验证“点击不下载”，用 `click({ force: true })` 后确认在约 2 s 内没有 `download` 事件 |
| 不可用原因 | `page.getByText('还没有可导出的字幕。出现中文定稿字幕后即可导出。')`，或 `expect(button).toHaveAccessibleDescription(该文字)` | 角色 `note`（`#export-hint`）；可用后 `hidden`，读屏描述随之为空 |
| 中文定稿字幕（页面一侧的对照） | `#captions li.caption[data-status="final"]:not([data-kind="notice"])` 的 `textContent`，按 DOM 顺序 | 现有数据属性（现状 §7.1），不是新加的测试钩子 |

**导出文件的读取**：`const [download] = await Promise.all([page.waitForEvent('download'), button.click()])`；`download.suggestedFilename()` 应匹配 `/^字幕-\d{8}-\d{6}\.txt$/`；内容用 `fs.readFile(await download.path(), 'utf8')` 读取，按 `/\r?\n/` 拆行；第 1 行 `导出日期：YYYY-MM-DD`，第 2 行空，之后每行匹配 `/^(\d{2}):(\d{2}):(\d{2}) (.+)$/`，末尾空行忽略。

**出现时刻的对照（AC-3、R3）**：现有 `INSTRUMENTATION`（`tests/e2e/fixtures.ts`）在页面内记录字幕时间线，每项带 `at: Date.now()`、`index`、`status`、`kind`、`text`；取每条 `status === 'final' && kind === ''` 的首次出现时刻（按 `index` 即页面顺序排列），先按 TD-911 从后往前取较小值得到每行的期望时刻，再换成页面本地时钟的 `HH:MM:SS`，与导出行比较（没有被越过的条目，期望时刻就是它自己的定稿时刻）。记录器与时间线都在同一任务内取 `Date.now()`，相差远小于 1 秒，但可能正好跨过整秒，判定允许相差不超过 1 秒。时刻与“点击导出的时刻”区分：让第 1 条定稿与点击导出之间相隔至少 5 秒，再断言第 1 行时刻与导出时刻不同。页面时区与测试进程相同（同一台机器），换算时在 `page.evaluate` 中用 `new Date(at)` 的本地 getter，避免时区差异。

**时间与随机性**：端到端用真实时钟，不使用 `page.clock` 固定时间（U-4）。跨秒舍去、跨午夜（A-4，只写一次导出日期）、文件名格式、时刻倒序的处理（TD-911：单条被越过、连续多条被越过、毫秒倒序但同一秒、末条最早）用单元测试覆盖：`CaptionTranscript` 构造参数注入 `now`，`formatExport`/`exportFileName` 直接传入 `Date`。单元测试运行在 Node 环境，本地时间取决于进程时区；测试用本地时间构造 `new Date(2026, 10, 25, 23, 59, 59)` 一类的值，结果与时区无关。没有随机性。

**造数与清理**：没有需要造的数据，也没有需要清理的数据。字幕由真实识别与翻译产生（麦克风模式，现有 `single` / `meeting` 素材，`tests/support/tts.ts`）；每个用例使用新的浏览器上下文，页面关闭即清空。下载文件由 Playwright 放在临时目录，上下文关闭时删除。

**受控触发**（只用应用已有能力和现有初始化脚本，不加测试开关）：

- “出错”状态（AC-5、R2）：沿用现有做法让翻译连续失败，例如 `tests/e2e/translationOverride.ts` 或在页面初始化脚本中让 `/api/translations` 的定稿请求失败 3 次（`captionPipeline` 连续 3 句失败即结束运行，现状 §8.2），前提是在这之前已经出现至少 1 条中文定稿字幕；也可以用现有 `speechStall.ts` 让系统声音模式停滞。
- 不可导出的条目夹在中间（AC-4）：`translationOverride.ts` 的 `{ kind: 'final', sentence: n, attempt: 'first' | 'retranslate', action: 'hangul' }` 让第 n 句两次都返回韩文，页面出现“（此句未能翻译成中文）”提示；运行中点击“停止”时正在定稿的条目在下一次“开始”时变为被中断。
- 页面顺序与定稿先后不一致（D-1 / TD-911）：`translationOverride.ts` 的 `{ kind: 'final', sentence: 1, attempt: 'first', action: 'delay', delayMs: 8000 }` 让第 1 句晚于第 2 句定稿；判定：导出第 1、2 行顺序与页面相同，第 1 行时刻等于第 2 条（及其后各条中最早）的定稿时刻（允许相差 1 秒），早于第 1 条自己的定稿时刻，第 2 行起各行等于各自的定稿时刻，整列不倒序。

**无网络请求与无存储（AC-7）**：点击前注册 `page.context().on('request', …)`，从点击到 `download.path()` 完成，应收到 0 个请求（blob 下载不产生请求事件，E-2）；正在听时导出，同一时间段可能有翻译请求，此项断言在“已停止”时做，或只断言没有新的非 `/api/translations`、`/api/speech-token` 请求且没有请求体包含字幕文字。存储检查：`page.evaluate` 取出 `localStorage`、`sessionStorage` 的全部键值，以及 `indexedDB.databases()` 的结果（应为空数组），断言都不含任何一条导出字幕的文字。

**开发者命令与用时**（Feature 目录 `runtime/deployment.json`；用时为全量运行一次的大致时间）：

| 类别 | 命令 | 验证什么 | 全量用时 |
| --- | --- | --- | --- |
| （安装） | `npm ci` | 安装锁定依赖 | 约 30 s～1 分钟（估计，取决于缓存） |
| `staticAnalysis` | `npm run lint`、`npm run typecheck` | ESLint；服务端与浏览器两套 tsconfig 的类型检查 | 约 30 s（估计，沿用第 8 号设计） |
| `build` | `npm run build` | esbuild 生成 `dist/` | 约 5 s（估计，沿用第 8 号设计） |
| `developerTests` | `npm test` | 单元测试（Vitest，Node 环境，无外部调用），含本次的记录器、导出格式、文件名、倒序处理 | 约 10 s（本会话实测现有 18 个文件 5.3 s；本次新增 2 个文件） |
| `integrationTests` | `npm run test:integration` | 针对真实 `dev` 实例：语音令牌、流式识别、翻译、中止、中文判定、翻译失败（本次不改） | 约 3～5 分钟（估计，沿用第 8 号设计），6 个文件 12 个用例 |

端到端用例不写进部署声明。现有全部端到端约 50～60 分钟（估计，第 8 号设计）。单独运行一个用例：

```bash
npm run build
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test tests/e2e/exportCaptions.spec.ts -g "<用例名片段>"
```

本次导出用例预计约 7 个（估计）：不需要开始翻译的（初始不可用与原因说明、刷新后不可用）单个约 10～30 s；需要“正在听”并等到定稿字幕的（导出内容与时刻、已停止 / 正在听 / 出错时导出、不可导出条目、无请求与无存储、D-1 规则）单个约 1～1.5 分钟；整个文件约 7～9 分钟。

**并行与隔离**：沿用现有做法。端到端 `workers: 1` 串行；每个 worker 在 `18180 + workerIndex` 端口启动构建产物（应用可以在执行环境内的 `localhost` 启动，需要 `AIDH_DEP_*`）；每个用例新的浏览器上下文，下载目录、存储互不影响。集成测试在随机端口启动 `buildApp`。应用不在依赖实例中保存数据，与 `dev` 实例共用时只共享配额与并发连接数。

**布局回归**：工具条加入后，`tests/e2e/topbar.spec.ts`（顶栏行数）、`tests/e2e/ui.spec.ts` IQA-119（字幕字号大于其他文字、最新字幕可见、“回到最新字幕”）、IQA-121（各尺寸无横向滚动、控件不重叠）原样运行应通过；这些用例不需要改。新按钮的定位与可用性见上表。

**已知测试限制**：E-1 的布局测量只在 Linux 字体下做过；Windows / macOS 上顶栏与工具条的折行需要人工查看。下载行为只在 Chromium 下验证（项目支持的浏览器为 Chromium 系，现状 §3.3 `support.ts`）。

## 安全、隐私、身份与 Secret

- 导出完全在浏览器内完成：不新增接口，不发出任何请求（E-2），服务端看不到也不记录导出的内容（FR-017）。
- 字幕只在页面内存中（记录器与 DOM）；不写 `localStorage`、`sessionStorage`、IndexedDB，也不写 Cookie、Cache Storage（FR-018）；现有三个偏好键不变（现状 §7.2）。
- 导出文件是纯文本，`Blob` 类型 `text/plain;charset=utf-8`；文件名由固定格式与数字组成，不含用户内容；字幕文字不经 HTML 解析，不存在注入问题。
- 不在 `console` 输出字幕文字；导出失败（例如浏览器阻止下载）时不提示也不重试，由浏览器处理（规格“依赖”一节）。
- 身份、凭据、依赖与项目机密不变（`docs/dependencies.json` 的 `secrets` 仍为空）；CSP 与其他安全响应头不变。

## 配置、可观测性与运维

- 不新增环境变量、配置项与日志事件；服务端行为不变，`operations.errorLogRules` 沿用现有 3 条（`app-error-or-fatal`、`upstream-errors-burst`、`node-crash-output`），本次不会产生新的错误日志写法。
- 导出没有服务端可观测信号（这是 FR-017 的要求）；问题只能从用户反馈与端到端测试发现。

## SLO、限制、扩缩容、重试与恢复

- 规格没有导出时限、条数或文件大小要求。按每条约 60 字、一场 2 小时会议约 2000 条估算，文本约 0.5 MB，格式化与 Blob 生成在主线程同步完成，用时在毫秒级（估计）；不设上限。
- 导出不依赖网络与服务：服务端不可用、网络中断时仍可导出（规格“错误与恢复”）。
- 不重试：下载由浏览器处理；用户可以再次点击导出。

## 部署拓扑、迁移、Rollout 与 Rollback

- 部署形态不变：同一个 `web` 服务、同一 `Dockerfile`；变化只在构建产物 `dist/web/{index.html,app.js,styles.css}`。
- 无数据迁移、无配置变更、无依赖变更。
- 回滚：重新部署上一版镜像即可；页面上的字幕本来就不持久化，回滚不影响任何数据。静态文件 `Cache-Control: no-cache` + ETag（现状 §6），用户下次加载即得到新版或回滚后的页面。

## 验证环境责任矩阵（Verification Environment）

| 验证类型 | 责任阶段 | 环境来源 | 依赖/凭据 | Coding 证据 | 下游结果 |
|---|---|---|---|---|---|
| 静态检查、构建 | 编码（每批） | Agent Pod | 无 | `npm run lint`、`npm run typecheck`、`npm run build` 通过 | 平台按 `runtime/deployment.json` 复跑 |
| 单元测试 | 编码（每批） | Agent Pod | 无 | `npm test` 通过，含 `captionTranscript`、`exportText` 新用例 | 平台复跑 |
| 集成测试 | 编码（每批） | Agent Pod | 依赖 `dev` 实例（平台注入 `AIDH_DEP_*`） | `npm run test:integration` 通过（本次不改） | 平台复跑 |
| 端到端（导出用例） | 编码自测单独运行新用例；独立测试 | Agent Pod 内 `localhost` 构建产物 + 依赖 `dev` 实例；独立测试用测试环境 | 依赖实例（平台注入） | 新用例单独运行通过的输出 | 独立测试按测试计划在测试环境执行 |
| 布局回归 | 编码自测、独立测试 | 同上 | `topbar.spec.ts` 不需要；`ui.spec.ts` 需要依赖实例 | `tests/e2e/topbar.spec.ts`、`tests/e2e/ui.spec.ts` 单独运行通过 | 独立测试回归 |
| 人工查看 | G4/UAT | 测试环境 | — | — | Windows / macOS 字体下顶栏与工具条的折行；用记事本 / 文本编辑打开导出文件 |

## 快速验证指南（Quickstart）

实验在仓库外的临时目录进行（`git archive HEAD` 解出副本 → `npm ci` → `npm run build`），用一个只提供 `dist/web` 静态文件、带与 `src/server/http/app.ts` 相同 CSP 与安全头的小 Node 服务（端口 18080），以及一个在 `index.html` 副本中额外引入同源脚本 `exp.js`、样式 `exp.css` 的页面 `exp.html`。浏览器为 Playwright 1.65.1 自带的 Chromium（headed，`xvfb-run -a -s "-screen 0 1920x1080x24"`），字体为容器内的 Linux 字体。实验文件已删除，没有进入仓库。

### 实验 E-1：顶栏加入“导出字幕”与原因说明后的行数（约 3 分钟）

- 做法：`exp.js` 在 `.pip-control` 之后插入 `<div class="export-control"><button id="export-button">导出字幕</button><span id="export-hint">…</span></div>`（说明文字三种：不加 / “还没有可导出的字幕” / A-1 全文），或把同样的元素放进 `#caption-panel` 顶部；对每种做法在麦克风、系统声音两种输入下，按 1920/1366/1280/1100/640/480 宽测量。行数按 `topbar.spec.ts` 的 `TOPBAR_PROBE` 算法（各元素垂直中点相差 < 12 px 视为同一行），元素为原有 8 项加新按钮与说明。
- 观察（两种输入方式结果相同）：

| 做法 | 1920 | 1366 | 1280 | 480 | 按钮高度 |
| --- | --- | --- | --- | --- | --- |
| 顶栏只加按钮 | 1 行 | 1 行 | 1 行 | 2 行 | 36 px（480 宽 34 px），与其他控件相同 |
| 顶栏加按钮 + 短说明 | 1 行 | 2 行 | 2 行 | 3 行 | 同上 |
| 顶栏加按钮 + A-1 全文 | 1 行 | 3 行 | 3 行 | 4 行（原有 8 项也占 3 行） | 同上 |
| 按钮 + A-1 全文放在字幕区顶部工具条 | 顶栏 1 行 | 顶栏 1 行 | 顶栏 1 行 | 顶栏 2 行 | 工具条高 53 px，480 宽折成 2 行 77 px；页面无横向滚动 |

- 结论：原因说明放进顶栏会违反已验收的顶栏行数约束；按钮单独放进顶栏、或按钮与说明一起放进字幕区工具条都不影响顶栏。（实验中工具条与字幕区的滚动层重叠，是因为 `.caption-scroll` 为绝对定位，正式实现按“布局约束”把字幕区改为两行网格。）

### 实验 E-2：CSP 下的 Blob 下载与网络请求（约 2 分钟）

- 做法：同一页面中，按钮点击处理（同源脚本，受页面 CSP 约束）执行 TD-904 的做法，文本为 `导出日期：2026-11-25\n\n14:05:32 我们下午三点开始讨论预算。\n14:05:40 第二条😀字幕\n`，文件名 `字幕-20261125-160210.txt`。测试端：页面加载并 `networkidle` 后注册 `context.on('request')` 与 CDP `Network.requestWillBeSent`，`Promise.all([page.waitForEvent('download'), getByRole('button', { name: '导出字幕' }).click()])`，读取 `download.path()` 的字节。
- 观察：`suggestedFilename()` 为 `字幕-20261125-160210.txt`；`download.url()` 以 `blob:http://localhost:18080/` 开头；`failure()` 为 null；文件 105 字节，首字节不是 BOM，按 UTF-8 解码与原文完全相同（含 😀）；Playwright 请求事件 0 条、CDP 请求事件 0 条；控制台只有一条资源 404，出现在页面加载阶段（请求监听注册之后再无任何请求，可知它发生在点击之前），与导出无关；`localStorage` 只有原有的 `rtmt.guideSeen`，`sessionStorage` 为空。

### 编码后的快速自查

```bash
npm ci && npm run lint && npm run typecheck && npm run build && npm test
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test tests/e2e/exportCaptions.spec.ts tests/e2e/topbar.spec.ts tests/e2e/ui.spec.ts
```

预期：新用例与布局用例通过（`ui.spec.ts` 约 5～8 分钟，估计）；打开页面时字幕区顶部工具条中“导出字幕”不可用且旁边显示原因说明；开始翻译出现第 1 条白色定稿字幕后按钮可用、说明消失；点击后下载 `字幕-YYYYMMDD-HHMMSS.txt`，内容符合“Interface 与契约”中的格式。

## 支持 Runbook

- 用户反馈“导出字幕一直不可用”：确认页面上是否已有白色、末尾无“…”的定稿字幕；只有临时字幕、被中断字幕或“（此句未能翻译成中文）”时按设计不可用。刷新页面会清空字幕，无法找回。
- 用户反馈“点击后没有下载”：检查浏览器是否阻止了本站下载（Chrome / Edge 地址栏右侧的下载图标或站点设置中的“自动下载”）；导出不经服务器，服务端日志中不会有对应记录。
- 用户反馈“打开文件是乱码”：文件为 UTF-8 无 BOM；较旧的 Windows 记事本（1809 之前）可能按本地编码打开，请用新版记事本或其他编辑器以 UTF-8 打开。

## 开放决策

### 已由人决定的事项

**D-1（业务，已决定 A）：页面顺序与定稿先后不一致时，导出文件怎样写时刻？**

- 背景：见 U-3。每句的定稿翻译各自进行，某句重试（1～2 秒）或整句重译时，后面一句可能先成为定稿，按页面顺序（AC-2）列出的定稿时刻（AC-3、R3）会倒序。
- 决定：A——保持页面顺序；被拖慢的那一句写成它后面各条中最早的定稿时刻，其余各条仍等于各自的定稿时刻。落实为 TD-911。
- 未选：B（被越过的后面各条写成前一条的时刻）、C（按定稿时刻排序输出）、D（改用说完的时刻）。

**D-2（业务，已决定 A）：“导出字幕”按钮与“不可用原因”说明放在哪里？**

- 背景：见 U-1、实验 E-1。按钮与说明都放进顶栏会让顶栏在 1366 px 宽变成 3 行、约 480 px 宽变成 4 行，违反已验收的顶栏约束。
- 决定：A——按钮与不可用原因说明并排放在字幕区顶部的一条工具条中，顶栏完全不变。落实为 TD-905、TD-912。这一决定取代规格假设 A-2（按钮放在顶栏）；A-1（说明在按钮旁边）照旧满足。
- 未选：B（按钮在顶栏、说明在字幕区工具条）、C（都放顶栏并放宽顶栏约束）。

本方案没有新的需要人决定的事项。

### 待验证假设

无。U-1、U-2 已由实验 E-1、E-2 得出结论，U-3、U-4 由项目代码得出结论。

### 建议，未纳入，待 G2 决定

- 无本步骤新增的建议。规格已列出的 3 条建议（使用引导中加入导出说明、关闭或刷新前提醒导出、跨午夜标注日期变化）本方案没有纳入，由 G2 按规格处理；若 G2 决定纳入，前两条只涉及 `index.html` / `main.ts`（`beforeunload`），第 3 条只涉及 `formatExport`，都不改变本方案的结构。
