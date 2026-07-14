# 运行时风险模式识别

> AI 安全扫描时的运行时风险参考

---

## 内存泄漏模式

### setInterval 未清理

```typescript
// ❌ 风险
setInterval(() => { this.poll(); }, 5000);
// 组件销毁后仍在执行

// ✅ 修复
onMounted(() => { this.timer = setInterval(() => { this.poll(); }, 5000); });
onUnmounted(() => { clearInterval(this.timer); });
```

### addEventListener 未移除

```typescript
// ❌ 风险
window.addEventListener('resize', this.handleResize);
// 组件销毁后监听器仍存在

// ✅ 修复
onMounted(() => { window.addEventListener('resize', this.handleResize); });
onUnmounted(() => { window.removeEventListener('resize', this.handleResize); });
```

### 闭包持有引用

```typescript
// ❌ 风险：闭包持有组件引用
const handler = () => { this.update(); };
longRunningTask(handler);
// 任务完成后闭包仍持有 this

// ✅ 修复：使用 weakRef 或显式释放
```

---

## Promise 风险

### 未处理 rejection

```typescript
// ❌ 风险
fetchData().then(data => { this.data = data; });
// 网络错误时 rejection 未处理，静默失败

// ✅ 修复
fetchData()
  .then(data => { this.data = data; })
  .catch(err => { this.error = err.message; });
```

### 浮动 Promise（async 未 await）

```typescript
// ❌ 风险
async function save() {
  validate();  // 返回 Promise 但未 await
  await persist();
}
// validate 的 rejection 不会被 save 的 catch 捕获

// ✅ 修复
async function save() {
  await validate();
  await persist();
}
```

---

## 事件风险

### 全局事件未清理

```typescript
// ❌ 风险
EventBus.on('data-updated', this.refresh);
// 组件销毁后仍监听

// ✅ 修复
onMounted(() => { EventBus.on('data-updated', this.refresh); });
onUnmounted(() => { EventBus.off('data-updated', this.refresh); });
```
