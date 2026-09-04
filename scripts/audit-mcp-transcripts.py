#!/usr/bin/env python3
# Audit Rabbithole MCP efficiency over a Claude Code transcript directory.
# Usage: python3 scripts/audit-mcp-transcripts.py ~/.claude/projects/<project-dir>
# Merges tool_result blocks with <task-notification> results (the host backgrounds
# MCP calls after 120s) by task id, then prints the SPEC-MCP-EFFICIENCY.md baseline table.
import json,glob,collections,statistics as st,re,os,html
from datetime import datetime
import sys
D=os.path.expanduser(sys.argv[1] if len(sys.argv)>1 else '~/.claude/projects/-Users-shlokkhemani-Projects-lifestream')
files=sorted(glob.glob(D+'/*.jsonl'))
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp() if s else None
def med(xs): return round(st.median(xs),1) if xs else None
def pct(xs,p):
    if not xs: return None
    xs=sorted(xs); return round(xs[min(len(xs)-1,int(p*len(xs)))],1)
def txt_of(b):
    c=b.get('content')
    if isinstance(c,str): return c
    if isinstance(c,list): return ''.join(x.get('text','') for x in c if isinstance(x,dict))
    return ''
RH=lambda n: n.startswith('mcp__rabbit')
events=[]; uses={}
for f in files:
    fid=os.path.basename(f)[:8]
    for i,line in enumerate(open(f)):
        try: o=json.loads(line)
        except: continue
        t=o.get('type'); m=o.get('message') or {}; cont=m.get('content'); T=ts(o.get('timestamp'))
        if t=='assistant' and isinstance(cont,list):
            usage=m.get('usage') or {}
            for b in cont:
                if not isinstance(b,dict): continue
                if b.get('type')=='tool_use':
                    e={'k':'use','f':fid,'i':i,'t':T,'id':b['id'],'name':b.get('name',''),'input':b.get('input') or {},'usage':usage}
                    events.append(e); uses[b['id']]=e
                elif b.get('type')=='text': events.append({'k':'text','f':fid,'i':i,'t':T,'len':len(b.get('text','')),'text':b.get('text','')})
        elif t=='user':
            if isinstance(cont,list):
                for b in cont:
                    if isinstance(b,dict) and b.get('type')=='tool_result':
                        txt=txt_of(b); mm=re.search(r'moved to the background as task (\w+)',txt)
                        events.append({'k':'res','f':fid,'i':i,'t':T,'id':b.get('tool_use_id'),'text':txt,'bg_task':mm.group(1) if mm else None})
            elif isinstance(cont,str):
                if '<task-notification>' in cont:
                    tid=re.search(r'<task-id>(\w+)</task-id>',cont); summ=re.search(r'<summary>(.*?)</summary>',cont,re.S); r=re.search(r'<result>\n?(.*?)\n?</result>',cont,re.S)
                    events.append({'k':'notif','f':fid,'i':i,'t':T,'task':tid.group(1) if tid else None,'summary':summ.group(1) if summ else '','text':html.unescape(r.group(1)) if r else ''})
                else: events.append({'k':'human','f':fid,'i':i,'t':T,'len':len(cont)})
def parse(txt):
    try: return json.loads(txt)
    except: return None
res_by_id={e['id']:e for e in events if e['k']=='res'}
notif_by_task=collections.defaultdict(list)
for e in events:
    if e['k']=='notif' and 'rabbit-hole' in e['summary']: notif_by_task[e['task']].append(e)
rh=[e for e in events if e['k']=='use' and RH(e['name'])]
# link results: direct or via background task notification
bg=0; linked=0; nolink=0
for e in rh:
    r=res_by_id.get(e['id']); e['res']=r; e['final']=None
    if r and r.get('bg_task'):
        bg+=1; ns=notif_by_task.get(r['bg_task'])
        if ns: e['final']=ns[0]; linked+=1
        else: nolink+=1
    elif r: e['final']=r
    if e['final']: e['j']=parse(e['final']['text'])
    else: e['j']=None
print('RH calls',len(rh),'backgrounded',bg,'bg with notification',linked,'bg never resolved in transcript',nolink)
allnotifs=[e for e in events if e['k']=='notif' and 'rabbit-hole' in e['summary']]; print('rabbit-hole notifications total',len(allnotifs),'unlinked to a call',sum(1 for e in allnotifs if e['task'] not in {r.get('bg_task') for r in res_by_id.values()}))
# statuses now
short=lambda n:n.split('__')[-1]
stat=collections.Counter()
for e in rh:
    if e['j']: stat[(short(e['name']),e['j'].get('status'))]+=1
    elif e['final']: stat[(short(e['name']),'ERR:'+e['final']['text'][:45])]+=1
    else: stat[(short(e['name']),'UNRESOLVED')]+=1
print('\n== final statuses'); [print(' ',k,v) for k,v in stat.most_common(30)]
brs=[e for e in rh if e['j'] and e['j'].get('status')=='branch_request']
print('\n== branch_requests delivered',len(brs),'via notification',sum(1 for e in brs if e['final']['k']=='notif'))
# duplicates: same request_id delivered twice?
rc=collections.Counter(e['j']['request_id'] for e in brs); print('request_ids delivered >1 times',sum(1 for v in rc.values() if v>1))
tot_br=sum(len(e['final']['text']) for e in brs); print('branch_request payload chars',tot_br)
for key in ['selected_text','question','lineage','notes','rehydration','saved_asks','region','attachments','instruction','anchor','lens']:
    v=[len(json.dumps(e['j'].get(key))) for e in brs if e['j'].get(key) is not None]
    print(f'  {key}: present {len(v)} sum {sum(v)} med {med(v)} max {max(v) if v else None}')
# notes repeats
seen=collections.defaultdict(set); tx=0;uniq=set();rep=0;redund=0;lin=0;ag=0;perreq=[];ack_notes=0;ack_rep=0
for e in brs:
    sid=e['j'].get('session_id'); notes=e['j'].get('notes') or []; perreq.append(len(notes))
    for n in notes:
        tx+=1; key=(n.get('note_id'),n.get('content')); sz=len(json.dumps(n)); uniq.add(key)
        if n.get('on_lineage'): lin+=1
        if n.get('author')=='agent': ag+=1
        isack=len((n.get('content') or '').strip())<=12
        if isack: ack_notes+=1
        if key in seen[sid]:
            rep+=1; redund+=sz
            if isack: ack_rep+=1
        seen[sid].add(key)
print(f'notes: transmitted {tx} unique {len(uniq)} repeats {rep} ({rep/max(1,tx):.1%}) redundant chars {redund} ({redund/tot_br:.1%} of branch payload) on_lineage {lin} agent {ag} | short(<=12ch) notes tx {ack_notes} of which repeats {ack_rep}')
print('notes/request med',med(perreq),'p90',pct(perreq,.9),'max',max(perreq))
# session_closed notes
sc=[e for e in rh if e['j'] and e['j'].get('status')=='session_closed']; print('session_closed',len(sc),'with notes',sum(1 for e in sc if e['j'].get('notes')),'notes chars',sum(len(json.dumps(e['j'].get('notes'))) for e in sc if e['j'].get('notes')),'reasons',collections.Counter(e['j'].get('reason') for e in sc))
# rehydration
rehy=[e for e in brs if e['j'].get('rehydration')]; print('rehydration',len(rehy),'chars',sum(len(json.dumps(e['j']['rehydration'])) for e in rehy),'med',med([len(json.dumps(e['j']['rehydration'])) for e in rehy]),'max',max([len(json.dumps(e['j']['rehydration'])) for e in rehy] or [0]))
for e in rehy[:3]:
    r=e['j']['rehydration']; print('   rehydration keys',list(r.keys()) if isinstance(r,dict) else type(r), 'nodes',len(r.get('nodes',[])) if isinstance(r,dict) else '')
# ---------- resume loop by date
opens=[e for e in rh if short(e['name'])=='open_rabbithole']
byfile=collections.defaultdict(list)
for e in rh: byfile[e['f']].append(e)
print('\n== per-day: backgrounded listener results, resumes, resumes right after a backgrounded result, resume outcomes')
day=collections.defaultdict(lambda:collections.Counter())
for f,lst in byfile.items():
    lst.sort(key=lambda e:e['i'])
    for idx,e in enumerate(lst):
        d=datetime.utcfromtimestamp(e['t']).strftime('%m-%d') if e['t'] else '?'
        day[d]['calls']+=1
        if e['res'] and e['res'].get('bg_task'): day[d]['backgrounded']+=1
        if short(e['name'])=='open_rabbithole' and e['input'].get('hole_id'):
            day[d]['resume']+=1
            prev=lst[idx-1] if idx>0 else None
            if prev and prev['res'] and prev['res'].get('bg_task'): day[d]['resume_after_bg']+=1
            j=e['j']; day[d]['resume->'+(j.get('status') if j else ('bg' if e['res'] and e['res'].get('bg_task') else 'err'))]+=1
        if e['j'] and e['j'].get('status')=='branch_request': day[d]['branch_req']+=1
for d in sorted(day): print(' ',d,dict(day[d]))
# the harm of the resume loop: after a resume, did the earlier backgrounded task ALSO deliver (duplicate listeners)?
# For each backgrounded open/answer, check whether a notification arrived; count tasks whose notification is 'cancelled' or 'already_listening'
# Model behavior right after background message: did it end turn with text?
after_bg=collections.Counter()
ev_by_file=collections.defaultdict(list)
for e in events: ev_by_file[e['f']].append(e)
for e in rh:
    if not (e['res'] and e['res'].get('bg_task')): continue
    nxt=[x for x in ev_by_file[e['f']] if x['i']>e['res']['i']][:1]
    if not nxt: after_bg['nothing']+=1; continue
    x=nxt[0]
    if x['k']=='use': after_bg['tool:'+(short(x['name']) if RH(x['name']) else x['name'])]+=1
    else: after_bg[x['k']]+=1
print('\nwhat the model did immediately after a "moved to background" result:',after_bg.most_common(10))
# ---------- answers with proper linking
ans=[e for e in rh if short(e['name'])=='answer_branch']
part=[e for e in ans if e['input'].get('partial')]; fin=[e for e in ans if not e['input'].get('partial') and e['input'].get('delegated') is None]
byreq=collections.defaultdict(list)
for e in ans: byreq[e['input'].get('request_id')].append(e)
br_by_req={e['j']['request_id']:e for e in brs}
print('\n== answers: requests answered',len(byreq),'branch_requests delivered',len(brs),'delivered but never answered',sum(1 for r in br_by_req if r not in byreq),'answered but no delivered request in transcript',sum(1 for r in byreq if r not in br_by_req))
ttf=[];ttfin=[];research=[];hosttext=[]
for rid,v in byreq.items():
    br=br_by_req.get(rid)
    if not br: continue
    v.sort(key=lambda e:e['i']); t0=br['final']['t']; first=v[0]; last=v[-1]
    if t0 and first['t']: ttf.append(first['t']-t0)
    if t0 and last['t']: ttfin.append(last['t']-t0)
    n=0; ht=0
    for x in ev_by_file[br['f']]:
        if br['final']['i']<x['i']<first['i']:
            if x['k']=='use' and not RH(x['name']): n+=1
            if x['k']=='text': ht+=x['len']
    research.append(n); hosttext.append(ht)
print('human wait: request->first visible chunk med',med(ttf),'p75',pct(ttf,.75),'p90',pct(ttf,.9),'| ->final med',med(ttfin),'p90',pct(ttfin,.9))
z=[ttf[i] for i,n in enumerate(research) if n==0]; print('  no-research requests',len(z),'wait med',med(z),'p90',pct(z,.9))
r=[ttf[i] for i,n in enumerate(research) if n>0]; print('  with-research requests',len(r),'wait med',med(r),'p90',pct(r,.9))
print('  host-chat text emitted before first chunk: reqs',sum(1 for h in hosttext if h),'chars',sum(hosttext))
first_sizes=[sorted(v,key=lambda e:e['i'])[0]['input'].get('content','') for v in byreq.values()]
print('first chunk chars med',med([len(s) for s in first_sizes]),'p90',pct([len(s) for s in first_sizes],.9),'; sentences in first chunk med',med([len(re.findall(r'[.!?](\s|$)',s)) for s in first_sizes]))
chunks=[len(v) for v in byreq.values()]; print('chunks/answer med',med(chunks),'p90',pct(chunks,.9),'1-call answers',sum(1 for c in chunks if c==1),'total answer calls',len(ans))
tot=[sum(len(e['input'].get('content') or '') for e in v) for v in byreq.values()]; print('answer chars med',med(tot),'p90',pct(tot,.9))
qlen=[len(br_by_req[r]['j'].get('question','')) for r in byreq if r in br_by_req]; alen=[sum(len(e['input'].get('content') or '') for e in byreq[r]) for r in byreq if r in br_by_req]
short_q=[a for q,a in zip(qlen,alen) if q<=30]; print('answers to questions <=30 chars: n',len(short_q),'answer chars med',med(short_q))
# per-call output overhead: tokens per call for partials
po=[e['usage'].get('output_tokens',0) for e in part if e.get('usage')]; pc=[len(e['input'].get('content') or '') for e in part]
print('partial calls: med output tokens',med(po),'med content chars',med(pc))
# ---------- list rank
ls=[e for e in rh if short(e['name'])=='list_rabbitholes']; print('\n== list_rabbitholes',len(ls))
for e in ls:
    j=e['j']; 
    if not j: print('  ERR'); continue
    ids=[h['hole_id'] for h in j.get('holes',[])]
    nxt=[x for x in byfile[e['f']] if x['i']>e['i'] and short(x['name'])=='open_rabbithole' and x['input'].get('hole_id')]
    rank=None
    if nxt:
        hid=nxt[0]['input']['hole_id']; rank=(ids.index(hid)+1) if hid in ids else 'NOTFOUND'
    print('  ',datetime.utcfromtimestamp(e['t']).date(),'holes',len(ids),'chars',len(e['final']['text']),'chosen rank',rank)
# ---------- listener durations
lst=[e for e in rh if short(e['name'])=='open_rabbithole' or (short(e['name'])=='answer_branch' and not e['input'].get('partial') and e['input'].get('delegated') is None)]
dur=[e['final']['t']-e['t'] for e in lst if e['final'] and e['final']['t'] and e['t']]
print('\n== listener wait until event: med',med(dur),'p75',pct(dur,.75),'p90',pct(dur,.9),'>2min',sum(1 for d in dur if d>120),'/',len(dur))
# ---------- hole growth in list

