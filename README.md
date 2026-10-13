# Cli Diff Review

Cli Diff Review 是一个面向 CLI Coding Agent 的 VS Code 扩展。

它自动识别 Git 工作区中的代码变更，并提供类似 Cursor、GitHub Copilot 的逐块审阅体验。无论代码由 Codex、Claude Code、Gemini CLI 或其他工具生成，都可以在同一个界面中查看、接受、拒绝和撤销变更。

同时，插件参考 [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 理念为项目建立可持续更新的本地知识库，使项目知识能够被 Coding Agent 和 Review Agent 感知，并结合工作区或分支差异提供 按需多 Agent AI Review。

> 🎬 项目介绍视频：[点击观看](VIDEO_URL)

## 核心原理

插件通过 Git 检测代码变化，以暂存区内容作为基线，将工作区中的未暂存修改转换为可审阅的 Diff Chunk，并在 VS Code 中高亮呈现。

许多 CLI Coding Agent 更关注任务执行，代码变更会直接写入工作区；部分交互流程还需要先接受当前变更，才能继续处理下一处修改。这使用户很难等 Agent 完成全部工作后，再对所有变更进行一次统一审阅。

终端中的 Diff 通常也只展示变更内容及其上下文，缺少完整的代码浏览能力，难以直接进行定义和引用跳转。

Cli Diff Review 将代码生成与代码审阅分离，通过 Git 汇总 Agent 产生的工作区变更，并在 VS Code 中提供统一的后置审阅体验。

你可以：

- 在 Agent 完成修改后统一审阅全部变更、按代码块或文件接受、拒绝和撤销变更
- 浏览完整文件，并从变更位置跳转到定义或引用
- 在修改之间快速跳转

这种方式不要求 Coding Agent 主动接入插件。只要 Agent 修改了 Git 工作区，Cli Diff Review 就能补充类似 Cursor 和 GitHub Copilot 的后置 Review 体验。

**交互说明**

修改区块保留浅红／浅绿背景，并用更深的背景标记发生变化的完整单词。审查界面与普通编辑器共享文档。未保存时保留上次正式区块供参考，不计算临时差异，并禁用审阅操作；手动保存或自动保存后，统一使用 Git diff 更新区块，完成后恢复操作。字段级高亮只处理正式 Git 区块，超出计算预算时保留行级背景，不改变区块。

![image-20260803194527802](README.assets/image-20260803194527802.png)

**支持多项目变更检测**

![image-20260803192648529](README.assets/image-20260803192648529.png)

**支持代码段/文件级/项目级review操作(接受/拒绝/撤销)**

![image-20260803195316558](README.assets/image-20260803195316558.png)

### 在本地审阅 Pull Request

远程代码仓库提供的 Pull Request Review 通常围绕局部 Diff 展开。面对复杂变更时，很难浏览完整文件、跳转代码定义和引用，AI 生成的修改建议也难以直接应用到本地代码。

Cli Diff Review 可以将分支之间的代码差异提取到当前工作区，复用已有的代码变更检测和审阅能力，无需切换或合并待审分支。

这使 Pull Request 的代码审校可以在完整的本地开发环境中进行，不再受远程代码仓库局部 Diff 交互的限制。
![image-20260803203050359](README.assets/image-20260803203050359.png)

![image-20260803203351042](README.assets/image-20260803203351042.png)



## LLM Code Wiki

本项目的 LLM Code Wiki 基于 Karpathy 的 [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 思路改造。

它用于在 Vibe Coding 过程中为项目建立一个持续更新的本地知识库。知识库可以随代码仓库共享，被插件内置的 AI Review、其他 Coding Agent，以及远程代码仓库中的 Review Agent 感知和使用。

知识库以项目 Skill 的形式存在。初始化后的完整基础结构如下：

```text
AGENTS.md                                  ───── 向 Coding Agent 提供 Wiki 入口与协作规则

.agents/skills/llm-code-wiki/
├── SKILL.md                               ───── Coding Agent 使用知识库的入口
├── .state.json                            ───── 插件维护的运行状态与源码指纹
└── references/
    ├── schema.md                          ───── 知识库结构、维护规则与写入约束
    ├── index.md                           ───── 所有知识页面的导航索引
    ├── overview.md                        ───── 项目目标、用户与主要能力
    ├── architecture.md                    ───── 系统边界、组件关系与数据流
    ├── modules.md                         ───── 模块职责及对应源码位置
    ├── interfaces.md                      ───── 公共 API、命令、协议与数据结构
    ├── workflows.md                       ───── 运行流程与开发工作流
    ├── decisions.md                       ───── 重要设计决策与技术取舍
    ├── open-questions.md                  ───── 尚未确认的问题与不完整结论
    ├── log.md                             ───── 初始化和更新的追加式记录
    └── <其他主题>.md                      ───── 根据项目需要扩展的知识页面
```

插件内置 Agent 负责初始化知识库骨架；在后续开发中，Coding Agent 能够感知并读取该 Skill，与插件更新 Agent 共同维护项目知识。

源码始终是事实来源。知识库使用 Markdown 提炼项目架构、模块职责、开发流程、开发约定和重要设计信息，使项目知识能够随代码持续演进。

### 初始化与更新 Agent

知识库初始化和更新采用相同的多 Agent 流程。初始化会搭建完整知识库，后续更新则根据源码变化维护受影响的内容。

```text
┌──────────────────────────────┐
│ Wiki Planning Agent          │───── 分析项目结构或源码变化，规划需要处理的模块
└──────────────────────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Module Analysis Agents       │───── 并行阅读相关源码和现有 Wiki，输出基于代码事实的模块分析
└──────────────────────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Wiki Integration Agent       │───── 汇总模块分析，创建或更新 Wiki 页面、索引和项目 Agent 指引
└──────────────────────────────┘
```

### 与 RAG 的取舍

LLM Code Wiki 并不是为了替代 RAG。RAG 更适合从大量资料中检索相关内容，而 LLM Code Wiki 更关注如何让 Coding Agent 持续理解并维护当前项目。

| LLM Code Wiki                          | RAG                                  |
| -------------------------------------- | ------------------------------------ |
| 将项目知识整理为结构化 Markdown        | 将文档切分、索引后按问题检索         |
| 内容可读、可编辑，可通过 Git 管理      | 更擅长从大量资料中进行语义召回       |
| Coding Agent 可以直接读取项目 Skill    | Agent 需要接入检索服务               |
| 架构简单，不需要向量数据库和 Embedding | 通常需要额外的索引和存储基础设施     |
| 适合维护架构、模块职责和开发约定       | 适合处理大规模、分散且频繁查询的资料 |
| 依赖 Agent 持续维护内容                | 依赖文档分块、Embedding 和召回质量   |

LLM Code Wiki 的优势是轻量、透明和可版本管理，适合保存 Coding Agent 需要反复参考的项目知识。面对超大型项目或大量非结构化资料时，它的语义检索和信息召回能力通常不如完整的 RAG 系统。

两者关注的问题不同，也可以在更复杂的场景中配合使用。

![image-20260803214840864](README.assets/image-20260803214840864.png)

![image-20260803220059481](README.assets/image-20260803220059481.png)



## AI Review

Cli Diff Review 可以基于当前工作区变更或分支差异运行 AI Code Review。

AI Review 支持：

- 分析代码变更中的潜在问题
- 结合当前源码和 LLM Code Wiki 理解项目上下文
- 检查跨文件调用、配置和集成问题
- 将问题和修改建议关联到具体代码块
- 直接应用或撤销 AI 修改建议

### 主 Agent 与按需子 Agent

审阅由一个主 Agent 发起。小变更直接审阅；需要背景调查时调用 Explore，需要独立审阅时调用 Review，复杂任务可选调用 Plan。只有主 Agent 提交问题、建议和整次审阅结果，子 Agent 提供证据和候选结果。

- `list_changes` 先返回插件检测到的 Chunk 清单，`read_change` 分页读取指定变更；不再把整个 Diff 一次性塞进提示词。
- `Glob`、`Grep`、`Read` 用于查找和读取项目源码、测试、配置及 Wiki。工具只读，不提供 Shell。读取已保存的磁盘代码。
- `spawn_agent` 异步创建子任务；`send_agent_message` 传递消息；`wait_agents` 可选等待；`read_agent_result` 分页读取报告；`cancel_agent` 取消子任务。子 Agent 只有五个读取工具和消息工具。
- `submit_findings`、`submit_suggestions` 校验并保存结果；`get_review_status` 查看任务、预算、覆盖情况；`finish_review` 保存完整或部分审阅结论。共 14 个工具。

每个问题绑定版本化 `chunkRef` 和源码 `evidenceRef`。代码或依赖证据变化后必须重新读取；建议应用前再次校验内容。建议提交本身不会修改文件。

审阅期间插件在下一轮调用前补充已保存代码的净变更通知，不会自动重跑整次审阅。默认允许 5 批通知，第 6 批发送前暂停。点击“继续审阅”会重新扫描，并一次性补报暂停期间的变更；这次恢复通知不占下一段额度。

### 模型、预算与恢复

只支持 DeepSeek、GLM；Base URL、API Key 和模型名由用户配置。已有两家配置保留且无需补填参数。上下文窗口、压缩阈值和最大输出 Token 均为可留空的普通输入框。未填写窗口时仍可审阅，但不自动压缩；压缩阈值默认已占用 40%，最大输出默认 12,000 Token（填写较小窗口时，默认值相应降至窗口的四分之一）。

设置中的 `cliDiff.aiReviewAutoCompress` 默认关闭，启用后才会自动压缩。压缩使用同模型的内部无工具请求，分段提炼历史，再合并插件保存的任务、引用及结果状态；校验成功后才替换上下文。固定提示词和工具允许时，目标是将输入降到窗口的 25% 以下。失败保留原历史并继续；关闭压缩不会因本地估算超限而暂停。模型实际拒绝请求时保存进度，提供“继续审阅”。

默认整次审阅预算为 1,000,000 Token，主 Agent、子 Agent、重试和压缩共同计费；恢复不清零。优先使用接口 usage，没有 usage 时采用保守估算并标注。默认最多 5 个活跃子 Agent，主 Agent 单独计算。每段默认 32 轮，继续时获得新一段轮数。

失败或中断后沿用原审阅 ID 和各 Agent 历史，从未完成的工具继续；不会重新创建已保存的子任务或重复提交结果。更换厂商或模型需新建审阅。旧 Auto/Multi/FileOnly 流程、设置及旧审阅 checkpoint 不再兼容。

观测界面按“主 Agent → round → 子任务 → 子 Agent rounds”展开。默认只传摘要，点击查看时分页加载详细请求和响应；压缩、变更通知、失败及恢复分别记录为事件。

![image-20260803201424106](README.assets/image-20260803201424106.png)

![image-20260803201627136](README.assets/image-20260803201627136.png)
