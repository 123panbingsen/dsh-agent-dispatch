# dsh-agent-dispatch — AI 派工

`npx dsh plugin install dsh-agent-dispatch` · [Issues](https://github.com/123panbingsen/dsh-agent-dispatch/issues) · MIT

> 给 DeepSeek Harness 加一层"AI 外包公司"：接单 → 按能力选模型 → 并行执行 → **换一家模型交叉验收** → 出带账本的交付报告。

**核心能力**

- **三种工人**：`dsh`（进程内子代理）/ `cli`（本机命令行 agent）/ `http`（任意 OpenAI 兼容端点，含生图）。
- **能力路由**：按 `needs`（coding / reasoning / fast / vision / long-context）选模型，不认名字。
- **轮转与熔断**：同类型任务按"最久未用"轮转，避免薅同一家额度；一家出配额/权限错误就整家冷却，不连累其它家。
- **到期优先权**：`useFirstUntil` 让即将下线的模型在截止日前优先吃活，过期自动回落。
- **本机自动发现**：启动时扫描回环网关（CC Switch / Ollama / LM Studio / vLLM）与常见 CLI agent（codex / claude / gemini / opencode / codebuddy …），装好即入列。
- **交叉验收**：产出与验收永远是不同模型；验收失败按 `acceptCriteria` 退回重做。
- **可观测**：右栏看板区分**正式工 / 外包**，绿=正常、蓝=干活中、灰=待机、红=无额度或故障；配置页可直接填 key 与改用接入点。

把一个大目标拆成任务，按**任务需要的能力**路由给这台机器上真实可达的模型执行，并在右侧栏给出实时看板：谁在干什么、用的哪个模型、跑了多久、产出什么。

## 本机资源实测（2026-10-27）

### 已登记的具名工人

| 工人 | 模型路由 | 实测结果 |
|---|---|---|
| `qoder` | `qodercn / dfmodel`（Qoder） | ✅ `QODER`（1.1s）|
| `doubao` | `trae / Doubao-Seed-2.1-Pro`（豆包） | ✅ `DOUBAO`（4.4s）|
| `zcode-flash` | `zcode / GLM-5.3-Flash` | ✅ `ZFLASH`（6.9s）|
| `zcode` | `zcode / GLM-5.3`（智谱） | ✅ `Z53`（12.6s）|
| `vision` | `deepseek-official / deepseek-flash` | ✅ `modalities=text+image` |
| `dsh` | Host 默认 `modlens-our-free-model/z-ai/glm-5.3` | ⚠️ 能跑，但**极慢**：100–151s 回 3–4 个字符 |

默认分工按实测延迟排序，**慢的默认路由垫底当兜底**：

```
implement → zcode, doubao, qoder, dsh
review    → zcode, doubao, dsh
research  → zcode-flash, zcode, dsh
test      → qoder, zcode, dsh
docs      → doubao, zcode, dsh
image     → vision, dsh
any       → doubao, zcode-flash, qoder, zcode, dsh
```

> 想让 `dsh` 不再慢：在 Channel Pack / Models 页把默认模型换成快的，或直接给它写死 `provider`/`model`。

### zcode 的额度经历

2026-10-27 早些时候 `GLM-5.3` 与 `GLM-5.3-Flash` 都返回"额度已用尽或没有可用权益（上游 200 空响应）"；补充账号后两个模型均恢复正常，已放进默认路由。遇到同样报错时先看 Channel Pack 的 ZCode 面板，插件本身不用改配置。

### 为什么这些"本地应用"不能当进程工人

`ZCode`、`Qoder CN`、`豆包` 都是 **Electron 桌面应用**，安装目录里只有 `*.exe` 和 `resources/`，**没有 headless CLI 入口**（和 `kiro`、`buddycn` 一样）。

真正能用的是它们接入 DSH 后的**模型路由**——也就是上表里的具名工人。

能当外部 CLI 工人的只有 `codex`：已登录，但本机 `chatgpt.com` / `api.openai.com` 不可达（HTTP 000），适配器已写好待命。

### 模型目录

`dispatch_models` 实测：**20 个供应商 / 153 条路由**，带 `inputModalities` 与 `contextWindow`。
数据来自 `ctx.llm` 实时注册表（缓存 60 秒），新装供应商自动出现，不用改插件。

## 能力表：自动侦察，不是手写

模型目录只能告诉你**机器事实**（能不能看图、上下文多大）；"谁擅长写代码"是判断，目录不知道。

所以有了 `dispatch_research`：派一个侦察模型，把**实时路由名册**交给它，让它编出能力表，落盘到 `<工作目录>/.agent-dispatch/capabilities.json`。**它报出的每条路由都会对照实时目录核验**——编造或不存在的模型直接丢弃，不会静默错路由。

实测（2026-10-27，153 条路由）：

| 类别 | 侦察结果 |
|---|---|
| coding | `deepseek-official/deepseek-v4-pro`、`lobsterai/kimi-k2.7-code`、`trae/kimi-k3.1-pro` |
| reasoning | `deepseek-official/deepseek-v4-pro`、`trae/kimi-k3.1-pro` |
| fast | `deepseek-official/deepseek-flash`、`trae/glm-5.3-flashx` |
| vision | `trae/glm-5v-turbo`、`trae/kimi-k3.1-pro` |
| long-context | `minimax/MiniMax-M3`、`lobsterai/kimi-k2.7-code` |

编造路由：**0 条**（15 个名字全部真实存在）。

优先级：**配置里显式写的 `capabilities` > 侦察结果 > 模态/上下文事实 > 工人自带路由 > Host 默认**。想临时钉死某一类，在 `config.capabilities` 里写一行即可，其余类别继续吃侦察结果。

## 交叉验收与交付

`outsource_run` 把四段串起来：**接单 → 派单 → 交叉验收 → 交付**。

验收方必须是**另一个模型**（不同 provider/model），返回 JSON 判定；不通过就带着具体问题返工，超过 `maxRework` 次才判失败。判定解析对格式宽容（模型常把 JSON 包在散文或代码围栏里），无法解析时**按通过处理**——一个格式混乱的验收方不该毁掉一份好交付。

实测：

```
交付报告 · 全部通过
run run-45236fb8 · 1 交付 / 0 验收未过 / 0 失败 · 返工 0 次
- 代码任务 [done] deepseek-official/deepseek-v4-pro ✓验收(zcode/GLM-5.3)
```

## 配套：dsh-outsourcing-expert

另一层的插件 [`dsh-outsourcing-expert`](https://github.com/Funny1Potato/dsh-outsourcing-expert)（零依赖，可共存）提供三个 agent preset，从**身份层**强制外包：

- `outsourcing-expert` — 领导的所有干活工具在派发前被 `deny`，只能委派
- `outsourcing-expert-reverse` — 故意挑"最不适合"的模型（要多样性/对抗视角时用）
- `leader` — 不拦截，只注入选模纪律

两层是互补的：**它管"必须外包、该给谁"，本插件管"外包出去怎么跑、谁验收、怎么交付"。**

## 工具

| 工具 | 作用 |
|---|---|
| `dispatch_models` | 列出真实可达的每个模型路由，带模态与上下文窗口。按能力派活前先调它。 |
| `dispatch_workers` | 工人清单 + 每个绑定的路由 + **活/死/未探**。 |
| `dispatch_run` | 派发一轮任务。`wait:false` 立即返回，`wait:true` 等全部收敛。 |
| `dispatch_status` | 每任务状态、工人、**模型**、耗时、token 用量、错误。 |
| `dispatch_result` | 单任务完整输出 + 日志尾部。 |
| `dispatch_cancel` | 取消：排队任务停止，运行中的工人被中止，已完成的保留结果。 |
| `dispatch_capabilities` | 能力表，并标注每个类别的**实际生效路由**与改选原因。 |
| `dispatch_research` | 让侦察模型读全部路由、逐条验活，生成能力表。 |
| `dispatch_probe` | 对指定路由（或整池）真发请求验活，结果写进健康表。 |
| `dispatch_cloud` | 探测 `http` 工人：列 `/models`、逐模型验额度。支持传显式模型 ID。 |
| `outsource_run` | 外包：给目标和任务，按类型自动派给不同工人，交叉验收后出报告。 |
| `outsource_team` | 领导 AI：只给目标，由领导模型拆工单、选人、派发、汇总交付。 |

## 能力路由

路由不认名字，认能力。任务可以声明 `needs`：

```jsonc
{ "id": "shot", "type": "image", "needs": ["vision"],
  "prompt": "读这张界面截图，指出和设计稿的差异" }
{ "id": "deep", "needs": ["long-context"], "prompt": "通读整个仓库后给结论" }
```

- `vision` / `image` → 路由到 `inputModalities` 含 `image` 的模型
- `long-context` → 路由到 `contextWindow` 最大的模型
- 优先级：任务显式 `provider`/`model` > `needs` > 工人自带路由 > Host 默认

实际跑在哪个模型会回写到任务上，看板和 `dispatch_status` 都能看到。

## 任务模型

```jsonc
{
  "goal": "补全这个仓库的测试",
  "maxParallel": 3,
  "tasks": [
    { "id": "scan",  "type": "research",  "prompt": "…" },
    { "id": "write", "type": "implement", "prompt": "…", "dependsOn": ["scan"] },
    { "id": "check", "type": "test",      "prompt": "…", "dependsOn": ["write"] }
  ]
}
```

- `type` ∈ `implement | review | research | test | docs | image | any`，决定工人路由。
- `dependsOn` 里的任务必须**成功**才会解锁下游；上游失败 → 下游 `skipped`（不是静默跑）。
- 依赖成环、依赖不存在，在**任何工人启动前**就报错。
- 默认并发 3（上限 8），单任务硬超时 **10 分钟**，超时杀进程并标记失败。

## 自动重试

失败的任务会**自动重试**，不用手动重新派发：

| 情况 | 行为 |
|---|---|
| 超时 / 供应商报错 / 空回答 | 重试，默认最多 2 次，指数退避（0.8s → 1.6s，上限 10s） |
| 重试仍失败 | 标记 `failed`，带上最后一次的真实原因 |
| **验收未通过且返工用尽** | **不重试**——确定性质量问题，重试只是烧 token |
| **你手动取消** | **不重试**——尊重停止指令 |
| `maxRetries: 0` | 关闭重试 |

**能力路由会故障转移**：能力表给的是「这几个模型都合适」的**有序列表**，不是「第一个今天一定能用」。首选路由失败（key 过期、账号禁用、路由下线）时，下一次尝试自动换下一个候选，并把这些候选和**整个实时目录**混在一起按健康度重排。

排名三条规则：

1. **最近失败过的路排到后面**（默认 10 分钟内有效，记在 `<工作目录>/.agent-dispatch/route-health.json`）——一把死掉的 key 不该在每一单上重复试。
2. **`providerPreference.last` 里的供应商排最后**（默认把官方 `deepseek-official` / `deepseek-account` 垫底）——第三方先上，官方兜底。
3. **能力表没点名的路由从目录补齐**——三候选过期了也绝不会让任务无路可走。

实测（`run-d54052a4`）：

```
- 登录接口说明 [done] modlens-our-free-model/z-ai/glm-5.3 ✓验收(zcode/GLM-5.3) 重试2次 49s
- 风险点评     [done] modlens-our-free-model/z-ai/glm-5.3 ✓验收(zcode/GLM-5.3) 重试2次 95s
```

链路上 `lobsterai`（账号禁用）→ `trae/kimi-k3.1-pro`（无凭证）→ 落到可用路由；**官方 `deepseek-official`（key 失效）一次都没被尝试**，因为第 1、2 条规则把它排到了后面。

**验收方按"权重是否相同"判独立**，不是按供应商。模型名先归一化再比：去厂商命名空间（`z-ai/glm-5.3` → `glm-5.3`）、去大小写差异、去 `-free`/`-preview` 这类后缀。

| 惩罚分 | 条件 |
|---|---|
| +16 | 该路由最近失败过 |
| +8 | **权重相同**（同一模型，只是换了入口）|
| +4 | 同一模型家族（`glm-5.3` vs `glm-5.3-flash`）|
| +2 | 同一供应商 |

分数最低者当选。所以交付在 `modlens-our-free-model/z-ai/glm-5.3` 时，`zcode/GLM-5.3` **不会**被当成独立意见（同一套权重），验收方会落到 `Doubao-Seed-2.1-Pro` 这种真正不同的模型上。

**验收方挂了不会毁掉交付**：验收方本身调用失败（key 失效、路由不通）时，验收被**跳过**并记录 `accept skipped, reviewer failed: …`，产出照常交付——一个坏掉的验收方不该否定一份好产出。

失败原因与重试次数都写进日志（`attempt N failed, retrying: …`）和交付报告（`重试 N 次`）。

## 配置

`cordis.patch.yml` 里本行的 `config`（当前仓库内就是最终值）：

```yaml
- id: agent-dispatch
  config:
    stateDir: .agent-dispatch
    timeoutMs: 600000
    maxParallel: 3
    workers:
      - id: dsh
        kind: dsh
      - id: doubao
        kind: dsh
        provider: trae
        model: Doubao-Seed-2.1-Pro
    routing:
      implement: [dsh, doubao, qoder]
      test: [qoder, dsh]
```

### 工人类型

- **`dsh`**（进程内）：`ctx.agents.create()` 起子代理 → `followup()` 下指令 → 订阅 `session/event` 等 `turn/end` → 从 `assistant/message` 取文本。`provider`/`model` 指定用哪个模型。
- **`cli`**（子进程）：按命令模板启动，占位符 `{prompt}` `{cwd}` `{outfile}` `{task}`。成功且 `{outfile}` 有内容时优先取该文件，否则用 stdout。

## 本机模型（http 工人）

`http` 工人接任何 **OpenAI 兼容端点**，把跑在这台机器上的模型变成可派工的工人：

```yaml
workers:
  - id: local
    kind: http
    baseUrl: http://127.0.0.1:1234/v1     # LM Studio
    model: qwen2.5-7b-instruct
  - id: ollama
    kind: http
    baseUrl: http://127.0.0.1:11434/v1    # Ollama
    model: qwen2.5:7b
```

支持 LM Studio、Ollama、vLLM、llama.cpp server、LocalAI。`baseUrl` 指向 `/v1` 前缀，插件自动请求 `/chat/completions`，并在 `dispatch_workers` 里探测 `/models` 报告可达性。

### 本机实测（2026-10-27）

| 探测项 | 结果 |
|---|---|
| 推理服务端口（11434/1234/8080/8000…） | 无服务监听 |
| 运行时（ollama / lms / llama-server / vllm） | 均未安装 |
| 本地权重（.gguf/.safetensors） | 无 LLM；只有 `u2net`/`birefnet` 两个抠图 ONNX |
| 独立显卡 | 无 `nvidia-smi` |

结论：这台机器**目前没有任何可用的本地模型**，插件里能跑的都是网络路由。`lms` 只是 LM Studio 的 CLI（随应用一起发布），单独装它不会带来模型。

## 侦察 → 验活 → 落表

能力表不是「侦察兵说什么就是什么」。完整链路：

1. **只给活路由**：已知死路直接剔除，**探测验证过活的排最前**，交给侦察兵（最多 60 条，多了它也理不清）。
2. **逐个真探测**：侦察兵选出的**每一条**路由，落表前都发一次真实的一 token 请求。
3. **死了就回填**：某类候选全灭时，从候选池里继续往下探，直到找到一条活的。

所以表里每一行都是**验证过能应答的**，不是「应该有」。

## 探测真可用性

目录里有 ≠ 能用。`dispatch_probe` 用**真实的一 token 请求**验活（走 `llm.stream`，不起子代理、不建会话），结果写进健康记忆：

```
Probed 8 route(s): 3 alive, 5 dead.
- ✓ zcode/GLM-5.3 812ms
- ✗ deepseek-official/deepseek-v4-pro — Authentication Fails, api key invalid
```

默认探测「能力表 + 所有工人路由」，`all: true` 才扫全目录（153 条，费额度）。

## 看板

右栏 `AI 派工` 标签页：轮询 `/api/agent-dispatch/state`（2s，页面隐藏降频 8s），点任务展开输出与日志尾部，任务行显示实际模型。HTTP 路由走 `ctx.connection.requestRejection` 鉴权，未带浏览器会话返回 401。

## 状态

`<工作目录>/.agent-dispatch/state.json`，日志在 `<工作目录>/.agent-dispatch/logs/<runId>/<taskId>.log`。保留最近 20 轮；写盘按文件路径串行化 + 唯一临时名原子替换。

## 已知限制

- **没有生图路由。** 153 条路由里 `inputModalities` 只有 `text`/`image`（读图），**没有任何图像生成**能力。`needs:["vision"]` 是"能看图"，不是"能画图"。要生图请加一个指向你自己生图命令的 `cli` 工人。
- 看板文案是中文硬编码，没走 `ctx.locale`（插件管理器标题/描述是双语的）。
- 新增工具进入已存在的会话，通常需要新开会话或重启应用；看板刷新页面即可。
