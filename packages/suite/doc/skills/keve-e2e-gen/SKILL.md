---
name: keve-e2e-gen
description: 源码分析 + 打标 + POM 生成 + 测试脚本生成。通过静态分析应用源代码，自动注入测试标识，生成 Page Object Model 和 Playwright 测试脚本。
allowed-tools: Bash(shell:*) Bash(npx:*) Bash(npm:*) Bash(node:*) Bash(git:*)
---

# keve-e2e-gen

## 定位

**本技能负责**：源码分析 → 打标 → POM → 测试脚本生成（不负责执行和修复）。

目录结构详见 `keve_test_spec/keve.yaml` 顶部注释（Single Source of Truth）。

***

## Phase 0: Scaffold

> 首次使用必须执行。

```bash
keve init
```

创建 `keve_test_spec/`、`.keve/`、`.codeflicker/` 等基础设施。

> **严禁从零手写配置**，只需微调 `baseURL` 和 `webServer.command`。

***

## Phase 1: Source Code Analysis + POM Generation

本阶段在源代码层面操作，不打开浏览器。四个 Agent **严格按顺序**执行：

| Agent | Mission | Output | 必须完成才能继续? |
|-------|---------|--------|:---:|
| Script Analyst | 扫描组件，提取交互元素、Props、条件渲染 | component-registry.json | ✅ |
| Stage Manager | 注入缺失的 aria-label / data-e2e-name | testid-injections.json + **源码实际修改** | ✅ **打标必须完成后才能生成定位器** |
| Blocking Coach | 生成定位器优先级链 | locator-catalog.json | ✅ |
| Set Designer | 生成 Page Object Model 类 | `keve_test_spec/poms/*.ts` | ✅ |

> **重要**：Stage Manager（打标）必须完成并实际修改源代码后，Blocking Coach 才能基于打标后的元素生成定位器。跳过打标会导致定位器找不到元素。

**POM 路径规范**：
- POM 类必须输出到 **项目根目录** 的 `keve_test_spec/poms/*.ts`（共享模块，跨 MR 复用）
- **禁止** 将 POM 输出到 `.keve/task_xxx/poms/`（任务级目录会导致 import 路径错误）

**定位器优先级**：

| 元素类型 | Priority 1 | Priority 2 | Priority 3 |
|----------|-----------|-----------|-----------|
| 交互元素 | `getByRole + name` | `locator('[data-e2e-name="xxx"]')` | 结构化 selector |
| 交互元素 | `locator('[data-e2e-name="xxx"]')` | 文本内容 | - |

> **注意**：项目使用 `data-e2e-name`，**不要**使用 `getByTestId()`（它查找 `data-testid`）。
> 正确写法：`page.locator('[data-e2e-name="xxx"]')`

**标识注入原则**：
- 交互元素：优先 `aria-label`，**绝不**注入 `data-e2e-name`
- 非交互元素：仅不得已时注入 `data-e2e-name`，命名规则 `组件名-区域描述`（<=3层）

→ 详细规则见 [code-analysis-guide](references/code-analysis-guide.md)

***

## Phase 2: Test Generation

| Agent | Mission | Output |
|-------|---------|--------|
| Choreographer | 规划用户旅程 + Feature Flag/权限排列组合 | journeys.json |
| Assistant Director | 映射到 POM 方法，生成 Playwright 脚本 | `.keve/task_xxx/keve_test_spec/*.spec.ts` |

### 脚本写法标准（D15 决策）

统一使用 `@keveModel/@keveScene` 装饰器写法。`@keveModel` 自动注册所有 `@keveScene` 方法为 Playwright `test()`，**不需要在文件底部手动调用 `test()`**。

**装饰器签名**：
- `@keveModel(id, description)` — 两个参数：模块ID（如 `AG`）+ 描述
- `@keveScene(id, description)` — 两个参数：用例ID（如 `AG-01`）+ 描述

**keveGoal 步骤标记**（函数调用形式，在方法体内每步调用一次）：
- `keveGoal({ precondition?, step, expected }, fn)` — 在 `@keveScene` 方法体内调用，每个步骤调用一次
- `fn` 为该步骤的具体执行函数，元数据和执行代码绑定在一起
- fixture 参数需声明 `keveGoal`：`{ page, keveGoal, keveAssert }`

**结构约束**：
- 一个 `@keveModel` 下可以有多个 `@keveScene`
- 一个 `@keveScene` 方法体内至少调用一次 `keveGoal({...}, fn)`

**禁止事项**：
- **禁止** 使用 `@keveGoal` 装饰器（已移除，改用 `keveGoal({...}, fn)` 函数调用）
- **禁止** 单独调用 `keveGoal({...})` 不传 fn（步骤元数据必须和执行代码绑定）
- **禁止** 在 `@keveScene` 方法内嵌套 `static async step1()` 子方法
- **禁止** 把 ID 和描述混在一个字符串里（如 `@keveModel('AG: 智能应用...')`）
- **禁止** 给装饰器传回调函数（如 `@keveModel('AG', () => {})`）

**正确写法 vs 错误写法**：

```typescript
// ✅ 正确：keveGoal 函数调用，步骤元数据 + 执行函数绑定
@keveScene('SF-01', '页面初始化加载筛选维度和视频列表')
static async testPageInit({ page, keveGoal, keveAssert }: any) {
  const searchPage = new VideoSearchPage(page);
  await keveGoal({ step: '导航到视频列表页', expected: '页面加载完成，搜索框可见' }, async () => {
    await searchPage.navigateTo();
  });
  await keveGoal({ step: '观察筛选器区域', expected: '显示6个筛选器下拉' }, async () => {
    await searchPage.assertFiltersVisible();
  });
  await keveGoal({ step: '观察视频卡片区域', expected: '5列网格布局' }, async () => {
    await keveAssert('页面加载完成', { label: 'SF01-Step3' });
  });
}

// ❌ 错误：@keveGoal 装饰器叠加（已移除）
@keveScene('SF-01', '页面初始化')
@keveGoal({ step: '导航', expected: '页面加载' })
static async testPageInit({ page, keveAssert }: any) { }

// ❌ 错误：keveGoal 不传 fn（步骤元数据和执行代码分离）
keveGoal({ step: '导航', expected: '页面加载' });
await searchPage.navigateTo();

// ❌ 错误：方法体内嵌套 static 子方法
static async testPageInit({ page, keveGoal, keveAssert }: any) {
  await keveGoal({ step: '导航', expected: '页面加载' }, async () => {
    static async step1() { }  // 方法体内不能定义 static 方法！
  });
}
```

**核心纪律**：
- 仅使用 POM 方法，绝不使用 `page.locator()` / `page.$()`
- 绝不硬编码等待时间
- 绝不硬编码环境数据（D05），从 `fixtures/test-data.ts` 导入
- keveGoal 步骤必须与 test-cases.yaml 一一对应（D14）
- 关键步骤追加 `keveAssert` 视觉断言（D11），每测试最多 5 次
@keveScene('SF-01', '页面初始化')
static async testPageInit() {
  @keveGoal({ step: '导航', expected: '页面加载' })
  static async step1() { }
}
```

**核心纪律**：
- 仅使用 POM 方法，绝不使用 `page.locator()` / `page.$()`
- 绝不硬编码等待时间
- 绝不硬编码环境数据（D05），从 `fixtures/test-data.ts` 导入
- goals 步骤必须与 test-cases.yaml 一一对应（D14）
- 关键步骤追加 `keveAssert` 视觉断言（D11），每测试最多 5 次

→ 详细规则见 [script-generation-guide](references/script-generation-guide.md)

***

## Key Decisions

| ID | 决策 | 说明 |
|----|------|------|
| D01 | 独立配置文件 | `--config=keve_test_spec/keve-test.config.ts` |
| D05 | 环境数据集中定义 | `fixtures/test-data.ts` 导入，不硬编码 |
| D11 | 关键步骤视觉断言 | keveAssert + 页面 console.error 采集 |
| D12 | keveAssert 数量约束 | 每测试上限 5 次（建议 2-3 次） |
| D14 | 用例步骤绑定 | `keveGoal({ precondition?, step, expected }, fn)` 函数调用，步骤元数据与执行代码绑定，与 YAML 一一对应 |
| D15 | 装饰器写法 | @keveModel 自动注册 @keveScene，不需要手动 test() |

***

## References

- [code-analysis-guide.md](references/code-analysis-guide.md) — 组件扫描、打标、定位器生成
- [pom-generation-guide.md](references/pom-generation-guide.md) — POM 类结构、设计原则、编码规范（waitForReady/hover/输入清空）
- [script-generation-guide.md](references/script-generation-guide.md) — 旅程规划、脚本生成、装饰器写法、keveAssert 用法
- [test-auditor-guide.md](references/test-auditor-guide.md) — 测试深度等级、一致性校验

## Scripts

- [extract-components.sh](scripts/extract-components.sh) — 从源码提取组件注册表
- [inject-testids.sh](scripts/inject-testids.sh) — 扫描并注入缺失标识