# 代码分析指南 (Code Analysis Guide)

> Phase 2 前三步的合并指引：组件扫描 → 打标 → 定位器生成

---

## 三阶段流程

```
Step 1: 组件扫描 (Script Analyst) → component-registry.json
Step 2: 打标 (Stage Manager) → testid-injections.json + *.patch
Step 3: 定位器生成 (Blocking Coach) → locator-catalog.json
```

> **关键依赖**：Step 3 必须在 Step 2 打标应用后执行。

---

## Step 1: 组件扫描

扫描 MR 变更涉及的组件文件，提取交互元素信息和 API 依赖，构建组件注册表。

**API 依赖扫描（D10）**：
- 扫描组件中调用的 API 方法（如 `getEditAgentDetail`、`getAgentList`）
- 提取对应的 endpoint 路径（如 `/api/agent/detail`）
- 标记 `triggersRender: true` 如果该 API 响应决定页面主要内容渲染（如 `v-if="detail"`）
- 在 POM 的 `waitForReady()` 中生成 `page.waitForResponse()` 等待该接口

### 各框架提取重点

| 框架 | 提取重点 |
|------|----------|
| React | 函数组件的 Props/State、事件处理器、条件渲染 |
| Vue | SFC 的 template 交互元素、Composition API 的 ref/reactive、v-if/v-show |

### 噪音过滤规则

- 排除纯展示组件（无交互元素）
- 排除第三方库内部组件
- 排除未在本次 MR 变更范围内的组件

### 组件注册表 Schema

```json
{
  "components": [
    {
      "name": "AgentList",
      "filePath": "src/pages/agent/AgentList.vue",
      "framework": "vue",
      "interactiveElements": [
        {
          "type": "button",
          "role": "filter",
          "label": "类型筛选",
          "existingTestId": null,
          "needsInjection": true
        }
      ],
      "conditionalRendering": [
        { "element": "deleteButton", "condition": "role === 'admin'" }
      ],
      "stateDependencies": ["filterType", "selectedRole"],
      "apiDependencies": [
        { "name": "getEditAgentDetail", "endpoint": "/api/agent/detail", "triggersRender": true }
      ]
    }
  ]
}
```

---

## Step 2: 打标

为缺失标识符的元素注入确定性定位标记。

### 元素分类注入策略

> **核心原则**：交互元素优先可访问性标识（aria-label），尽量不增加 data-e2e-name。

| 元素类型 | 判断依据 | 优先方案 | 降级方案 |
|----------|----------|----------|----------|
| **交互元素** | button、input、select、a、radio、checkbox、textarea | ① 已有 aria-label 或可见文本 → **不注入**<br/>② 无 aria-label 且无可见文本 → **注入 aria-label** | 绝不注入 data-e2e-name |
| **非交互元素** | div、span、container、text、status | ① 已有 data-e2e-name → **不注入**<br/>② 无 data-e2e-name → **注入 data-e2e-name** | 不得已才注入 |

### 注入决策树

```
元素需要定位标记？
  ├─ 是交互元素？
  │   ├─ 已有 aria-label？ → 不注入（用 getByRole）
  │   ├─ 有可见文本？ → 不注入（用 getByRole + name）
  │   └─ 都没有（图标按钮等）→ 注入 aria-label
  │       └─ 示例：<button aria-label="更多操作"><IconMore/></button>
  │
  └─ 非交互元素？
      ├─ 已有 data-e2e-name？ → 不注入
      └─ 没有 → 注入 data-e2e-name（不得已）
          └─ 示例：<div data-e2e-name="智能应用详情-置灰遮罩">...</div>
```

### aria-label 注入规则

**触发条件**（同时满足）：
1. 是交互元素（button/input/select/a/radio/checkbox/textarea）
2. 无现有 aria-label
3. 无可见文本内容（如纯图标按钮、icon-only 元素）

**命名规范**：
- 中文业务语义：`组件名-操作描述`
- 示例：`新建智能应用`、`更多操作`、`关闭弹窗`
- **不要**写成 `XX按钮`（Role 已经表达"按钮"语义）

### data-e2e-name 注入规则

**仅在非交互元素且无任何标识符时注入**。

**命名规范**：
- 中文业务语义：`组件名-区域-描述`
- ≤ 3 层
- 禁止：`XX容器`、`XX-wrapper`、英文命名

**旧属性共存**：新增 data-e2e-name 不删除旧属性，逐步下线统一。

### 注入模板

**交互元素——只注入 aria-label**：
```vue
<!-- Vue: 图标按钮 -->
<KsButton aria-label="更多操作"><IconMore/></KsButton>

<!-- Vue: 有文本则不需要注入 -->
<KsButton>新建</KsButton>        <!-- 通过 getByRole('button', { name: '新建' }) -->

<!-- React: 图标按钮 -->
<button aria-label="更多操作"><IconMore/></button>
```

**非交互元素——注入 data-e2e-name**：
```vue
<!-- Vue: 容器/遮罩层 -->
<div data-e2e-name="智能应用详情-置灰遮罩">不可编辑</div>
```

---

## Step 3: 定位器生成

基于已打标源代码，为每个交互元素生成确定性定位器。

### 定位器优先级链

> **重要**：交互元素和非交互元素使用不同的定位器策略。

**交互元素（button/input/select/a/radio/checkbox/textarea）**：

| 优先级 | 定位器类型 | Playwright API | 示例 |
|--------|-----------|----------------|------|
| Level 1 | getByRole + name | `page.getByRole('button', { name: '新建' })` | 基于 aria-label 或可见文本 |
| Level 2 | locator + data-e2e-name | `page.locator('[data-e2e-name="xxx"]')` | 仅当元素已有 data-e2e-name |
| Level 3 | CSS/Locator | `page.locator('[id="xxx"]')` | 最后手段 |

**非交互元素（div/span/container/text）**：

| 优先级 | 定位器类型 | Playwright API | 示例 |
|--------|-----------|----------------|------|
| Level 1 | locator + data-e2e-name | `page.locator('[data-e2e-name="xxx"]')` | 基于 data-e2e-name |
| Level 2 | Text/Locator | `page.getByText('xxx')` | 最后手段 |

> **重要**：项目使用 `data-e2e-name` 而非 `data-testid`，因此不能用 `getByTestId()`。
> 必须使用 `page.locator('[data-e2e-name="xxx"]')`。

### AST 验证

定位器选择后必须通过 AST 验证：
- aria-label → 确认为静态字符串（非动态绑定）
- data-e2e-name → 确认属性存在于源代码中
- id → 确认为静态值而非动态生成

### 动态元素特殊处理

| 类型 | 处理方式 |
|------|----------|
| 动态列表项 | 模板化定位器：`locator('[data-e2e-name="列表项-{{name}}"]')` |
| 条件渲染元素 | 标注出现条件：`conditionalRender: "v-if=\"type === DATA\""` |
| Feature Flag 控制 | 标注 flag：`featureFlag: "enableAppCreation"` |
| 多状态元素 | 标注状态变体：`states: ["enabled", "disabled"]` |

---

## 输出文件

| 文件 | 路径 | 内容 |
|------|------|------|
| 组件注册表 | `.keve/component-registry.json` | 所有交互组件和元素 |
| 打标注入 | `.keve/testid-injections.json` | 需注入的 testid 列表 |
| 打标补丁 | `*.patch` 或源代码变更 | 注入后的代码变更 |
| 定位器目录 | `.keve/locator-catalog.json` | 每个元素的定位器链 |

---

## 最佳实践

- **全量扫描**：不遗漏任何组件目录（pages/、views/、layouts/）
- **最小侵入**：交互元素优先 aria-label，尽量不增加 data-e2e-name
- **区分策略**：交互元素 getByRole，非交互元素 locator('[data-e2e-name="xxx"]')
- **POM 定位器优先级**：交互元素: getByRole > locator('[data-e2e-name]') > css locator / 非交互元素: locator('[data-e2e-name]') > text