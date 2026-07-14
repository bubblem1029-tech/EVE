# 组件测试 Mock 策略

> AI 生成组件测试时的 stub/mock 指南

---

## 优先级

| 优先级 | 方式 | 适用场景 |
|--------|------|---------|
| 1 | `global.stubs` | 子组件、RouterLink、RouterView |
| 2 | `createTestingPinia` | Pinia Store |
| 3 | `vi.mock` | API 调用、工具函数 |
| 4 | 直接传 Props | 不需要 mock |

---

## 子组件 Stub

```typescript
// 方式1：通过 mountConfig.globalStubs（在 model 中声明）
mount(Component, {
  global: {
    stubs: { RouterLink: true, ChildComponent: true },
  },
});

// 方式2：stub 所有子组件（粗暴，不推荐）
mount(Component, {
  global: {
    stubs: { stubChildComponent: true },
  },
});
```

**原则**：只 stub 有副作用的子组件（API 调用、路由跳转），不 stub 纯展示组件。

---

## Pinia Store Mock

```typescript
import { createTestingPinia } from '@pinia/testing';

mount(Component, {
  global: {
    plugins: [createTestingPinia({ stubActions: false })],
  },
});
```

**原则**：默认 `stubActions: false`，保留 Store 逻辑；只在 Store 有 API 调用时 `stubActions: true`。

---

## API Mock

```typescript
vi.mock('@/api/agent', () => ({
  getAgentList: vi.fn().mockResolvedValue({ list: [], total: 0 }),
  getAgentDetail: vi.fn().mockResolvedValue({ id: 1, name: 'Test Agent' }),
}));
```

---

## 禁止做法

| 禁止 | 原因 |
|------|------|
| Stub 被测组件本身 | 失去测试意义 |
| Mock Vue 内置组件 | `Transition`、`Teleport` 不需要 mock |
| `shallowMount` 替代 `mount` | 会跳过子组件渲染，断言不完整 |
| 在 `global.stubs` 中 stub 所有 | 过度 stub 导致测试无意义 |
