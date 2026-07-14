# 常规问题修复建议

> 针对报告中常见错误分类的修复策略与操作指引。

---

## 1. errorCategory 分类与对应修复

| errorCategory | 报告显示 | 典型原因 | 修复方式 |
|---------------|----------|----------|----------|
| script | 脚本错误 | TypeError / ReferenceError / SyntaxError | 修复测试脚本代码 |
| env | 环境异常 | Timeout / 网络错误 / Auth 重定向 / Cookie 过期 | 检查环境或更新 Auth |
| visual | 视觉断言失败 | keveAssert 视觉比对不通过 | 检查截图，确认是 Bug 还是断言预期需更新 |
| assert | 断言失败 | Playwright expect 断言不通过 | 根因分析（A/B/C/D），见下方 |
| unknown | 未知异常 | 无法自动分类的错误 | 人工排查 |
| pass | 通过 | 测试正常通过 | 无需处理 |

---

## 2. 环境异常（env）修复流程

环境异常是最常见的"非脚本问题"导致测试失败的原因。

### 2.1 Auth / Cookie 过期

**识别信号**：
- 错误信息包含 `authenticate`、`redirect`、`ERR_`、`401`、`403`
- 截图显示登录页面而非目标页面
- `navigation intercepted`

**修复步骤**：

```bash
# 直接重跑测试 — global-setup 每次自动获取 Auth（打开浏览器手动登录）
KEVE_TASK_DIR=.keve/mr-868-temp npx keve run --config=keve_test_spec/keve-test.config.ts
```

`keve run` 的 global-setup 会自动：
- 打开浏览器（非 headless）
- 导航到登录页面，等待用户手动登录
- 自动检测登录完成（URL 不再包含 login/auth）
- 保存 cookies + localStorage 到 `.auth/storage-state.json`

**注意事项**：
- 确保 dev server 正在运行（`pnpm dev`），否则无法打开目标页面
- 如果目标 URL 不是默认的 `http://localhost:3000`，使用 `--url` 参数指定
- 如果 storage-state 路径不是默认的 `.auth/storage-state.json`，使用 `--config` 参数让命令从 Playwright config 中读取

### 2.2 网络超时（Timeout）

**识别信号**：
- 错误信息包含 `timeout`、`timed out`、`TimeoutError`
- 截图显示空白页面或部分加载的页面

**排查方向**：
1. dev server 是否正在运行？
2. 目标页面加载是否确实很慢？（调整 Playwright config 中 `timeout` / `actionTimeout`）
3. 网络是否不稳定？（如果是偶发，重跑一次即可）

**修复步骤**：

```bash
# 如果是偶发超时，直接重跑
KEVE_TASK_DIR=.keve/mr-868-temp npx keve run --config=keve_test_spec/keve-test.config.ts --retry-from=<round>

# 如果是系统性超时，调整 timeout 配置
# 编辑 .keve/keve-test.config.ts 中的 timeout 和 actionTimeout
```

### 2.3 元素未找到（Locator not found）

**识别信号**：
- 错误信息包含 `locator.*not found`、`waiting for selector`
- 截图显示页面但缺少预期元素

**排查方向**：
1. 页面是否真的没有这个元素？（→ 应用 Bug，报告给开发）
2. 定位器是否写错了？（→ 脚本缺陷，修复定位器）
3. 页面是否还在加载中？（→ 增加 `waitFor` 或 timeout）
4. Auth 是否过期导致页面跳转到登录？（→ 更新 Auth，见 2.1）

---

## 3. 脚本错误（script）修复流程

脚本错误是测试代码本身的问题，与被测应用无关。

**常见类型**：

| 错误类型 | 典型原因 | 修复方式 |
|----------|----------|----------|
| TypeError | 调用 undefined 的方法、属性访问错误 | 检查变量是否已定义 |
| ReferenceError | 使用未声明的变量 | 检查 import / 变量声明 |
| SyntaxError | 代码语法错误 | 检查括号、逗号等语法 |

**修复步骤**：
1. 查看报告中"执行结果"列的错误信息
2. 定位到对应的 `@keveScene` 测试脚本
3. 修复代码错误
4. 重跑验证

---

## 4. 视觉断言失败（visual）修复流程

视觉断言失败说明 keveAssert 的 AI 判断认为页面视觉状态不符合预期。

**排查方向**：
1. **是真的 Bug？** → 截图显示页面确实有问题（文案错误、样式异常、功能缺失）
2. **是断言预期不合理？** → 截图显示页面正常，但 keveAssert 的描述与实际不符
3. **是 AI 误判？** → 截图显示页面正常，断言描述也合理，但 AI 误判了

**修复方式**：

| 场景 | 修复方式 |
|------|----------|
| 真的 Bug | 报告 Bug，不修脚本 |
| 断言预期不合理 | 更新 `keveAssert` 的 description，使其更精确 |
| AI 误判 | 重跑一次确认（AI 误判概率 < 5%）；如果反复误判，考虑改用 Playwright expect 断言 |

---

## 5. 断言失败（assert）修复流程

断言失败是经过 AI 评估仍确认为"不通过"的用例，需做根因分析。

### 5.1 断言失败的根因判断

读 `confidence-data.jsonl` 中 `data="不通过"` 的记录，根据 `errorCategory` + `thought` 判断行动：

| errorCategory | thought 关键词 | 根因 | 行动 |
|--------------|---------------|------|------|
| script | "locator not found" / "element not found" | 脚本缺陷 | 自修 POM/spec |
| script | "timeout" / "wait" | 等待策略不足 | 调整 waitFor/timeout |
| assert | "text mismatch" + MR 有相关 diff | 需求变更 | ask_user_questions 确认 |
| assert | "element exists but behavior wrong" | 应用 Bug | 报 Bug，不修脚本 |
| visual | "keveAssert failed but DOM passed" | 假阳性 | 查截图判断 |

### 5.2 决策流程

```
data="不通过"
  ├─ errorCategory=script → 自修 POM/spec → --last-failed 重跑
  ├─ errorCategory=assert
  │    ├─ thought 提示需求/文案变更 → ask_user_questions 确认
  │    ├─ thought 提示应用 Bug → 报 Bug，不修脚本
  │    └─ thought 提示断言逻辑错 → 自修断言 → 重跑
  └─ errorCategory=visual → 查截图 → 判断 Bug/预期/AI误判
```

---

## 6. 快速参考卡片

```
看 confidence-data.jsonl → 按 data + errorCategory 分流
  │
  ├─ script → 修代码 → 重跑
  ├─ env → 检查 auth/server/网络
  │   ├─ auth 过期 → 重跑（global-setup 自动获取 Auth）
  │   ├─ server 没跑 → pnpm dev → 重跑
  │   └─ 偶发超时 → 直接重跑
  ├─ visual → 查截图 → 判断 Bug/预期/AI误判
  ├─ assert → 读 thought 判断根因 → 修脚本/报Bug/问用户
  └─ unknown → 人工排查
```