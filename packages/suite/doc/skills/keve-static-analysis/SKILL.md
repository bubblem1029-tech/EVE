---
name: keve-static-analysis
description: 全栈静态分析：tsc+eslint 编译检查 + Code-Graph 关系分析 + Git 变更影响分析 + 安全漏洞扫描。AI 按优先级自动修复类型/lint 错误，输出依赖风险、变更影响范围和安全评级报告。
allowed-tools: Bash(shell:*) Bash(npx:*) Bash(npm:*) Bash(node:*) Bash(git:*) Bash(pnpm:*) Bash(yarn:*) codegraph_search codegraph_explore codegraph_callers codegraph_callees codegraph_impact codegraph_files
---

# keve-static-analysis

## 定位

**本技能负责**：四阶段静态分析，作为测试流水线的**第一步**。

- Phase 1: tsc + eslint → 语法/类型/规范错误（P0 必修）
- Phase 2: Code-Graph → 依赖关系/架构违规/死代码（P1 建议修）
- Phase 3: Git 分析 → 变更影响范围/热点文件（P2 信息参考）
- Phase 4: 安全扫描 → 漏洞/密钥/运行时风险（P1~P0 按评级）

***

## 触发条件

| 触发方式 | 场景 | 说明 |
|----------|------|------|
| `use_skill("keve-static-analysis")` | 测试流水线第一步 | 由 keve-dev-test-agent 或 keve-test-agent 调度 |
| `/keve-static-analysis` 指令 | 用户主动要求静态检查 | 手动触发 |

***

## 输入

- 项目源码（`src/` 目录）
- `tsconfig.json`（TypeScript 配置）
- `.eslintrc.*` 或 `eslint.config.*`（ESLint 配置，可选）
- `.codegraph/` 索引（如不存在，需先 `codegraph init -i`）

***

## 流程

### Phase 1: tsc + eslint（P0 必修）

#### Step 1: TypeScript 检查

```bash
npx tsc --noEmit --pretty false 2>&1
```

解析输出，按文件分组：
- 格式：`src/path/file.ts(line,col): error TSXXXX: message`
- 提取：文件路径、行号、错误码、错误消息
- 分组：`Map<filePath, TSError[]>`

#### Step 2: ESLint 检查

```bash
npx eslint src/ --format json 2>&1
```

解析 JSON 输出，按规则分组：
- 格式：`[{ filePath, messages: [{ ruleId, severity, message, line, column }] }]`
- severity: 1=warning, 2=error
- 分组：`Map<ruleId, LintMessage[]>`

#### Step 3: 按优先级修复

| 优先级 | 类型 | 修复策略 |
|--------|------|---------|
| P0 | TS 类型错误 | 修复类型标注、接口定义、导入路径 |
| P1 | ESLint error | 自动修复（`--fix`）或手动修复 |
| P2 | ESLint warning | 可选修复，不阻塞 |

**修复约束**：
- **禁止修改业务逻辑**，只修类型标注和代码风格
- **禁止添加 `@ts-ignore` / `@ts-nocheck`** 掩盖错误
- **禁止删除 ESLint 规则配置**来绕过检查

**每轮修复后重新验证**（最多 3 轮）。

### Phase 2: Code-Graph 关系分析（P1 建议修）

> Code-Graph 内部基于 Tree-sitter 构建 AST→符号→图索引，
> 不需要单独引入 Tree-sitter。

#### Step 4: 循环依赖检测

```
1. codegraph_files() → 项目文件结构
2. 对每个模块目录调用 codegraph_explore("import from module")
3. 识别 A→B→C→A 环路
4. 输出: ["src/utils/a.ts → src/store/b.ts → src/utils/a.ts"]
```

#### Step 5: 幽灵依赖检测

```
1. 读取 package.json 的 dependencies + devDependencies
2. 扫描源码中所有 import/from 语句
3. 对比: import 了但 package.json 没有声明的包 = 幽灵依赖
4. codegraph_callees("外部模块名") → 验证调用关系
5. 输出: [{ package: "lodash", file: "src/utils/format.ts", declared: false }]
```

#### Step 6: 死代码检测

```
1. codegraph_search("*") → 列出所有符号
2. codegraph_callers("符号名") → 无调用者的非导出函数 = 死代码
3. 排除: export 的函数（可能被外部使用）
4. 输出: [{ symbol: "formatCurrency", file: "src/utils/format.ts", callers: 0 }]
```

#### Step 7: 架构违规检测

```
1. codegraph_explore("import patterns") → 查看跨目录导入
2. 检测违规模式:
   - common/ import src/ → 反向依赖
   - utils/ import components/ → 层级违规
   - services/ import pages/ → 层级违规
3. 输出: [{ from: "common/utils/a.ts", to: "src/components/B.vue", rule: "common 不应 import src" }]
```

#### Step 8: 圈复杂度检测

```
1. codegraph_search("*") → 列出所有函数
2. 对每个函数: codegraph_node("函数名", includeCode=true) → 获取函数体源码
3. AI 计算决策点: if + else if + for + while + case + catch + && + || + 三元表达式
4. 圈复杂度 = 1 + 决策点数
5. 阈值: ≤10 正常, 11-20 ⚠️偏高, >20 🔴过高
6. 输出: [{ symbol: "handleSubmit", file: "src/pages/Form.vue", cyclomatic: 22 }]
```

**Phase 2 不自动修复**，只输出建议列表。

### Phase 3: Git 变更分析（P2 信息参考）

#### Step 9: 当前变更范围

```bash
git diff --name-only HEAD~1    → 本次提交修改了哪些文件
git diff --name-only --cached  → 暂存区变更
```

#### Step 10: 变更影响范围

```
codegraph_impact("改动的函数名")  → 计算受影响的调用者链
```

#### Step 11: 热点文件分析

```bash
git log --format="%H" --since="30 days ago" | xargs git diff-tree --no-commit-id --name-only -r | sort | uniq -c | sort -rn | head -20
```

→ 最近 30 天高频变更的文件 = 不稳定区域，需要更多测试覆盖

### Phase 4: 安全扫描（P1~P0 按评级）

#### Step 12: 依赖漏洞扫描

```bash
npm audit --json 2>&1
# 或
pnpm audit --json 2>&1
```

#### Step 13: 代码安全规则扫描

```bash
npx eslint src/ --plugin security --format json 2>&1
```

检测：eval / ReDoS / innerHTML / 动态正则 / 属性注入

#### Step 14: 硬编码密钥扫描

```bash
npx gitleaks detect --no-git --source . --report-format json 2>&1
```

#### Step 15: 运行时风险扫描

```bash
npx eslint src/ --plugin promise --plugin sonarjs --plugin vue --format json 2>&1
```

检测：Promise 未 catch / setInterval 未清理 / addEventListener 未移除 / v-html XSS

**安全扫描不自动修复**（误报率高，输出报告由人工确认）。

***

## 产出

| 产出 | 路径 | 说明 |
|------|------|------|
| 修复后的源码 | 源文件 | Phase 1 直接修改，无独立产出 |
| 分析报告(YAML) | `.keve/analysis-report.yaml` | 四阶段完整结果，机器可读 |
| 分析报告(HTML) | `.keve/analysis-report.html` | 人可读，`keve analysis` 生成 |
| test-plan 更新 | `.keve/test-plan.yaml` | phase status + outputs 摘要 |

### analysis-report.yaml 结构

```yaml
# .keve/analysis-report.yaml
generated_at: 2026-06-16T20:07:00

phase1:
  status: passed
  type_errors_before: 5
  type_errors_after: 0
  lint_errors_before: 3
  lint_errors_after: 0
  lint_warnings_before: 8
  lint_warnings_after: 5
  fix_rounds: 2

phase2:
  status: completed
  circular_deps:
    - path: "src/utils/a.ts → src/store/b.ts → src/utils/a.ts"
      severity: warning
      suggestion: "提取共享模块到 src/shared/"
  ghost_deps:
    - package: "lodash"
      file: "src/utils/format.ts"
      declared_in_package_json: false
      detail: "import 了但 package.json 未声明"
  dead_code:
    - symbol: "formatCurrency"
      file: "src/utils/format.ts"
      callers: 0
      is_exported: false
      suggestion: "删除或添加 export"
  arch_violations:
    - from: "src/utils/request.ts"
      to: "src/components/Modal.vue"
      rule: "utils 不应 import components"
      count: 1
  cyclomatic_complexity:
    - symbol: "handleSubmit"
      file: "src/pages/FormPage.vue"
      cyclomatic: 22
      decision_points: 21
      threshold: 10
      severity: critical
      suggestion: "拆分为多个子函数"
    - symbol: "processData"
      file: "src/utils/data.ts"
      cyclomatic: 15
      decision_points: 14
      threshold: 10
      severity: warning
      suggestion: "考虑拆分"

phase3:
  status: completed
  changed_files:
    - "src/utils/format.ts"
    - "src/components/SearchFilter.vue"
  impact_scope:
    - file: "src/utils/format.ts"
      callers_count: 15
      risk: high
  hotspots:
    - file: "src/api/client.ts"
      changes_last_30d: 8
      risk: high

phase4:
  status: completed
  dependency_audit:
    critical:
      - package: "lodash@4.17.15"
        cve: "CVE-2021-23337"
        fix_version: "4.17.21"
    high: []
    medium: []
    low: []
  code_security:
    - type: xss
      file: "src/components/UserComment.vue"
      line: 42
      detail: "v-html 绑定用户输入"
      severity: high
    - type: hardcoded_secret
      file: "src/config.ts"
      line: 15
      detail: "API_KEY = 'sk-xxx'"
      severity: critical
  runtime_risks:
    - type: unhandled_promise
      file: "src/api/client.ts"
      line: 30
      detail: "fetch().then() 无 .catch()"
    - type: uncleared_timer
      file: "src/components/Poller.vue"
      line: 20
      detail: "setInterval 未在 onUnmounted 清理"
  recommendation: "修复 1 个 Critical（硬编码密钥）+ 1 个 High（v-html XSS）"

summary:
  pass: true
  blockers: []           # Critical 级别会进这里
  warnings: 5
  info: 3
```

***

## 通过条件

- ✅ Phase 1: 0 个 type error + 0 个 lint error（必修）
- ⚠️ Phase 2: 循环依赖/死代码/架构违规 → 建议修，不阻塞
- ℹ️ Phase 3: 信息参考，不阻塞
- 🔴 Phase 4: 0 个 Critical 安全漏洞 → 否则阻塞
- 🟠 Phase 4: High 级别漏洞 → 建议修，不阻塞

***

## 禁止事项

- **禁止添加 `@ts-ignore` / `@ts-nocheck`**
- **禁止修改 ESLint 规则配置来绕过检查**
- **禁止修改业务逻辑**（只修类型和风格）
- **禁止删除文件来消除错误**
- **禁止引入新依赖来解决类型问题**（除非必要且用户确认）
- **Phase 2/3 不自动修改代码**（只输出分析结果）
- **Phase 4 安全扫描不自动修复**（误报率高，需人工确认）

***

## Key Decisions

| ID | 决策 | 说明 |
|----|------|------|
| SA01 | 静态分析是流水线第一步 | 类型错误不修，后续测试会被干扰 |
| SA02 | 不修改业务逻辑 | 静态分析只修类型标注和代码风格 |
| SA03 | 最多 3 轮修复 | 防止无限修复循环 |
| SA04 | lint warning 不阻塞 | 不强制清零 warning，避免过度修改 |
| SA05 | 四阶段架构 | P0: tsc+eslint, P1: Code-Graph, P2: Git 分析, P1~P0: 安全扫描 |
| SA06 | Code-Graph 替代单独 Tree-sitter | Code-Graph 内部基于 Tree-sitter，不需要重复引入 |
| SA07 | Phase 2/3 不自动修复 | 关系分析/变更分析只输出建议，由人决策 |
| SA08 | 安全扫描合并为 Phase 4 | 安全是静态分析的一个维度，不是独立 Skill |
| SA09 | 安全扫描不自动修复 | 误报率高，需人工确认修复方案 |
| SA10 | Critical 安全漏洞阻塞流程 | Phase 4 的 Critical 级别 = 阻塞后续测试 |
| SA11 | Phase 2 必须输出圈复杂度数值 | codegraph_node 获取函数体 → AI 计算决策点 → 具体数值 |
| SA12 | 幽灵依赖对比 package.json | 不只是缺 .d.ts，还要检测 import 了但未在 package.json 声明的包 |

***

## References

- [ts-error-patterns.md](references/ts-error-patterns.md) — 常见 TS 错误码及修复模式
- [lint-fix-guide.md](references/lint-fix-guide.md) — ESLint 自动修复和手动修复指南
- [codegraph-analysis-guide.md](references/codegraph-analysis-guide.md) — Code-Graph 检测模式和查询策略
- [git-impact-analysis.md](references/git-impact-analysis.md) — Git 变更影响分析方法
- [security-scan-guide.md](references/security-scan-guide.md) — 安全漏洞扫描规则和评级体系
- [runtime-risk-patterns.md](references/runtime-risk-patterns.md) — 运行时风险模式识别
- [vue-security-guide.md](references/vue-security-guide.md) — Vue 专项安全规则
