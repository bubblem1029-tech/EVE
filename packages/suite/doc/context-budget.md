# 模型上下文预算

`KEVE_CONTEXT_WINDOW_TOKENS` 设置实际部署容量（不是模型标称窗口）。未设置或为 `0` 时保留原始完整上下文；设置正数时启用紧凑系统提示词、schema 描述精简、历史压缩、目标相关 ARIA 选择与发送前预算检查。自定义系统提示词不会被替换。

当前物理机六个 Qwen3-VL-32B-AWQ 后端均实测 6009 输入 tokens 可生成，8009 输入失败。可使用以下保守配置：

```dotenv
KEVE_CONTEXT_WINDOW_TOKENS=6000
KEVE_LLM_MAX_OUTPUT_TOKENS=1024
KEVE_CONTEXT_SAFETY_TOKENS=512
KEVE_CONTEXT_IMAGE_TOKENS=4096
```

输入预算为 4464 估算 tokens，包含系统提示、用户消息、工具 schema 和协议余量。估算器用于保守控制，不能替代部署 tokenizer；日志中的估算值和服务 usage 应持续核对。图片使用单张固定预算估算，需要按模型设置；小窗口模式省略主循环的初始截图，视觉工具仍执行独立预算检查，无法容纳时明确报错而非绕过限制。依赖前后截图比较的任务不应使用这一小窗口配置，应选择足够大的视觉模型。

大页面保留目标相关行及祖先、完整 ref 和状态，并标记 PARTIAL。未出现在局部树里的元素不能据此断言不存在，可用 execute_javascript 或重新观察确认。原始事件与快照保留在执行报告。

错误行为：显式上下文超限不原样重试；原因未知的服务错误有限重试，耗尽后结束当前 goal 并保留原因。连续三次滚动后 ARIA 完全不变时结束探索并标记 blocked。空文本或没有有效工具调用不会被合成为成功。

从失败录制脚本可直接提取的 text/getByText 点击目标会保留在 user_request 中。若模型声称 pass，却没有在完整快照中找到与该目标对应的 ref 点击证据，则改为 blocked；不能用另一个数据集代替目标。这是窄范围的防误判检查，不是对任意 JavaScript 动作的完整语义验证。

本地开发中 suite 依赖工作区 core，先构建 core 再构建 suite。仅重建 suite、仍从已发布 core 读取旧代码，会使预算保护失效。

client 对照工具（从 client 目录运行，复用 `.env`，不在命令行传密钥）：

```sh
node --env-file=.env scripts/verify-context.cjs baseline
node --env-file=.env scripts/verify-context.cjs optimized
node --env-file=.env scripts/verify-context.cjs regressions
```

每次新实验设置唯一的 `KEVE_BENCHMARK_LABEL`，避免复用结果目录。baseline 显式关闭预算；optimized 使用上述小窗口配置。物理请求指标不记录正文、凭据或图片。原测试会创建测试看板，只能使用批准的测试账号与资产。

`baseline` 只关闭当前构建的上下文预算，不会恢复旧版重试/成功判定代码。本次历史基线是在修改代码前采集；未来若要复现完整旧行为，必须使用保存的旧构建，不能只切换这个参数。

`KEVE_BENCHMARK_PROVIDER=wanqing` 仅对当前进程切换到 `.env` 中的 LLM_BASE_URL/LLM_MODEL_NAME/LLM_API_KEY，关闭小窗口裁剪，保留完整上下文用于端点对照，不更改默认端点。

`KEVE_BENCHMARK_PROVIDER=wanqing-budgeted` 使用同一万擎配置和 32768 的应用策略预算。`KEVE_BENCHMARK_CASES=3287` 可限定用例；`KEVE_BENCHMARK_STEP_LIMIT=14` 仅执行前 14 步，结果必须标为局部验证，不能计作完整用例通过。

对录制代码中可确定的具体点击目标，若当前期望仅为编译器的“操作完成，页面正常响应”，成功执行匹配目标的 ref 点击后立即交回确定性脚本。包含额外业务断言的步骤仍需要完成断言；不会因为任意一次点击成功就自动通过。

万擎当前配置的应用 `app-4goowr-1774409971970678346` 实测 128014 输入 tokens 成功；256K 合成输入被拒绝，错误声明最大上下文为 **202752 tokens**。此值对应当前应用路由，不代表全部万擎模型。应扣除实际输出与安全余量，并注意应用内部可能调整参数。
