---
name: keve-bddcase-gen
description: Generate structured BDD test cases from requirement documents and code changes. Produces test-cases.yaml with functional module grouping, case ID, description, steps (When), expected results (Then), and preconditions (Given).
allowed-tools: Bash(shell:*) Bash(git:*) Bash(npx:*) ask_user_questions
---


> 目录结构参见 keve_test_spec/keve.yaml 顶部注释（Single Source of Truth）
# 测试用例生成技能 (Test Case Generation Skill)

## 触发条件

本技能在以下场景触发（按优先级排列）：

| 触发方式 | 场景 | 说明 |
|----------|------|------|
| `use_skill("keve-bddcase-gen")` | 需求开发阶段，规划完成后需要生成测试用例 | 在 workflow-req-plan 流程中，PRD 分析完成后加载 |
| `/keve-bddcase-gen` 指令 | 用户主动要求生成测试用例 | 兼容指令，类似 `/plan`、`/work` |
| MR Review | 分析 MR 变更影响，生成回归测试用例 | 用户说"分析这个 MR"或"看看这个 MR 有什么测试点" |

**与项目 AGENTS.md 的衔接**：

在需求开发路径中，本技能应在 **2.1 规划阶段** 中被 workflow-req-plan 加载，产出 `test-cases.md` 后再进入编码阶段。

```
Intent A: 需求开发
  → 2.0 阶段检测
  → 2.1 规划阶段 (workflow-req-plan)
      → use_skill("keve-bddcase-gen") → 产出 test-cases.yaml
  → 2.2 编码阶段 (workflow-req-work)
```

---

## 定位

本技能从需求文档和代码变更中提取测试点，生成结构化的测试用例文档。

```
需求文档 + 代码变更 → [本技能] → test-cases.yaml
```

---

## 核心原则

**1. 需求与代码不一致时，以代码为准，并在结论中标注差异**。
**2. 每一步骤必须有对应的预期结果**

---

## 输入

| 输入类型 | 来源 | 说明 |
|----------|------|------|
| 需求文档 | PRD 链接 / Docs 文档 / Figma 链接 | 业务需求、功能描述、交互设计 |
| 代码变更 | MR diff / git diff / 提交历史 | 变更涉及的文件和功能模块 |
| 现有代码 | 仓库源代码 | 理解变更前后的组件结构 |

---

## 输出

生成 `test-cases.md`，格式遵循以下规范：

### 输出格式规范

**只输出 YAML 格式**，不再输出 Markdown 格式。
> `test-cases.yaml` 的字段设计（module/case_id/steps/expected）遵循 Playwright 规范，可直接映射为 describe 块、test title 和断言。

详见 [references/test-case-rules.md](references/test-case-rules.md)

### 输出路径规范

本技能产出的测试用例统一存放于 `.keve/mr-${当前分支名或者MR_id}-temp` 目录下：

```
.keve/mr-XXX-temp
├── test-cases.yaml    # 当前需求测试用例文档（测试计划）
```

---

## 生成流程

### Step 1: 需求理解

读取需求文档（PRD / Docs / Figma），提取：
- 新增/修改的功能点列表
- 交互设计变更点
- 业务规则变更点
- 权限/状态变更点

### Step 2: 代码变更分析

**优先使用 GitNexus（如果项目已索引）**，获取更深层的影响分析；若无 GitNexus 则回退到 git diff。

#### GitNexus 模式（推荐）

使用 GitNexus MCP 工具获取变更影响：

| 工具 | 用途 | 产出 |
|------|------|------|
| `detect_changes()` | 分析 MR/分支的所有未提交变更 | 受影响的符号列表 + 受影响的执行流程 + 风险等级 |
| `impact({target, direction:"upstream"})` | 分析变更符号的爆炸半径 | 直接调用者 + 间接影响者 + 受影响模块 |
| `query({query})` | 查找相关执行流程 | 按相关性排序的流程 + 涉及的符号和文件 |
| `context({name})` | 查看符号的完整上下文 | 所有调用者/被调用者/参与的流程 |

**分析流程**：

```
1. detect_changes() → 获取 MR 变更涉及的符号和执行流程
2. 对每个变更符号 → impact(target, "upstream") → 获取受影响的调用链
3. 对每个受影响的执行流程 → query() → 理解完整业务流程
4. 输出: 变更功能点列表 + 受影响的执行流程 + 风险评估
```

**示例输出**：

```json
{
  "changedSymbols": ["AgentList.vue", "SkillItem.vue", "ToolManagement.vue"],
  "affectedProcesses": ["AgentListFilter", "SkillEditFlow", "ToolAuthFlow"],
  "riskLevel": "MEDIUM",
  "blastRadius": {
    "AgentList.vue": { "directCallers": 3, "affectedModules": ["智能应用管理"] },
    "SkillItem.vue": { "directCallers": 5, "affectedModules": ["技能市场", "技能详情"] }
  }
}
```

#### Git Diff 模式（回退）

如果项目未索引 GitNexus，回退到传统方式：

```bash
git diff origin/main...HEAD --stat          # 变更文件列表
git diff origin/main...HEAD --name-only     # 文件名列表
git diff origin/main...HEAD src/pages/       # 具体变更内容
```

输出：变更涉及的文件列表 + 每个文件的核心变更内容 + 变更前后的行为差异

### Step 3: 按功能模块分组

将变更点按**功能模块**分组，每个模块对应一个涉及文件集合：

```
功能模块 = 变更涉及的一个或多个组件文件 + 关联的业务功能点
```

分组原则：
- 一个功能模块对应一组相关的组件文件
- 同一页面的不同功能区域（如筛选、列表、弹窗）应分开
- 跨页面的功能（如导航、布局）独立成模块

### Step 4: 为每个模块生成测试用例

对每个功能模块，从以下维度生成用例：

| 维度 | 用例类型 | 说明 |
|------|----------|------|
| 正向验证 | 功能点正常行为 | 验证新功能/修改功能是否按预期工作 |
| 边界验证 | 极端情况 | 空/满/超长/零值 |
| 权限验证 | 不同角色/状态 | 管理员 vs 普通用户、创建者 vs 协作者 |
| 禁用验证 | 功能下线 | 禁用按钮、禁用选项、下线提示 |
| 回归验证 | 跨页面完整流程 | 创建 → 编辑 → 删除完整流程 |

### Step 5: 不确定时向用户确认

在生成用例过程中，如果遇到以下不确定情况，**必须暂停并向用户确认**：

| 不确定情况 | 确认问题示例 | 处理方式 |
|------------|--------------|----------|
| **数值不一致** | "欢迎语最大字符限制是多少？PRD描述为200，代码中MAX_LENGTH=300，以哪个为准？" | 提供选项让用户选择 |
| **数据存在性** | "测试环境中是否存在天策门户类型的智能应用？" | 是/否，是则继续问具体ID |
| **具体数值** | "天策门户Agent的ID是多少？" | 等待用户输入具体值 |
| **环境配置** | "测试需要特定的环境配置（如登录态、权限），请确认测试环境是否已配置" | 确认环境就绪后再生成用例 |
| **需求理解歧义** | "PRD中描述的功能A有两种理解方式：1) xxx 2) yyy，请确认哪种是正确的" | 确认后再继续生成 |
| **测试范围边界** | "这个功能是否包含子功能B？请确认测试范围" | 明确范围后再生成 |

**确认流程**：

```
1. 识别信息缺口 → 2. 将大问题拆分为小问题 → 3. 逐个向用户提问 → 4. 等待用户回复 → 5. 根据回复继续/调整
```

**信息缺口识别机制（推荐模式）**：

将确认拆分为多个独立小问题，每个问题聚焦一个具体信息缺口：

```
问题1: 欢迎语最大字符限制是多少？
  ├─ 选项A: 300字符（代码中 MAX_LENGTH=300）← 推荐
  ├─ 选项B: 200字符（PRD描述为200）
  └─ 选项C: 其他（请确认具体数值）

问题2: 测试环境中是否存在天策门户类型的智能应用？
  ├─ 是（继续问问题3）
  └─ 否 → 跳过相关用例

问题3: 天策门户Agent的ID是多少？
  └─ 输入: _______
```

**设计原则**：
- 每个问题只问一个具体信息缺口
- 问题之间有依赖关系（"是否存在"决定是否需要问"具体ID"）
- 提供明确的选项，避免开放式问题
- 推荐选项应标注理由（如"代码中实际限制为300"）
- 提供"无需补充，继续"或"跳过"选项

**使用 `ask_user_questions` 工具提问**：

当需要用户确认时，使用结构化的问题格式：

```json
{
  "questions": [
    {
      "question": "欢迎语最大字符限制是多少？",
      "options": [
        {
          "label": "300字符",
          "description": "代码中 MAX_LENGTH=300，以代码为准",
          "isRecommended": true
        },
        {
          "label": "200字符",
          "description": "PRD描述为200",
          "isRecommended": false
        },
        {
          "label": "其他",
          "description": "请确认具体数值",
          "isRecommended": false
        }
      ]
    },
    {
      "question": "测试环境中是否存在天策门户类型的智能应用？",
      "options": [
        {
          "label": "是",
          "description": "环境中存在TC类型Agent，可以继续测试",
          "isRecommended": false
        },
        {
          "label": "否",
          "description": "环境中没有TC类型Agent，跳过相关用例",
          "isRecommended": true
        }
      ]
    }
  ]
}
```

**提问原则**：
- 每个问题必须有明确的选项
- 必须提供推荐选项及理由
- 避免开放式问题（如"怎么办？"）
- 问题要具体，包含必要的背景信息
- 大问题拆分为小问题，逐个确认

**信息缺口记录**：

所有识别到的信息缺口和用户回答，记录在 `.keve/info-gaps.md` 中：

```markdown
## 信息缺口记录

| 缺口ID | 问题 | 用户回答 | 影响用例 | 状态 |
|--------|------|----------|----------|------|
| IG-001 | 欢迎语最大字符限制 | 300（以代码为准） | WW-001, WW-002 | resolved |
| IG-002 | TC类型Agent是否存在 | 是，ID=636 | AG-004 | resolved |
| IG-003 | DATASET类型Agent是否存在 | 否 | AG-005 | skipped |
```

### Step 6: 生成回归测试

对整体变更，生成 2-3 条回归测试：
- 完整创建流程（从进入页面到创建成功）
- 核心交互流程（从列表到详情到编辑）
- 删除/移除残留检查（检查旧代码引用是否已清理）

### Step 7: 输出 test-cases.yaml

按照格式规范输出完整的测试用例文档。详见 [references/test-case-example.md](references/test-case-example.md)

---

## 质量校验（自检清单）

生成完成后，对照以下清单自检：

详见 [references/test-case-rules.md](references/test-case-rules.md)

| 检查项 | 通过条件 |
|--------|----------|
| 步骤-预期一一对应 | 每个操作步骤都有对应的预期结果，不存在"无预期的步骤" |
| 用例ID覆盖度 | 每个变更的功能点都有对应的用例ID |
| 预期结果可验证性 | 每个预期结果都能映射为具体的 Playwright 断言 |
| 模块分组完整性 | 每个变更涉及的文件都被某个模块覆盖 |
| 操作步骤具体性 | 步骤描述足够具体，可以直接转化为 POM 方法调用 |
| 回归测试覆盖 | 至少有 1 条跨页面完整流程的回归测试 |
| 用例ID唯一性 | 同一模块内用例ID不重复 |
| 无降级预期 | 关键业务步骤的预期不是"页面可见"这种浅层断言 |

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 需求文档无法访问 | 记录错误，尝试从代码变更反推需求 |
| 代码变更分析失败 | 回退到手动分析，标记风险 |
| 用例生成中断 | 保存已生成部分，从中断点继续 |
| 用户确认超时 | 使用默认选项继续，标记不确定性 |

## 版本控制

| 版本 | 说明 |
|------|------|
| `test-cases.yaml` | 当前版本（每次生成覆盖） |
| `test-cases-v{N}.yaml` | 历史版本（保留最近5个版本） |
| `test-cases.yaml.bak` | 备份版本（生成前自动备份） |

---

## References

- [test-cases-example.md](references/test-cases-example.md) — 完整的测试用例文档示例（MR !868）
- [test-case-rules.md](references/test-case-rules.md) — 用例生成与校验规则（ID命名、预期编写、输出格式、自检清单、核心原则）