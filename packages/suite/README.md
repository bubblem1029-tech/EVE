# keve-agent 使用指南

## 1. 安装

```bash
# 在目标项目中安装
pnpm add -D c
```

## 2. 初始化项目

```bash
# 在业务项目根目录执行
keve init

# 创建的文件和目录：
#   .keve/                        — keve 工作区
#   keve_test_spec/               — 共享模块（POM + fixtures + config）
#   .codeflicker/skills/keve-case-generation/   — 用例生成 Skill
#   .codeflicker/skills/keve-script-generation/ — 脚本生成 Skill
#   .codeflicker/skills/keve-test-eval/         — 执行与评估 Skill
#   .codeflicker/agents/keve-test-agent.md       — 测试编排 Agent

# 覆盖已有文件
keve init --force
```

**职责边界**：
- **keve-script-generation**：源码分析 + 打标 + POM + spec 生成（不做执行和修复）
- **keve-test-eval**：执行 + 评估 + 根因分析 + 修复建议 + 重跑（单次闭环）
- **keve-test-agent**：编排层，控制调用顺序和修复轮次上限（≤3 轮）

## 3.  执行测试

> 日常使用建议通过 Skill/Agent 触发，CLI 命令保留作为底层入口。

```bash
/keve-test-agent 根据需求xxx和代码变更xx 生成测试用例并执行 
```

手动执行
```bash
KEVE_TASK_DIR=.keve/mr-868-temp npx keve run --config=keve_test_spec/keve-test.config.ts   # e2e用例执行
keve vitest --coverage 2>&1 | head -30  # 单元测试 组件测试执行                                       
```

## 4. 自定义模型 .env

```bash
KEVE_LLM_BASE_URL=https://xxx/api/agent/v1/apps
KEVE_LLM_MODEL=xxx
KEVE_LLM_API_KEY=your-api-key
```