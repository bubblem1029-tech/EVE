"""Run on model host. Reversible TP2 experiment; all paths and instances explicit."""
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path
import yaml

ROOT = Path('/media/disk1/model-gateway')
EXP = ROOT / 'experiment-tp2-20261101'
CONFIG = ROOT / 'gateway.yaml'
OLD = ['qwen3-vl-32b-awq-gpu2', 'qwen3-vl-32b-awq-gpu3']
NAME = 'qwen3-vl-32b-awq-tp2-experiment'

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def manager(action, name, experimental=False):
    env = os.environ.copy()
    if experimental:
        env.update(GATEWAY_CONFIG=str(EXP/'gateway.yaml'), GATEWAY_LOG_DIR=str(EXP/'logs'), GATEWAY_RUN_DIR=str(EXP/'run'))
    run([sys.executable, str(ROOT/'gateway.py'), action, name], env=env)

def prepare():
    EXP.mkdir(exist_ok=True)
    backup = EXP/'gateway.original.yaml'
    if backup.exists():
        raise RuntimeError('Experiment backup already exists; inspect state rather than overwrite it')
    original = CONFIG.read_bytes()
    backup.write_bytes(original)
    (EXP/'state.json').write_text(json.dumps({'monitorWasRunning': (ROOT/'run/monitor.pid').exists()}))
    cfg = yaml.safe_load(original)
    inst = next(x for x in cfg['instances'] if x['name'] == OLD[0]).copy()
    inst.update(name=NAME, enabled=True, gpu='2,3', host='127.0.0.1', port=9890)
    inst['extraArgs'] = ['--backend','pytorch','--tp','2','--dtype','float16',
        '--tool-call-parser','qwen3','--max-concurrent-requests','1',
        '--session-len','131072','--cache-max-entry-count','0.55','--quant-policy','8']
    (EXP/'gateway.yaml').write_text(yaml.safe_dump({'instances':[inst]}, sort_keys=False))
    (EXP/'proxy.conf').write_text('''worker_processes 2;
pid /media/disk1/model-gateway/experiment-tp2-20261101/proxy.pid;
error_log /media/disk1/model-gateway/experiment-tp2-20261101/proxy-error.log;
events { worker_connections 256; }
http {
 access_log /media/disk1/model-gateway/experiment-tp2-20261101/proxy-access.log;
 client_max_body_size 50m;
 server { listen 9887; location / { proxy_pass http://127.0.0.1:9883; proxy_http_version 1.1; proxy_set_header Connection ""; proxy_buffering off; proxy_read_timeout 600s; } }
 server { listen 9888; location / { proxy_pass http://127.0.0.1:9884; proxy_http_version 1.1; proxy_set_header Connection ""; proxy_buffering off; proxy_read_timeout 600s; } }
}
''')
    run([sys.executable, str(ROOT/'gateway.py'), 'monitor-stop'])
    # Persist disabled flags before stopping: the existing monitor reloads YAML.
    for item in cfg['instances']:
        if item['name'] in OLD: item['enabled'] = False
    CONFIG.write_text(yaml.safe_dump(cfg, sort_keys=False))
    for name in OLD: manager('stop', name)
    run(['/usr/sbin/nginx','-c',str(EXP/'proxy.conf'),'-p',str(EXP)])
    manager('start', NAME, experimental=True)
    run([sys.executable, str(ROOT/'gateway.py'), 'monitor'])
    print('TP2_READY', flush=True)

def restore():
    backup = EXP/'gateway.original.yaml'
    if not backup.exists(): raise RuntimeError('No original config backup')
    run([sys.executable, str(ROOT/'gateway.py'), 'monitor-stop'])
    try: manager('stop', NAME, experimental=True)
    except Exception as e: print('Experimental stop:', str(e), flush=True)
    if (EXP/'proxy.pid').exists():
        run(['/usr/sbin/nginx','-c',str(EXP/'proxy.conf'),'-p',str(EXP),'-s','quit'])
        for _ in range(30):
            if not (EXP/'proxy.pid').exists(): break
            time.sleep(1)
    original = yaml.safe_load(backup.read_bytes())
    expected = yaml.safe_load(backup.read_bytes())
    for item in expected['instances']:
        if item['name'] in OLD: item['enabled'] = False
    current = yaml.safe_load(CONFIG.read_bytes())
    if current == expected or current == original:
        CONFIG.write_bytes(backup.read_bytes())
    else:
        for item in current['instances']:
            if item['name'] in OLD:
                item['enabled'] = next(x for x in original['instances'] if x['name'] == item['name'])['enabled']
        CONFIG.write_text(yaml.safe_dump(current, sort_keys=False))
        print('Preserved concurrent configuration edits while restoring enabled flags', flush=True)
    procs = [subprocess.Popen([sys.executable,str(ROOT/'gateway.py'),'start',name]) for name in OLD]
    codes = [p.wait() for p in procs]
    if any(codes): raise RuntimeError('Original service restore failed: '+str(codes))
    if json.loads((EXP/'state.json').read_text()).get('monitorWasRunning'):
        run([sys.executable, str(ROOT/'gateway.py'), 'monitor'])
    print('ORIGINAL_TOPOLOGY_RESTORED', flush=True)

if __name__ == '__main__':
    if sys.argv[1] == 'prepare':
        try: prepare()
        except BaseException:
            if (EXP/'gateway.original.yaml').exists(): restore()
            raise
    elif sys.argv[1] == 'restore': restore()
    else: raise ValueError('Use prepare or restore')
