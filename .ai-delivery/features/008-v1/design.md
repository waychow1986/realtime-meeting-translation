# 字幕行距可调 技术方案

> 交付：DLV-20261124-CDD1D5B4A4A5（第 8 号 Feature）。依据：已确认意图第 2 版（含 Q1＝C：本次不做背景透明度；R1、R2 的人工答案）、规格 `spec.md`、项目宪章、仓库现状。本交付没有 `g2Decisions`。项目还没有 `.ai-delivery/system-current.md`，现状以仓库代码、`README.md` 与第 2、3、7 号 Feature 的设计为准。
>
> 本方案只涉及浏览器端（页面结构、样式、界面偏好、字幕小窗），不改服务端、接口、依赖与部署形态。
>
> **OD-1 已由人决定（选 A）**：实验 E-1 测得，把“行距”作为第三个分段按钮组直接放进顶栏，会破坏第 2 号交付已确认的顶栏布局要求（宽 1366 px 时顶栏一行、约 480 px 宽时最多两行）。人的答复：“采用 A：顶栏‘字号’位置换成‘字幕显示’按钮，浮层内放‘字号’和‘行距’两组；字号档位、默认值与本机保存行为不变；顶栏布局要求（宽屏一行、约 480 px 两行）保持不变；使用引导里‘调整字号’一条随之更新。理由：不放宽第 2 号交付已确认的布局要求，代价只是调字号多点一下。”本方案按此定稿（TD-806、TD-809），不再保留做法 B 的分支。

## 技术上下文（Technical Context）

### 不确定项

| 编号 | 不确定的技术事实 | 影响哪项决定 | 结论 | 证据 |
| --- | --- | --- | --- | --- |
| U-1 | 在现有顶栏中再加一个三档分段按钮组“行距 紧凑/标准/宽松”，是否仍满足第 2 号交付已确认的布局要求：宽 ≥ 1100 px 时控制区一行（现有测试在 1366/1440/1600/1920 px 宽断言 1 行），宽 ≤ 640 px（约 480 px）时控制区最多两行。现有样式与字体下的实际宽度，文档与代码都给不出 | 行距控件放在哪里、用什么形式（TD-806、OD-1） | **不满足**。现状（不加控件）在 1366 px 宽、状态“正在启动…”时控制区右侧只剩 37 px（不支持小窗、显示说明文字时 29 px）。加入分段按钮组（宽约 226 px）后：1366 px 为 2～3 行，1440 px 为 2 行，480 px 为 3 行。另外试了两种不改变控件位置的做法：① 把顶栏所有控件的内边距与间距收紧（`--control-pad` 16→10 px 等），1366 px 下勉强一行但只剩 1 px，不支持小窗时 2 行，480 px 仍为 3 行；② 改用下拉框（`<select>`），1366 px 仍为 2 行，480 px 仍为 3 行。把“字号”分段组换成一个“字幕显示”按钮（“字号”“行距”两组放进它的浮层）后，1366 px 一行、右侧余 159 px，480 px 两行、第二行余 78 px | 实验 E-1；布局要求见 `.ai-delivery/features/002-v1/design.md` 第 286～287 行、`tests/e2e/topbar.spec.ts`（1366 px ≤ 1 行、480 px ≤ 2 行）、`tests/e2e/ui.spec.ts` IQA-121 |

### 已由文档或项目代码写明的事实（直接引用，未做实验）

| 事实 | 用在哪里 | 出处 |
| --- | --- | --- |
| 第 2 号交付已确认：字幕行高不小于该字幕字号的 1.4 倍，每一档字号都适用，字幕小窗同样适用 | “紧凑”档的行高下限（TD-802） | `.ai-delivery/features/002-v1/spec.md` FR-129、PQ-003 人工答案；`tests/e2e/ui.spec.ts`（`lineHeight >= size * 1.4`） |
| 现有字幕样式：`.caption` 的 `line-height: 1.5`、`padding: 4px 0 4px 16px`，`.caption + .caption { margin-top: 6px }`；提示条目字号为 `calc(var(--caption-size) * 0.75)` | “标准”档取值必须与它们完全相同（FR-4） | `src/web/styles.css` |
| 无单位的 `line-height` 让每个行盒的高度等于“数值 × 该元素的字号”，与字体自身的上下伸部无关 | 字幕内行距与字幕间距的计算公式（TD-802） | CSS 2.1 §10.8.1（Leading and half-leading）；MDN `line-height` |
| 用户禁用站点存储时，访问 `window.localStorage` 会抛出 `SecurityError` | 存储不可用时的退化（TD-803、AC-7 的测试做法） | MDN `Window.localStorage`（Exceptions 一节） |
| 现有偏好模块的读写都包在 `try` 中，存储不可用或取值无法识别时退回默认值，写入失败时静默忽略 | 行距沿用同一机制（FR-18、FR-19） | `src/web/preferences.ts`、`tests/unit/preferences.test.ts` |
| 字幕小窗是同源的 Document Picture-in-Picture 文档，载入同一份 `/styles.css`；字号通过小窗 `body` 的 `data-caption-size` 属性同步 | 行距用同样方式同步到小窗（TD-805） | `src/web/pip.ts`（`build`、`setCaptionSize`）、`README.md`“字幕小窗”一节 |
| 小窗中的 `DomCaptionView` 以 `alwaysFollow = true` 构造，主页面视图只在读者停留在底部附近时跟随 | 切换行距后的滚动处理（TD-804） | `src/web/pip.ts`（`new DomCaptionView(list, scroller, undefined, true)`）、`src/web/captionView.ts` |
| 已知测试限制：启用 Playwright 路由后，小窗样式表不生效 | 小窗行距的端到端用例使用麦克风输入 | `README.md`（“已知限制”）、第 7 号设计“已知测试限制” |
| HTML `popover` 属性与 `popovertarget` 调用按钮（Chrome/Edge 114+、Firefox 125+、Safari 17+）提供顶层显示、点击外部关闭、按 Esc 关闭与焦点返回 | “字幕显示”浮层（TD-806） | MDN “Popover API”、HTML 标准 §6.12 “The popover attribute” |

## 治理与技术约束

| 约束 | 来源 | 设计响应 |
| --- | --- | --- |
| 保持已批准的业务意图和范围；优先最简单架构 | 宪章·产品与架构 | 只做行距（Q1＝C），背景透明度相关的代码、样式与存储键一概不加；纯前端改动，沿用现有字号的实现方式（CSS 变量 + `data-*` 属性 + `preferences.ts`），不引入框架或新依赖 |
| 绝不记录 secret 或客户内容；验证输入 | 宪章·安全与隐私 | `localStorage` 只增加 `rtmt.captionSpacing` 一项，取值只能是 `compact`/`normal`/`loose`，读出时按白名单校验（TD-803）；不保存任何字幕内容，不新增发往服务端的数据 |
| 每项用户可见能力都要有可独立执行的验收场景；外部集成用真实测试服务 | 宪章·测试与质量 | AC-1、AC-3～AC-7 都有端到端验收设计（见“验证环境责任矩阵”）；需要“正在听”的用例（AC-4、AC-6）走真实 `dev` 的 `speech` 与 `chat-model`，不使用模拟服务 |
| 字幕行高 ≥ 字号 × 1.4（每档字号、主页面与小窗） | 第 2 号规格 FR-129（PQ-003 人工答案） | “紧凑”档行高取 1.4（TD-802），不低于这条下限 |
| 顶栏布局：宽 ≥ 1100 px 时控制区一行（测试在 1366～1920 px 断言）；宽 ≤ 640 px 时控制区最多两行；所有控件等高、无原生单选圆点；任何宽度无横向滚动 | 第 2 号设计第 286～287 行、G4 退回意见（`tests/e2e/topbar.spec.ts`、IQA-121） | 按实验 E-1，直接加第三个分段组会违反这条要求；按人对 OD-1 的决定（A），“字号”“行距”两组放进“字幕显示”浮层，顶栏在两种宽度下都留有余量，布局要求与 `topbar.spec.ts` 的行数上限不变（TD-806） |
| 字号的档位、保存与恢复行为不变 | 意图·不做的事、FR-14、OD-1 的决定 | `rtmt.captionSize` 键、取值、默认值与读写代码不变；只把字号这组单选按钮原样移进浮层（人已决定，OD-1），不改档位与行为 |
| 产品代码中不加测试开关 | 第 3、7 号设计的约定（第 3 号 TD-310、第 7 号设计的开放决策 OD-1） | 存储不可用、预置偏好等情况都在测试的浏览器初始化脚本中构造（见“可测性约定”） |
| 现有 CI、部署脚本与 IaC 保持原样 | 本步骤边界 | 不改 `Dockerfile`、`infra/`、`scripts/`；`docs/dependencies.json` 不变；`docs/deployment.json` 只更新服务说明文字 |

## 架构概览（Architecture）

不新增模块与进程。在现有“界面偏好 → CSS 变量 → 主页面与小窗共用样式”的链路上增加一项偏好：

```
用户选中“行距”单选按钮（主页面）
   └─ main.ts applyCaptionSpacing(spacing)
        ├─ #caption-panel[data-caption-spacing]  ← 主页面字幕区
        ├─ CaptionWindow.setCaptionSpacing()      ← 小窗 body[data-caption-spacing]（打开时立即改，打开前记住）
        ├─ 同步单选按钮的选中状态
        └─ preferences.setCaptionSpacing()        ← localStorage 'rtmt.captionSpacing'（失败静默）
styles.css:
   [data-caption-spacing='compact'|'normal'|'loose'] → --caption-line-height / --caption-pad-y / --caption-gap
   .caption 使用这三个变量（主页面 #captions 与小窗 #pip-captions 共用）
页面载入：preferences.captionSpacing()（无效或不可读 → 'normal'）→ applyCaptionSpacing
```

字幕管线（`captionPipeline.ts`、`MirroredCaptionView`）、识别与翻译完全不动；切换行距只改属性与 CSS 变量，不重建 DOM，所以不会中断翻译，已有字幕和之后的新字幕都按新值排版（FR-8、FR-9）。

## 技术决策与替代方案

| 决策 ID | 选择 | 理由 | 已考虑替代方案 | 证据 | 来源 |
|---|---|---|---|---|---|
| TD-801 | 行距档位的内部取值为 `compact`/`normal`/`loose`（显示为“紧凑”/“标准”/“宽松”），默认 `normal`；类型 `CaptionSpacing` 与常量 `CAPTION_SPACINGS`、`DEFAULT_CAPTION_SPACING` 放在 `src/web/preferences.ts`，与 `CaptionSize` 并列 | 与字号的组织方式相同（`CaptionSize`、`CAPTION_SIZES` 在同一文件），校验与默认值集中一处 | 用数字（行高倍数）作为存储值：之后调整取值会让旧的保存值失效，也更难做白名单校验 | `src/web/preferences.ts` | FR-1、FR-12 |
| TD-802 | 用三个 CSS 变量实现档位，`.caption` 改为 `line-height: var(--caption-line-height)`、`padding: var(--caption-pad-y) 0 var(--caption-pad-y) 16px`，`.caption + .caption { margin-top: var(--caption-gap) }`。取值：**紧凑** 1.4 / 2px / 0px；**标准** 1.5 / 4px / 6px（等于现有字面值）；**宽松** 1.8 / 4px / 14px。在 `:root` 中给出“标准”值作为默认值，再由 `[data-caption-spacing='…']` 属性选择器覆盖 | 字号为 *f* 时，字幕内行距＝行高倍数 × *f*；两条相邻的单行字幕之间的字幕间距＝行高倍数 × *f* ＋ 2 × 上下内边距 ＋ 间隔，即紧凑 1.4*f*＋4、标准 1.5*f*＋14、宽松 1.8*f*＋22。三项都随档位严格增大，所以对任何字号都有紧凑 < 标准 < 宽松（FR-2、FR-3）；提示条目（0.75 倍字号）同样成立。“标准”与现有样式逐项相同（FR-4）。“紧凑”行高取 1.4 而不是更小，是为了满足第 2 号 FR-129（行高 ≥ 1.4 倍字号）。字幕内行距的差别因此较小（中号 44.8 / 48 / 57.6 px），可见的“紧凑”主要靠字幕间距（中号 48.8 / 62 / 79.6 px） | ① 只改 `line-height`、不改字幕间距：不满足 R2 的答案（行距也作用于相邻两条字幕之间）；② “紧凑”行高取 1.25：违反第 2 号 FR-129；③ 用 `em` 单位的间距：会随字号变化，“标准”无法逐像素等于现有的固定 6 px | CSS 2.1 §10.8.1；`src/web/styles.css`；第 2 号规格 FR-129 | FR-2～FR-5、FR-7 |
| TD-803 | `Preferences` 增加 `captionSpacing()` 与 `setCaptionSpacing(spacing)`，以及类型守卫 `isCaptionSpacing`；存储键 `rtmt.captionSpacing`；读写沿用现有的 `read`/`write`（都在 `try` 中，存储为 `null`、访问时抛错或取值不在白名单中都按“没有保存过”处理，返回 `normal`；写入失败静默） | 与字号逐字相同的保存方式与退化行为（意图·假设第 3 条、规格 A-4、A-5）；不保存任何字幕内容 | 另起一个存储模块或一个 JSON 对象键（例如 `rtmt.display`）：会改变字号现有的存储格式（违反 FR-14），也没有必要 | `src/web/preferences.ts`；MDN `Window.localStorage` | FR-10～FR-13、FR-18、FR-19 |
| TD-804 | `main.ts` 增加 `applyCaptionSpacing(spacing)`，结构与 `applyCaptionSize` 相同：先记下主页面是否停留在底部附近，再设置 `#caption-panel` 的 `data-caption-spacing`，调用 `captionWindow.setCaptionSpacing`，同步单选按钮的选中状态，若原先在底部则 `captionView.scrollToEnd()`。单选按钮 `change` 事件中先应用再保存；页面初始化时在 `applyCaptionSize(...)` 之后调用 `applyCaptionSpacing(preferences.captionSpacing())`。不监听 `storage` 事件 | 切换只改属性，不触碰字幕管线与运行状态，翻译不中断（FR-8、FR-9）；与字号的滚动跟随一致，读者正在往回翻看时不被拉到底部。规格 A-8 不要求多个页面互相同步，故不监听 `storage` 事件 | 切换时重新渲染字幕列表：没有必要，并且有打断滚动位置的风险 | `src/web/main.ts`（`applyCaptionSize`） | FR-6、FR-8、FR-9、FR-11、FR-12 |
| TD-805 | `CaptionWindow` 增加字段 `captionSpacing`（默认 `'normal'`）与方法 `setCaptionSpacing(spacing)`：记下取值；小窗已打开时设置小窗 `body.dataset.captionSpacing` 并调用小窗视图的 `scrollToEnd()`。`build()` 中与 `captionSize` 一起设置 `body.dataset.captionSpacing = this.captionSpacing` | 小窗与主页面共用 `styles.css`，属性选择器对小窗 `body` 同样生效，打开时与打开期间都和主页面一致（FR-15、FR-16）；小窗视图本来就总是跟随最新字幕，换行距后保持最新字幕可见。小窗中不加任何控件（FR-17） | 在小窗中注入内联样式：要维护第二份取值，容易与主页面不一致 | `src/web/pip.ts` | FR-15～FR-17 |
| TD-806 | **控件位置（人已决定 OD-1＝A）**。顶栏中“字号”分段组的位置（`.status-box` 与 `.pip-control` 之间）换成一个按钮 `<button id="display-button" type="button" popovertarget="display-panel" aria-expanded="false">`，可见文字“字幕显示”，后附装饰性的“▾”（`<span aria-hidden="true">`，按钮的可访问名称因此为“字幕显示”），样式与顶栏其他次要按钮同高；浮层 `<div id="display-panel" popover>` 紧随按钮之后。浮层中上下放两个分段组：`<fieldset id="caption-size" class="choice segmented">`（原样移入，`legend`“字号”、`name`、取值、文字、默认选中“中”都不变）和新的 `<fieldset id="caption-spacing" class="choice segmented">`（`legend`“行距”，三个 `name="caption-spacing"` 的单选按钮，取值 `compact`/`normal`/`loose`，文字“紧凑”“标准”“宽松”，`normal` 默认选中）。浮层的 `toggle` 事件中：打开时按按钮的 `getBoundingClientRect()` 把浮层定位在按钮下方（`position: fixed; margin: 0`，左边界限制在 `[8px, 视口宽 − 浮层宽 − 8px]` 内），并设置按钮的 `aria-expanded` 为 `true`；关闭时设为 `false`。窗口 `resize` 时若浮层打开则 `hidePopover()`。浮层内的分组标题在任何宽度下都可见（覆盖 ≤ 640 px 时隐藏 `.choice legend` 的规则，只作用于 `#display-panel` 内）。选中单选按钮后浮层不自动关闭（便于连续比较几档），点击外部、按 Esc 或再次点按钮关闭 | 人对 OD-1 的决定；实验 E-1 中两种宽度都留有较大余量（1366 px 余 159 px，480 px 第二行余 78 px；实验中按钮文字为更长的“字号与行距 ▾”，宽 122 px，定稿文字“字幕显示 ▾”少一个汉字，余量只会更大），在 Windows 字体下仍稳妥；单选按钮保留，键盘操作与无障碍名称“小/中/大/特大”“紧凑/标准/宽松”不变；`popover` 自带顶层显示、点击外部关闭、Esc 关闭与焦点返回 | ① 行距分段组直接放顶栏（原 B）：违反第 2 号布局要求，人未选；② 收紧全部控件间距（原 C）：1366 px 只余 1 px、480 px 仍为 3 行（E-1）；③ 下拉框：两种宽度都不满足（E-1）；④ 行距控件放进字幕区：与规格 A-1 不符，还会遮挡字幕；⑤ 用 `<dialog>` 或自己实现浮层的显示、关闭与焦点管理：`popover` 已提供这些行为，更简单；⑥ 用 CSS 锚点定位（`anchor-name`）：各浏览器开始支持的版本较新且不一致（MDN 兼容表），而现有端到端用例 IQA-109/123 还会在 Playwright Firefox 中打开页面；脚本定位只依赖 `getBoundingClientRect()`，在各浏览器中行为一致 | 实验 E-1；MDN “Popover API”、MDN “CSS anchor positioning”（浏览器兼容表）；第 2 号设计第 286～287 行；人对 OD-1 的答复 | FR-1、FR-17、规格 A-1；第 2 号 AC-11；OD-1 |
| TD-807 | 首屏不闪烁：`index.html` 中 `#caption-panel` 静态带 `data-caption-spacing="normal"`，脚本运行前与旧版本外观完全相同 | 与 `data-caption-size="m"` 的做法一致；首次打开即为“标准”（FR-12） | 只靠 `:root` 默认值：也能工作，但测试与读者从属性上看不出当前档位 | `src/web/index.html` | FR-4、FR-12 |
| TD-808 | 不做背景透明度：不加透明度变量、控件与存储键；`--caption-bg` 与字幕区、小窗背景不变 | Q1＝C、R1 的答案 | — | 意图 Q1、R1 | FR-7、规格 AC-2 |
| TD-809 | 使用引导（`index.html` 中 `#guide` 的第 4 条）随控件位置更新为：“<strong>调整字号：</strong>点击“字幕显示”，在“字号”中选择“小 / 中 / 大 / 特大”，字幕立即按新字号显示。”只改字号的操作路径，不新增“调整行距”一条（见开放决策中的建议） | 人对 OD-1 的答复明确要求“使用引导里‘调整字号’一条随之更新”；字号移入浮层后，原文“在‘字号’中选择”已找不到入口 | 合并写成“调整字号与行距”：等于新增行距的引导内容，超出答复范围，按建议列入开放决策 | `src/web/index.html` 第 97 行；人对 OD-1 的答复 | OD-1 |

## 技术先后依赖

- `preferences.ts` 中的 `CaptionSpacing`、`isCaptionSpacing`、`captionSpacing()`/`setCaptionSpacing()` 必须先于（或同时于）`main.ts`、`pip.ts` 中使用它们的改动，因为后两者引用这些类型与方法，否则 `npm run typecheck` 不通过。
- `pip.ts` 的 `setCaptionSpacing` 必须先于（或同时于）`main.ts` 中的 `applyCaptionSpacing`，原因同上。
- `index.html` 中 `#caption-spacing` 单选按钮、`#display-button`/`#display-panel` 浮层与 `styles.css` 中的 `[data-caption-spacing]` 规则必须先于新的端到端用例，因为这些用例按角色与可见名称定位控件（先点“字幕显示”）、按计算样式测量行距。
- 把 `#caption-size` 移入浮层，必须与修改现有端到端用例中操作或探测字号控件的代码放在同一次改动中完成，因为浮层关闭时这些单选按钮不可见（不在顶栏中），Playwright 无法操作，顶栏探测也会找不到元素，现有用例会失败。已知的位置：`tests/e2e/topbar.spec.ts` 第 11、18、55 行（顶栏项目与等高探测中的 `#caption-size` 改为 `#display-button`；“选中项区分”检查改为在打开浮层后核对 `caption-size`、`caption-spacing`）、第 101、108 行（先打开浮层再选字号）；`tests/e2e/ui.ts` 第 30 行 `OTHER_CONTROLS`（`#caption-size` 改为 `#display-button`）；`tests/e2e/ui.spec.ts` 第 184～188 行与第 315 行（先打开浮层）；`tests/e2e/captions.spec.ts` 第 39 行（排除的单选按钮再加上 `caption-spacing`）。行数上限（1366 px ≤ 1 行、480 px ≤ 2 行）不改。

## 领域与数据模型

| 项 | 取值 | 默认 | 存放位置 |
| --- | --- | --- | --- |
| 行距档位 `CaptionSpacing` | `compact`（紧凑）、`normal`（标准）、`loose`（宽松） | `normal` | 浏览器 `localStorage` 键 `rtmt.captionSpacing`（只存这三种字符串之一）；页面内存中只在 DOM 属性 `data-caption-spacing` 上体现 |

档位与样式取值（字号 *f* 为当前字号档的 `--caption-size`：24/32/40/52 px）：

| 档位 | `--caption-line-height` | `--caption-pad-y` | `--caption-gap` | 字幕内行距 | 相邻两条单行字幕的字幕间距 | 中号（32 px）时 |
| --- | --- | --- | --- | --- | --- | --- |
| 紧凑 | 1.4 | 2px | 0px | 1.4*f* | 1.4*f* ＋ 4 px | 44.8 / 48.8 px |
| 标准（＝交付前） | 1.5 | 4px | 6px | 1.5*f* | 1.5*f* ＋ 14 px | 48 / 62 px |
| 宽松 | 1.8 | 4px | 14px | 1.8*f* | 1.8*f* ＋ 22 px | 57.6 / 79.6 px |

各字号下的“标准”值（＝交付前版本）：小 36 / 50 px，中 48 / 62 px，大 60 / 74 px，特大 78 / 92 px（字幕内行距 / 字幕间距）。字幕间距指前一条最后一行文字基线到后一条第一行文字基线的距离（规格 A-2）；两条字幕字号不同时（例如提示条目为 0.75 倍），差值不同，但三档之间仍满足严格的大小关系。

不新增服务端数据、日志字段或接口数据。

## Component 边界与项目结构

Coding 会创建或修改的路径：

- `src/web/preferences.ts`：`CaptionSpacing` 类型、`CAPTION_SPACINGS`、`DEFAULT_CAPTION_SPACING`、`isCaptionSpacing`、`captionSpacing()`、`setCaptionSpacing()`（TD-801、TD-803）。
- `src/web/main.ts`：`applyCaptionSpacing`、行距单选按钮的 `change` 处理、初始化调用；浮层的定位、`aria-expanded` 同步与 `resize` 时关闭（TD-804、TD-806）。
- `src/web/pip.ts`：`setCaptionSpacing`、`build()` 中设置 `data-caption-spacing`（TD-805）。
- `src/web/index.html`：`#caption-panel` 的 `data-caption-spacing="normal"`；`#display-button` 与 `#display-panel` 浮层（`#caption-size` 移入，新增 `#caption-spacing`）；使用引导第 4 条（TD-806、TD-807、TD-809）。
- `src/web/styles.css`：三个 CSS 变量的默认值与 `[data-caption-spacing]` 规则，`.caption` 改用变量；“字幕显示”按钮与浮层样式（TD-802、TD-806）。
- `src/web/guide.ts`：不改（引导文字在 `index.html` 中）。
- `tests/unit/preferences.test.ts`：行距的默认值、保存与恢复、无效值、存储抛错与不可用。
- `tests/e2e/captionSpacing.spec.ts`（新）：AC-1、AC-3～AC-7 的端到端用例。
- `tests/e2e/ui.ts`：增加行距测量辅助函数（字幕内行距、字幕间距、计算样式），供新用例使用。
- `tests/e2e/topbar.spec.ts`、`tests/e2e/ui.ts`、`tests/e2e/ui.spec.ts`、`tests/e2e/captions.spec.ts`：顶栏探测以 `#display-button` 代替 `#caption-size`，操作字号前先打开浮层（位置见“技术先后依赖”）；行数上限不改。另在 `topbar.spec.ts` 加一项：浮层打开时在 1366 px 与 480 px 宽下完整位于视口内、无横向滚动。
- `tests/e2e/fixtures.ts`：只在需要提供“预置偏好”“存储不可用”的初始化脚本选项时修改。
- `README.md`：“界面”一节补充行距与 `rtmt.captionSpacing`。
- `docs/deployment.json`：只更新 `web` 服务的说明文字（本步骤已改）。

不修改：`src/server/`、`src/shared/`、`tests/integration/`、`infra/`、`Dockerfile`、`scripts/`、`docs/dependencies.json`。

## 数据流、状态、并发与生命周期

- **页面载入**：`init()` 依次 `applyCaptionSize(preferences.captionSize())`、`applyCaptionSpacing(preferences.captionSpacing())`。存储不可用时两者都得到默认值，页面照常可用（FR-18）。
- **切换**：单选按钮 `change` → `applyCaptionSpacing` → `preferences.setCaptionSpacing`。浏览器同步重排，下一帧即按新值显示；运行状态、`run` 对象、识别会话、翻译请求都不受影响（FR-8、FR-9）。任何翻译状态下都可切换，行距单选按钮不随状态禁用（规格 A-6）。
- **小窗**：打开时 `build()` 读取 `CaptionWindow.captionSpacing`；打开期间每次切换都写小窗 `body`；小窗关闭（`pagehide`）后只保留取值，下次打开再应用。小窗写入失败不影响主页面（小窗随时可能被关闭；`setCaptionSpacing` 只在 `this.current` 存在时写入，与 `setCaptionSize` 相同）。
- **多个页面**：每个页面只在载入时读取一次，不互相同步（规格 A-8）。
- **“字幕显示”浮层**：`popover="auto"`，点击外部、按 Esc 或再次点按钮关闭；浮层打开或关闭都不影响字幕与运行状态；窗口尺寸改变时关闭，避免位置失效。

## Interface 与契约（Contract）

- 不新增、不修改 HTTP 接口；`src/shared/contracts.ts` 不变。
- 浏览器本地存储契约（新增一项）：键 `rtmt.captionSpacing`，取值 `compact` | `normal` | `loose`；其他取值、缺失或读取抛错一律视为 `normal`。现有 `rtmt.guideSeen`、`rtmt.captionSize` 不变。
- DOM 契约（供测试与样式使用）：主页面 `#caption-panel[data-caption-spacing]`、小窗 `body.pip[data-caption-spacing]`，取值同上；三个 CSS 变量 `--caption-line-height`、`--caption-pad-y`、`--caption-gap` 定义在设置该属性的元素上。

## 可测性约定

沿用现有约定（`README.md`“开发者命令”与各端到端说明、第 7 号设计“可测性约定”）：端到端使用 Playwright 与完整版 Chromium，在 `xvfb-run` 下以有界面方式运行，用 TTS 合成的英语 WAV 作为假麦克风；需要真实服务的用例走 `dev` 实例；产品代码中没有测试开关。下面只写本次新增或改变的部分。

**关键控件的角色与可见名称**（按角色与名称定位，不按样式或页面结构定位）：

| 控件 | 角色与名称 | 说明 |
| --- | --- | --- |
| 行距分组 | `group`，名称“行距”（`fieldset` + `legend`） | `getByRole('group', { name: '行距' })` |
| 行距三档 | `radio`，名称“紧凑”“标准”“宽松” | 例如 `getByRole('radio', { name: '宽松', exact: true }).check()`；选中状态用 `toBeChecked()` 判定 |
| 字号四档 | `radio`，名称“小”“中”“大”“特大”（不变） | — |
| 字幕显示按钮 | `button`，名称“字幕显示”；`aria-expanded` 为 `true`/`false` | 操作行距或字号前先 `getByRole('button', { name: '字幕显示' }).click()`；浮层打开时上面两组单选按钮可见，按 Esc 关闭。选中后浮层不自动关闭 |
| 当前档位 | 主页面 `#caption-panel` 的 `data-caption-spacing`；小窗 `documentPictureInPicture.window.document.body.dataset.captionSpacing` | 语义属性，可用来核对，但 AC 的判定以测量到的行距为准 |

**行距的测量方法**（`tests/e2e/ui.ts` 新增辅助函数；独立测试可以沿用同样的方法）：

- 字幕内行距：在一条换行成多行的字幕（`li.caption`）中，用 `Range.selectNodeContents(li)` 的 `getClientRects()` 取各行文字框，按 `top` 去重排序后，相邻两行 `top` 之差即两行基线间的距离（同一条字幕字号相同，所以文字框顶部之差等于基线之差）。要得到多行字幕：把视口设为 480×800 并选“特大”，或等待较长的句子。
- 字幕间距：相邻两条非空、字号相同的字幕（例如两条 `data-status="final"`），前一条最后一行文字框的 `top` 到后一条第一行文字框的 `top` 之差。
- 也可以直接读计算样式：`getComputedStyle(li).lineHeight`、`paddingTop`、`paddingBottom`，以及后一条的 `marginTop`。按“领域与数据模型”中的公式算出的值与上面的测量值一致（误差 ≤ 1 px）。
- “标准”＝交付前（AC-3）：按上表核对（例如中号字幕内行距 48 px、字幕间距 62 px），或与交付前版本在同一视口、同一字号、同一素材下的测量值比较。字幕区背景仍为 `rgb(13, 17, 23)`（`--caption-bg` 的 `#0d1117`）。

**造数与清理**：应用不保存服务端数据，无需造数与清理；每个测试使用新的浏览器上下文（`localStorage` 为空，即“首次打开”）。

- 预置已保存的行距：在 `context.addInitScript` 中写 `localStorage.setItem('rtmt.captionSpacing', 'loose')`；注意初始化脚本每次导航都会执行，验证“关闭后再打开”（AC-5）时不要用它，而是在页面中通过界面选择后，用同一上下文新开页面（`context.newPage()` 并关闭原页面）或 `page.reload()`。
- 无法识别的保存值（FR-19）：用同样方式预置 `'tight'`、`''`、`'Loose'` 等。
- 浏览器不允许本地保存（AC-7）：在 `context.addInitScript` 中把 `window.localStorage` 的读取改为抛出 `DOMException('…', 'SecurityError')`（`Object.defineProperty(window, 'localStorage', { get() { throw … } })`）。这就是 Chromium 在用户禁用站点存储时的行为（MDN `Window.localStorage`）。可以再加一个用例，让 `Storage.prototype.setItem` 抛 `QuotaExceededError`，模拟“能读不能写”。
- 字幕：麦克风模式下用现有 `meeting` 或 `single` 素材（`tests/support/tts.ts`，缓存在系统临时目录）。

**时间与随机性**：没有新增的时间或随机因素。“立即生效”按规格 FR-8 判定：选中后不刷新页面，在 Playwright 默认的自动等待时间内（≤ 5 s）测量到新的行距即可；应用本身在同一帧内重排。

**受控触发**：不需要新的受控触发。正在翻译时切换行距（AC-4）、小窗打开期间切换行距（AC-6）都直接通过界面操作完成；小窗相关用例用麦克风输入（Playwright 路由会让小窗样式表不生效，见“已知测试限制”）。

**开发者命令与用时**（`runtime/deployment.json`；用时为全量运行一次的大致时间）：

| 类别 | 命令 | 验证什么 | 全量用时 |
| --- | --- | --- | --- |
| （安装） | `npm ci` | 安装锁定依赖 | 约 5～30 s（估计，取决于缓存） |
| `staticAnalysis` | `npm run lint`、`npm run typecheck` | ESLint；服务端与浏览器两套 tsconfig 的类型检查 | 约 30 s（估计，沿用第 7 号设计） |
| `build` | `npm run build` | esbuild 生成 `dist/server/main.js`、`dist/web/{index.html,app.js,styles.css}` | 约 5 s（估计，沿用第 7 号设计） |
| `developerTests` | `npm test` | 单元测试（Vitest，无外部调用），含本次的行距偏好用例 | 约 10 s（估计；第 7 号设计实测 15 个文件 5.2 s，现为 18 个文件，本次只在已有文件中加用例） |
| `integrationTests` | `npm run test:integration` | 针对真实 `dev` 实例：语音令牌、流式识别、流式翻译、中止与日志、韩语/日语只输出中文（本次不改） | 约 3～5 分钟（估计，沿用第 7 号设计），6 个文件 12 个用例 |

端到端用例不写进部署声明。全部端到端用例（`npm run test:e2e`）约 50～60 分钟（估计：第 7 号设计估计 45～55 分钟，本次新增约 7 个用例约 6～8 分钟）。单独运行新用例：

```bash
npm run build
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test tests/e2e/captionSpacing.spec.ts -g "<用例名片段>"
```

新文件约 7 个用例：不需要开始翻译的（AC-1 的样式测量、AC-3、AC-5、AC-7、FR-19）单个约 10～30 s；需要“正在听”的（AC-1 的多行实测、AC-4、AC-6）单个约 1～1.5 分钟；整个文件约 6～8 分钟（均为估计）。

**并行与隔离**：沿用现有做法。端到端 `workers: 1` 串行，每个 worker 在 `18180 + workerIndex` 端口启动构建产物；每个测试使用新的浏览器上下文，`localStorage` 互不影响。集成测试在随机端口启动 `buildApp`。应用不保存数据，依赖实例只共享配额与并发连接数。应用可以在执行环境内的 `localhost` 启动（`npm run build && node dist/server/main.js`，需要 `AIDH_DEP_*` 变量）。

**已知测试限制**：沿用现有限制。另外，实验 E-1 的布局测量只在 Linux 字体（文泉驿正黑）下做过，Windows 字体（微软雅黑）下的宽度没有实测。顶栏文字以汉字为主，汉字通常是等宽的全角字形，差异主要来自少量拉丁字符与符号；选定做法留出的余量（≥ 78 px）预计足以覆盖这部分差异。自动化测试只在 Linux 上的 Chromium 中运行，Windows 上的顶栏行数需要人工查看。

## 安全、隐私、身份与 Secret

- 只新增一个本地界面偏好键 `rtmt.captionSpacing`，取值为三种固定字符串之一；读出时按白名单校验，不把读到的值写进 DOM 或样式（只写校验通过的取值）。
- 不保存、不上传任何字幕或发言内容；不新增网络请求，小窗依旧不请求任何接口。
- 身份、凭据、依赖与项目机密不变（`docs/dependencies.json` 的 `secrets` 仍为空）。
- 现有端到端检查“浏览器存储中没有凭据”（IQA-008/115，`tests/e2e/isolation.spec.ts`）照常适用；新增的键只含档位字符串。

## 配置、可观测性与运维

- 不新增环境变量与配置项。
- 不新增服务端日志；浏览器端行距切换不记录日志（与字号一致）。服务端日志格式与白名单不变，`docs/deployment.json` 中的 `operations.errorLogRules`（`app-error-or-fatal`、`upstream-errors-burst`、`node-crash-output`）照常适用，不需要新增规则。

## SLO、限制、扩缩容、重试与恢复

- 没有获批准的新质量指标（规格“产品质量要求”）。切换行距只改 CSS 变量，开销与切换字号相同。
- 存储失败不重试、不提示（规格 A-5），本次打开期间设置照常生效。

## 部署拓扑、迁移、Rollout 与 Rollback

- 部署拓扑不变：单服务 `web`（`Dockerfile`，端口 8080，`/healthz`）。`docs/deployment.json` 只更新说明文字。
- 没有数据迁移。旧版本会忽略新的 `rtmt.captionSpacing` 键；回滚时重新部署上一个镜像即可，用户的字号偏好不受影响。新版本读到旧浏览器中没有这个键时按“标准”处理，与交付前显示相同。
- 依赖：沿用已绑定的 `speech`、`chat-model` 的 `dev`、`test` 实例（声明不变，探测脚本 `infra/probes/*.sh` 不变）。

## 验证环境责任矩阵（Verification Environment）

| 验证类型 | 责任阶段 | 环境来源 | 依赖/凭据 | Coding 证据 | 下游结果 |
|---|---|---|---|---|---|
| 静态检查、构建 | 编码、候选验证 | Agent Pod / 平台候选验证 | 无 | `npm run lint`、`npm run typecheck`、`npm run build` 通过 | 候选验证记录 |
| 单元测试（偏好读写与退化） | 编码、候选验证 | 同上 | 无 | `npm test` 通过，含 `preferences.test.ts` 新用例 | 候选验证记录 |
| 集成测试（回归） | 编码、候选验证 | 同上，`dev` 实例 | `AIDH_DEP_*`（`dev`） | `npm run test:integration` 通过（本次不改） | 候选验证记录 |
| 端到端：行距三档、标准＝交付前、正在听时切换、保存与恢复、小窗一致、存储不可用、无效保存值 | 编码（自测，单独运行新文件）；独立测试按测试计划 | Agent Pod `localhost` + Xvfb；独立测试环境为测试环境部署 | `dev`（编码）/`test`（独立测试）实例 | 单独运行 `tests/e2e/captionSpacing.spec.ts` 的结果、测量 JSON 与截图 | 独立测试结果 |
| 端到端：顶栏布局回归（`topbar.spec.ts`、IQA-121）与字号、小窗回归（IQA-118/119/122） | 编码 | Agent Pod `localhost` + Xvfb | `dev` 实例 | 这些用例在改动后通过（操作字号前先打开浮层；行数上限不变） | 独立测试按测试计划 |

端到端用例的设计（文件 `tests/e2e/captionSpacing.spec.ts`）：

| 用例 | 覆盖 | 方法与判定 | 单个用时（估计） |
| --- | --- | --- | --- |
| 三档与默认 | AC-1（控件部分）、AC-3、FR-12、FR-7 | 新上下文打开页面：“行距”分组有且只有“紧凑”“标准”“宽松”三个单选按钮，“标准”选中；`#caption-panel` 背景为 `rgb(13, 17, 23)`；每档字号下“标准”的计算样式为行高 1.5 × 字号、上下内边距 4 px、间隔 6 px | 约 15 s |
| 行距大小关系（实测） | AC-1、FR-2～FR-6 | 视口 480×800、“特大”，麦克风 `meeting` 素材，等待至少 2 条定稿且其中一条换成多行；依次选三档，按“行距的测量方法”测字幕内行距与字幕间距，严格满足 紧凑 < 标准 < 宽松；每档行高 ≥ 字号 × 1.4；切换后字号选中值与字幕字号不变；再切字号，行距选中值不变 | 约 1.5 分钟 |
| 正在听时切换 | AC-4、FR-8、FR-9 | 运行中依次选“宽松”“紧凑”：页面不重新载入（切换前在 `window` 上设标记，之后仍在）；状态保持“正在听”；已有定稿条数不减少；切换后已有字幕的计算行高立即为新值；之后新出现的定稿同样为新值 | 约 1.5 分钟 |
| 保存与恢复 | AC-5、FR-10、FR-11、FR-14 | 选“宽松”与字号“大”，关闭页面后在同一上下文新开页面：“宽松”“大”为选中，字幕区计算样式为“宽松”；`localStorage` 中 `rtmt.captionSpacing` 为 `loose`、`rtmt.captionSize` 为 `l`，没有其他新键，值中不含字幕文字 | 约 20 s |
| 字幕小窗 | AC-6、FR-15～FR-17 | 先选“紧凑”再开始翻译（麦克风），打开小窗：小窗 `body` 的 `data-caption-spacing` 为 `compact`，小窗字幕的计算行高与间隔和主页面相同；小窗打开期间选“宽松”：小窗随即变为 `loose`，已有字幕的计算样式随之改变，之后的新字幕也是；小窗中没有任何单选按钮 | 约 1.5 分钟 |
| 存储不可用 | AC-7、FR-18 | 初始化脚本让读取 `localStorage` 抛 `SecurityError`：页面正常打开，“标准”选中；选“宽松”后立即生效；开始翻译能出现定稿字幕；无页面错误（`pageerror` 为 0） | 约 1 分钟 |
| 无法识别的保存值 | FR-19 | 预置 `rtmt.captionSpacing` 为 `tight`、空串、`Loose`：均显示“标准” | 约 10 s |

## 快速验证指南（Quickstart）

### 实现后的人工核对

1. `npm ci && npm run build`，按 `README.md` 设置 `AIDH_DEP_*` 后运行 `node dist/server/main.js`，打开 `http://localhost:8080`。
2. 点击“字幕显示”，在“行距”中依次选三档。开始翻译后，字幕之间的距离按 紧凑 < 标准 < 宽松 变化，状态保持“正在听”。
3. 刷新页面，所选档位保留；在开发者工具中执行 `localStorage.getItem('rtmt.captionSpacing')`，结果为三种字符串之一。
4. 打开字幕小窗，在主页面切换行距，小窗随即变化。

### 实验 E-1：顶栏加入“行距”控件后的行数（Chromium 159.0.8154.6，Playwright 1.65.1，headless，字体为文泉驿正黑；约 3 分钟）

在仓库外的临时目录中进行，不改仓库文件：

```bash
mkdir -p /tmp/e1 && cd /tmp/e1 && npm init -y && npm i @playwright/test@1.65.1   # 浏览器使用 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright 中的 chromium-1255
node e1.mjs <variant> [extra.css]
```

`e1.mjs` 的做法：用 `page.route` 把 `http://app.test/` 映射到仓库中的 `src/web/index.html`、`/styles.css` 映射到 `src/web/styles.css`（可以追加一段额外的 CSS），`/app.js` 返回空脚本；用 `page.evaluate` 在 `#caption-size` 之后插入 `<fieldset id="caption-spacing" class="choice segmented"><legend>行距</legend>`（三个单选按钮，文字为“紧凑”“标准”“宽松”）；把 `#status` 的文字依次设为五种状态，并切换 `#pip-unsupported` 的显示（模拟不支持小窗的浏览器）；在多个宽度下测量控件行数（与 `tests/e2e/topbar.spec.ts` 相同的算法：控件中线相差 ≥ 12 px 算新的一行）、顶栏高度，以及控制区右侧剩余的宽度。

观察结果（“正在启动…”是最长的状态文字；“余量”为控制区右侧剩余的宽度）：

| 变体 | 1366 px | 1440 px | 1600 px | 480 px | 1366 px，不支持小窗 |
| --- | --- | --- | --- | --- | --- |
| 现状（不加控件） | 1 行，余 37 px | 1 行，余 111 px | 1 行 | 2 行 | 1 行，余 29 px |
| 加分段组 | **3 行** | **2 行** | 1 行，余 33 px | **3 行** | **3 行** |
| 加分段组 + 收紧顶栏间距（≥ 641 px 时 `--control-pad: 10px; --control-gap: 8px; gap: 8px 12px; padding: 10px 16px`，≤ 640 px 时 `--control-pad: 8px; gap: 8px 4px`） | 1 行，余 **1 px** | 1 行 | 1 行 | **3 行** | **2 行** |
| 下拉框（`<select>`）代替分段组 | **2 行** | 1 行，余 15 px | 1 行 | **3 行** | **2 行** |
| 做法 A（人已选定）：按钮（实验时文字为“字号与行距 ▾”，宽 122 px；定稿文字“字幕显示 ▾”更短）代替“字号”分段组，两组移入 `popover` | 1 行，余 159 px | — | — | 2 行，第二行余 78 px | — |

480 px 时（现状）第一行为 标题 + 输入方式 + 开始/停止，右侧还剩 73 px；第二行为 状态 + 字号 + 小窗 + 引导。加分段组后（宽 148 px），“弹出字幕小窗”与“使用引导”被挤到第三行。实验文件在会话结束前已删除。

## 支持 Runbook

- 用户反馈“行距设置不保存”：先确认浏览器是否禁用了站点存储或处于不保存数据的隐私模式（这种情况下按设计每次都是“标准”，规格 A-5）；否则在开发者工具中查看 `localStorage` 的 `rtmt.captionSpacing`。
- 用户反馈“小窗行距与主页面不一致”：确认小窗是从当前页面打开的；查看小窗 `body` 的 `data-caption-spacing`。只有在 Playwright 路由等测试环境中，小窗样式表才可能不生效。
- 回滚：重新部署上一个镜像，无数据需要处理。

## 开放决策

- **OD-1（已决定：A）：行距控件放在哪里。** 证据见实验 E-1：在顶栏直接加第三个分段组，会违反第 2 号交付已确认的顶栏布局要求，收紧间距或改用下拉框也满足不了。人选 A：顶栏“字号”位置换成“字幕显示”按钮，浮层内放“字号”和“行距”两组；字号档位、默认值与本机保存行为不变；顶栏布局要求（宽屏一行、约 480 px 两行）不变；使用引导“调整字号”一条随之更新。已落实到 TD-806、TD-809 与“技术先后依赖”。未选：B（行距直接放顶栏并放宽布局要求）、C（收紧全部控件间距）。
- **说明（不是需要决定的事项）**：受第 2 号 FR-129（行高 ≥ 字号 × 1.4）约束，“紧凑”档的字幕内行距只比“标准”小约 7%（中号 44.8 px 对 48 px），“紧凑”的效果主要来自字幕间距（48.8 px 对 62 px）。如果业务方希望“紧凑”更紧，需要另行放宽 FR-129，本方案不自行降低。
- **建议，未纳入，待 G2 决定**：在使用引导中加入“调整行距”一条（规格的范围外边界已列出同一建议）。引导第 4 条“调整字号”按人对 OD-1 的答复改写操作路径（TD-809），属于已决定的内容，不在本建议之内。
