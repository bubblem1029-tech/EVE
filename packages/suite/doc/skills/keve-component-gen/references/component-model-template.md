# Component Model 模板

> AI 生成 component model 时的参考

---

## 基本结构

```typescript
import ComponentName from '@/components/ComponentName.vue';

export const ComponentNameModel = {
  name: 'ComponentName',
  source: 'src/components/ComponentName.vue',
  component: ComponentName,

  events: ['update:modelValue', 'confirm', 'cancel'],
  slots: ['default', 'footer'],

  scenarios: [
    {
      id: 'CN-DEFAULT',
      name: '默认状态',
      description: '组件在默认 Props 下的渲染',
      props: { /* default prop values */ },
      mountConfig: {
        globalStubs: ['RouterLink'],
      },
      assertions: [
        { type: 'visible', target: '组件根元素' },
      ],
    },
  ],
};
```

---

## 场景设计规则

### Props 变化场景

每个有意义的 Props 变化 → 独立场景：

| Props | 场景 ID | 场景名 |
|-------|---------|--------|
| 默认值 | `CN-DEFAULT` | 默认状态 |
| disabled: true | `CN-DISABLED` | 禁用状态 |
| loading: true | `CN-LOADING` | 加载中 |
| empty: [] | `CN-EMPTY` | 空数据 |

### 条件渲染场景

每个 `v-if` → true/false 两个场景：

| 条件 | 场景 ID | 场景名 |
|------|---------|--------|
| `v-if="detail"` 为 true | `CN-WITH-DETAIL` | 有详情 |
| `v-if="detail"` 为 false | `CN-NO-DETAIL` | 无详情 |

### 交互场景

每个用户交互 → 独立场景：

| 交互 | 场景 ID | 场景名 |
|------|---------|--------|
| 点击确认按钮 | `CN-CONFIRM` | 确认操作 |
| 点击取消按钮 | `CN-CANCEL` | 取消操作 |
| 输入文本 | `CN-INPUT` | 输入内容 |

---

## 场景 ID 命名规则

格式：`{组件缩写}-{场景描述}`（大写英文 + 连字符）

示例：
- `SF-DEFAULT` — SearchFilter 默认
- `SF-DISABLED` — SearchFilter 禁用
- `SF-EMPTY` — SearchFilter 空选项
- `SF-FILTER-MINE` — SearchFilter 切换到我创建的

---

## 断言类型速查

| type | 用途 | 必填字段 |
|------|------|---------|
| `visible` | 元素可见 | target |
| `hidden` | 元素隐藏 | target |
| `disabled` | 元素禁用 | target |
| `enabled` | 元素可用 | target |
| `emitted` | 事件触发 | event |
| `no-emit` | 事件未触发 | event |
| `text` | 文本内容 | target, value |
| `value` | 输入值 | target, value |
| `class` | CSS 类 | target, value |
| `attribute` | HTML 属性 | target, value |
