// jafo /news — anchor-script cards. Polls /api/news, renders top stories that
// have a finished broadcast script. Clicking a card opens /news/<id>.

function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }

function fmtClock(ts){
  if(!ts) return '—';
  return new Date(ts*1000).toLocaleString([], {hour:'numeric', minute:'2-digit'});
}

// Hour bucket helpers — group cards by the clock hour of last activity.
function hourBucket(ts){ const d = new Date(ts*1000); d.setMinutes(0,0,0); return d.getTime(); }
function sameDay(a, b){
  const x = new Date(a), y = new Date(b);
  return x.getFullYear()===y.getFullYear() && x.getMonth()===y.getMonth() && x.getDate()===y.getDate();
}
function hourLabel(bucketMs){
  const d = new Date(bucketMs);
  const end = new Date(bucketMs + 3600*1000);
  const fmt = t => t.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  let range = `${fmt(d)} – ${fmt(end)}`;
  const now = Date.now();
  if(!sameDay(bucketMs, now)){
    const yest = new Date(now); yest.setDate(yest.getDate()-1);
    const prefix = sameDay(bucketMs, yest.getTime())
      ? 'Yesterday'
      : d.toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'});
    range = `${prefix} · ${range}`;
  }
  return range;
}

function cardHtml(s){
  const conf = (s.news_confidence || 'medium').toLowerCase();
  const badge = conf === 'high'
    ? '<span class="news-badge high">High</span>'
    : '<span class="news-badge medium">Medium</span>';
  const runtime = s.news_runtime_sec ? `~${s.news_runtime_sec}s read` : '';
  const funTag = s.is_fun ? '<span class="news-badge fun">🦦 Just for fun</span>' : '';
  return `<a class="news-card${s.is_fun ? ' fun' : ''}" href="/news/${s.id}">
    <div class="news-card-top">
      <span class="news-card-slug">${esc(s.news_slug || 'STORY')}</span>
      ${funTag}${badge}
    </div>
    <h2 class="news-card-title">${esc(s.title || '')}</h2>
    <div class="news-card-meta">
      ${esc(s.talkgroup_tag || '')} · ${esc(fmtClock(s.last_call_at))} ${runtime ? '· ' + esc(runtime) : ''}
    </div>
    <span class="news-readlink">Read script →</span>
  </a>`;
}

function renderCards(data){
  const grid = document.getElementById('news-grid');
  const stories = (data && data.stories) || [];
  if(!stories.length){
    grid.innerHTML = '<div class="news-empty">No anchor scripts yet — they appear as newsworthy activity is verified across the radio. Check back shortly.</div>';
    return;
  }
  // Newest first, then group by clock hour. The most recent hour is "Just In";
  // every hour below it gets its own labeled section with a dividing line.
  const sorted = stories.slice().sort((a,b) => (b.last_call_at||0) - (a.last_call_at||0));
  const groups = [];
  let cur = null;
  for(const s of sorted){
    const b = hourBucket(s.last_call_at || 0);
    if(!cur || cur.bucket !== b){ cur = {bucket:b, items:[]}; groups.push(cur); }
    cur.items.push(s);
  }
  grid.innerHTML = groups.map((g, i) => {
    const label = (i === 0) ? '🦦 Just In' : hourLabel(g.bucket);
    const cls = (i === 0) ? 'news-hour-head news-hour-new' : 'news-hour-head';
    return `<section class="news-hour-group">
        <div class="${cls}"><span class="news-hour-label">${esc(label)}</span><span class="news-hour-rule"></span></div>
        <div class="news-grid-row">${g.items.map(cardHtml).join('')}</div>
      </section>`;
  }).join('');
}

async function refresh(){
  try {
    const r = await fetch('/api/news', {cache:'no-store'});
    if(!r.ok) throw new Error('http '+r.status);
    renderCards(await r.json());
  } catch(e){
    console.warn('news refresh failed', e);
  }
}

function tickClock(){
  const now = new Date();
  const d = document.getElementById('paper-date');
  const t = document.getElementById('paper-time');
  if(d) d.textContent = now.toLocaleDateString([], {weekday:'long', month:'long', day:'numeric'});
  if(t) t.textContent = now.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
}

tickClock();
setInterval(tickClock, 30000);
refresh();
setInterval(refresh, 60000);
