---
name: keve-unit-gen
description: 从源码导出函数自动生成 Vitest 单元测试。扫描 src/utils/、src/hooks/、src/store/ 中的纯函数和 composable，分析函数签名、边界条件和异常路径，生成 describe + it 测试文件，执行验证后输出覆盖索引。
allowed-tools: Bash(shell:*) Bash(npx:*) Bash(npm:*) Bash(node:*) Bash(git:*) Bash(pnpm:*) Bash(yarn:*)
---

# keve-unit-gen

## 定位

**本技能负责**：从源码导出函数自动生成单元测试（不负责组件测试、E2E 测试）。

单元测试覆盖测试金字塔最底层：纯函数、hooks、store 模块。
运行环境为 Node.js，不需要浏览器/DOM/jsdom，毫秒级执行。

***

## 触发条件

| 触发方式 | 场景 | 说明 |
|----------|------|------|
| `use_skill("keve-unit-gen")` | 开发阶段测试流水线 | 由 keve-dev-test-agent 调度 |
| `/keve-unit-gen` 指令 | 用户主动要求生成单测 | 手动触发 |

***

## 输入

- 项目源码中的工具函数、composable、store 模块等（由 Step 1 自动扫描识别）
- 不硬编码目录路径，根据项目实际结构分析

**排除**：
- `.vue` 组件文件（由 keve-component-gen 负责）
- `.spec.ts` / `.test.ts` 已有测试文件
- 类型定义文件（`*.d.ts`）
- 配置文件（`vite.config.*` / `tsconfig.*` / `*.config.*`）
- `index.ts` 纯导出聚合文件

***

## 流程

### Step 1: 扫描目标文件

从项目 `src/` 目录扫描，识别导出函数的目标文件：

```
扫描路径:
  - src/utils/**/*.ts
  - src/hooks/**/*.ts
  - src/store/**/*.ts
  - src/helpers/**/*.ts
  - src/composables/**/*.ts

排除:
  - *.vue, *.spec.ts, *.test.ts
  - *.d.ts, *.config.ts, *.config.js
  - index.ts (纯导出聚合)
  - types/ 或 types.ts 目录/文件
```

输出：目标文件列表 + 每个文件的导出符号列表。

### Step 2: 分析每个导出符号

对每个导出函数/类/composable 分析：

| 分析维度 | 识别方式 | 生成用例 |
|---------|---------|---------|
| 函数签名 | 参数类型 + 返回类型 | 正常路径 1 test |
| 必填参数 | 无默认值的参数 | 缺失必填参数 1 test |
| 可选参数 | 有 `?` 或默认值 | 有/无可选参数各 1 test |
| 边界条件 | number → 0/-1/NaN/Infinity; string → ''/超长; array → 空数组 | 每个边界 1 test |
| null/undefined | 参数类型含 `null | undefined` | null/undefined 输入各 1 test |
| 异常路径 | `throw` / `reject` / `try-catch` | 异常触发 1 test |
| 异步路径 | `async` / `Promise` | 异步正常 + 异步异常 |

### Step 3: 生成测试文件

**生成路径**：`keve_test_spec/util/__test__/{sourceFilename}.test.ts`

**生成结构**：

```typescript
// keve_test_spec/util/__test__/format.test.ts
import { describe, it, expect, vi } from 'vitest';
import { truncate, formatCurrency } from '@/utils/format';

describe('format', () => {
  describe('truncate', () => {
    it('短字符串不截断', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });
    it('长字符串截断加...', () => {
      expect(truncate('hello world', 5)).toBe('he...');
    });
    it('刚好等于 maxLen', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });
    it('空字符串', () => {
      expect(truncate('', 5)).toBe('');
    });
  });

  describe('formatCurrency', () => {
    it('正整数', () => {
      expect(formatCurrency(1000)).toBe('¥1,000');
    });
    it('小数保留两位', () => {
      expect(formatCurrency(1000.5)).toBe('¥1,000.50');
    });
  });
});
```

**命名规则**：
- 文件名与源文件同名，后缀 `.test.ts`
- `describe` 第一层 = 源文件模块名
- `describe` 第二层 = 函数名
- `it` 描述 = 中文场景描述

### Step 4: 执行验证

```bash
npx vitest run keve_test_spec/util/__test__/format.test.ts --coverage
```

- 如果通过 → 继续
- 如果失败 → AI 分析错误，修复测试（≤2 轮）
- 超过 2 轮仍失败 → 跳过该用例，标记为 `pending`（加 `it.todo`）

### Step 5: 生成覆盖索引

从 Vitest 覆盖率输出 + 测试文件分析反向生成 `keve_test_spec/util/coverage.yaml`：

```yaml
generated_at: 2026-06-16T16:05:00
total_exports: 15
tested_exports: 13
untested_exports: 2
overall_coverage: 87%

files:
  - source: src/utils/format.ts
    test: __test__/format.test.ts
    exports:
      - fn: truncate
        scenarios: [短字符串不截断, 长字符串截断加..., 刚好等于maxLen, 空字符串]
        coverage: 100%
      - fn: formatCurrency
        scenarios: [正整数, 小数两位]
        coverage: 85%
        missing: [NaN输入, 超大数值]

  - source: src/utils/validator.ts
    test: null
    exports:
      - fn: validateEmail
      - fn: validatePhone
    missing: [全部场景]
```

***

## 产出

| 产出 | 路径 |
|------|------|
| 测试脚本 | `keve_test_spec/util/__test__/*.test.ts` |
| 覆盖索引 | `keve_test_spec/util/coverage.yaml` |
| 覆盖率报告 | `coverage/`（Vitest 生成） |

***

## 硬性约束

- **不生成 .vue 组件测试**（由 keve-component-gen 负责）
- **不需要 DOM / jsdom / 浏览器**（纯 Node.js 环境运行）
- **优先使用 `vi.mock`**，而非 `vi.spyOn`
- **不修改源码**（只生成测试文件）
- **测试文件放在 `keve_test_spec/util/__test__/`**，不放在源码旁
- **每轮修复后重新执行验证**
- **失败的用例用 `it.todo` 标记**，不删除

***

## Key Decisions

| ID | 决策 | 说明 |
|----|------|------|
| UG01 | 测试文件放在 keve_test_spec/util/ | 长期资产，跨 MR 复用（D12） |
| UG02 | 不修改源码 | 只生成测试，不修改被测代码 |
| UG03 | 最多 2 轮修复 | 单测修复通常简单，2 轮足够 |
| UG04 | 失败用例用 it.todo | 保留场景信息，不删除 |
| UG05 | 覆盖索引反向汇总 | 保证和代码一致（D09） |

***

## References

- [unit-test-template.md](references/unit-test-template.md) — 单测生成模板
- [unit-mock-strategy.md](references/unit-mock-strategy.md) — vi.mock 使用策略
- [boundary-conditions.md](references/boundary-conditions.md) — 边界条件识别规则
