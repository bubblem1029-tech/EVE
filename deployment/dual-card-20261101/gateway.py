#!/usr/bin/env python3
"""
gateway.py — 通用推理实例管理器（配置驱动，不绑定任何具体模型）

为什么重写而不是改 run_image_pick.sh：
    run_image_pick.sh 把模型路径、GPU→端口映射（9879+GPU）、image_pick.py、
    nginx upstream 名全部硬编码成 Qwen2.5 专用逻辑。新增模型要改脚本，
    换引擎要改脚本，且只能起 image_pick。这里把「实例定义」外置到 gateway.yaml，
    脚本只做通用的 start/stop/status/logs/health，支持 lmdeploy 与 vLLM 两种引擎。

设计约束：
    - 只动配置里点名的实例；start/stop 绝不按端口或 GPU 批量杀进程。
    - 端口被非本实例进程占用时拒绝启动，避免误杀 vLLM 等无关服务。
    - 只暴露通用推理端点；提示词、SSIM、S3 等业务逻辑不在本机（已上移 backend）。

用法：
    python3 gateway.py status
    python3 gateway.py start                 # 启动 enabled=true 的实例
    python3 gateway.py start qwen3-vl-32b-awq
    python3 gateway.py stop qwen3-vl-32b-awq
    python3 gateway.py restart qwen3-vl-32b-awq
    python3 gateway.py logs qwen3-vl-32b-awq [-f]
    python3 gateway.py health                # 探活所有实例的 /v1/models
"""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("需要 pyyaml：pip install pyyaml")

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("GATEWAY_CONFIG", BASE_DIR / "gateway.yaml"))
LOG_DIR = Path(os.environ.get("GATEWAY_LOG_DIR", BASE_DIR / "logs"))
RUN_DIR = Path(os.environ.get("GATEWAY_RUN_DIR", BASE_DIR / "run"))
START_TIMEOUT_SEC = int(os.environ.get("GATEWAY_START_TIMEOUT", "300"))
STOP_TIMEOUT_SEC = int(os.environ.get("GATEWAY_STOP_TIMEOUT", "60"))


def log(msg: str) -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def load_instances() -> list:
    if not CONFIG_PATH.exists():
        sys.exit(f"配置不存在: {CONFIG_PATH}")
    with CONFIG_PATH.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    instances = data.get("instances") or []
    if not instances:
        sys.exit(f"配置里没有 instances: {CONFIG_PATH}")
    return instances


def find_instance(instances: list, name: str) -> dict:
    for item in instances:
        if item.get("name") == name:
            return item
    available = ", ".join(i.get("name", "?") for i in instances)
    sys.exit(f"未知实例 '{name}'。已配置: {available}")


def pid_file(inst: dict) -> Path:
    return RUN_DIR / f"{inst['name']}.pid"


def log_file(inst: dict) -> Path:
    return LOG_DIR / f"{inst['name']}.log"


def listening_pid(port: int):
    """返回监听该端口的 pid（无则 None）。用 /proc 扫描，避免依赖 lsof。"""
    inodes = set()
    for proto in ("tcp", "tcp6"):
        path = Path(f"/proc/net/{proto}")
        if not path.exists():
            continue
        for line in path.read_text().splitlines()[1:]:
            parts = line.split()
            if len(parts) < 10 or parts[3] != "0A":
                continue
            local = parts[1]
            try:
                if int(local.split(":")[1], 16) == port:
                    inodes.add(parts[9])
            except (IndexError, ValueError):
                continue
    if not inodes:
        return None
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        fd_dir = pid_dir / "fd"
        try:
            for fd in fd_dir.iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue
                if target.startswith("socket:[") and target[8:-1] in inodes:
                    return int(pid_dir.name)
        except (PermissionError, FileNotFoundError):
            continue
    return None


def read_pid(inst: dict):
    state = read_state(inst)
    pid = (state or {}).get("pid")
    return pid if pid and Path(f"/proc/{pid}").exists() else None


def read_state(inst: dict) -> dict:
    """
    读取实例运行态 {pid, pgid}。

    为什么要存 pgid：lmdeploy/vLLM 会在自己的进程组里 fork 出 engine worker，
    只 kill 父进程会把 worker 留成孤儿——它们继续占着显存，下一次启动直接 OOM。
    记录 pgid 后，stop 可以整组回收。
    """
    path = pid_file(inst)
    if not path.exists():
        return {}
    raw = path.read_text().strip()
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    # 兼容早期只写 pid 的格式
    return {"pid": int(raw)} if raw.isdigit() else {}


def write_state(inst: dict, pid: int, pgid: int) -> None:
    pid_file(inst).write_text(json.dumps({"pid": pid, "pgid": pgid}))


def _kill_process_group(pgid: int, name: str, timeout: int) -> bool:
    """TERM 整个进程组，超时后 KILL。返回是否已清空。"""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except PermissionError:
        log(f"{name}: 无权向进程组 {pgid} 发送 TERM")
        return False

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _group_alive(pgid):
            return True
        time.sleep(1)

    log(f"{name}: 进程组 {pgid} TERM 超时，发送 KILL")
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    deadline = time.time() + 15
    while time.time() < deadline:
        if not _group_alive(pgid):
            return True
        time.sleep(1)
    return not _group_alive(pgid)


def _group_alive(pgid: int) -> bool:
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            if os.getpgid(int(pid_dir.name)) == pgid:
                return True
        except (ProcessLookupError, PermissionError, OSError):
            continue
    return False


def gpu_compute_pids(gpu_spec: str) -> list:
    """某张卡上的计算进程 pid 列表。gpu_spec 支持 '4' 或 '4,5'。"""
    pids = []
    for gpu in str(gpu_spec).split(","):
        gpu = gpu.strip()
        if not gpu:
            continue
        try:
            out = subprocess.run(
                ["nvidia-smi", "-i", gpu, "--query-compute-apps=pid", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10, check=False,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for line in out.splitlines():
            line = line.strip()
            if line.isdigit():
                pids.append(int(line))
    return pids


def reap_stale(inst: dict) -> None:
    """
    清理上一次崩溃/被强杀留下的孤儿 worker。

    只认两种情况，避免误伤同机其他服务：
      1. 记录的 pgid 与我们的 pgid 一致；
      2. 进程环境变量 GATEWAY_INSTANCE 命中本实例名（worker 会继承）；
      3. cmdline 里含本实例的权重路径。
    """
    name = inst["name"]
    state = read_state(inst)
    old_pgid = state.get("pgid")
    gpu = str(inst.get("gpu", ""))
    model_path = inst["modelPath"]
    killed = []

    for pid in gpu_compute_pids(gpu):
        if old_pgid:
            try:
                if os.getpgid(pid) == old_pgid:
                    killed.append(pid)
                    continue
            except (ProcessLookupError, OSError):
                pass
        environ_path = Path(f"/proc/{pid}/environ")
        try:
            environ = environ_path.read_bytes()
            if f"GATEWAY_INSTANCE={name}".encode() in environ:
                killed.append(pid)
                continue
        except OSError:
            pass
        cmdline_path = Path(f"/proc/{pid}/cmdline")
        try:
            cmdline = cmdline_path.read_bytes().replace(b"\x00", b" ").decode(errors="ignore")
        except OSError:
            continue
        if model_path in cmdline:
            killed.append(pid)

    for pid in killed:
        log(f"{name}: 清理上次残留 worker pid={pid}")
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if killed:
        time.sleep(3)


def build_command(inst: dict) -> list:
    venv = Path(inst["venv"])
    engine = inst.get("engine", "lmdeploy")
    model_path = inst["modelPath"]
    port = str(inst["port"])
    host = inst.get("host", "0.0.0.0")
    served = inst.get("servedModelName") or inst["name"]
    extra = [str(a) for a in (inst.get("extraArgs") or [])]

    if engine == "lmdeploy":
        exe = venv / "bin" / "lmdeploy"
        cmd = [
            str(exe), "serve", "api_server", model_path,
            "--server-name", host,
            "--server-port", port,
            "--model-name", served,
        ]
    elif engine == "vllm":
        exe = venv / "bin" / "vllm"
        cmd = [
            str(exe), "serve", model_path,
            "--host", host,
            "--port", port,
            "--served-model-name", served,
        ]
    elif engine == "nginx":
        # A managed, isolated compatibility listener; never reload shared nginx.
        cmd = ["/usr/sbin/nginx", "-p", str(Path(model_path).parent / f"port-{port}"),
               "-c", model_path, "-g", "daemon off;"]
    else:
        sys.exit(f"不支持的 engine='{engine}'（仅支持 lmdeploy / vllm）")
    return cmd + extra


def is_our_process(inst: dict, pid: int) -> bool:
    cmdline_path = Path(f"/proc/{pid}/cmdline")
    if not cmdline_path.exists():
        return False
    try:
        cmdline = cmdline_path.read_bytes().replace(b"\x00", b" ").decode(errors="ignore")
    except OSError:
        return False
    return inst["modelPath"] in cmdline and str(inst["port"]) in cmdline


def wait_http_ready(port: int, timeout: int) -> bool:
    url = f"http://127.0.0.1:{port}/v1/models"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError):
            pass
        time.sleep(2)
    return False


def start_instance(inst: dict) -> bool:
    name, port = inst["name"], int(inst["port"])
    occupied = listening_pid(port)
    if occupied:
        if read_pid(inst) == occupied or is_our_process(inst, occupied):
            extra = [str(a) for a in inst.get("extraArgs", [])]
            actual = Path(f"/proc/{occupied}/cmdline").read_bytes().split(b"\x00")
            actual = [a.decode(errors="ignore") for a in actual if a]
            for flag in ("--tp", "--session-len"):
                if flag in extra:
                    expected = extra[extra.index(flag) + 1]
                    if flag not in actual or actual[actual.index(flag) + 1] != expected:
                        log(f"{name}: 监听进程参数与配置不符 ({flag} expected={expected})，拒绝误报就绪")
                        return False
            log(f"{name}: 已在运行 pid={occupied} port={port}")
            return True
        log(f"{name}: 端口 {port} 被 pid={occupied} 占用且不是本实例，拒绝启动")
        return False

    existing = read_pid(inst)
    if existing:
        log(f"{name}: pid 文件指向 {existing} 但端口未监听，清理陈旧 pid 文件")
    # 上一轮可能被强杀，留下仍占显存的孤儿 worker——启动前先回收，否则必定 OOM
    reap_stale(inst)
    pid_file(inst).unlink(missing_ok=True)

    cmd = build_command(inst)
    if not Path(cmd[0]).exists():
        log(f"{name}: 找不到可执行文件 {cmd[0]}")
        return False
    if not Path(inst["modelPath"]).exists():
        log(f"{name}: 权重目录不存在 {inst['modelPath']}")
        return False

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({str(k): str(v) for k, v in inst.get("env", {}).items()})
    env["CUDA_VISIBLE_DEVICES"] = str(inst.get("gpu", "0"))
    # 实例标记：multiprocessing spawn 出的 worker 会继承 os.environ，
    # 因此即使父进程被强杀，也能靠这个标记在 /proc/<pid>/environ 里认出孤儿。
    env["GATEWAY_INSTANCE"] = inst["name"]
    # 部分环境把权重放在 NFS/慢盘，lmdeploy 需要放宽 ray object store 检查
    env.setdefault("RAY_OBJECT_STORE_ALLOW_SLOW_STORAGE", "1")

    out = log_file(inst).open("a", encoding="utf-8")
    out.write(f"\n===== start {datetime.now():%Y-%m-%d %H:%M:%S} GPU={inst.get('gpu')} port={port} =====\n")
    out.flush()
    log(f"{name}: 启动 {' '.join(cmd)} (GPU={inst.get('gpu')})")
    proc = subprocess.Popen(
        cmd,
        stdout=out,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        env=env,
        start_new_session=True,
    )
    # start_new_session=True 让进程自成组长，pgid == pid，便于整组回收
    write_state(inst, proc.pid, proc.pid)

    if wait_http_ready(port, START_TIMEOUT_SEC):
        log(f"{name}: 就绪 pid={proc.pid} http=127.0.0.1:{port}/v1")
        return True
    log(f"{name}: {START_TIMEOUT_SEC}s 内未就绪，日志 {log_file(inst)}")
    # 启动失败同样要整组回收，避免失败进程继续霸卡
    _kill_process_group(proc.pid, name, 15)
    return False


def stop_instance(inst: dict) -> bool:
    name, port = inst["name"], int(inst["port"])
    state = read_state(inst)
    bound = listening_pid(port)
    recorded = state.get("pid")
    if bound and is_our_process(inst, bound):
        pid = bound
        if recorded and recorded != bound:
            log(f"{name}: PID 记录 {recorded} 与实际监听 {bound} 不一致，使用已核验的监听进程")
    elif bound:
        # nginx workers inherit the master's socket but rewrite argv; accept only
        # a worker in the verified recorded master's own process group.
        try:
            same_group = recorded and is_our_process(inst, recorded) and os.getpgid(bound) == os.getpgid(recorded)
        except ProcessLookupError:
            same_group = False
        if not same_group:
            log(f"{name}: 端口监听者不属于本实例，拒绝停止")
            return False
        pid = recorded
    else:
        pid = recorded
    if not pid:
        log(f"{name}: 未在运行")
        pid_file(inst).unlink(missing_ok=True)
        return True
    if not is_our_process(inst, pid):
        log(f"{name}: pid={pid} 与实例不匹配，拒绝停止（避免误杀）")
        return False

    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        reap_stale(inst)
        pid_file(inst).unlink(missing_ok=True)
        return True
    log(f"{name}: 停止进程组 pgid={pgid} (pid={pid})")
    ok = _kill_process_group(pgid, name, STOP_TIMEOUT_SEC)
    # 兜底：小组没清干净时，按权重路径清理该卡上的残留 worker
    reap_stale(inst)
    pid_file(inst).unlink(missing_ok=True)
    log(f"{name}: {'已停止' if ok else '停止未完全成功，请检查日志'}")
    return ok


def gpu_memory() -> dict:
    """GPU 序号 → 已用显存 MiB。失败返回空 dict，不阻断 status。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    result = {}
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and parts[0].isdigit():
            result[parts[0]] = parts[1]
    return result


def cmd_status(instances: list, _args) -> int:
    mem = gpu_memory()
    header = f"{'INSTANCE':28} {'ENGINE':10} {'GPU':5} {'PORT':6} {'PID':8} {'HTTP':6} {'MEM':8} {'ENABLED':8}"
    print(header)
    print("-" * len(header))
    for inst in instances:
        port = int(inst["port"])
        pid = read_pid(inst) or listening_pid(port)
        http = "ok" if wait_http_ready(port, 1) else "-"
        gpu = str(inst.get("gpu", "-"))
        used = mem.get(gpu.split(",")[0], "?")
        print(
            f"{inst['name']:28} {inst.get('engine', 'lmdeploy'):10} {gpu:5} {port:<6} "
            f"{(str(pid) if pid else '-'):8} {http:6} {str(used) + 'MiB':8} "
            f"{'yes' if inst.get('enabled') else 'no':8}"
        )
    print(f"\n配置: {CONFIG_PATH}\n日志目录: {LOG_DIR}")
    return 0


def cmd_health(instances: list, _args) -> int:
    rc = 0
    for inst in instances:
        port = int(inst["port"])
        url = f"http://127.0.0.1:{port}/v1/models"
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                payload = json.loads(resp.read())
            models = [m.get("id") for m in payload.get("data", [])]
            log(f"{inst['name']}: ok models={models}")
        except Exception as err:  # noqa: BLE001 - health 需要把任何异常转为状态
            log(f"{inst['name']}: FAILED {type(err).__name__}: {err}")
            rc = 1
    return rc


def cmd_logs(instances: list, args) -> int:
    inst = find_instance(instances, args.name)
    path = log_file(inst)
    if not path.exists():
        log(f"{inst['name']}: 日志不存在 {path}")
        return 1
    cmd = ["tail"] + (["-f"] if args.follow else ["-n", str(args.lines)]) + [str(path)]
    return subprocess.call(cmd)


def monitor_file() -> Path:
    return RUN_DIR / "monitor.pid"


def monitor_loop(interval: int) -> None:
    """守护 enabled 实例：不在听就拉起。沿用本机既有的 monitor 约定（无 systemd）。"""
    log(f"守护启动 interval={interval}s")
    while True:
        for inst in load_instances():
            if not inst.get("enabled"):
                continue
            port = int(inst["port"])
            if wait_http_ready(port, 1):
                continue
            log(f"{inst['name']}: 未就绪，自动拉起")
            try:
                start_instance(inst)
            except Exception as err:  # noqa: BLE001 - 守护进程不能因单实例异常退出
                log(f"{inst['name']}: 拉起失败 {type(err).__name__}: {err}")
        time.sleep(interval)


def cmd_monitor(instances: list, args) -> int:
    path = monitor_file()
    if path.exists():
        try:
            old = int(path.read_text().strip())
        except (ValueError, OSError):
            old = 0
        if old and Path(f"/proc/{old}").exists():
            log(f"守护已在运行 pid={old}，先执行 monitor-stop")
            return 1
        path.unlink(missing_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / "monitor.log"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    out = log_path.open("a", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "__monitor_loop", "--interval", str(args.interval)],
        stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True,
    )
    path.write_text(str(proc.pid))
    log(f"守护已启动 pid={proc.pid} 日志={log_path}")
    return 0


def cmd_monitor_stop(_instances: list, _args) -> int:
    path = monitor_file()
    if not path.exists():
        log("守护未运行")
        return 0
    try:
        pid = int(path.read_text().strip())
    except (ValueError, OSError):
        path.unlink(missing_ok=True)
        log("pid 文件损坏，已清理")
        return 0
    cmdline_path = Path(f"/proc/{pid}/cmdline")
    is_monitor = cmdline_path.exists() and b"__monitor_loop" in cmdline_path.read_bytes()
    if not is_monitor:
        path.unlink(missing_ok=True)
        log(f"pid={pid} 不是本守护，拒绝停止；已清理 pid 文件")
        return 1
    os.kill(pid, signal.SIGTERM)
    path.unlink(missing_ok=True)
    log(f"守护已停止 pid={pid}")
    return 0


def select(instances: list, names: list) -> list:
    if names:
        return [find_instance(instances, n) for n in names]
    enabled = [i for i in instances if i.get("enabled")]
    if not enabled:
        log("配置里没有 enabled=true 的实例（指定实例名可强制操作）")
    return enabled


def main() -> int:
    parser = argparse.ArgumentParser(description="通用推理实例管理器")
    sub = parser.add_subparsers(dest="command")

    for name in ("start", "stop", "restart"):
        p = sub.add_parser(name)
        p.add_argument("names", nargs="*", help="实例名；省略则操作 enabled=true 的实例")

    sub.add_parser("status")
    sub.add_parser("health")

    p_monitor = sub.add_parser("monitor")
    p_monitor.add_argument("--interval", type=int, default=60, help="检查间隔秒数")
    sub.add_parser("monitor-stop")
    p_loop = sub.add_parser("__monitor_loop")
    p_loop.add_argument("--interval", type=int, default=60)

    p_logs = sub.add_parser("logs")
    p_logs.add_argument("name")
    p_logs.add_argument("-f", "--follow", action="store_true")
    p_logs.add_argument("-n", "--lines", type=int, default=100)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    instances = load_instances()

    if args.command == "status":
        return cmd_status(instances, args)
    if args.command == "health":
        return cmd_health(instances, args)
    if args.command == "logs":
        return cmd_logs(instances, args)
    if args.command == "monitor":
        return cmd_monitor(instances, args)
    if args.command == "monitor-stop":
        return cmd_monitor_stop(instances, args)
    if args.command == "__monitor_loop":
        monitor_loop(args.interval)
        return 0

    targets = select(instances, args.names)
    if not targets:
        return 1
    rc = 0
    for inst in targets:
        if args.command == "start":
            ok = start_instance(inst)
        elif args.command == "stop":
            ok = stop_instance(inst)
        else:
            ok = stop_instance(inst) and start_instance(inst)
        rc = rc or (0 if ok else 1)
    return rc


if __name__ == "__main__":
    sys.exit(main())
