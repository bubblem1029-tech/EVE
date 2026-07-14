---
name: keve-component-gen
description: 从 Vue 组件源码自动生成组件行为模型和 Vitest 组件测试。分析组件 Props/emit/Slots/条件渲染，生成 Component Model（场景 + 断言）和测试脚本，执行验证后输出覆盖索引。
allowed-tools: Bash(shell:*) Bash(npx:*) Bash(npm:*) Bash(node:*) Bash(git:*) Bash(pnpm:*) Bash(yarn:*)
---

# keve-component-gen

## 定位

**本技能负责**：从 Vue 组件源码自动生成组件行为模型和组件测试（不负责单元测试、E2E 测试）。

组件测试覆盖测试金字塔中层：Vue 组件的 Props、事件、条件渲染、Slots。
运行环境为 Node.js + jsdom，不需要真实浏览器，秒级执行。

***

## 触发条件

| 触发方式 | 场景 | 说明 |
|----------|------|------|
| `use_skill("keve-component-gen")` | 开发阶段测试流水线 | 由 keve-dev-test-agent 调度 |
| `/keve-component-gen` 指令 | 用户主动要求生成组件测试 | 手动触发 |

***

## 输入

- 项目组件源码（由 Step 1 自动扫描识别，`.vue` SFC 文件）
- 可选：已有的 `keve_test_spec/component/registry.json`

**排除**：
- 页面级组件（pages/、views/、layouts/ 目录下的组件，由 E2E 覆盖）
- 纯布局组件（无交互、无 Props、无逻辑）
- 第三方组件库组件
- 已在 `coverage.yaml` 中标记 100% 覆盖的组件

***

## 流程

### Step 1: 扫描组件文件

**分析项目结构**，自动识别包含 `.vue` SFC 文件的目录，不硬编码路径：

```
扫描策略:
  1. 读取项目 src/ 目录结构
  2. 识别包含 .vue 文件的目录
  3. 过滤条件：
     - **只扫描 components/ 目录下的组件**（页面级组件由 E2E 覆盖）
     - 排除: pages/、views/、layouts/ 目录（页面级，依赖路由+API，组件测试 ROI 低）
     - 排除: 纯布局组件（无 script 或 script 只有 name）
     - 排除: 第三方组件库组件（node_modules 下的）
     - 排除: 已在 coverage.yaml 中 coverage=100% 的组件

  判断标准：
  - 组件能独立 mount（只依赖 Props + stub 子组件）→ 适合组件测试
  - 组件依赖路由/API/页面级生命周期 → 不适合，由 E2E 覆盖

  常见组件目录（仅供参考，不硬编码）：
  - src/components/
  - 项目可能有自定义目录名，需逐一分析
```

### Step 2: 分析组件 API

对每个组件分析：

| 分析维度 | 提取来源 | 用途 |
|---------|---------|------|
| Props 定义 | `defineProps` / `props` 选项 | 场景 Props + 默认值 |
| emit 事件 | `defineEmits` / `emits` 选项 | 断言 emitted |
| Slots | `$slots` / `<slot>` 标签 | 断言插槽渲染 |
| 条件渲染 | `v-if` / `v-show` | true/false 分支各 1 test |
| 计算属性 | `computed` | 断言派生值 |
| 事件处理器 | `@click` / `@input` 等 | trigger + 断言 |

### Step 3: 生成 Component Model

**生成路径**：`keve_test_spec/component/models/{ComponentName}.model.ts`

**model.ts 结构**（纯数据，不依赖 Storybook，D14）：

```typescript
// keve_test_spec/component/models/SearchFilter.model.ts

import SearchFilter from '@/components/SearchFilter.vue';

export const SearchFilterModel = {
  // ─── 组件标识 ───
  name: 'SearchFilter',
  source: 'src/components/SearchFilter.vue',
  component: SearchFilter,

  // ─── 组件 API ───
  events: ['update:modelValue'],
  slots: [],

  // ─── 组件场景 ───
  scenarios: [
    {
      id: 'SF-DEFAULT',
      name: '默认状态',
      description: '显示三个选项，当前选中"全部"',
      props: { modelValue: 'all', disabled: false, options: ['全部', '我创建的', '可编辑的'] },
      mountConfig: { globalStubs: ['RouterLink'] },
      assertions: [
        { type: 'visible', target: '三个筛选按钮' },
        { type: 'checked', target: '"全部"按钮' },
      ],
    },
    {
      id: 'SF-DISABLED',
      name: '禁用状态',
      description: '所有按钮 disabled，不响应点击',
      props: { modelValue: 'all', disabled: true, options: ['全部', '我创建的', '可编辑的'] },
      mountConfig: { globalStubs: ['RouterLink'] },
      assertions: [
        { type: 'disabled', target: '所有按钮' },
        { type: 'no-emit', event: 'update:modelValue' },
      ],
    },
  ],
};
```

**场景 ID 命名规则**：`{组件缩写}-{场景描述}`（如 `SF-DEFAULT`）

### Step 4: 生成组件测试脚本

**生成路径**：`keve_test_spec/component/__test__/{ComponentName}.test.ts`

```typescript
// keve_test_spec/component/__test__/SearchFilter.test.ts

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchFilter from '@/components/SearchFilter.vue';
import { SearchFilterModel } from '@/keve_test_spec/component/models/SearchFilter.model';

function mountFromScenario(scenarioId: string, overrides: Record<string, unknown> = {}) {
  const scenario = SearchFilterModel.scenarios.find(s => s.id === scenarioId)!;
  return mount(SearchFilter, {
    props: { ...scenario.props, ...overrides },
    global: {
      stubs: Object.fromEntries(scenario.mountConfig.globalStubs.map(n => [n, true])),
    },
  });
}

describe('SearchFilter', () => {
  it('SF-DEFAULT: 默认状态', async () => {
    const wrapper = mountFromScenario('SF-DEFAULT');
    expect(wrapper.findAll('button')).toHaveLength(3);
  });

  it('SF-DISABLED: 禁用状态', async () => {
    const wrapper = mountFromScenario('SF-DISABLED');
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
```

### Step 5: Mock 策略

| 场景 | Mock 方式 |
|------|----------|
| 子组件 | `global.stubs: { ChildComponent: true }` |
| RouterLink | `global.stubs: { RouterLink: true }` |
| Pinia Store | `global.plugins: [createTestingPinia()]` |
| API 调用 | `vi.mock('@/api/xxx')` |

**原则**：使用 `stubChildComponent`（通过 `global.stubs`）避免级联渲染，
只在 model 的 `mountConfig.globalStubs` 中声明需要 stub 的组件名。

### Step 6: 执行验证

```bash
npx vitest run keve_test_spec/component/__test__/SearchFilter.test.ts
```

- 如果通过 → 继续
- 如果失败 → AI 分析错误，修复测试（≤3 轮）
- 超过 3 轮仍失败 → 用 `it.todo` 标记

### Step 7: 生成覆盖索引

生成 `keve_test_spec/component/coverage.yaml`：

```yaml
generated_at: 2026-06-16T16:08:00
total_components: 20
tested_components: 12
untested_components: 8

components:
  - source: src/components/SearchFilter.vue
    model: component/models/SearchFilter.model.ts
    test: component/__test__/SearchFilter.test.ts
    scenarios_total: 2
    scenarios_tested: 2
    coverage: 100%
    missing: []

  - source: src/components/ToolManagement.vue
    model: null
    test: null
    missing: [全部场景]
```

***

## 产出

| 产出 | 路径 |
|------|------|
| 组件行为模型 | `keve_test_spec/component/models/*.model.ts` |
| 组件测试脚本 | `keve_test_spec/component/__test__/*.test.ts` |
| 覆盖索引 | `keve_test_spec/component/coverage.yaml` |

***

## 硬性约束

- **不打标**（不需要 `data-e2e-name`，D07）
- **不生成 POM**（组件测试不需要页面操作模型，D07）
- **不生成 .stories.ts**（延后，D14）
- **model.ts 保持纯数据**（不依赖 Storybook，D14）
- **test.ts 通过 model 的 scenarios 获取 mount 配置**
- **model 和 test 放在 `keve_test_spec/component/`**（长期资产，D12）
- **每轮修复后重新执行验证**
- **失败用例用 `it.todo` 标记**

***

## Key Decisions

| ID | 决策 | 说明 |
|----|------|------|
| CG01 | 先生成 model 再生成 test | model 是唯一数据源，test 引用 model |
| CG02 | model.ts 保持纯数据 | 不依赖 Storybook，后续可按需扩展（D14） |
| CG03 | 不打标、不 POM | jsdom 中直接 mount，不需要浏览器定位（D07） |
| CG04 | 最多 3 轮修复 | 组件测试比单测复杂，允许更多轮次 |
| CG05 | 覆盖索引从 model 生成 | 场景信息已含在 model 中，直接提取 |

***

## References

- [component-model-template.md](references/component-model-template.md) — model.ts 结构和字段说明
- [component-test-template.md](references/component-test-template.md) — .test.ts 生成模板
- [component-mock-strategy.md](references/component-mock-strategy.md) — stub + vi.mock 策略
- [vue-test-utils-guide.md](references/vue-test-utils-guide.md) — @vue/test-utils API 速查
