# 视觉模型池：三组双卡部署

日期：2026-11-01。目标为 GPU 0—5 的六个单卡视觉副本改成三个 TP=2 实例，GPU 6、7 的现有 vLLM 不变。

| GPU | 模型端口 | 兼容转发端口 | 总窗口 |
|---|---:|---:|---:|
| 0、1 | 9885 | 9886 → 9885 | 32768 tokens |
| 2、3 | 9887 | 9888 → 9887 | 32768 tokens |
| 4、5 | 9883 | 9884 → 9883 | 32768 tokens |

六个原地址仍可调用，但实际是三个模型实例；并发上限按三个实例规划，不能仍按六个独立 GPU 推理槽位估算。每个模型保持原 servedModelName。

## 实现

- TP=2、float16、AWQ 4bit 权重、8bit KV、session-len=32768、cache-max-entry-count=0.55、max-concurrent-requests=1。
- 各实例 `RAY_ADDRESS=local`，使用独立短路径 `/tmp/qv01`、`/tmp/qv23`、`/tmp/qv45`，避免连接其他实例集群和 Unix socket 路径超长。
- 三个兼容入口使用独立的 Nginx master，由 model-gateway 同样守护，不修改宿主共享 Nginx 配置。
- 网关增加 nginx 类型与实例 env；停止时核验真实监听者及进程组，启动时检查 TP/session-len 关键参数，拒绝把残留旧进程误报为新配置就绪。
- 配置仍在服务端 `/media/disk1/model-gateway/gateway.yaml`；管理命令保持 `python3 gateway.py status|health|start|stop|restart|monitor`。

## 部署与回滚

部署脚本为 [rollout.py](rollout.py)，修改后的管理器为 [gateway.py](gateway.py)。服务端目录：`/media/disk1/model-gateway/dual-card-20261101/`。

该目录保留 `gateway.before.yaml`、`gateway.before.py`。`apply` 拒绝覆盖备份；`retry` 只有在原配置与管理器已完全恢复时允许执行。每组必须通过约 27.8K 输入的真实截图和标准工具调用验证，才会继续下一组；失败自动回滚。

第一次切换遇到旧 PID 文件不对应真实监听 API 进程的问题，已恢复六单卡原状后修复并重试。备份未覆盖，失败与成功的验证记录均应保留。对管理器的模拟测试覆盖：实际监听者优先、Nginx worker 与 master 的组归属、TP1 旧实例不能冒充 TP2。

手动回滚命令（会停止视觉池并恢复六单卡，需安排服务切换）：

```sh
python3 /media/disk1/model-gateway/dual-card-20261101/rollout.py rollback
```

回滚后，client 的 `KEVE_CONTEXT_WINDOW_TOKENS` 也要恢复为 6000 并重启 client，避免继续将 32K 请求发送到原单卡池。回滚不操作 GPU 6、7。

## 验收与使用

最终验收（2026-11-01）：三组切换全部完成，9883—9888 六端口 `/v1/models` 均返回 200，守护进程已恢复。GPU 6、7 原 vLLM PID 80244、81076 保持不变；线上管理器与本目录 `gateway.py` SHA256 一致。

- 三路并发经兼容端口 9884、9886、9888 各发送 27806 输入 tokens（含真实截图），全部返回正确 `ObserveDatasetPanel` 工具调用，耗时分别 32.54、32.33、31.00 秒。记录见 `concurrent-validation.json`。
- client 经原生产模型入口执行 SG3287 前 14 步，69.5 秒通过；旧数据集定位器失败后，模型接管并完成后续选择和确定。唯一模型请求输入 15258 tokens、输出 163 tokens，HTTP 200、`finish_reason=tool_calls`，20.33 秒，无长度错误。本次仅验证前 14 步，不代表整个业务用例通过。
- client 已更新 `.env` 的 `KEVE_CONTEXT_WINDOW_TOKENS=32768`，输出预算 1024、安全余量 512。已运行的其他 client 进程需要重启读取。

client 证据：`/Users/liumin/Documents/eve/eve_v2/autotest-core/packages/client/.keve-local/context-benchmark-dual-card-32k-client/`；包含 `3287-result.json` 和 `requests.jsonl`。

每组验证结果位于 `validation.jsonl`；全部成功后生成 `complete.json`。另外应检查六端口健康、三路并发读图、实际 PID/GPU 映射与守护。API 200 不能替代工具调用及答案正确性检查。

client 使用 `KEVE_CONTEXT_WINDOW_TOKENS=32768`、输出 1024、安全余量 512 时，估算输入预算为 31232 tokens；图像和工具 schema 都占预算。需要重启已运行的 client 读取环境变量。

这个窗口来自当前三组服务配置，不等于整机无代价获得更高吞吐。大输入的 prefill 仍需数十秒；应继续压缩重复历史，保留当前目标和最近动作，并用实际用例检查延迟与准确率。

本次没有修改模型权重、升级软件依赖或变更 GPU 6、7 的服务。多卡窗口能力的前置实验见 [实验报告](../../vision-tp2-results-20261101.md)。
