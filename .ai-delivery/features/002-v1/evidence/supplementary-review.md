# G3 独立测试补充复核（候选 44c6bd7ee5f290b3d935eb380dcfe0f5e68b6b4a）

- 被测地址：https://cand-42ad37e84bf9.eastus2.cloudapp.azure.com/（服务日志显示 07:58:34 新启动，本次测试全部在该部署上执行）
- 测试计划：tasks-qa.md 第 1 版，锁定指纹 `sha256:2f5df71150367e70e92d42b01d64720b40d37cdc95da32ca0f9cf9099aca7174`。脚本 runtime/qa-run.sh 原样执行，没有修改计划和产品代码。
- 分阶段：1 个阶段，不请求重部署。
- 浏览器：Playwright 1.65.1 Chromium（Xvfb 有头）、Firefox 159.0、WebKit 27.2（WebKit 只用于补充探针）。
- 本目录原有证据来自上一个候选 720833972d…，已全部移出。现有文件都是本次针对 44c6bd7 产生的。

## 1. 锁定脚本运行

| 运行 | 时间（UTC） | 结果 | 证据 |
| --- | --- | --- | --- |
| 运行 1 | 08:00:03–08:03:06 | 23 个场景中 19 个通过。脚本记为缺陷的检查点：IQA-103 c4、IQA-119 c5、IQA-123 c3。未能验证的检查点：IQA-114 c4、IQA-123 c1/c2 | `qa-result.json`、`run.log`、`setup.log` 及本目录其他文件 |

其余场景全部通过：IQA-101、102、104–113、115–118、120–122。

## 2. 脚本失败检查点的复核与归类

| 检查点 | 脚本结论 | 复核 | 归类 |
| --- | --- | --- | --- |
| IQA-103 c4 临时与定稿样式不同 | 缺陷 | 采样时机问题。`iqa-103-stream.json` 中，第 1 句在 t=…028310 首次标为 final 时，样式签名仍是临时样式；600 ms 后的下一次快照已变为定稿样式：白色、实线边框。临时样式为 rgb(182,194,207)、虚线边框。脚本只比较了刚定稿的那一帧。IQA-119 c4 在同一候选上测得两者不同，检查通过。 | 非产品缺陷（测试计划问题：采样时机） |
| IQA-119 c5 小窗字号 | 缺陷（小窗 4 档都是 16 px） | 这是测试工具造成的假象。补充探针 `supp/supp-probe.json` 在同一候选、同一 Chromium 上做了对照：不设 `context.route` 时，小窗字幕为 24/32/40/52 px，行高为字号的 1.5 倍，小窗载入了 `/styles.css`（93 条规则）；只加一条与脚本相同、仅拦截 `/__qa__/` 的 `context.route` 时，小窗样式表没有载入（`styleSheets`=0），字号都是 16 px，行高为 normal。主页面 24/32/40/52 px 由锁定脚本测得，生效用时 ≤14 ms。截图见 `supp/supp-probe-pip-main-*.png`。 | 非产品缺陷（测试计划问题：工具干扰） |
| IQA-123 c3 Firefox 麦克风出中文字幕 | 缺陷 | 环境原因。容器没有音频输出设备（没有 /dev/snd，`enumerateDevices` 只返回 audioinput、videoinput）。在被测页面中新建的 AudioContext 调用 resume 后仍是 suspended（`supp/supp-firefox-audio.json`）。Chromium 的麦克风模式（IQA-113、IQA-122 c5）全部通过。 | 环境或平台问题 |
| IQA-123 c1/c2 不支持浏览器的按钮与说明 | 未能验证，脚本已标为测试计划问题 | Firefox 159 支持 Document PiP，所以计划假设 T-A5 不成立。改用 WebKit 27.2 做补充探针：页面没有 `documentPictureInPicture`，“弹出字幕小窗”按钮为禁用状态，旁边显示“当前浏览器不支持悬浮字幕小窗。请使用 Windows 或 macOS 上最新版的 Chrome 或 Edge。”（`supp/supp-probe.json`、`supp/supp-probe-webkit-pip.png`） | 测试计划问题（T-A5）；补充探针给出了满足要求的证据 |
| IQA-114 c4 reasoning 关闭 | 未能验证（无证据来源） | 服务日志状态为 ok、无 gaps、未丢弃。日志中共 215 条 `translation_completed`：173 条正常完成（partial 142、final 31），全部为 `reasoningTokens: 0`，模型都是 gpt-5.1-2025-11-13；另外 42 条为 `client_aborted`，没有 token 字段（`supp/supp-logs-reasoning.json`）。IQA-114 c1/c2/c5 已证明翻译调用指向注入的大模型部署。 | 补充证据，判为满足 |

## 3. 观察：服务端 unhandled_error（不影响验收，交 G4 参考）

- 服务日志中有 34 条 `unhandled_error`（route `/api/translations`，errorCode `internal_error`）。它们全部与同一 reqId 的 `translation_completed errorCode=client_aborted` 对应，即客户端中止了已被新结果取代的翻译请求。其中 partial 29 条，final 5 条。
- 返回客户端的 `/api/translations` 响应全部为 200（173 条），用户侧看不到错误。IQA-105（顺序、不重复、不遗漏）与 IQA-122 均通过。
- 判断：这是服务端处理客户端中止时的日志噪声，不对应任何验收标准的失败行为，不计为产品缺陷。建议后续交付在服务端把客户端中止作为正常情况处理。

## 4. S30 修复项核对（观察，不单列验收标准）

- ① 定稿回退闪烁：用 `supp/supp-s30-length-drop.json` 检查 5 份字幕时间线（sys-main、iqa-122、mic-main、iqa-106、iqa-107），规则是同一位置的字幕在相邻快照之间长度降到原来的 60% 以下且减少 5 字以上。结果是 0 次骤降。`iqa-103-stream.json` 中，定稿原位替换了临时字幕，长度只增不减。
- ② 说明栏自动收起：1366×768 和 480×800 下，“系统声音”说明 details 未开始时展开，正在听时收起，停止后重新展开（`supp/supp-s30.json`）。
- ③ 顶栏：6 个单选控件都不显示原生圆点；顶栏高度在 1366 宽时为 57 px（1 行），在 480 宽时为 93 px（2 行）。麦克风、系统声音、小、中、大、特大、开始、弹出字幕小窗、使用引导这些无障碍名称都在。IQA-118 与 IQA-121 全部通过。

## 5. 凭据扫描

用注入的 2 个依赖密钥值逐字节比对本目录全部 90 个文件，命中 0 次。比对值没有写入任何文件或日志。脚本自身的凭据扫描（IQA-115 c1/c2、IQA-116）同样命中 0 次。

## 6. 结论

12 条验收标准都按证据判为通过，没有发现产品缺陷。依赖补充证据或假设的项目已在结果信封各条的 note 和 assumptions 中写明：AC-03（采样时机）、AC-04/AC-10（日志 reasoningTokens）、AC-11（不拦截请求时的字号探针）、AC-12（WebKit 探针；T-A5 不成立；Firefox 为环境问题）。AC-05 中的浏览器“停止共享”按 G2 决定 I1 以 IQA-107 作为等效证据。交 G4 复核。
