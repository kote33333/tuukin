// Commute PWA core logic
// - Dexie (IndexedDB) for storage
// - Manual check-ins (arrivals)
// - Analysis: daily stacked segments, weekly (7-day) averages, total time with 7-day MA
// - CSV/JSON export

// ---- DB Init ----
const db = new Dexie('commute_db');
db.version(1).stores({
  routes: '++id, name',
  places: '++id, route_id, order, name, lat, lon, radius_m',
  sessions: '++id, route_id, started_at, ended_at',
  arrivals: '++id, session_id, place_id, ts'
});

const $ = (sel) => document.querySelector(sel);
const elRouteName = $('#routeName');
const elPlacesList = $('#placesList');
const elNewPlace = $('#newPlace');
const btnAddPlace = $('#addPlace');
const btnSaveRoute = $('#saveRoute');
const btnResetRoute = $('#resetRoute');
const btnClearAll = $('#clearAll');

const btnStart = $('#startSession');
const btnEnd = $('#endSession');
const divArriveButtons = $('#arriveButtons');
const divSessState = $('#sessionState');

const elStartDate = $('#startDate');
const elEndDate = $('#endDate');
const selMode = $('#mode');
const divStacked = $('#stacked');
const divTotals = $('#totals');
const divDataSummary = $('#dataSummary');

const btnExportCSV = $('#exportCSV');
const btnExportJSON = $('#exportJSON');

const DEFAULT_PLACES = ['家','橋','朝倉駅','56号線','会社'];

let currentRouteId = null;
let draftPlaces = []; // {id?, name, order}

async function ensureDefaultRoute() {
  const has = await db.routes.count();
  if (has === 0) {
    const rid = await db.routes.add({ name: '通勤ルート' });
    for (let i=0;i<DEFAULT_PLACES.length;i++) {
      await db.places.add({ route_id: rid, order: i, name: DEFAULT_PLACES[i] });
    }
    currentRouteId = rid;
  } else {
    const route = await db.routes.orderBy('id').first();
    currentRouteId = route.id;
  }
}

async function loadRouteToEditor() {
  const route = await db.routes.get(currentRouteId);
  const places = await db.places.where('route_id').equals(currentRouteId).sortBy('order');
  elRouteName.value = route?.name ?? '';
  draftPlaces = places.map(p => ({ id: p.id, name: p.name, order: p.order }));
  renderPlaceEditor();
}

function renderPlaceEditor() {
  elPlacesList.innerHTML = '';
  draftPlaces.sort((a,b)=>a.order-b.order).forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'place-item';
    row.innerHTML = `
      <span class="pill">${idx+1}</span>
      <input value="${p.name}" data-idx="${idx}"/>
      <button class="btn secondary" data-act="up" data-idx="${idx}">↑</button>
      <button class="btn secondary" data-act="down" data-idx="${idx}">↓</button>
      <button class="btn danger" data-act="del" data-idx="${idx}">削除</button>
    `;
    elPlacesList.appendChild(row);
  });

  elPlacesList.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e)=>{
      const i = Number(e.target.dataset.idx);
      draftPlaces[i].name = e.target.value;
    });
  });
  elPlacesList.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e)=>{
      const act = e.target.dataset.act;
      const i = Number(e.target.dataset.idx);
      if (act === 'up' && i>0) {
        const tmp = draftPlaces[i-1]; draftPlaces[i-1] = draftPlaces[i]; draftPlaces[i] = tmp;
      } else if (act === 'down' && i<draftPlaces.length-1) {
        const tmp = draftPlaces[i+1]; draftPlaces[i+1] = draftPlaces[i]; draftPlaces[i] = tmp;
      } else if (act === 'del') {
        draftPlaces.splice(i,1);
      }
      draftPlaces.forEach((p,k)=>p.order=k);
      renderPlaceEditor();
    });
  });
}

btnAddPlace.addEventListener('click', ()=>{
  const name = (elNewPlace.value || '').trim();
  if (!name) return;
  draftPlaces.push({ name, order: draftPlaces.length });
  elNewPlace.value='';
  renderPlaceEditor();
});

btnSaveRoute.addEventListener('click', async ()=>{
  const name = (elRouteName.value || '通勤ルート').trim();
  await db.routes.update(currentRouteId, { name });
  // Sync places table: delete removed, update/add others
  const existing = await db.places.where('route_id').equals(currentRouteId).toArray();
  const keepIds = new Set(draftPlaces.map(p=>p.id).filter(Boolean));
  for (const p of existing) {
    if (!keepIds.has(p.id)) await db.places.delete(p.id);
  }
  for (const [i, p] of draftPlaces.entries()) {
    if (p.id) {
      await db.places.update(p.id, { name: p.name, order: i });
    } else {
      const id = await db.places.add({ route_id: currentRouteId, name: p.name, order: i });
      p.id = id;
    }
  }
  alert('ルートを保存しました。');
  await refreshSessionUI();
});

btnResetRoute.addEventListener('click', async ()=>{
  if (!confirm('初期テンプレ（家→橋→朝倉駅→56号線→会社）に戻します。よろしいですか？')) return;
  await db.places.where('route_id').equals(currentRouteId).delete();
  for (let i=0;i<DEFAULT_PLACES.length;i++) {
    await db.places.add({ route_id: currentRouteId, order: i, name: DEFAULT_PLACES[i] });
  }
  await loadRouteToEditor();
  await refreshSessionUI();
});

btnClearAll.addEventListener('click', async ()=>{
  if (!confirm('【注意】すべてのルート・セッション・到着記録を削除します。よろしいですか？')) return;
  await db.delete();
  await db.open(); // recreate
  await ensureDefaultRoute();
  await loadRouteToEditor();
  await refreshSessionUI();
  await initAnalysisDates();
  alert('すべて削除しました（初期状態に戻しました）。');
});

// ---- Session Recording ----
async function getActiveSession() {
  return await db.sessions.where({ ended_at: undefined, route_id: currentRouteId }).first();
}

btnStart.addEventListener('click', async ()=>{
  const active = await getActiveSession();
  if (active) { alert('既にセッションが開始されています。'); return; }
  const id = await db.sessions.add({ route_id: currentRouteId, started_at: Date.now() });
  await refreshSessionUI();
});

btnEnd.addEventListener('click', async ()=>{
  const active = await getActiveSession();
  if (!active) { alert('アクティブなセッションがありません。'); return; }
  await db.sessions.update(active.id, { ended_at: Date.now() });
  await refreshSessionUI();
  alert('セッションを終了しました。分析タブで確認できます。');
});

async function refreshSessionUI() {
  const active = await getActiveSession();
  const places = await db.places.where('route_id').equals(currentRouteId).sortBy('order');
  divArriveButtons.innerHTML = '';

  if (active) {
    divSessState.textContent = `記録中（ID ${active.id}）`;
    btnStart.disabled = true;
    btnEnd.disabled = false;
    // Determine already arrived places
    const arrivals = await db.arrivals.where('session_id').equals(active.id).toArray();
    const arrivedIds = new Set(arrivals.map(a=>a.place_id));
    for (const p of places) {
      const row = document.createElement('div');
      row.className = 'row';
      const hit = arrivedIds.has(p.id);
      row.innerHTML = `
        <span class="pill">${p.order+1}</span>
        <span>${p.name}</span>
        <button class="btn ${hit?'secondary':''}" data-place="${p.id}" ${hit?'disabled':''}>到着</button>
      `;
      const btn = row.querySelector('button');
      btn.addEventListener('click', async ()=>{
        const now = Date.now();
        await db.arrivals.add({ session_id: active.id, place_id: p.id, ts: now });
        await refreshSessionUI();
      });
      divArriveButtons.appendChild(row);
    }
  } else {
    divSessState.textContent = '待機中';
    btnStart.disabled = false;
    btnEnd.disabled = true;
    // show last session summary (optional)
    const last = await db.sessions.orderBy('id').last();
    if (last) {
      const row = document.createElement('div');
      row.className = 'muted';
      const when = new Date(last.started_at).toLocaleString();
      row.textContent = `最後のセッション: ID ${last.id}（${when} 開始）`;
      divArriveButtons.appendChild(row);
    }
  }
}

// ---- Analysis ----
function ymd(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

async function initAnalysisDates() {
  const sess = await db.sessions.toArray();
  const arrs = await db.arrivals.toArray();
  const minTs = arrs.length ? Math.min(...arrs.map(a=>a.ts)) : Date.now();
  const maxTs = arrs.length ? Math.max(...arrs.map(a=>a.ts)) : Date.now();
  const minD = new Date(minTs); minD.setHours(0,0,0,0);
  const maxD = new Date(maxTs); maxD.setHours(0,0,0,0);
  elStartDate.value = ymd(minD);
  elEndDate.value = ymd(maxD);
}

async function computeSegmentsForSession(sessionId, placesOrdered) {
  const arrs = await db.arrivals.where('session_id').equals(sessionId).toArray();
  const mapTs = new Map();
  for (const a of arrs) {
    mapTs.set(a.place_id, a.ts);
  }
  // Build sequence by place order
  const seq = [];
  for (const p of placesOrdered) {
    if (mapTs.has(p.id)) seq.push({ place: p.name, place_id: p.id, ts: mapTs.get(p.id) });
  }
  if (seq.length < 2) return { segments: [], totalMin: 0, baseDate: null };
  // base = first ts
  const baseTs = seq[0].ts;
  const totalMin = (seq[seq.length-1].ts - baseTs)/60000;
  const segments = [];
  for (let i=0;i<seq.length-1;i++) {
    const a = seq[i], b = seq[i+1];
    segments.push({ segment: `${a.place}→${b.place}`, minutes: (b.ts - a.ts)/60000 });
  }
  const baseDate = new Date(seq[seq.length-1].ts); // date of arrival at last place
  baseDate.setHours(0,0,0,0);
  return { segments, totalMin, baseDate };
}

async function renderAnalysis() {
  const start = new Date(elStartDate.value);
  const end = new Date(elEndDate.value);
  end.setHours(23,59,59,999);

  const places = await db.places.where('route_id').equals(currentRouteId).sortBy('order');
  const sessions = await db.sessions.where('route_id').equals(currentRouteId).toArray();
  const inRange = [];
  for (const s of sessions) {
    if (!s.ended_at) continue;
    const res = await computeSegmentsForSession(s.id, places);
    if (!res.baseDate) continue;
    if (res.baseDate >= start && res.baseDate <= end) {
      inRange.append = 1; // dummy to avoid lint
      inRange.push({ id: s.id, segments: res.segments, totalMin: res.totalMin, date: res.baseDate });
    }
  }
  inRange.sort((a,b)=>a.date-b.date);
  divDataSummary.textContent = `期間内セッション数: ${inRange.length}`;

  // Build daily stacked table
  const segNames = Array.from(new Set(inRange.flatMap(r => r.segments.map(s=>s.segment))));
  const days = Array.from(new Set(inRange.map(r=>ymd(r.date)))).sort();
  const dailyTable = days.map(d => {
    const rec = { day: d };
    for (const name of segNames) rec[name] = 0;
    const rows = inRange.filter(r => ymd(r.date) === d);
    for (const r of rows) {
      for (const s of r.segments) {
        rec[s.segment] += s.minutes;
      }
    }
    return rec;
  });

  // Weekly (7-day buckets) average
  function weeklyBuckets(daysArr) {
    const startD = new Date(elStartDate.value); startD.setHours(0,0,0,0);
    const endD = new Date(elEndDate.value); endD.setHours(23,59,59,999);
    const buckets = [];
    for (let d = new Date(startD); d <= endD; d = new Date(d.getTime() + 7*86400000)) {
      const bStart = new Date(d);
      const bEnd = new Date(Math.min(d.getTime() + 7*86400000 - 1, endD.getTime()));
      buckets.push({ key: `${ymd(bStart)}〜${ymd(bEnd)}`, start: bStart, end: bEnd });
    }
    return buckets;
  }
  const buckets = weeklyBuckets(days);
  const weeklyTable = buckets.map(b => {
    const rec = { bucket: b.key };
    for (const name of segNames) rec[name] = 0;
    // collect all sessions inside bucket
    const rows = inRange.filter(r => r.date >= b.start && r.date <= b.end);
    if (rows.length) {
      for (const name of segNames) {
        const vals = [];
        for (const r of rows) {
          const hit = r.segments.find(s => s.segment === name);
          if (hit) vals.push(hit.minutes);
        }
        rec[name] = vals.length ? vals.reduce((a,c)=>a+c,0) / vals.length : 0;
      }
    }
    return rec;
  });

  // Totals (daily) + 7-day moving average
  const totals = inRange.map(r => ({ date: ymd(r.date), value: r.totalMin }));

  // ---- Plotly: stacked ----
  function plotStackedDaily() {
    const x = dailyTable.map(r => r.day);
    const traces = segNames.map(name => ({
      type:'bar', name, x, y: dailyTable.map(r => r[name]),
      hovertemplate: '%{x}<br>%{fullData.name}: %{y:.1f} 分<extra></extra>'
    }));
    Plotly.react(divStacked, traces, {
      title: '日別 区間時間（積み上げ）',
      barmode: 'stack',
      xaxis: { type: 'category' },
      yaxis: { title: '分' },
      legend: { orientation: 'h' },
      margin: { t: 40, r: 20, b: 60, l: 50 }
    }, {displayModeBar:true, responsive:true});
  }

  function plotStackedWeekly() {
    const x = weeklyTable.map(r => r.bucket);
    const traces = segNames.map(name => ({
      type:'bar', name, x, y: weeklyTable.map(r => r[name]),
      hovertemplate: '%{x}<br>%{fullData.name}: %{y:.1f} 分<extra></extra>'
    }));
    Plotly.react(divStacked, traces, {
      title: '7日ごとの平均 区間時間（積み上げ）',
      barmode: 'stack',
      xaxis: { type: 'category' },
      yaxis: { title: '分' },
      legend: { orientation: 'h' },
      margin: { t: 40, r: 20, b: 60, l: 50 }
    }, {displayModeBar:true, responsive:true});
  }

  // ---- Plotly: totals ----
  function plotTotals() {
    const x = totals.map(r => r.date);
    const y = totals.map(r => r.value);
    // 7-day moving average
    const ma = y.map((_,i)=>{
      const from = Math.max(0, i-6);
      const slice = y.slice(from, i+1);
      return slice.reduce((a,c)=>a+c,0)/slice.length;
    });
    const traces = [
      { type:'scatter', mode:'lines+markers', name:'合計', x, y,
        hovertemplate: '%{x}<br>合計: %{y:.1f} 分<extra></extra>' },
      { type:'scatter', mode:'lines', name:'7日移動平均', x, y: ma, line:{ dash:'dash' },
        hovertemplate: '%{x}<br>7日移動平均: %{y:.1f} 分<extra></extra>' }
    ];
    Plotly.react(divTotals, traces, {
      title: '合計通勤時間と7日移動平均',
      xaxis: { type: 'category' },
      yaxis: { title: '分' },
      legend: { orientation: 'h' },
      margin: { t: 40, r: 20, b: 60, l: 50 }
    }, {displayModeBar:true, responsive:true});
  }

  if (selMode.value === 'weekly') plotStackedWeekly(); else plotStackedDaily();
  plotTotals();
}

[elStartDate, elEndDate, selMode].forEach(el => el.addEventListener('change', renderAnalysis));

// ---- Export ----
function download(filename, text, mime='text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}

btnExportCSV.addEventListener('click', async ()=>{
  // Arrivals CSV
  const sessions = await db.sessions.toArray();
  const routes = await db.routes.toArray();
  const places = await db.places.toArray();
  const arrivals = await db.arrivals.toArray();
  const routeMap = new Map(routes.map(r => [r.id, r]));
  const placeMap = new Map(places.map(p => [p.id, p]));
  const rows = [['session_id','route_name','place','timestamp_iso']];
  for (const a of arrivals) {
    const s = sessions.find(x => x.id === a.session_id);
    const r = s ? routeMap.get(s.route_id)?.name : '';
    const p = placeMap.get(a.place_id)?.name ?? '';
    rows.push([a.session_id, r, p, new Date(a.ts).toISOString()]);
  }
  download('arrivals.csv', rows.map(r=>r.join(',')).join('\n'), 'text/csv');
});

btnExportJSON.addEventListener('click', async ()=>{
  const dump = {
    routes: await db.routes.toArray(),
    places: await db.places.toArray(),
    sessions: await db.sessions.toArray(),
    arrivals: await db.arrivals.toArray(),
    exported_at: new Date().toISOString()
  };
  download('backup.json', JSON.stringify(dump, null, 2), 'application/json');
});

// ---- Init ----
(async function init() {
  await ensureDefaultRoute();
  await loadRouteToEditor();
  await refreshSessionUI();
  await initAnalysisDates();
  await renderAnalysis();
})();
