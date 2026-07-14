# Vue 安全扫描指南

> AI 扫描 Vue 项目安全风险时的参考

---

## XSS 风险

| 模式 | 风险等级 | 说明 |
|------|---------|------|
| `v-html="userInput"` | 🔴 Critical | 直接渲染用户输入 = XSS |
| `element.innerHTML = userInput` | 🔴 Critical | 原生 innerHTML |
| `v-html="sanitizedContent"` | 🟡 Medium | 取决于 sanitization 实现 |
| `v-text="userInput"` | ✅ 安全 | 自动转义 |
| `{{ userInput }}` | ✅ 安全 | 模板语法自动转义 |

### v-html 安全修复

```typescript
// ❌ 危险
<div v-html="comment.content" />

// ✅ 使用 DOMPurify
import DOMPurify from 'dompurify';
const sanitized = DOMPurify.sanitize(comment.content);
<div v-html="sanitized" />

// ✅ 最佳：不用 v-html
<div>{{ comment.content }}</div>
```

---

## 数据流风险

### Props 修改

```typescript
// ❌ 风险：直接修改 props
props: { list: Array },
setup(props) { props.list.push(newItem); }

// ✅ 修复：emit 事件
emits: ['update:list'],
setup(props, { emit }) { emit('update:list', [...props.list, newItem]); }
```

### 计算属性中的副作用

```typescript
// ❌ 风险：计算属性中发请求
computed: {
  data() { return fetchData(this.id); }  // 每次访问都触发
}

// ✅ 修复：用 watch + ref
watch: {
  id(newId) { this.fetchData(newId); }
}
```

---

## 依赖安全

### 已知 Vue 生态漏洞

| 包 | CVE | 修复版本 |
|----|-----|---------|
| lodash < 4.17.21 | CVE-2021-23337 | 升级到 4.17.21+ |
| vue < 2.6.12 | XSS in templates | 升级到 2.6.12+ |
| vue-server-renderer | CVE-2024-6345 | 检查版本 |
