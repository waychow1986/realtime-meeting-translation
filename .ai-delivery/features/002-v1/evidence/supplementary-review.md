# G3 独立测试补充复核（候选 720833972d47425ad1f940bae245db5d25894450）

- 被测地址：https://cand-42ad37e84bf9.eastus2.cloudapp.azure.com/
- 测试计划：tasks-qa.md 第 1 版，锁定指纹 `sha256:2f5df71150367e70e92d42b01d64720b40d37cdc95da32ca0f9cf9099aca7174`；脚本 runtime/qa-run.sh 原样执行，未修改计划与产品代码。
- 分阶段：1 个阶段，不请求重部署。
- 浏览器：Playwright 1.65.1 Chromium（Xvfb 有头）、Firefox 159.0、WebKit（仅补充探针）。

## 1. 锁定脚本运行

| 运行 | 时间（UTC） | 结果 | 证据 |
| --- | --- | --- | --- |
| 运行 1 | 约 07:30–07:34 | 23 个场景通过 18 个；脚本记缺陷 IQA-103 c4、IQA-119 c5、IQA-122 c3、IQA-123 c3；未能验证 IQA-114 c4、IQA-123 c1/c2 | `run1-qa-result.json`、`run1-run.log`、`run1-iqa-122-*.json` |
| 运行 2（主证据） | 约 07:38–07:41 | 23 个场景通过 19 个；IQA-122 全部通过；其余失败检查点同上一个候选 | `qa-result.json`、`run.log` 及本目录其他文件 |

两次运行结果的差别只有 IQA-122 c3，见第 3 节。

## 2. 脚本失败检查点的复核与归类

| 检查点 | 脚本结论 | 复核 | 归类 |
| --- | --- | --- | --- |
| IQA-103 c4 临时与定稿样式不同 | 缺陷 | 采样伪影：同一条字幕刚定稿后约 0.5 s 的快照仍带临时样式，下一次快照即为定稿样式（`iqa-103-stream.json`）。IQA-119 c4 同时测得临时为 rgb(182,194,207)、虚线边框，定稿为白色、实线边框，两者不同。 | 非产品缺陷（测试计划问题：采样时机） |
| IQA-119 c5 小窗字号 | 缺陷（小窗 16 px） | 工具伪影：脚本 `context.route('/__qa__/…')` 拦截后，Document PiP 窗口加载不到样式表。用去掉拦截的探针副本复测，主页面和小窗都是 24/32/40/52 px，行高 1.5，生效用时 ≤26 ms（`supp/supp-noroute-iqa-119-sizes.json`、`supp/supp-noroute-run.log`）。该副本中 IQA-122 c5 失败，原因是麦克风素材本来就通过被去掉的拦截提供，属于探针自身的副作用。 | 非产品缺陷（测试计划问题：工具干扰） |
| IQA-123 c3 Firefox 麦克风出中文字幕 | 缺陷 | 环境：容器没有音频输出设备（无 /dev/snd，`enumerateDevices` 只有 audioinput/videoinput）。在空白页新建的 AudioContext 调用 resume 后仍是 suspended，页面一直停在“正在启动…”（`supp/supp-firefox-audio.json`、`supp/supp-firefox-mic.png`）。 | 环境或平台问题 |
| IQA-123 c1/c2 不支持浏览器的按钮与说明 | 未能验证（脚本已标为测试计划问题） | Firefox 159 支持 Document PiP，计划假设 T-A5 不成立。用 WebKit 补充探针：`documentPictureInPicture` 不存在，“弹出字幕小窗”按钮不可用，旁边显示“当前浏览器不支持悬浮字幕小窗。请使用 Windows 或 macOS 上最新版的 Chrome 或 Edge。”（`supp/supp-pip-browsers.json`、`supp/supp-webkit-pip.png`） | 测试计划问题（T-A5），补充探针给出正面证据 |
| IQA-114 c4 reasoning 关闭 | 未能验证（无证据来源） | 服务日志（status ok）中有 451 条 `translation_completed`（partial 380、final 71），全部为 `reasoningTokens: 0`，模型都是 gpt-5.1-2025-11-13。另有 105 条为 `client_aborted`，没有 token 字段（`supp/supp-logs-reasoning.json`）。 | 补充证据，判为满足 |

## 3. 观察：IQA-122 系统声音字幕偶发停止更新（交 G4 判断）

- 现象（只在运行 1 出现）：07:32:40 弹出小窗后约 1.5 s（07:32:41.9）起，主页面与小窗的字幕都停止更新。临时字幕“请不要把这个文档分享给”一直没有定稿；状态始终显示“正在听”，2 条共享轨道保持 live，直到 07:33:19 停止。c2 通过只是因为两边都静止，c3 判失败（15 s 内无新字幕）。见 `run1-iqa-122-timeline.json`、`run1-iqa-122-sync.json`、`run1-run.log`。
- 服务日志在该时段没有与此会话相关的错误。语音识别 WebSocket 由浏览器直连 eastus2.stt.speech.microsoft.com，服务端日志看不到。
- 重复验证：只跑 IQA-122 的探针副本连续 2 次（`supp/supp-iqa122-repeat-r1.log`、`supp/supp-iqa122-repeat-r2.log`），加上锁定脚本完整运行 2，共 3 次全部通过（7 条定稿，关闭小窗后继续更新）。
- 判断：偶发，无法稳定复现，不能区分是产品问题还是外部语音服务或测试环境的瞬时问题。AC-12 按运行 2 判为通过，此现象作为风险观察交 G4。

## 4. S30 修复项核对（观察，不单列验收标准）

- ① 定稿回退闪烁：两次运行的全部字幕时间线（sys-main、iqa-122、mic-main、iqa-106、iqa-107）中，同一条字幕都没有出现文本长度骤降。上一候选 sys-main 曾出现 33→4 字的回退。`iqa-103-stream.json` 显示定稿原位替换临时字幕，长度只增不减。已修复。
- ② 正在听时说明栏自动收起：1366×768 下，“系统声音：操作步骤与支持的浏览器”所在的 details 未开始时展开（open=true），正在听时收起（open=false），停止后重新展开（`supp/s30-sidebar.txt`、`supp/s30-1366-*.png`）。已修复。
- ③ 顶栏：6 个单选输入都不显示原生圆点；1366 宽时顶栏 1 行，480 宽时 2 行（header 高 93 px）；麦克风/系统声音/小/中/大/特大/开始/停止/弹出字幕小窗/使用引导这些无障碍名称都在（`supp/s30-probe.json`、`supp/s30-480-*.png`）。IQA-118/IQA-121 全部通过。已修复。

## 5. 凭据扫描

用注入的 2 个依赖密钥的值逐字节比对本目录全部 100 个文件，命中 0。比对值未写入任何文件或日志。脚本自身的凭据扫描（IQA-115 c1/c2、IQA-116）同样为 0 命中。

## 6. 结论

12 条验收标准都按证据判为通过，没有产品缺陷。依赖补充证据或假设的项目已在结果信封各条 note 中写明：AC-03（采样伪影）、AC-10（日志 reasoningTokens）、AC-11（去掉拦截后的字号探针）、AC-12（WebKit 探针、T-A5 不成立、Firefox 环境问题、IQA-122 偶发观察）。交 G4 复核。
