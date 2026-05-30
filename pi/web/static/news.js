// jafo /news — anchor-script cards. Polls /api/news, renders top stories that
// have a finished broadcast script. Clicking a card opens /news/<id>.
// When opened with ?token=<admin>, also shows the child-safety approval queue.

function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }

// Admin token (enables the approval queue). Read from the URL once.
const ADMIN_TOKEN = new URLSearchParams(location.search).get('token') || '';
function withTok(u){ return ADMIN_TOKEN ? u + (u.includes('?')?'&':'?') + 'token=' + encodeURIComponent(ADMIN_TOKEN) : u; }

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

// ---- Child-safety approval queue (admin only) ---------------------------
function ctxHtml(calls){
  if(!calls || !calls.length) return '<em>No source transmissions linked.</em>';
  return calls.map(c =>
    `<div class="mod-ctx-line"><span class="mod-ctx-meta">[${esc(fmtClock(c.start_time))}] ${esc(c.talkgroup_tag||'')}</span> ${esc(c.transcript||'(no transcript)')}</div>`
  ).join('');
}

function modItemHtml(it){
  const funTag = it.is_fun ? '<span class="news-badge fun">🦦 fun</span>' : '';
  return `<div class="mod-item" data-id="${it.id}">
    <div class="mod-flag">⚠️ ${esc(it.reason || 'Flagged for review')}</div>
    <div class="mod-sub">${esc(it.talkgroup_tag||'')} · ${esc(fmtClock(it.last_call_at))} · ${esc(it.severity||'')} ${funTag}</div>
    <h3 class="mod-title">${esc(it.title||'')}</h3>
    <div class="mod-label">Story as it will be told</div>
    <p class="mod-script">${esc(it.script||'')}</p>
    <div class="mod-label">Radio context — why it was flagged</div>
    <div class="mod-context">${ctxHtml(it.context_calls)}</div>
    <div class="mod-actions">
      <button class="mod-btn approve" data-act="approve" data-id="${it.id}">✓ Approve &amp; release</button>
      <button class="mod-btn deny" data-act="deny" data-id="${it.id}">✗ Deny &amp; archive</button>
      <button class="mod-btn del" data-act="delete" data-id="${it.id}">🗑 Delete</button>
    </div>
  </div>`;
}

async function moderate(id, action){
  if(action === 'delete' && !confirm('Delete this story permanently?')) return;
  const btns = document.querySelectorAll(`.mod-item[data-id="${id}"] .mod-btn`);
  btns.forEach(b => b.disabled = true);
  try {
    const r = await fetch(withTok(`/api/news/${id}/moderate?action=${action}`), {method:'POST'});
    if(!r.ok) throw new Error('http '+r.status);
    const el = document.querySelector(`.mod-item[data-id="${id}"]`);
    if(el) el.remove();
    loadPending();   // refresh count/empty state
  } catch(e){
    alert('Action failed: '+e.message);
    btns.forEach(b => b.disabled = false);
  }
}

async function loadPending(){
  const wrap = document.getElementById('news-approval');
  if(!wrap) return;
  if(!ADMIN_TOKEN){ wrap.style.display='none'; return; }
  try {
    const r = await fetch(withTok('/api/news/pending'), {cache:'no-store'});
    if(r.status === 401){ wrap.style.display='none'; return; }
    if(!r.ok) throw new Error('http '+r.status);
    const items = (await r.json()).pending || [];
    if(!items.length){
      wrap.style.display='block';
      wrap.innerHTML = `<div class="mod-head"><span class="mod-h-title">⚠️ Approval Required</span>
        <a class="mod-denied-link" href="${withTok('/news/denied')}">View denied archive →</a></div>
        <div class="mod-empty">Nothing awaiting review. New stories that mention a minor will appear here.</div>`;
      return;
    }
    wrap.style.display='block';
    wrap.innerHTML = `<div class="mod-head"><span class="mod-h-title">⚠️ Approval Required (${items.length})</span>
      <a class="mod-denied-link" href="${withTok('/news/denied')}">View denied archive →</a></div>
      <div class="mod-list">${items.map(modItemHtml).join('')}</div>`;
    wrap.querySelectorAll('.mod-btn').forEach(b =>
      b.addEventListener('click', () => moderate(b.dataset.id, b.dataset.act)));
  } catch(e){
    console.warn('pending load failed', e);
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
loadPending();
setInterval(loadPending, 60000);
