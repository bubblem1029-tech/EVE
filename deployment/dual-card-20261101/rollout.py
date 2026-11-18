"""Three TP2 vision instances with managed aliases; automatic full rollback."""
import hashlib, json, os, subprocess, sys, time, urllib.request
from pathlib import Path
import yaml

ROOT = Path('/media/disk1/model-gateway')
DEPLOY = ROOT/'dual-card-20261101'
CONFIG = ROOT/'gateway.yaml'
MANAGER = ROOT/'gateway.py'
PROBE = ROOT/'experiment-tp2-20261101/probe.py'
PYTHON = '/media/disk1/qwen3_32b_env_awq_lmdeploy/bin/python'
PAIRS = [('qwen3-vl-32b-awq-gpu2','qwen3-vl-32b-awq-gpu3','2,3'),
         ('qwen3-vl-32b-awq-gpu0','qwen3-vl-32b-awq-gpu1','0,1'),
         ('qwen3-vl-32b-awq','qwen3-vl-32b-awq-gpu5','4,5')]

def command(*args, **kwargs):
    return subprocess.run(list(args), check=True, **kwargs)

def manage(action, name=None):
    args = [sys.executable,str(MANAGER),action]
    if name: args.append(name)
    command(*args)

def proxy_config(port, upstream):
    path = DEPLOY/f'proxy-{port}.conf'
    (DEPLOY/f'port-{port}').mkdir(exist_ok=True)
    path.write_text(f'''worker_processes 1;
pid {DEPLOY}/proxy-{port}.pid;
error_log {DEPLOY}/proxy-{port}-error.log;
events {{ worker_connections 256; }}
http {{
 access_log {DEPLOY}/proxy-{port}-access.log;
 client_max_body_size 50m;
 server {{ listen {port}; location / {{
  proxy_pass http://127.0.0.1:{upstream};
  proxy_http_version 1.1; proxy_set_header Connection "";
  proxy_buffering off; proxy_read_timeout 600s; proxy_send_timeout 600s;
 }} }}
}}
''')
    command('/usr/sbin/nginx','-p',str(DEPLOY/f'port-{port}'),'-c',str(path),'-t')
    return str(path)

def rollback():
    print('ROLLBACK_BEGIN',flush=True)
    manage('monitor-stop')
    for item in yaml.safe_load(CONFIG.read_text())['instances']:
        manage('stop',item['name'])
    CONFIG.write_bytes((DEPLOY/'gateway.before.yaml').read_bytes())
    MANAGER.write_bytes((DEPLOY/'gateway.before.py').read_bytes())
    procs = [subprocess.Popen([sys.executable,str(MANAGER),'start',x['name']])
        for x in yaml.safe_load(CONFIG.read_text())['instances'] if x.get('enabled')]
    codes = [p.wait() for p in procs]
    if any(codes): raise RuntimeError('Rollback startup failed: '+str(codes))
    manage('monitor')
    print('ROLLBACK_COMPLETE',flush=True)

def rollout(retry=False):
    if (DEPLOY/'gateway.before.yaml').exists():
        if not retry: raise RuntimeError('Existing rollout backup; inspect before rerun')
        if CONFIG.read_bytes() != (DEPLOY/'gateway.before.yaml').read_bytes() or MANAGER.read_bytes() != (DEPLOY/'gateway.before.py').read_bytes():
            raise RuntimeError('Retry requires exact restoration of original configuration and manager')
    old = CONFIG.read_bytes()
    # A staged copy prevents overwriting configuration edited since preparation.
    if old != (DEPLOY/'gateway.original.yaml').read_bytes(): raise RuntimeError('Configuration changed since staging')
    if hashlib.sha256(MANAGER.read_bytes()).hexdigest() != (DEPLOY/'gateway.expected.sha256').read_text().strip():
        raise RuntimeError('Manager changed since staging')
    if not retry:
        (DEPLOY/'gateway.before.yaml').write_bytes(old)
        (DEPLOY/'gateway.before.py').write_bytes(MANAGER.read_bytes())
    cfg = yaml.safe_load(old)
    expected_names = {name for a,b,_ in PAIRS for name in [a,b]}
    if {x['name'] for x in cfg['instances']} != expected_names:
        raise RuntimeError('Unexpected instance set; refusing broad changes')
    manage('monitor-stop')
    MANAGER.write_bytes((DEPLOY/'gateway.new.py').read_bytes())
    try:
        for primary, alias, gpu in PAIRS:
            main = next(x for x in cfg['instances'] if x['name']==primary)
            side = next(x for x in cfg['instances'] if x['name']==alias)
            print('PAIR_BEGIN '+gpu,flush=True)
            proxy = proxy_config(side['port'],main['port'])
            manage('stop',alias)
            manage('stop',primary)
            main.update(gpu=gpu, extraArgs=['--backend','pytorch','--tp','2','--dtype','float16',
                '--tool-call-parser','qwen3','--max-concurrent-requests','1',
                '--session-len','32768','--cache-max-entry-count','0.55','--quant-policy','8'])
            # Each replica owns a local Ray cluster, scoped to its visible GPU pair.
            # Ray uses Unix sockets with a short pathname limit.
            ray_dir = Path('/tmp/qv'+gpu.replace(',','')); ray_dir.mkdir(exist_ok=True)
            if ray_dir.is_symlink() or ray_dir.stat().st_uid != 0:
                raise RuntimeError('Unexpected Ray temp directory owner/path')
            main['env']={'RAY_ADDRESS':'local','RAY_TMPDIR':str(ray_dir)}
            side.update(engine='nginx',gpu='',modelPath=proxy,extraArgs=[],env={})
            CONFIG.write_text(yaml.safe_dump(cfg,sort_keys=False))
            manage('start',primary)
            manage('start',alias)
            env=os.environ.copy()
            env.update(PROBE_BASE_URL=f"http://127.0.0.1:{main['port']}/v1",PROBE_CANONICAL_TOOLS='1')
            result=subprocess.run([PYTHON,str(PROBE),'structured','24000'],env=env,
                capture_output=True,text=True,timeout=300)
            print(result.stdout,flush=True)
            if result.returncode: raise RuntimeError(result.stderr[-2000:])
            lines=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if not lines or not lines[-1].get('observationCorrect'):
                raise RuntimeError('Vision/tool validation failed for '+gpu)
            with (DEPLOY/'validation.jsonl').open('a') as out:
                out.write(json.dumps({'gpu':gpu,'port':main['port'],'alias':side['port'],'result':lines[-1]},ensure_ascii=False)+'\n')
            print('PAIR_VALIDATED '+gpu,flush=True)
        manage('monitor')
        (DEPLOY/'complete.json').write_text(json.dumps({'completed':time.strftime('%Y-%m-%d %H:%M:%S'),
            'windowTokens':32768,'gpuPairs':['0,1','2,3','4,5'],
            'configSha256':hashlib.sha256(CONFIG.read_bytes()).hexdigest()},indent=2))
        print('ALL_THREE_PAIRS_READY',flush=True)
    except BaseException:
        rollback()
        raise

if __name__=='__main__':
    if sys.argv[1]=='apply': rollout()
    elif sys.argv[1]=='retry': rollout(retry=True)
    elif sys.argv[1]=='rollback': rollback()
    else: raise ValueError('Use apply or rollback')
