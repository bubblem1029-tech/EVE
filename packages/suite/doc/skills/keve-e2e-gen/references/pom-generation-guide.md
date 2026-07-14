# POM 生成指南 (POM Generation Guide)

> Phase 1 后半 + 实战编码规范：定位器目录 → POM 类生成

---

## POM 类结构

```typescript
export class AgentListPage {
  constructor(private page: Page) {}

  // 导航方法
  async navigateTo(): Promise<void> {
    await this.page.goto('/agents');
    await this.waitForReady();
  }

  // 等待方法
  async waitForReady(): Promise<void> {
    // 等待关键 API 响应（如果页面依赖接口渲染） 注意接口地址严格按照代码逻辑不要随意改写
    await this.page.waitForResponse(resp =>
      resp.url().includes('/api/agent/detail') && resp.status() === 200
    );
    // 等待 DOM 渲染
    await this.page.locator('[data-e2e-name="智能应用列表-筛选区域"]').waitFor({ state: 'visible' });
  }

  // 交互方法（语义化命名）
  async selectFilterType(type: string): Promise<void> {
    await this.page.getByRole('radio', { name: type }).click();
  }

  // 断言方法（返回 Locator 或直接断言）
  async assertFilterOptionsVisible(): Promise<void> {
    await expect(this.page.locator('[data-e2e-name="智能应用列表-筛选区域"]')).toBeVisible();
  }
}
```

## POM 设计原则

- **单一页面 = 单一 POM 类**
- **方法命名用业务语义**（`selectFilterType` 而非 `clickRadio`）
- **定位器只在 POM 中定义**，测试文件通过 POM 方法调用
- **navigate 方法必须包含 waitForReady**
- **不包含环境数据**（D05：ID 从 test-data.ts 导入，POM 的 navigate 方法接受参数）
- **路由必须对照源代码验证**（D09）：POM 中 `page.goto()` 的路由必须从源代码的 router 配置文件中提取，**严禁猜测路由格式**
- **waitForReady 必须等待 API 响应**（D10）：在代码分析阶段扫描组件的 API 依赖（如 `getEditAgentDetail`），在 `waitForReady()` 中增加 `page.waitForResponse()` 等待接口返回后再定位元素。避免 `v-if="detail"` 导致的内容区空白超时。

---

## POM 编码规范（实战提炼）

> 来自 MR868 实战经验，以下规范必须写入所有生成的 POM 代码。

### waitForReady: 事件驱动，不吞错误

```typescript
// 反模式: 多层串行等待 + 超长timeout + catch吞错误 + 兜底硬等
async waitForReady(): Promise<void> {
  await this.page.waitForResponse(
    resp => resp.url().includes('/api/list') && resp.status() === 200,
    { timeout: 15000 }  // 太长!
  ).catch(() => {});  // 吞掉错误, 可能导致静默超时
  await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await this.page.locator('[data-e2e-name="列表"]').waitFor({ state: 'visible', timeout: 15000 }).catch(async () => {
    await this.page.waitForTimeout(2000);  // 兜底硬等!
  });
}

// 推荐: 单一关键信号等待 + 合理timeout + 不吞错误
async waitForReady(): Promise<void> {
  // 方案A: 等关键API响应 (最精确)
  await this.page.waitForResponse(
    resp => resp.url().includes('/api/list') && resp.status() === 200,
    { timeout: 5000 }  // 合理timeout, API正常应在1-2s内返回
  );
  // 等关键UI元素可见 (确认渲染完成)
  await this.page.locator('[data-e2e-name="列表"]').waitFor({ state: 'visible', timeout: 3000 });
}

// 方案B: 等UI信号 (不依赖API, 更健壮)
async waitForReady(): Promise<void> {
  await this.page.locator('[data-e2e-name="列表"]').waitFor({ state: 'visible', timeout: 5000 });
}
```

**规范要点**:
- `waitForResponse` timeout 不超过 5000ms (API正常1-2s内返回)
- 不使用 `.catch(() => {})` 吞掉超时错误
- 不使用 `waitForLoadState` + 兜底 `waitForTimeout` 组合
- `waitForReady` 最多2层等待: API信号 + UI信号

### Tooltip hover: 等DOM出现，不硬等时间

```typescript
// 反模式: 硬等tooltip弹出
async hoverButton(): Promise<void> {
  await this.button.hover({ force: true });
  await this.page.waitForTimeout(800);  // 硬等, 可能不够或浪费
}

// 推荐: 等tooltip DOM出现
async hoverButtonAndWaitTooltip(): Promise<void> {
  await this.button.hover({ force: true });
  await this.page.locator('[role="tooltip"], .ks-tooltip__popper')
    .first().waitFor({ state: 'visible', timeout: 3000 });
}
```

**规范要点**:
- hover后用 `waitFor({ state: 'visible' })` 等tooltip DOM出现
- 绝不使用 `waitForTimeout` 等待tooltip弹出
- tooltip定位器优先 `[role="tooltip"]`, fallback `.ks-tooltip__popper`
- disabled元素的hover必须使用 `{ force: true }`

### 输入清空: 等DOM更新，不硬等时间

```typescript
// 反模式: 清空后硬等
await input.clear();
await page.waitForTimeout(500);

// 推荐: 等字数统计DOM更新 (事件驱动)
await input.clear();
await expect(wordCountLocator).toHaveText(/0\/300/, { timeout: 3000 });
```

**规范要点**:
- `input.clear()` 后用 `expect(locator).toHaveText()` 等DOM更新
- 绝不使用 `waitForTimeout` 等清空生效
- 如果没有对应的DOM指示器, 使用 `waitForFunction` 或 `waitForResponse`

---

## 输出路径

- POM 类必须输出到 **项目根目录** 的 `keve_test_spec/poms/*.ts`（共享模块，跨 MR 复用）
- **禁止** 将 POM 输出到 `.keve/task_xxx/poms/`（任务级目录会导致 import 路径错误）
