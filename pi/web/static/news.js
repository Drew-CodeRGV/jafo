// jafo /news — anchor-script cards. Polls /api/news, renders top stories that
// have a finished broadcast script. Clicking a card opens /news/<id>.

function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }

function fmtClock(ts){
  if(!ts) return '—';
  return new Date(ts*1000).toLocaleString([], {hour:'numeric', minute:'2-digit'});
}

function renderCards(data){
  const grid = document.getElementById('news-grid');
  const stories = (data && data.stories) || [];
  if(!stories.length){
    grid.innerHTML = '<div class="news-empty">No anchor scripts yet — they appear as newsworthy activity is verified across the radio. Check back shortly.</div>';
    return;
  }
  grid.innerHTML = stories.map(s => {
    const conf = (s.news_confidence || 'medium').toLowerCase();
    const badge = conf === 'high'
      ? '<span class="news-badge high">High</span>'
      : '<span class="news-badge medium">Medium</span>';
    const runtime = s.news_runtime_sec ? `~${s.news_runtime_sec}s read` : '';
    return `<a class="news-card" href="/news/${s.id}">
      <div class="news-card-top">
        <span class="news-card-slug">${esc(s.news_slug || 'STORY')}</span>
        ${badge}
      </div>
      <h2 class="news-card-title">${esc(s.title || '')}</h2>
      <div class="news-card-meta">
        ${esc(s.talkgroup_tag || '')} · as of ${esc(fmtClock(s.last_call_at))} ${runtime ? '· ' + esc(runtime) : ''}
      </div>
      <span class="news-readlink">Read script →</span>
    </a>`;
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
