# 脚本生成指南 (Script Generation Guide)

> Phase 2 指引：旅程规划 → 测试脚本生成 → keveAssert 视觉断言

---

## Step 1: 旅程规划

从 test-cases.yaml 的用例步骤生成测试旅程（journey），确定排列组合。

### 旅程结构

```json
{
  "journeys": [
    {
      "id": "AG-01-type-filter",
      "name": "类型筛选只显示用户自建",
      "testCaseId": "AG-01",
      "permutations": {
        "role": ["admin", "viewer"],
        "dataState": ["populated", "empty"]
      },
      "steps": [
        { "action": "navigateTo", "pom": "AgentListPage" },
        { "action": "selectFilterType", "pom": "AgentListPage", "args": ["我创建的"] },
        { "action": "assertFilterResult", "pom": "AgentListPage", "expected": "只显示当前用户创建的Agent" }
      ]
    }
  ]
}
```

### 排列维度

从以下维度识别排列：
- **角色/权限**：admin vs viewer
- **数据状态**：有数据 vs 空数据
- **Feature Flag**：开关状态
- **环境条件**：已登录 vs 未登录

---

## Step 2: 测试脚本生成

将旅程映射为 Playwright 测试代码。

### 核心纪律（强制规则）

> 1. **绝不使用原始定位器**：不使用 `page.locator()` / `page.$()` / CSS/XPath（POM 内部除外）
> 2. **绝不硬编码等待时间**：不使用 `waitForTimeout()`，通过 POM waitForReady 或断言等待
> 3. **绝不硬编码环境数据**（D05）：ID/配置值从 `fixtures/test-data.ts` 导入
> 4. **每个测试覆盖恰好一个排列**：测试体内无 if/else 分支逻辑

### 正确模式 vs 禁止模式

```typescript
// ✅ 正确：POM 方法 + test-data 导入
import { testData } from '../fixtures/test-data';
await agentDetailPage.navigate(testData.agents.tcPortal.id, 'edit');
await expect(page.locator('[data-e2e-name="智能应用列表-筛选区域"]')).toBeVisible();

// ❌ 禁止：原始定位器 + 硬编码
await page.locator('.filter-area').click();
await page.waitForTimeout(5000);
await agentDetailPage.navigate(636, 'edit');
```

### fixtures/test-data.ts 结构

```typescript
export const testData = {
    agents: { tcPortal: { id: 636, name: '天策门户Agent' }, ... },
    knowledges: { tcPortal: { id: 1008, name: '天策门户知识库' }, ... },
    welcomeWord: { maxChars: 300 },
};
```

### 测试文件结构（装饰器写法，D15 决策）

> **注意**：装饰器只用于 spec 测试文件。POM 类仍然是普通 TypeScript 类，不使用装饰器。

```typescript
import { test, expect, keveModel, keveScene } from '@ks-data/keve-suite/keve-test';
import { AgentListPage } from '../../../keve_test_spec/poms/AgentListPage';
import { testData } from '../../../keve_test_spec/fixtures/test-data';

@keveModel('AG', '智能应用列表筛选去除TC/DATASET')
class AgentFilterTests {
  @keveScene('AG-01', '智能应用列表不显示TC/DATASET来源筛选选项')
  static async testSourceFilterHidden({ page, keveGoal, keveAssert }: any) {
    const agentListPage = new AgentListPage(page);
    await keveGoal({ step: '进入智能应用列表页', expected: '页面正常加载，筛选区域可见' }, async () => {
      await agentListPage.navigateTo();
    });
    await keveGoal({ step: '观察来源筛选区域选项', expected: '来源筛选不显示TC/DATASET选项，仅显示权限筛选' }, async () => {
      await agentListPage.assertSourceFilterHidden();
      await keveAssert('筛选区域不显示TC/DATASET选项', { label: 'AG01-Step2' });
    });
  }

  @keveScene('AG-02', '权限筛选功能正常')
  static async testPermissionFilter({ page, keveGoal, keveAssert }: any) {
    const agentListPage = new AgentListPage(page);
    await keveGoal({ precondition: '已登录且在列表页', step: '选择"我创建的"筛选', expected: '列表仅显示当前用户创建的Agent' }, async () => {
      await agentListPage.navigateTo();
      await agentListPage.selectFilterType('我创建的');
      await keveAssert('列表仅显示用户创建的Agent', { label: 'AG02-Step1' });
    });
  }
}
```

**三层装饰器映射**：

| 层级 | 装饰器/函数 | 对应 | 职责 |
|------|------------|------|------|
| 模块 | `@keveModel(id, description)` | test.describe | 模块ID + 描述 |
| 场景 | `@keveScene(id, description)` | test | 用例ID + 描述 + fn.toString() 自动捕获完整场景脚本 |
| 步骤 | `keveGoal({ precondition?, step, expected })` | 步骤元数据 | 函数调用，嵌套在 @keveScene 方法体内 |

**装饰器/函数签名**：
- `@keveModel(id, description)` — 两个参数：模块ID（如 `AG`）+ 描述
- `@keveScene(id, description)` — 两个参数：用例ID（如 `AG-01`）+ 描述
- `keveGoal({ precondition?, step, expected }, fn)` — 函数调用形式，在方法体内每步调用一次，fn 为该步骤的执行函数

**结构约束**：
- 一个 `@keveModel` 下可以有多个 `@keveScene`
- 一个 `@keveScene` 下至少有一个 keveGoal 调用

**重要约束**：
- `@keveModel` 和 `@keveScene` 的 id 对应 test-cases.yaml 中的模块 ID 和用例 ID
- **禁止** 使用 `@keveGoal` 装饰器（已移除，改用 `keveGoal({...}, fn)` 函数调用）
- **禁止** 单独调用 `keveGoal({...})` 不传 fn（步骤元数据必须和执行代码绑定）
- **禁止** 在 `@keveScene` 方法内嵌套 `static async step1()` 子方法
- **禁止** 把 ID 和描述混在一个字符串里（如 `@keveModel('AG: 智能应用...')`）
- **禁止** 传入回调函数（如 `@keveModel('AG', () => {})`)
- `@keveScene` 自动捕获 `fn.toString()` 供 Reporter 做 code-goal 一致性校验

### 用例状态过滤

| 状态 | 处理 |
|------|------|
| `active` | 正常生成脚本 |
| `skipped` | **不生成脚本** |
| `pending` + `data_dependency: true` | **暂不生成**，等待数据后补充 |

---

## Step 3: keveAssert 视觉断言（消除假阳性）

> **核心思路**：Playwright DOM 断言为主（确定性、快速），keveAssert 视觉断言为辅（验证真实页面状态）。

```typescript
// 1. 导入装饰器和测试工具
import { test, expect, keveModel, keveScene } from '@ks-data/keve-suite/keve-test';
import { AgentListPage } from '../../keve_test_spec/poms/AgentListPage';

// 2. 使用 @keveModel/@keveScene 装饰器 + keveGoal() 函数调用编写用例
@keveModel('AG', '智能应用列表筛选去除TC/DATASET')
class AgentFilterTests {
  @keveScene('AG-01', '智能应用列表不显示TC/DATASET来源筛选选项')
  static async testNoSourceFilter({ page, keveGoal, keveAssert }: any) {
    const agentListPage = new AgentListPage(page);
    await keveGoal({ precondition: '已登录', step: '进入列表页并观察筛选区域', expected: '来源筛选区域不显示TC/DATASET选项' }, async () => {
      await agentListPage.navigateTo();
      await agentListPage.assertSourceFilterHidden();
      await keveAssert('筛选区域不显示TC/DATASET选项', { label: 'AG01-Step1' });
    });
  }
}
```

**何时添加 keveAssert**：

| 步骤类型 | 是否需要 keveAssert | 示例 |
|----------|---------------------|------|
| 页面首次加载完成 | **必须** | "页面已完全加载，无加载中提示" |
| 关键交互操作后 | **必须** | "点击筛选后列表仅显示对应类型" |
| 状态变更断言 | **必须** | "按钮已变为禁用状态" |
| 简单导航跳转 | 可选 | 跳转到详情页 |
| 数据填充/输入 | 可选 | 填写表单字段 |

**keveAssert 规范要点**:
- 断言描述必须**具体、可视觉判断**，不要写模糊描述如"页面正常"
- 断言描述要包含**负面条件**："无加载中提示"、"无错误弹窗"
- label 格式：`用例ID-StepN-视觉验证`（如 `AG01-Step1-视觉验证`）
- keveAssert 失败时直接抛出 Error，测试标记为 failed

**keveAssert 数量约束**（D12 决策）:
- 每个测试用例**最多 5 次** keveAssert 调用
- **建议 2-3 次**：Step1 验证页面加载状态，Step2-3 验证核心断言
- 冗余断言应**合并**
- 可由 DOM `expect` 覆盖的验证**不使用 keveAssert**

**keveWaitFor 使用**（替代硬等待）：

```typescript
// 替代 page.waitForTimeout(2000)
await keveWaitFor('页面加载完成，列表数据已渲染', { timeoutMs: 10000 });
```

**Tooltip 验证**（不依赖 hover/popper）：

ks-tooltip 基于 ks-popper，content 存在 Vue 组件 props 中。使用 `getTooltipContent()` 直接读取，无需 hover 触发：

```typescript
import { getTooltipContent, getAllTooltipContents } from '@ks-data/keve-suite/keve-test';

// 单个验证
const tip = await getTooltipContent(page, '[data-e2e-name="新建按钮提示"]');
expect(tip).toBe('暂无创建权限');

// 批量验证
const tips = await getAllTooltipContents(page, '[data-e2e-name$="-tooltip"]');
for (const t of tips) {
  expect(t.content).not.toBeNull();
}
```

**禁止**：`await page.hover(...)` + `await page.waitForSelector('.ks-popper')` 这种方式不稳定。

**页面 console.error 自动采集**（D11 决策）：
- 所有使用 `keve-fixture` 的测试默认启用 console.error 采集
- 测试结束后，如有 console.error，自动附加到报告作为 `页面-Console-Error` attachment

---

## 输出文件

| 文件 | 路径 |
|------|------|
| 测试脚本 | `.keve/task_xxx/keve_test_spec/*.spec.ts` |
| 测试数据 | `keve_test_spec/fixtures/test-data.ts` |

> POM 类输出到 `keve_test_spec/poms/*.ts`，详见 [pom-generation-guide](pom-generation-guide.md)