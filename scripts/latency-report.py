# Regenerates .probe/reports/2026-08-18-latency-analysis.html
#   python scripts/latency-report.py [path-to-a-report-to-borrow-CSS-from]
# Figures are read from .probe/runs/2026-08-17-18-07-live by the analysis in the
# report body; this file is the renderer, not the analysis.
import io,sys,json
sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8',errors='replace')
import re as _re
# House CSS lives in the week report; reuse it verbatim so every report looks the same.
_src=sys.argv[1] if len(sys.argv)>1 else '.probe/reports/2026-08-18-live-week-analysis.html'
css=_re.search(r'(?s)<style>.*?</style>',open(_src,encoding='utf-8').read()).group(0)

def bars(data,w=760,bh=26,gap=8,pad_l=140,maxv=None,fmt=lambda v:'%.0f'%v,color='var(--s1)'):
    maxv=maxv or max(d[1] for d in data)
    h=len(data)*(bh+gap)+16
    o=['<svg viewBox="0 0 %d %d" role="img">'%(w,h)]
    for i,d in enumerate(data):
        lab,v=d[0],d[1]; c=d[2] if len(d)>2 else color
        y=i*(bh+gap)+8
        bw=max(1,(v/maxv)*(w-pad_l-70))
        o.append('<text class="lbl" x="%d" y="%.1f" text-anchor="end">%s</text>'%(pad_l-8,y+bh*0.68,lab))
        o.append('<rect x="%d" y="%d" width="%.1f" height="%d" rx="2" fill="%s"/>'%(pad_l,y,bw,bh,c))
        o.append('<text class="val" x="%.1f" y="%.1f">%s</text>'%(pad_l+bw+7,y+bh*0.68,fmt(v)))
    o.append('</svg>')
    return '\n'.join(o)

def stack(segs,w=760,h=54):
    tot=sum(s[1] for s in segs)
    o=['<svg viewBox="0 0 %d %d" role="img">'%(w,h+34)]
    x=0
    for lab,v,c in segs:
        sw=v/tot*w
        o.append('<rect x="%.1f" y="0" width="%.1f" height="%d" fill="%s"/>'%(x,sw,h,c))
        if sw>62:
            o.append('<text class="val" x="%.1f" y="%.1f" text-anchor="middle" style="fill:#fff;font-weight:600">%.0f%%</text>'%(x+sw/2,h/2+4,v/tot*100))
        o.append('<text x="%.1f" y="%d" style="font-size:10.5px">%s</text>'%(min(x+2,w-96),h+16,lab))
        o.append('<text x="%.1f" y="%d" class="lbl" style="font-size:10.5px">%.0fs</text>'%(min(x+2,w-96),h+29,v))
        x+=sw
    o.append('</svg>')
    return '\n'.join(o)

def cols(data,w=760,h=210,pad_l=44,pad_b=42,color='var(--s1)'):
    maxv=max(d[1] for d in data)
    n=len(data); iw=(w-pad_l-14)/n
    o=['<svg viewBox="0 0 %d %d" role="img">'%(w,h)]
    for gy in range(5):
        y=(h-pad_b)-(gy/4)*(h-pad_b-14)
        o.append('<line class="gl" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/>'%(pad_l,y,w-8,y))
        o.append('<text x="%d" y="%.1f" text-anchor="end" style="font-size:10px">%.0f</text>'%(pad_l-6,y+4,maxv*gy/4))
    for i,(lab,v) in enumerate(data):
        bh=(v/maxv)*(h-pad_b-14)
        x=pad_l+i*iw+iw*0.16
        y=(h-pad_b)-bh
        o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="%s"/>'%(x,y,iw*0.68,bh,color))
        o.append('<text class="val" x="%.1f" y="%.1f" text-anchor="middle">%.0f</text>'%(x+iw*0.34,y-4,v))
        o.append('<text x="%.1f" y="%.1f" text-anchor="middle" style="font-size:10.5px">%s</text>'%(x+iw*0.34,h-pad_b+16,lab))
    o.append('</svg>')
    return '\n'.join(o)

H=[]
A=H.append
A('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">')
A('<meta name="viewport" content="width=device-width, initial-scale=1">')
A('<title>Why a turn takes thirty seconds</title>')
A(css)
A('</head>\n<body>\n<div class="wrap">')

A('<h1>Why a turn takes thirty seconds</h1>')
A('<p class="sub">Latency and round-count analysis of run <code>.probe/runs/2026-08-17-18-07-live</code> &mdash; '
  '82 conversational turns, deepseek-v4-flash, thinking <code>low</code>. '
  'Read from <code>record.json</code> and <code>seat.jsonl</code> directly, not from the week report&rsquo;s summary tables. '
  'Written 18 Aug 2026.</p>')

A('<div class="verdict">The week report&rsquo;s &ldquo;442 model rounds&rdquo; are <em>trace entries</em>, not inference calls. '
  'The loop actually ran <em>2.0 iterations</em> and <em>2.85 model calls</em> per turn &mdash; it is not going round in circles. '
  'Every second of the wait is a decode second, and <em>91% of the tokens being decoded are reasoning nobody reads</em>: '
  '10,182 characters of thinking per turn to deliver 377 characters of message, a ratio of 27 to 1.</div>')

A('<h2>1 &middot; The measurements</h2>')
A('<div class="grid">'
  '<div class="stat"><div class="v">35.5s</div><div class="k">mean turn, wall clock</div></div>'
  '<div class="stat"><div class="v">28.7s</div><div class="k">mean user-visible wait</div></div>'
  '<div class="stat"><div class="v">21.4s</div><div class="k">median user-visible wait</div></div>'
  '<div class="stat"><div class="v">2.85</div><div class="k">model calls per turn</div></div>'
  '<div class="stat"><div class="v">2.0</div><div class="k">loop iterations per turn</div></div>'
  '<div class="stat"><div class="v">9.6s</div><div class="k">mean per model call</div></div>'
  '<div class="stat"><div class="v">106</div><div class="k">output tokens/sec decode</div></div>'
  '<div class="stat"><div class="v">91%</div><div class="k">of output tokens are reasoning</div></div>'
  '</div>')

A('<h2>2 &middot; &ldquo;Rounds&rdquo; means three different numbers, and only one of them costs time</h2>')
A('<p>The headline in the week report counts entries in the trace array. A trace entry is written for every model call, '
  'every tool call, the reflection, and shadow observers that cost nothing. Three counts fall out of the same data, '
  'and they differ by more than 2&times;:</p>')
A('<div class="tablewrap"><table><thead><tr><th>What is being counted</th><th class="n">Total</th><th class="n">Mean/turn</th>'
  '<th class="n">Median</th><th class="n">Max</th><th>Costs wall clock?</th></tr></thead><tbody>')
A('<tr><td>Trace entries &mdash; the report&rsquo;s &ldquo;442 rounds&rdquo;</td><td class="n">442</td><td class="n">5.39</td><td class="n">5</td><td class="n">14</td><td>partly</td></tr>')
A('<tr><td>Agent loop iterations (<code>MAX_TOOL_ROUNDS</code> = 5)</td><td class="n">163</td><td class="n">1.99</td><td class="n">2</td><td class="n">5</td><td>yes</td></tr>')
A('<tr><td>Actual LLM inference calls</td><td class="n">234</td><td class="n">2.85</td><td class="n">3</td><td class="n">6</td><td><strong>this is the one</strong></td></tr>')
A('<tr><td>In-loop tool executions</td><td class="n">171</td><td class="n">2.09</td><td class="n">2</td><td class="n">7</td><td>barely &mdash; 1.13s each</td></tr>')
A('</tbody></table></div>')
A('<p>Loop-iteration histogram across the 82 turns: <code>0&rarr;10 &middot; 1&rarr;19 &middot; 2&rarr;27 &middot; 3&rarr;17 &middot; 4&rarr;6 &middot; 5&rarr;3</code>. '
  'Only three turns in a seven-day week hit the five-iteration ceiling. The loop is not thrashing, and raising or '
  'lowering <code>MAX_TOOL_ROUNDS</code> would move almost nothing.</p>')

A('<h2>3 &middot; Where the 48.5 minutes went</h2>')
A('<figure><h4>Wall-clock budget, all 82 turns</h4>'
  '<p class="lede">2,910 seconds of turn time, decomposed from the per-entry <code>ms</code> field.</p>'
  '<div class="chartscroll">')
A(stack([('model inference (in loop)',1702,'var(--s1)'),('post-send reflection',558,'var(--s2)'),
         ('runtime overhead',429,'var(--s4)'),('tool execution',221,'var(--s3)')]))
A('</div><figcaption>Model inference is 77.7% of the run once the reflection call is counted as what it is &mdash; '
  'another inference call. Tools, including all 407 SQL statements the loop issued, are 7.6%.</figcaption></figure>')
A('<p>The 429s of runtime overhead is 5.2s per turn: context assembly, the standing prefetch, the turn row, '
  '<code>composeAndSend</code>, message persistence. About 37% of it is SQL that runs outside any round &mdash; the prefetch is '
  'already parallelised with <code>Promise.all</code> (<code>lib/agent/context.ts:1020</code>), so its wall cost is the '
  'slowest query, not the sum.</p>')

A('<h2>4 &middot; Per-call latency is decode, and decode is reasoning</h2>')
A('<p>234 inference calls produced 238,524 output tokens in 2,260 seconds of model time &mdash; <strong>106 tokens per second</strong>, '
  'flat across the run. That single number explains the wait: latency is output volume divided by a constant. '
  'And output volume is reasoning.</p>')
A('<figure><h4>Model-call latency by length of recorded reasoning</h4>'
  '<p class="lede">Each bar is the mean latency of the calls in that bucket.</p>'
  '<div class="chartscroll">')
A(bars([('no reasoning (n=10)',1.9),('1&ndash;2k chars (n=115)',3.7),('2&ndash;5k chars (n=52)',8.9),
        ('5&ndash;10k chars (n=41)',17.8),('10k+ chars (n=16)',37.8)],fmt=lambda v:'%.1fs'%v))
A('</div><figcaption>A call that thinks nothing costs 1.9s &mdash; that is the floor: network, prefill of the ~3,000 uncached '
  'tokens, and a short decode. Everything above 1.9s is thinking, at 106 tok/s. The relationship is linear with no knee, '
  'which means there is no pathology to fix &mdash; only volume to cut.</figcaption></figure>')

A('<figure><h4>Distribution of the 234 model calls, seconds</h4><div class="chartscroll">')
A(cols([('0&ndash;2',16),('2&ndash;4',70),('4&ndash;6',33),('6&ndash;8',29),('8&ndash;12',22),('12&ndash;16',20),('16&ndash;24',27),('24&ndash;32',8),('32+',9)]))
A('</div><figcaption>Median 5.9s, mean 9.6s, p90 21.0s, max 59.8s. The tail is fat: 44 calls (19%) took over 16 seconds each.</figcaption></figure>')

A('<div class="tablewrap"><table><thead><tr><th>Output channel</th><th class="n">Characters</th><th class="n">&asymp; tokens</th>'
  '<th class="n">Share of billed output</th></tr></thead><tbody>')
A('<tr><td>Reasoning (<code>reasoning_content</code>)</td><td class="n">834,909</td><td class="n">217,700</td><td class="n">91%</td></tr>')
A('<tr><td>Tool-call arguments and scaffolding</td><td class="n">&mdash;</td><td class="n">12,700</td><td class="n">5%</td></tr>')
A('<tr><td><strong>Text a human actually read</strong></td><td class="n">30,944</td><td class="n">8,070</td><td class="n"><strong>3.4%</strong></td></tr>')
A('<tr class="tot"><td>Billed output</td><td class="n">&mdash;</td><td class="n">238,524</td><td class="n">100%</td></tr>')
A('</tbody></table></div>')
A('<p>Per turn: <strong>10,182 characters of thinking to produce 377 characters of message.</strong> '
  'The mean reasoning block is 3,727 characters; the p90 is 9,069; the longest is 27,044. '
  'This is already at <code>reasoning_effort: low</code> &mdash; <code>lib/agent/deepseek.ts:160</code> records why '
  '<code>off</code> was disqualified (fluent false claims of state) and <code>high</code> rejected (2.6&times; the median wait). '
  'There is no third setting. The volume has to come out of the prompt, not the dial.</p>')

A('<h2>5 &middot; One fifth of the run is spent after the reply has already gone</h2>')
A('<p>The reflection call runs as the turn&rsquo;s last round, and <code>lib/agent/loop.ts:1798</code> is explicit about the '
  'ordering: <em>&ldquo;Nobody is waiting: the reply is already on their phone.&rdquo;</em> The record confirms it &mdash; reflection fired '
  'on 71 of 82 turns, at a mean of 7.65s each, 558s in total.</p>')
A('<div class="tablewrap"><table><thead><tr><th>Measure</th><th class="n">Mean</th><th class="n">Median</th><th class="n">p90</th><th class="n">Max</th></tr></thead><tbody>')
A('<tr><td>Turn total, as the week report quotes it</td><td class="n">35.5s</td><td class="n">30.0s</td><td class="n">69.6s</td><td class="n">144.4s</td></tr>')
A('<tr><td>&nbsp;&nbsp;&mdash; post-send reflection</td><td class="n">6.8s</td><td class="n">5.3s</td><td class="n">16.2s</td><td class="n">21.0s</td></tr>')
A('<tr class="tot"><td>Silence the person actually sees</td><td class="n">28.7s</td><td class="n">21.4s</td><td class="n">65.3s</td><td class="n">131.4s</td></tr>')
A('</tbody></table></div>')
A('<p>So the &ldquo;30.2s median turn latency&rdquo; in the week report is a <em>drive</em> number, not a customer number. '
  'The customer&rsquo;s median is 21.4s. Both are too long, but they have different fixes: reflection is free to the customer '
  'and costs a fifth of every drive&rsquo;s wall clock.</p>')

A('<h2>6 &middot; What is not the problem</h2>')
A('<div class="grid">'
  '<div class="stat"><div class="v">7.6%</div><div class="k">of wall clock is the database</div></div>'
  '<div class="stat"><div class="v">527ms</div><div class="k">mean SQL statement</div></div>'
  '<div class="stat"><div class="v">87.0%</div><div class="k">prompt cache hit rate</div></div>'
  '<div class="stat"><div class="v">5.0</div><div class="k">SQL statements per turn</div></div>'
  '</div>')
A('<p>407 statements across the week, 214 seconds in total, and the tool rounds that carry them account for 221s of the '
  '2,910s run. The slowest single statement was 5.15s on turn 77 &mdash; pool contention, the same '
  '<code>EMAXCONNSESSION</code> class as the 23 Sunday errors against <code>pool_size: 15</code>. '
  'The prompt is 66,951 tokens per turn but 87% of it is cached, leaving roughly 3,000 uncached tokens to prefill '
  'per call. None of these is the cost centre. <strong>Optimising the database would move 8% of the number.</strong></p>')

A('<h2>7 &middot; The comparison that isolates the cause</h2>')
A('<p>The same runtime, the same model, the same prompt prefix, run as the <code>ask</code> suite &mdash; single-question turns '
  'that resolve in one loop iteration:</p>')
A('<div class="tablewrap"><table><thead><tr><th>Suite</th><th class="n">Turns</th><th class="n">Trace entries</th>'
  '<th class="n">Output tok/turn</th><th class="n">Median latency</th></tr></thead><tbody>')
A('<tr><td><code>ask</code> &mdash; 2026-08-17-17-40</td><td class="n">18</td><td class="n">1.22</td><td class="n">670</td><td class="n">6.6s</td></tr>')
A('<tr><td><code>ask</code> &mdash; 2026-08-17-17-39</td><td class="n">18</td><td class="n">1.22</td><td class="n">798</td><td class="n">7.0s</td></tr>')
A('<tr><td><code>week</code> &mdash; 2026-08-17-13-03</td><td class="n">28</td><td class="n">4.32</td><td class="n">1,118</td><td class="n">30.1s</td></tr>')
A('<tr><td><code>stress-week</code> &mdash; 2026-08-17-1439</td><td class="n">20</td><td class="n">5.80</td><td class="n">3,141</td><td class="n">30.1s</td></tr>')
A('<tr class="tot"><td><code>live</code> &mdash; 2026-08-17-18-07</td><td class="n">82</td><td class="n">5.39</td><td class="n">2,909</td><td class="n">30.0s</td></tr>')
A('</tbody></table></div>')
A('<p>A one-call turn costs 7 seconds. A three-call turn costs 30. The multiplier is calls, the constant is 106 tok/s, '
  'and the thing that turns one call into three is a turn that has to read before it can answer.</p>')

A('<figure><h4>Mean user-visible latency by seat</h4><div class="chartscroll">')
A(bars([('client &mdash; Divya',35.4,'var(--s2)'),('admin &mdash; Rahul',31.0,'var(--s1)'),
        ('prospect &mdash; Farah',25.9,'var(--s4)'),('coach &mdash; Arjun',19.9,'var(--s3)')],fmt=lambda v:'%.1fs'%v))
A('</div><figcaption>Output tokens per turn track it exactly: client 3,785 &middot; prospect 3,231 &middot; admin 2,768 &middot; coach 1,813. '
  'The coach is fast because his turns are register taps that need one read; the client is slow because her turns are '
  'questions about money that need three.</figcaption></figure>')

A('<h2>8 &middot; Why the drive itself takes an evening</h2>')
A('<p>Separate question, separate answer. <code>seat.jsonl</code> timestamps the whole drive: 119 seat actions from '
  '18:09:03 to 19:43:24 &mdash; <strong>1 hour 34 minutes</strong> for a seven-day week from four seats.</p>')
A('<div class="tablewrap"><table><thead><tr><th>Component</th><th class="n">Hours</th><th class="n">Share</th></tr></thead><tbody>')
A('<tr><td>Product turn time (the 82 turns)</td><td class="n">0.81</td><td class="n">51%</td></tr>')
A('<tr><td>Tester deciding what to say next</td><td class="n">0.76</td><td class="n">49%</td></tr>')
A('<tr class="tot"><td>Seat-log span</td><td class="n">1.57</td><td class="n">100%</td></tr>')
A('</tbody></table></div>')
A('<p>Mean gap between seat actions is 48.0s, median 32.4s &mdash; and the product accounts for 35.5s of that mean. '
  'Five gaps exceeded three minutes, totalling 18 minutes. The seats are driven serially, one action at a time, so '
  'the 82 turns cannot overlap: halving turn latency halves the drive.</p>')
A('<p>Everything after 19:43 &mdash; the diaries, <code>record.json</code>, five judgement passes, the report &mdash; was written '
  'between 23:55 and 01:26. That phase is a separate cost from the drive and is not measured by anything in the run.</p>')

A('<h2>9 &middot; The levers, with their sizes</h2>')
A('<div class="f warn"><h4><span class="id">L1</span>Cut reasoning volume &mdash; the only lever that is worth anything</h4>'
  '<p>91% of decoded tokens are reasoning. Halving the mean reasoning block from 3,727 to ~1,900 characters takes the mean '
  'model call from 9.6s to roughly 5.5s and the median visible wait from 21.4s to about 13s. Nothing else on this page '
  'is that size. The dial is already at <code>low</code>; the volume is coming from prompt length and instruction density, '
  'so this is a <code>PREFIX.md</code> question, not a config one.</p></div>')
A('<div class="f warn"><h4><span class="id">L2</span>Remove the second read round</h4>'
  '<p>2.0 loop iterations is already close to the floor of 1, but the 27 turns at 2 and 17 at 3 are mostly '
  '&ldquo;model reads, model thinks again, model answers&rdquo;. Every iteration removed is one full 9.6s call. Prefetching what the '
  'first read almost always asks for would convert a three-call turn into a two-call turn.</p></div>')
A('<div class="f ok"><h4><span class="id">L3</span>Reflection &mdash; leave it alone for the customer, skip it in drives</h4>'
  '<p>558s, 19.2% of the run, zero of it user-visible. It costs the customer nothing and costs every drive a fifth of its '
  'wall clock. A drive flag that skips reflection would cut drive time ~19% without touching production behaviour. '
  '<code>loop.ts:1766</code> already states the condition for deleting it outright: if a drive shows it earning nothing.</p></div>')
A('<div class="f"><h4><span class="id">L4</span>Database and cache work &mdash; not worth doing for latency</h4>'
  '<p>7.6% of wall clock, 87% cache hit rate, 527ms mean statement. Raising <code>pool_size</code> above 15 is worth doing '
  'for the 23 Sunday <code>EMAXCONNSESSION</code> failures &mdash; those are correctness, not speed. As a latency lever it is noise.</p></div>')

A('<div class="foot">Source: <code>.probe/runs/2026-08-17-18-07-live/record.json</code> (82 turns, per-entry <code>ms</code>) '
  'and <code>seat.jsonl</code> (119 timestamped seat actions). Token counts are the provider&rsquo;s, per turn. '
  'The reasoning share is a turn-level least-squares fit of billed output tokens on recorded reasoning characters '
  '(n=82, R&sup2;=0.985): 3.83 chars per reasoning token, with 254 non-reasoning output tokens per turn. '
  'Cross-run figures read from the five other <code>record.json</code> files carrying per-round timings.</div>')
A('</div>\n</body>\n</html>')

out='.probe/reports/2026-08-18-latency-analysis.html'
open(out,'w',encoding='utf-8').write('\n'.join(H))
print('wrote',out,len('\n'.join(H)),'chars')
