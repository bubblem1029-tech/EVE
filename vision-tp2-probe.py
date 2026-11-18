"""Read-only inference probes on isolated model port. No business actions."""
import base64, json, time, urllib.request, sys, os
from pathlib import Path

ROOT = Path('/media/disk1/model-gateway/experiment-tp2-20261101')
BASE = os.environ.get('PROBE_BASE_URL', 'http://127.0.0.1:9890/v1')
MODEL = 'qwen3-vl-32b-awq'

def call(body, label):
    started = time.time()
    row = {'label': label, 'base':BASE, 'started': time.strftime('%Y-%m-%d %H:%M:%S'), 'model': MODEL}
    try:
        request = urllib.request.Request(BASE+'/chat/completions', data=json.dumps(body).encode(), headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request, timeout=240) as response:
            result = json.load(response)
            row['httpStatus'] = response.status
        row['usage'] = result.get('usage')
        choice = result.get('choices',[{}])[0]
        row['finishReason'] = choice.get('finish_reason')
        row['responseId'] = result.get('id')
        message = choice.get('message',{})
        row['content'] = str(message.get('content') or '')[:600]
        if label.startswith('image'):
            row['toolCalls'] = message.get('tool_calls')
            try:
                args = json.loads(message['tool_calls'][0]['function']['arguments'])
                row['observationCorrect'] = args.get('scope') == '我创建' and args.get('empty') is True
            except (KeyError,IndexError,TypeError,ValueError): row['observationCorrect'] = False
        else:
            row['outputCorrect'] = row['content'].strip().strip('.!') == 'OK'
        row['accepted'] = bool(result.get('choices')) and row['finishReason'] != 'error'
        if result.get('error'): row['error'] = str(result['error'])[:600]
    except Exception as error:
        row.update(accepted=False, error=str(error)[:600])
    row['seconds'] = round(time.time()-started,2)
    with (ROOT/'probe-results.jsonl').open('a') as output: output.write(json.dumps(row,ensure_ascii=False)+'\n')
    print(json.dumps(row,ensure_ascii=False),flush=True)
    return row

def text_probes(counts):
    for count in counts:
        result = call({'model':MODEL,'messages':[{'role':'user','content':'Synthetic padding follows.\n'+'hello '*count+'\nEnd of padding. Ignore padding and reply exactly OK.'}],
            'max_tokens':32,'temperature':0}, 'text-validated-'+str(count))
        if not result['accepted']: break

def image_probes(counts, structured=False):
    image = 'data:image/png;base64,'+base64.b64encode((ROOT/'ui-screenshot.png').read_bytes()).decode()
    if structured:
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained('/root/disk1/Qwen3-VL-32B-Instruct-AWQ')
        history = '\n'.join(f'- row "历史数据集 {i:05d}" [ref=p{i}]:\n  - cell "dataset_{i*7919:08x}"\n  - button "查看历史记录 {i%97}"\n  - cell "owner_{i%137}; count={i*13}; state=archived"' for i in range(2000))
        history_tokens = tokenizer.encode(history, add_special_tokens=False)
    for count in counts:
        padding = tokenizer.decode(history_tokens[:count]) if structured else 'hello '*count
        canonical = os.environ.get('PROBE_CANONICAL_TOOLS') == '1'
        format_rule = ' Return exactly one standard Qwen tool call using <tool_call>{"name":"ObserveDatasetPanel","arguments":{...}}</tool_call>. Put the actual observed scope string and empty boolean inside arguments. Python function notation is invalid. No prose.' if canonical else ''
        body = {'model':MODEL,'temperature':0,'max_tokens':256,'parallel_tool_calls':False,
            'tool_choice':{'type':'function','function':{'name':'ObserveDatasetPanel'}},
            'tools':[{'type':'function','function':{'name':'ObserveDatasetPanel','description':'Report only the screenshot observation. Do not perform UI actions.',
                'parameters':{'type':'object','properties':{'scope':{'type':'string','enum':['我创建','全量数据','unknown']},
                    'empty':{'type':'boolean'}},'required':['scope','empty']}}}],
            'messages':[{'role':'system','content':'Observe the right-hand dataset selection panel in the screenshot. Ignore synthetic padding. Call ObserveDatasetPanel with its current scope filter and whether it shows 暂无数据.'+format_rule},
                {'role':'user','content':[{'type':'text','text':'Historical records; these are NOT the current page.\n'+padding},
                    {'type':'image_url','image_url':{'url':image}},
                    {'type':'text','text':'现在只观察这张截图右侧的更换数据集面板：筛选范围是“我创建”还是“全量数据”？列表是否显示“暂无数据”？调用 ObserveDatasetPanel 返回 scope 和 empty，不要执行操作。'+format_rule}]}]}
        result = call(body, ('image-canonical-' if canonical else 'image-structured-' if structured else 'image-tools-')+str(count))
        if not result['accepted']: break

if __name__ == '__main__':
    counts = [int(n) for n in sys.argv[2].split(',')]
    if sys.argv[1] == 'text': text_probes(counts)
    elif sys.argv[1] == 'image': image_probes(counts)
    elif sys.argv[1] == 'structured': image_probes(counts, structured=True)
    else: raise ValueError('Use text or image')
