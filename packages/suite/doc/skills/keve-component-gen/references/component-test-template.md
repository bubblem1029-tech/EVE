# 组件测试生成模板

> AI 生成组件测试脚本时的参考

---

## 基本结构

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ComponentName from '@/components/ComponentName.vue';
import { ComponentNameModel } from '@/keve_test_spec/component/models/ComponentName.model';

function mountFromScenario(scenarioId: string, overrides: Record<string, unknown> = {}) {
  const scenario = ComponentNameModel.scenarios.find(s => s.id === scenarioId)!;
  return mount(ComponentName, {
    props: { ...scenario.props, ...overrides },
    global: {
      stubs: Object.fromEntries(
        scenario.mountConfig.globalStubs.map(n => [n, true])
      ),
    },
  });
}

describe('ComponentName', () => {
  it('CN-DEFAULT: 默认状态', async () => {
    const wrapper = mountFromScenario('CN-DEFAULT');
    // 断言...
  });
});
```

---

## 常见测试模式

### 默认渲染

```typescript
it('CN-DEFAULT: 默认状态', async () => {
  const wrapper = mountFromScenario('CN-DEFAULT');
  expect(wrapper.find('.component-root').exists()).toBe(true);
});
```

### Props 变更

```typescript
it('CN-DISABLED: 禁用状态', async () => {
  const wrapper = mountFromScenario('CN-DISABLED');
  expect(wrapper.find('button').attributes('disabled')).toBeDefined();
});
```

### 事件触发

```typescript
it('CN-CONFIRM: 点击确认', async () => {
  const wrapper = mountFromScenario('CN-DEFAULT');
  await wrapper.find('[data-test="confirm-btn"]').trigger('click');
  expect(wrapper.emitted('confirm')).toHaveLength(1);
});
```

### 条件渲染

```typescript
it('CN-WITH-DETAIL: 有详情', async () => {
  const wrapper = mountFromScenario('CN-WITH-DETAIL');
  expect(wrapper.find('.detail-section').exists()).toBe(true);
});

it('CN-NO-DETAIL: 无详情', async () => {
  const wrapper = mountFromScenario('CN-NO-DETAIL');
  expect(wrapper.find('.detail-section').exists()).toBe(false);
});
```

### Slots

```typescript
it('CN-SLOT-FOOTER: 底部插槽', async () => {
  const wrapper = mount(ComponentName, {
    props: ComponentNameModel.scenarios[0].props,
    slots: { footer: '<div class="custom-footer">Footer</div>' },
    global: { stubs: { RouterLink: true } },
  });
  expect(wrapper.find('.custom-footer').exists()).toBe(true);
});
```

---

## 失败用例处理

```typescript
it.todo('CN-LOADING: 加载中状态');
```
