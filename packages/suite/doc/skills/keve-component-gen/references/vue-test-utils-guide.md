# @vue/test-utils API 速查

> AI 生成组件测试时的 API 参考

---

## mount / shallowMount

```typescript
import { mount } from '@vue/test-utils';

const wrapper = mount(Component, {
  props: { modelValue: 'test' },
  attrs: { id: 'my-component' },
  slots: { default: '<div>Slot content</div>' },
  global: {
    plugins: [router, pinia],
    stubs: { RouterLink: true },
    mocks: { $t: (key: string) => key },
    provide: { theme: 'dark' },
  },
});
```

---

## Wrapper 方法

### 查询

| 方法 | 说明 |
|------|------|
| `wrapper.find(selector)` | 查找单个元素 |
| `wrapper.findAll(selector)` | 查找所有元素 |
| `wrapper.findComponent(Component)` | 查找子组件 |
| `wrapper.get(selector)` | 查找元素（不存在则抛错） |
| `wrapper.vm` | 组件实例 |

### 交互

| 方法 | 说明 |
|------|------|
| `wrapper.trigger('click')` | 触发 DOM 事件 |
| `wrapper.trigger('click', { button: 0 })` | 带参数的事件 |
| `wrapper.setValue('new value')` | 设置表单值 |
| `wrapper.setChecked(true)` | 设置 checkbox |
| `wrapper.setSelected('option1')` | 设置 select |

### 断言

| 方法 | 说明 |
|------|------|
| `wrapper.exists()` | 元素是否存在 |
| `wrapper.isVisible()` | 元素是否可见（v-show） |
| `wrapper.text()` | 元素文本内容 |
| `wrapper.html()` | 元素 HTML |
| `wrapper.classes()` | 元素 CSS 类列表 |
| `wrapper.attributes('href')` | 元素属性值 |
| `wrapper.emitted()` | 所有触发的事件 |
| `wrapper.emitted('update')` | 特定事件的参数列表 |

### 状态操作

| 方法 | 说明 |
|------|------|
| `wrapper.setProps({ key: value })` | 更新 Props |
| `wrapper.setData({ key: value })` | 更新 data（Options API） |
| `await wrapper.vm.$nextTick()` | 等待下次渲染 |

---

## 常见模式

### 等待异步渲染

```typescript
await wrapper.setProps({ loading: false });
await wrapper.vm.$nextTick();
// 或
await flushPromises();
```

### 测试 v-model

```typescript
const wrapper = mount(Component, {
  props: { modelValue: 'initial', 'onUpdate:modelValue': (e: any) => wrapper.setProps({ modelValue: e }) },
});
await wrapper.find('input').setValue('new value');
expect(wrapper.emitted('update:modelValue')).toHaveLength(1);
```
