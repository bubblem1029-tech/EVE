---
name: keve-test-eval
description: 测试执行与评估技能。指导用例执行（keve run），读取 Reporter 工程分类和 AI 评估结果，对失败用例做根因分析、给出修复建议、指导重跑闭环。
allowed-tools: Bash(shell:*) Bash(npx:*) Bash(npm:*) Bash(node:*) Bash(git:*) ask_user_questions
---

# keve-test-eval

## 1. 定位

**本技能负责**：执行用例 → 评估结果 → 分析根因 → 修复 → 重跑。

```
keve run → confidence-data.jsonl
                │
                ├─ data="通过"    → 无需处理
                ├─ data="跳过"    → 按 errorCategory 排查
                ├─ data="不通过"  → 读 thought 判断根因 → 修复/报Bug/问用户
                └─ data="待确认"  → ask_user_questions 确认
```

## 2. 用例执行

### 2.1 前置条件

项目已通过 `keve init` 初始化（见 keve-e2e-gen Phase 0），目录结构详见 `keve_test_spec/keve.yaml` 顶部注释。

### 2.2 keve run 命令

```bash
# 基本执行（必传 KEVE_TASK_DIR 和 --config）
KEVE_TASK_DIR=.keve/mr-868-temp npx keve run --config=keve_test_spec/keve-test.config.ts

# 重跑失败用例
KEVE_TASK_DIR=.keve/mr-868-temp npx keve run --config=keve_test_spec/keve-test.config.ts --last-failed

# 指定/筛选用例
KEVE_TASK_DIR=.keve/mr-868-temp npx keve run --config=keve_test_spec/keve-test.config.ts --cases=AG-01,KB-03
```

## 3. 执行结果分析

读 `$KEVE_TASK_DIR/test-artifacts/latest/confidence-data.jsonl`，按 `data` + `errorCategory` 分流：

| data | errorCategory | 行动 |
|------|--------------|------|
| 通过 | pass | 无需处理 |
| 跳过 | env | [common-fix-guide 第2节](references/common-fix-guide.md)：Auth/网络/元素找不到 |
| 跳过 | script | [common-fix-guide 第3节](references/common-fix-guide.md)：测试代码本身有错 |
| 跳过 | visual | [common-fix-guide 第4节](references/common-fix-guide.md)：keveAssert 判断异常 |
| 不通过 | assert | 读 `thought` 判断根因：脚本缺陷→自修 / 应用Bug→报Bug / 需求变更→问用户 |
| 不通过 | script | 自修 POM/spec → --last-failed 重跑 |
| 待确认 | * | ask_user_questions 确认实际结果 |

**定位根因**：`errorCategory` → `thought` → `keveScreenshots` 截图 → 必要时读 `test-results.json` 取 error.stack → 定位 `@keveScene` / POM 方法

**即时确认规则**：遇到以下情况，必须立即用 `ask_user_questions` 向用户确认，不要自行决策：
- errorCategory=env → 确认是修复环境、添加 mock 还是标记跳过
- thought 提示需求/预期可能变更 → 确认预期是否需要更新
- data="待确认" → 确认实际结果是否符合预期

## 4. 修复闭环

```
data="跳过" → 按 errorCategory 排查 → env 时检查 Auth → 重跑（global-setup 自动获取）
data="不通过" + script → 自修 POM/spec → --last-failed 重跑 → 由编排层控制迭代轮次
data="不通过" + assert → 读 thought 判断 → 自修/报Bug/问用户
data="待确认" → ask_user_questions → 人工复核
```

每轮修复后在 `run-state.yaml` 中记录修复内容（fixes 字段），编排层读取轮次进度。

> 脚本缺陷的子类型和修复流程详见 [fix-loop-guide](references/fix-loop-guide.md)

## References

- [confidence-data-guide.md](references/confidence-data-guide.md) — confidence-data.jsonl 字段说明、组合解读、thought 关键词、示例
- [common-fix-guide.md](references/common-fix-guide.md) — 各 errorCategory 的排查与修复流程
