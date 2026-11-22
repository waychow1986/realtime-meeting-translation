import json,os,re
D='/workspace/agent/prompt/service-logs'
st=json.load(open(D+'/status.json'))
logs=[json.loads(l) for l in open(D+'/logs.jsonl')]
cases=json.load(open('/tmp/abort-manual.json'))
secrets=[v for k,v in os.environ.items() if (k.startswith('AIDH_SECRET_') or re.search(r'KEY|TOKEN|PASSWORD|SECRET',k)) and k.startswith('AIDH_') and len(v)>=8]
srcfrags=['안녕하세요 여러분','상반기 매출','감사합니다','좋은 하루','하반기']
out={'logStatus':{k:st[k] for k in ('status','logsReadAt','gaps','droppedOldest')},'cases':[]}
for c in cases:
  w0,w1=c['win']
  assert w1 < st['logsReadAt']
  inw=[l for l in logs if w0<=l['time']<=w1]
  def lvl(t):
    try: return str(json.loads(t).get('level'))
    except: return 'nonjson'
  levels={}
  for l in inw: levels[lvl(l['text'])]=levels.get(lvl(l['text']),0)+1
  ab=[json.loads(l['text']) for l in inw if 'client_aborted' in l['text']]
  errs=[l for l in inw if lvl(l['text']) in ('error','fatal','50','60') or re.search(r'\[ERROR\]|FATAL|Unhandled|uncaught',l['text'])]
  frags=srcfrags+[f for f in c['fragments'] if len(f)>=2]
  out['cases'].append({'phase':c['phase'],'mode':c['mode'],'window':c['win'],
   'client':{'abortStatus':c['abort']['status'],'bytesAtAbort':c['abort'].get('bytesAtAbort'),'hanAtAbort':c['abort'].get('hanAtAbort'),'endedAtAbort':c['abort'].get('endedAtAbort'),'normalStatus':c['normal']['status'],'normalHasHan':c['normal']['han'],'normalHasHangul':c['normal']['hangul']},
   'logLines':len(inw),'levels':levels,'errorFatal':len(errs),
   'clientAborted':len(ab),'clientAbortedLevels':[a.get('level') for a in ab],'clientAbortedKinds':[a.get('kind') for a in ab],'clientAbortedDeltaCount':[a.get('deltaCount') for a in ab],
   'clientAbortedFieldSets':sorted({','.join(sorted(a.keys())) for a in ab}),
   'contentHits':sum(1 for l in inw for f in frags if f in l['text']),
   'redactionMarkerHits':sum(l['text'].count('***') for l in inw),
   'secretHits':sum(1 for l in inw for s in secrets if s in l['text'])})
allab=[json.loads(l['text']) for l in logs if 'client_aborted' in l['text']]
out['allClientAbortedFieldSets']=sorted({','.join(sorted(a.keys())) for a in allab})
out['allLevels']={}
for l in logs:
  try: v=str(json.loads(l['text']).get('level'))
  except: v='nonjson'
  out['allLevels'][v]=out['allLevels'].get(v,0)+1
out['allLines']=len(logs); out['allClientAborted']=len(allab)
out['allSecretHits']=sum(1 for l in logs for s in secrets if s in l['text'])
print(json.dumps(out,ensure_ascii=False,indent=1))
