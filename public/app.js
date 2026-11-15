'use strict';

// 全局状态
let devices = new Map();          // deviceId -> deviceSummary
let speciesList = [];             // 物种知识库
let speciesMap = {};              // name -> species
let analysisData = { results: [], alerts: [], alertCount: 0 };
let agentConnected = false;
let chatHistory = [];
let pendingImages = [];           // [{file_id, dataUrl}]
let editingDeviceId = null;       // 弹窗当前编辑的设备（null=新增）

const $ = (sel) => document.querySelector(sel);

// 指标名称/单位
const METRIC_LABELS = {
  temperature: '温度', temp: '温度',
  humidity: '湿度', hum: '湿度',
  ammonia: '氨气', nh3: '氨气',
  co2: '二氧化碳',
  light: '光照', lux: '光照',
  soil: '土壤湿度', water: '水位', flame: '火焰',
  feed_activity: '进食活动', feeding: '进食', vibration: '振动',
  feed_level: '饲料槽余量',
  ph: 'pH 值', noise: '噪声', wind: '风速',
  pressure: '气压', rain: '降雨量', h2s: '硫化氢',
  pm25: 'PM2.5', o2: '氧气', soil_temp: '土壤温度', oxygen: '氧气'
};
const METRIC_UNITS = {
  temperature: '°C', temp: '°C',
  humidity: '%', hum: '%',
  ammonia: 'ppm', nh3: 'ppm',
  co2: 'ppm', light: '%', lux: 'lux',
  soil: '%', water: '%', flame: '',
  feed_activity: '', feeding: '', vibration: '',
  feed_level: '%',
  ph: '', noise: 'dB', wind: 'm/s',
  pressure: 'hPa', rain: 'mm', h2s: 'ppm',
  pm25: 'μg/m³', o2: '%', soil_temp: '°C', oxygen: '%'
};
const METRIC_ORDER = ['temperature', 'humidity', 'ammonia', 'co2', 'h2s', 'soil', 'water', 'light', 'flame', 'wind', 'pressure', 'rain', 'pm25', 'noise', 'o2', 'soil_temp', 'feed_activity'];

function metricLabel(key) { return METRIC_LABELS[key] || key; }
function metricUnit(key) { return METRIC_UNITS[key] || ''; }
// 饲料槽状况文字：次日剩余 ≤20% 说明吃干净了；>20% 提示采食不足
function feedStatus(v) {
  const n = Number(v);
  if (!isFinite(n)) return '';
  if (n <= 20) return '采食正常';
  if (n <= 40) return '剩料偏多';
  return '采食不足';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Markdown 渲染
function renderMarkdown(text) {
  let html = escapeHtml(String(text));
  // 图片 ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  // 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 加粗 **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // 行内代码 `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 换行
  html = html.replace(/\n/g, '<br>');
  return html;
}

// 加载物种知识库
async function loadSpecies() {
  try {
    const res = await fetch('/api/species');
    const data = await res.json();
    if (data.ok) {
      speciesList = data.species || [];
      speciesMap = {};
      for (const s of speciesList) speciesMap[s.name] = s;
      $('#speciesCount').textContent = '共 ' + speciesList.length + ' 种';
      renderKnowledge();
      fillSpeciesSelect();
    }
  } catch (e) { console.error('加载物种失败：', e); }
}

// 养殖手册（折叠）
// 模糊匹配：包含 或 按顺序的子序列匹配（如「北油」可匹配「北京油鸡」）
function fuzzyMatch(q, text) {
  const t = String(text || '').toLowerCase();
  if (!q) return true;
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of q) {
    const k = t.indexOf(ch, i);
    if (k < 0) return false;
    i = k + 1;
  }
  return true;
}

function renderKnowledge(filter) {
  const q = (filter || '').trim().toLowerCase();
  const totalBreeds = speciesList.reduce((a, s) => a + (s.breeds ? s.breeds.length : 0), 0);
  $('#speciesCount').textContent = '共 ' + speciesList.length + ' 类 · ' + totalBreeds + ' 个品种';

  // 类别下拉：按类别名或品种名模糊过滤
  const catList = q
    ? speciesList.filter((s) => fuzzyMatch(q, s.name) || (s.breeds || []).some((b) => fuzzyMatch(q, b.name)))
    : speciesList;
  const sel = $('#speciesSelect');
  sel.innerHTML = '<option value="">请选择类别（当前 ' + catList.length + ' 类）</option>' +
    catList.map((s) => `<option value="${escapeHtml(s.id)}">${s.icon} ${escapeHtml(s.name)}（${(s.breeds || []).length} 个品种）</option>`).join('');

  const el = $('#knowledge');
  if (!q) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📖</div><p>请从上方下拉栏选择一个类别</p><p class="empty-hint">或直接在上方搜索框输入品种名，如「北京油鸡」「清远鸡」</p></div>';
    return;
  }

  // 模糊搜索品种：直接列出匹配结果
  const results = [];
  for (const s of speciesList) {
    for (const b of (s.breeds || [])) {
      if (fuzzyMatch(q, b.name) || fuzzyMatch(q, s.name)) {
        results.push({ species: s, breed: b });
      }
    }
  }
  if (results.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">🔍</div><p>没找到匹配的品种</p><p class="empty-hint">换个关键词试试，如「鸡」「北京油鸡」「猪」</p></div>';
    return;
  }
  const shown = results.slice(0, 80);
  el.innerHTML = '<div class="search-count">找到 ' + results.length + ' 个品种' + (results.length > 80 ? '（显示前 80 个）' : '') + '</div>' +
    '<div class="search-results">' + shown.map((r) => `
      <div class="search-item" data-sp="${escapeHtml(r.species.id)}" data-breed="${escapeHtml(r.breed.name)}">
        <div class="search-item-name">${r.species.icon || ''} ${escapeHtml(r.breed.name)}</div>
        <div class="search-item-sub">${escapeHtml(r.species.name)} · ${escapeHtml(r.breed.traits || '')}</div>
      </div>`).join('') + '</div>';

  el.querySelectorAll('[data-sp]').forEach((row) => {
    row.addEventListener('click', () => openHandbook(row.getAttribute('data-sp'), row.getAttribute('data-breed')));
  });
}

// 手册两级弹窗
function openHandbook(speciesId, breedName) {
  const sp = speciesList.find((s) => s.id === speciesId);
  if (!sp) return;
  const modal = $('#handbookModal');
  modal.classList.add('show');

  if (breedName) {
    const b = (sp.breeds || []).find((x) => x.name === breedName);
    if (!b) return;
    $('#hbTitle').textContent = sp.icon + ' ' + sp.name + ' · ' + b.name;
    $('#hbBack').style.display = '';
    const sections = [
      { icon: '🌡', title: '环境要求', text: sp.environment },
      { icon: '📐', title: '养殖密度', text: sp.density },
      { icon: '🌬', title: '通风换气', text: sp.ventilation },
      { icon: '💡', title: '光照管理', text: sp.lighting },
      { icon: '🍚', title: '饲料配比', text: sp.diet },
      { icon: '💧', title: '饮水管理', text: sp.water },
      { icon: '💉', title: '免疫程序', text: sp.immunity },
      { icon: '🧹', title: '卫生消毒', text: sp.hygiene },
      { icon: '⚠️', title: '常见误区', text: sp.mistakes }
    ].filter((x) => x.text);
    $('#hbBody').innerHTML = `
      <div class="hb-detail">
        <div class="hb-breed-head">
          <div class="hb-breed-name">${escapeHtml(b.name)}</div>
          <div class="hb-traits">${escapeHtml(b.traits || '')}</div>
        </div>
        <div class="hb-normals">${Object.entries(sp.normal || {}).map(([k, r]) => `<span class="k-tag">${metricLabel(k)} ${r.min}~${r.max}${r.unit}</span>`).join('')}</div>
        <div class="hb-sections">
          ${sections.map((x) => `<div class="hb-card"><div class="hb-card-title">${x.icon} ${x.title}</div><div class="hb-card-text">${escapeHtml(x.text)}</div></div>`).join('')}
        </div>
        <div class="hb-diseases">
          <div class="hb-card-title">🦠 常见疫病与诱因</div>
          ${(sp.diseases || []).map((d) => `<div class="k-disease"><span class="d-name">${escapeHtml(d.name)}</span><br/>症状：${escapeHtml(d.symptoms)}<br/>诱因：${escapeHtml(d.factors)}</div>`).join('')}
        </div>
      </div>`;
  } else {
    $('#hbTitle').textContent = sp.icon + ' ' + sp.name + ' · ' + (sp.breeds || []).length + ' 个品种';
    $('#hbBack').style.display = 'none';
    $('#hbBody').innerHTML = '<div class="hb-grid">' + (sp.breeds || []).map((b) => `
      <div class="hb-breed" data-breed="${escapeHtml(b.name)}">
        <div class="hb-breed-name">${escapeHtml(b.name)}</div>
        <div class="hb-breed-traits">${escapeHtml(b.traits || '')}</div>
      </div>`).join('') + '</div>';
    $('#hbBody').querySelectorAll('[data-breed]').forEach((c) => {
      c.addEventListener('click', () => openHandbook(speciesId, c.getAttribute('data-breed')));
    });
  }

  $('#hbBack').onclick = () => openHandbook(speciesId);
}

function closeHandbook() {
  $('#handbookModal').classList.remove('show');
}

function fillSpeciesSelect() {
  const sel = $('#dmSpecies');
  sel.innerHTML = '<option value="">请选择物种</option>' +
    speciesList.map((s) => `<option value="${escapeHtml(s.name)}">${s.icon} ${escapeHtml(s.name)}</option>`).join('');
}

// 正常值
function normalRange(speciesName, key) {
  if (!speciesName) return null;
  const sp = speciesMap[speciesName];
  if (sp && sp.normal && sp.normal[key]) return sp.normal[key];
  return null;
}

// 健康等级：优 / 良 / 危（按指标偏离程度）
function deviceLevel(d) {
  const metrics = (d && d.metrics) || {};
  let severe = 0, mild = 0;
  for (const k of Object.keys(metrics)) {
    const s = metrics[k].severity;
    if (s === 'severe') severe++;
    else if (s === 'mild') mild++;
  }
  if (severe > 0) return { label: '危', cls: 'danger' };
  if (mild > 0) return { label: '良', cls: 'warn' };
  return { label: '优', cls: 'ok' };
}

// 设备卡片渲染
function renderDevices() {
  const container = $('#devices');
  const list = [...devices.values()].sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  if (list.length === 0) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">📭</div><p>暂无设备数据</p>
      <p class="empty-hint">点击「添加设备」录入物种信息，或让 ESP32 向 <code>POST /api/data</code> 发送 JSON 数据</p></div>`;
    return;
  }

  container.innerHTML = list.map((d) => {
    const online = d.status === 'online';
    const sp = d.meta && d.meta.species ? speciesMap[d.meta.species] : null;
    const metricsHtml = METRIC_ORDER
      .filter((key) => d.metrics && d.metrics[key] !== undefined)
      .map((key) => {
        const m = d.metrics[key];
        const cls = m.severity === 'severe' ? 'high' : m.severity === 'mild' ? 'low' : 'normal';
        const norm = (d.normal && d.normal[key]) || normalRange(d.meta && d.meta.species, key);
        const normHtml = key === 'feed_level'
          ? `<div class="metric-normal">${feedStatus(m.value)} · 正常 ≤20%</div>`
          : (norm ? `<div class="metric-normal">正常 ${norm.min}~${norm.max}${norm.unit}</div>` : '');
        return `<div class="metric ${cls}">
          <div class="metric-label">${escapeHtml(metricLabel(key))}</div>
          <div class="metric-value">${Number(m.value).toFixed(1)}<span class="metric-unit">${metricUnit(key)}</span></div>
          ${normHtml}</div>`;
      }).join('');

    // 识别数量 / 种群密度（与环境数据同格展示）
    const userCount = Number(d.meta && d.meta.count) || 0;
    const camCount = d.metrics && d.metrics.camera_count !== undefined ? Math.round(Number(d.metrics.camera_count.value)) : null;
    const dinfo = d.density || {};
    const densityVal = dinfo.actual;
    const ref = dinfo.ref;
    const missing = camCount != null && userCount > 0 && camCount < userCount;
    let extraMetrics = '';
    extraMetrics += `<div class="metric ${missing ? 'high' : 'normal'}">
      <div class="metric-label">识别数量</div>
      <div class="metric-value">${camCount != null ? camCount : '—'}<span class="metric-unit">只</span></div>
      <div class="metric-normal">${userCount > 0 ? '填写 ' + userCount + ' 只' + (missing ? ' · 少 ' + (userCount - camCount) : '') : '未填写数量'}</div></div>`;
    const dCls = dinfo.status === 'high' ? 'high' : dinfo.status === 'low' ? 'low' : 'normal';
    extraMetrics += `<div class="metric ${dCls}">
      <div class="metric-label">种群密度</div>
      <div class="metric-value">${densityVal != null ? densityVal : '—'}<span class="metric-unit">只/㎡</span></div>
      <div class="metric-normal">${ref ? '参考 ' + ref.min + '~' + ref.max + ' 只/㎡' : '未填写数量/面积'}</div></div>`;

    const metaTags = [];
    if (d.meta && d.meta.species) metaTags.push(`<span class="meta-tag">${sp ? sp.icon + ' ' : ''}${escapeHtml(d.meta.species)}</span>`);
    if (d.meta && d.meta.count) metaTags.push(`<span class="meta-tag">${Number(d.meta.count)} 只/头</span>`);
    if (d.meta && d.meta.area) metaTags.push(`<span class="meta-tag">${Number(d.meta.area)} ㎡</span>`);

    const lv = deviceLevel(d);
    return `<div class="device-card ${online ? '' : 'offline'}" data-id="${escapeHtml(d.id)}">
      <div class="device-head">
        <div>
          <div class="device-name"><span class="icon">${sp ? sp.icon : '📟'}</span>${escapeHtml(d.name)}</div>
          <div class="device-id">${escapeHtml(d.id)}</div>
        </div>
        <div class="device-badges">
          <span class="a-level ${lv.cls}">${lv.label}</span>
          <span class="device-status">${online ? '在线' : '离线'}</span>
        </div>
      </div>
      ${metaTags.length ? `<div class="device-meta">${metaTags.join('')}</div>` : ''}
      <div class="metrics">${(metricsHtml + extraMetrics) || '<div class="metric"><div class="metric-label">等待数据</div><div class="metric-value">--</div></div>'}</div>
      <div class="device-hint">点击卡片进入详情，可开启 AI 健康预警</div>
      <div class="device-foot">
        <span>${d.lastSeen ? '更新 ' + formatTime(d.lastSeen) : '尚未上报'}</span>
        <div class="device-ops">
          <button class="device-edit" data-edit="${escapeHtml(d.id)}">✏️ 编辑</button>
          <button class="device-remove" data-remove="${escapeHtml(d.id)}">🗑 删除</button>
        </div>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.device-card').forEach((card) => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
  container.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeDevice(b.dataset.remove); }));
  container.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(b.dataset.edit); }));
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 状态栏
function renderStatusbar() {
  const list = [...devices.values()];
  const online = list.filter((d) => d.status === 'online');
  $('#statOnline').textContent = online.length;
  $('#statTotal').textContent = list.length;

  const temps = [], hums = [];
  $('#statAlert').textContent = analysisData.alertCount || 0;
}
function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }

// 今日天气（天气局实时数据）
function savedCity() { return localStorage.getItem('weather-city') || ''; }

async function fetchWeather(city) {
  const res = await fetch('/api/weather' + (city ? '?city=' + encodeURIComponent(city) : ''));
  return await res.json();
}

async function loadWeather() {
  try {
    const data = await fetchWeather(savedCity());
    if (data.ok) {
      let txt = (data.temperature != null ? data.temperature + '°C' : '--') + ' / ' + (data.humidity != null ? data.humidity + '%' : '--');
      if (data.wind != null) txt += ' / ' + data.wind + 'm/s';
      $('#statWeatherLabel').textContent = '今日天气 · ' + (data.city || '本地');
      $('#statWeather').textContent = txt;
      $('#statWeather').title = '点击查看天气详情';
      $('#statWeather').style.cursor = 'pointer';
    } else {
      $('#statWeather').textContent = '—';
    }
  } catch (e) { $('#statWeather').textContent = '—'; }
}

// 天气弹窗：搜索城市 + 详细数据 + 24 小时曲线 + 3 天预报
async function openWeather() {
  $('#weatherModal').classList.add('show');
  $('#weatherCity').value = savedCity();
  $('#weatherBody').innerHTML = '加载中…';
  const data = await fetchWeather(savedCity());
  renderWeather(data);
}

async function searchWeather() {
  const city = ($('#weatherCity').value || '').trim();
  if (city) localStorage.setItem('weather-city', city);
  else localStorage.removeItem('weather-city');
  $('#weatherBody').innerHTML = '加载中…';
  const data = await fetchWeather(city);
  renderWeather(data);
  loadWeather();
}

function renderWeather(w) {
  const box = $('#weatherBody');
  if (!w || !w.ok) {
    box.innerHTML = '<div class="empty">' + escapeHtml((w && w.error) || '天气获取失败') + '</div>';
    return;
  }
  const items = [
    ['天气', w.desc || '—'],
    ['气温', w.temperature != null ? w.temperature + '°C' : '—'],
    ['体感温度', w.apparent != null ? w.apparent + '°C' : '—'],
    ['相对湿度', w.humidity != null ? w.humidity + '%' : '—'],
    ['风向风速', (w.windDir || '—') + ' ' + (w.wind != null ? w.wind + ' m/s' : '—')],
    ['阵风', w.gust != null ? w.gust + ' m/s' : '—'],
    ['降水量', w.precipitation != null ? w.precipitation + ' mm' : '—'],
    ['云量', w.cloud != null ? w.cloud + '%' : '—'],
    ['气压', w.pressure != null ? Math.round(w.pressure) + ' hPa' : '—']
  ];
  const risk = (w.risks && w.risks.length)
    ? '<div class="weather-risk">⚠ 需要防范：' + escapeHtml(w.risks.join('、')) + '</div>' : '';
  let html = '<div class="weather-title">' + escapeHtml(w.city || '') + ' · ' + escapeHtml(w.desc || '') + '</div>' + risk +
    '<div class="weather-grid">' + items.map(([k, v]) =>
      '<div class="weather-item"><span>' + k + '</span><b>' + escapeHtml(String(v)) + '</b></div>').join('') + '</div>';

  // 空气质量（PM2.5 雾霾等）
  if (w.air) {
    const a = w.air;
    const aqiTxt = a.aqi != null ? a.aqi + '（' + (a.level || '') + '）' : '—';
    const rows = [
      ['AQI', aqiTxt],
      ['PM2.5（雾霾）', a.pm25 != null ? a.pm25 + ' μg/m³' : '—'],
      ['PM10', a.pm10 != null ? a.pm10 + ' μg/m³' : '—'],
      ['一氧化碳 CO', a.co != null ? a.co + ' μg/m³' : '—'],
      ['二氧化氮 NO₂', a.no2 != null ? a.no2 + ' μg/m³' : '—'],
      ['二氧化硫 SO₂', a.so2 != null ? a.so2 + ' μg/m³' : '—'],
      ['臭氧 O₃', a.o3 != null ? a.o3 + ' μg/m³' : '—']
    ];
    html += '<div class="weather-chart-title">空气质量</div><div class="weather-grid">' +
      rows.map(([k, v]) => '<div class="weather-item"><span>' + k + '</span><b>' + escapeHtml(String(v)) + '</b></div>').join('') + '</div>';
  }

  // 本场传感器实测（CO₂、氨气）
  if (w.farm && (w.farm.co2 != null || w.farm.ammonia != null)) {
    const rows = [
      ['二氧化碳 CO₂', w.farm.co2 != null ? w.farm.co2 + ' ppm' : '—'],
      ['氨气 NH₃', w.farm.ammonia != null ? w.farm.ammonia + ' ppm' : '—'],
      ['在线设备', (w.farm.devices || 0) + ' 台']
    ];
    html += '<div class="weather-chart-title">本场传感器实测</div><div class="weather-grid">' +
      rows.map(([k, v]) => '<div class="weather-item"><span>' + k + '</span><b>' + escapeHtml(String(v)) + '</b></div>').join('') + '</div>';
  } else {
    html += '<div class="weather-chart-title">本场传感器实测</div>' +
      '<div class="empty-hint">暂无设备上报 CO₂ / 氨气，接入 ESP32 后自动显示</div>';
  }

  if (w.hourly && w.hourly.length) {
    html += '<div class="weather-chart-title">未来 24 小时温度 / 湿度走势</div>' +
      '<canvas id="weatherChart" width="720" height="220"></canvas>';
  }
  if (w.daily && w.daily.length) {
    html += '<div class="weather-chart-title">未来 3 天</div><div class="weather-daily">' +
      w.daily.map((d) => '<div class="weather-day"><div class="wd-date">' + escapeHtml(d.date || '') + '</div>' +
        '<div class="wd-desc">' + escapeHtml(d.desc || '') + '</div>' +
        '<div class="wd-temp"><b>' + (d.max != null ? d.max + '°' : '—') + '</b> / ' + (d.min != null ? d.min + '°' : '—') + '</div>' +
        '<div class="wd-sub">降水 ' + (d.precip != null ? d.precip : 0) + 'mm · 风 ' + (d.wind != null ? d.wind : 0) + 'm/s</div>' +
        '</div>').join('') + '</div>';
  }
  box.innerHTML = html;
  if (w.hourly && w.hourly.length) drawWeatherChart(w.hourly);
}

// 24 小时温度/湿度折线
function drawWeatherChart(hourly) {
  const cv = document.getElementById('weatherChart');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const padL = 44, padR = 44, padT = 24, padB = 30;
  ctx.clearRect(0, 0, W, H);

  const temps = hourly.map((h) => Number(h.temperature));
  const hums = hourly.map((h) => Number(h.humidity));
  const tMin = Math.min.apply(null, temps);
  const tMax = Math.max.apply(null, temps);
  const tRange = (tMax - tMin) || 1;
  const n = hourly.length;
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const yT = (v) => padT + (1 - (v - tMin) / tRange) * (H - padT - padB);
  const yH = (v) => padT + (1 - v / 100) * (H - padT - padB);

  ctx.strokeStyle = '#ecdfc9';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * (H - padT - padB);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
  }

  ctx.strokeStyle = '#e0762e';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  temps.forEach((v, i) => { const px = x(i), py = yT(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();

  ctx.strokeStyle = '#2f6fd0';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  hums.forEach((v, i) => { const px = x(i), py = yH(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#8a7a66';
  ctx.font = '11px sans-serif';
  for (let i = 0; i < n; i += 4) {
    const t = hourly[i] && hourly[i].time ? hourly[i].time : '';
    ctx.fillText(t, x(i) - 12, H - 8);
  }
  ctx.fillStyle = '#e0762e';
  ctx.fillText('温度 ' + tMax + '° ~ ' + tMin + '°', padL, 14);
  ctx.fillStyle = '#2f6fd0';
  ctx.fillText('湿度（虚线）', W - padR - 80, 14);
}

// 数据分析
async function loadAnalysis() {
  try {
    const res = await fetch('/api/analysis?city=' + encodeURIComponent(localStorage.getItem('weather-city') || ''));
    const data = await res.json();
    if (data.ok) {
      analysisData = data;
      renderAlerts();
      renderAnalysis();
      renderStatusbar();
    }
  } catch (e) { console.error('加载分析失败：', e); }
}

function renderAlerts() {
  const box = $('#alerts');
  const list = $('#alertsList');
  if (!analysisData.alertCount) { box.classList.remove('show'); return; }
  box.classList.add('show');
  list.innerHTML = analysisData.alerts.map((a) => {
    const dir = a.status === 'high' ? '偏高' : '偏低';
    const norm = a.normal ? `（正常 ${a.normal.min}~${a.normal.max}${a.unit}）` : '';
    return `<li class="alert-item" data-device="${escapeHtml(a.deviceId || '')}" data-metric="${escapeHtml(a.key || '')}"><span class="tag">${a.status === 'high' ? '偏高' : '偏低'}</span>${escapeHtml(a.device)}：${escapeHtml(a.label)} ${a.value}${a.unit} ${norm} ${dir} <span class="alert-go">查看 ›</span></li>`;
  }).join('');
  list.querySelectorAll('.alert-item').forEach((li) => {
    li.addEventListener('click', () => {
      const deviceId = li.getAttribute('data-device');
      const metric = li.getAttribute('data-metric');
      if (deviceId) jumpToMetric(deviceId, metric);
    });
  });
}

// 点击异常项 → 打开设备详情并定位/高亮对应指标
function jumpToMetric(deviceId, metricKey) {
  openDetail(deviceId);
  if (!metricKey) return;
  setTimeout(() => {
    const el = document.querySelector('#detailMetrics [data-metric="' + metricKey + '"]');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('metric-flash');
      setTimeout(() => el.classList.remove('metric-flash'), 1800);
    }
  }, 150);
}

function renderAnalysis() {
  const el = $('#analysis');
  if (!analysisData.results.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📈</div><p>暂无数据，等待设备上报后自动生成分析结论与趋势图</p></div>`;
    return;
  }
  el.innerHTML = analysisData.results.map((r) => {
    const d = devices.get(r.id);
    const hasAlert = r.anomalies.length > 0;
    const meta = (d && d.meta) || {};
    const tags = [];
    if (r.species) tags.push(r.species);
    if (meta.stage) tags.push(meta.stage);
    if (meta.count) tags.push(meta.count + ' 只/头');
    if (meta.area) tags.push(meta.area + ' ㎡');
    const anomalyList = r.anomalies.map((a) => `${a.label} ${a.value}${a.unit} ${a.status === 'high' ? '偏高' : '偏低'}`).join('；');
    const lv = deviceLevel(d);
    return `<div class="analysis-card ${hasAlert ? 'has-alert' : ''}" data-id="${escapeHtml(r.id)}">
      <div class="a-head">
        <span class="a-name">${escapeHtml(r.name)}</span>
        <span class="a-level ${lv.cls}">${lv.label}</span>
      </div>
      ${tags.length ? `<div class="a-tags">${tags.map((t) => `<span class="a-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="a-conclusion">${escapeHtml(r.conclusion)}</div>
      ${hasAlert ? `<div class="a-anomalies">异常项：${escapeHtml(anomalyList)}</div>` : ''}
      <canvas class="a-chart" width="300" height="80"></canvas>
      <div class="a-hint">点击卡片查看详细分析，获取环境改善解决方案</div>
    </div>`;
  }).join('');

  analysisData.results.forEach((r, i) => {
    const d = devices.get(r.id);
    if (!d || !d.history || !d.history.length) return;
    const canvas = el.querySelectorAll('.a-chart')[i];
    if (canvas) drawTrendChart(canvas, d.history, 'temperature', '#e0762e', '°C');
  });

  el.querySelectorAll('.analysis-card').forEach((c) => {
    c.addEventListener('click', () => openAnalysisDetail(c.getAttribute('data-id')));
  });
}

// 环境异常改善建议（按指标 + 偏高/偏低）
const SOLUTIONS = {
  temperature: {
    high: ['加强通风换气，打开门窗或开启风机', '屋顶喷淋、遮阴网降温', '适当降低饲养密度', '提供充足清凉饮水', '避开中午高温时段饲喂'],
    low: ['检查并加强保温设施（保温灯/加热板）', '封堵漏风处、加厚垫料', '雏苗阶段适当提高舍温', '避免冷风直吹']
  },
  humidity: {
    high: ['加大通风，排出湿气', '减少地面洒水，及时更换潮湿垫料', '加强清粪，减少水分蒸发', '必要时使用除湿设备'],
    low: ['地面/墙壁适当喷雾增湿', '增加饮水器面积或放置水盆', '避免过度通风', '使用湿帘加湿']
  },
  co2: {
    high: ['立即加强通风换气', '检查通风设备是否正常运行', '适当降低饲养密度', '及时清理粪便']
  },
  ammonia: {
    high: ['加强通风，排出氨气', '及时清粪、更换垫料', '饲料中添加除臭剂/微生态制剂', '适当降低饲养密度']
  },
  light: {
    high: ['加装遮阳网或调暗灯光', '避免强光直射', '调整灯具高度/功率'],
    low: ['增加补光灯（产蛋鸡每日 14~16 小时）', '清洁灯罩、更换老化灯管', '合理布局灯具']
  },
  soil: {
    high: ['减少浇水频率', '加强通风', '检查排水是否通畅'],
    low: ['适当浇水/喷淋', '增加覆盖物保墒']
  },
  flame: {
    high: ['立即排查火源并切断电源', '使用灭火器扑救', '疏散人员并报警']
  }
};
async function openAnalysisDetail(deviceId) {
  const d = devices.get(deviceId);
  if (!d) return;
  $('#analysisModal').classList.add('show');
  $('#analysisTitle').textContent = (d.name || deviceId) + ' · 数据诊断分析';
  const body = $('#analysisBody');
  const meta = d.meta || {};
  const keys = Object.keys(d.metrics || {});
  const rows = keys.map((k) => {
    const m = d.metrics[k];
    const norm = (d.normal && d.normal[k]) || normalRange(meta.species, k);
    const cls = m.severity === 'severe' ? 'severe' : m.severity === 'mild' ? 'mild' : 'normal';
    const st = m.severity === 'severe' ? '严重偏离' : m.severity === 'mild' ? '轻微偏离' : '正常';
    return `<div class="ad-row ${cls}">
      <span class="ad-name">${escapeHtml(metricLabel(k))}</span>
      <span class="ad-val">${Number(m.value).toFixed(1)}${metricUnit(k)}</span>
      <span class="ad-norm">${norm ? norm.min + '~' + norm.max + norm.unit : '—'}</span>
      <span class="ad-status">${st}</span>
    </div>`;
  }).join('');
  const tags = [];
  if (meta.species) tags.push(meta.species);
  if (meta.stage) tags.push(meta.stage);
  if (meta.count) tags.push(meta.count + ' 只/头');
  if (meta.area) tags.push(meta.area + ' ㎡');
  body.innerHTML = (tags.length ? '<div class="a-tags">' + tags.map((t) => `<span class="a-tag">${escapeHtml(t)}</span>`).join('') + '</div>' : '') +
    '<div class="ad-table"><div class="ad-row ad-head"><span>指标</span><span>当前</span><span>健康范围</span><span>状态</span></div>' + rows + '</div>' +
    '<div class="ad-actions"><button class="btn primary" id="adSolveBtn" type="button">如何改善环境</button></div>' +
    '<div class="ad-ai" id="adSolveResult"></div>';
  $('#adSolveBtn').addEventListener('click', () => {
    const box = $('#adSolveResult');
    const bad = keys.filter((k) => d.metrics[k].severity === 'mild' || d.metrics[k].severity === 'severe');
    if (!bad.length) {
      box.innerHTML = '<p>当前各项指标均在健康范围内，保持现有管理即可。</p>';
      return;
    }
    box.innerHTML = bad.map((k) => {
      const m = d.metrics[k];
      const dir = m.status === 'low' ? 'low' : 'high';
      const list = (SOLUTIONS[k] && SOLUTIONS[k][dir]) || [];
      const label = metricLabel(k);
      const head = label + '（' + (dir === 'high' ? '偏高' : '偏低') + '）';
      if (!list.length) return '<div class="solve-block"><div class="solve-title">' + escapeHtml(head) + '</div><div class="solve-empty">暂无针对性建议</div></div>';
      return '<div class="solve-block"><div class="solve-title">' + escapeHtml(head) + '</div><ul>' + list.map((s) => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul></div>';
    }).join('');
  });
}

function drawTrendChart(canvas, history, key, color, unit) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const data = history.filter((p) => p[key] !== undefined).slice(-30);
  if (data.length < 2) {
    ctx.fillStyle = '#b0a48f'; ctx.font = '11px sans-serif'; ctx.fillText('数据不足，等待更多上报', 6, 18);
    return;
  }
  const values = data.map((p) => p[key]);
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || 1;
  const stepX = w / (data.length - 1);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  data.forEach((p, i) => {
    const x = i * stepX;
    const y = h - 6 - ((p[key] - min) / span) * (h - 18);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const last = data[data.length - 1];
  const ly = h - 6 - ((last[key] - min) / span) * (h - 18);
  ctx.fillStyle = color; ctx.font = '11px sans-serif';
  ctx.fillText(key === 'temperature' ? '温度' : metricLabel(key) + ' ' + last[key] + unit, 6, Math.max(12, ly - 4));
}

// 单指标曲线（对比正常范围）
function openMetricChart(deviceId, key) {
  const d = devices.get(deviceId);
  if (!d) return;
  const history = (d.history || []).filter((p) => p[key] !== undefined).slice(-60);
  const meta = d.meta || {};
  const norm = (d.normal && d.normal[key]) || normalRange(meta.species, key);
  const unit = metricUnit(key);
  $('#chartTitle').textContent = (d.name || deviceId) + ' · ' + metricLabel(key) + '曲线';
  $('#chartModal').classList.add('show');

  const canvas = $('#chartCanvas');
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (history.length < 2) {
    ctx.fillStyle = '#9a8f7e'; ctx.font = '13px sans-serif';
    ctx.fillText('数据不足，等待更多上报（至少 2 条）', 20, 40);
    $('#chartLegend').innerHTML = '';
    return;
  }

  const padL = 46, padR = 16, padT = 18, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const values = history.map((p) => Number(p[key]));
  let min = Math.min(...values), max = Math.max(...values);
  if (norm) { min = Math.min(min, norm.min); max = Math.max(max, norm.max); }
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => padL + (i / (history.length - 1)) * plotW;
  const y = (v) => padT + (1 - (v - min) / span) * plotH;

  ctx.strokeStyle = '#ece3d5'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yy = padT + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    const val = max - (span / 4) * i;
    ctx.fillStyle = '#9a8f7e'; ctx.font = '11px sans-serif';
    ctx.fillText(val.toFixed(1), 6, yy + 4);
  }

  if (norm) {
    const y1 = y(norm.max), y2 = y(norm.min);
    ctx.fillStyle = 'rgba(47, 158, 91, 0.10)';
    ctx.fillRect(padL, y1, plotW, y2 - y1);
    ctx.strokeStyle = 'rgba(47, 158, 91, 0.55)';
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y1); ctx.lineTo(w - padR, y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, y2); ctx.lineTo(w - padR, y2); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = '#e0762e'; ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((p, i) => { const yy = y(Number(p[key])); if (i === 0) ctx.moveTo(x(i), yy); else ctx.lineTo(x(i), yy); });
  ctx.stroke();

  ctx.fillStyle = '#e0762e';
  history.forEach((p, i) => { ctx.beginPath(); ctx.arc(x(i), y(Number(p[key])), 2.4, 0, Math.PI * 2); ctx.fill(); });

  ctx.fillStyle = '#9a8f7e'; ctx.font = '10px sans-serif';
  const tick = Math.max(1, Math.floor(history.length / 6));
  history.forEach((p, i) => {
    if (i % tick !== 0 && i !== history.length - 1) return;
    const t = new Date(p.time || Date.now());
    const lbl = (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    ctx.fillText(lbl, Math.min(x(i) - 14, w - padR - 46), h - 8);
  });

  $('#chartLegend').innerHTML = '<span class="lg-line"></span> 实测值　' +
    (norm ? '<span class="lg-band"></span> 正常范围 ' + norm.min + '~' + norm.max + unit : '无正常范围参考');
}


function connectSSE() {
  const es = new EventSource('/api/events');
  const cs = $('#connStatus');
  es.onopen = () => { cs.classList.remove('offline'); cs.classList.add('online'); $('#connText').textContent = '实时连接正常'; };
  es.addEventListener('device-data', (ev) => { const d = JSON.parse(ev.data); devices.set(d.id, d); renderDevices(); renderStatusbar(); loadAnalysis(); });
  es.addEventListener('device-status', (ev) => { const data = JSON.parse(ev.data); for (const d of data.devices || []) devices.set(d.id, d); renderDevices(); renderStatusbar(); });
  es.addEventListener('device-updated', (ev) => { const d = JSON.parse(ev.data); devices.set(d.id, d); renderDevices(); renderStatusbar(); loadAnalysis(); });
  es.addEventListener('device-removed', (ev) => { const { id } = JSON.parse(ev.data); devices.delete(id); renderDevices(); renderStatusbar(); loadAnalysis(); });
  es.addEventListener('devices-cleared', () => { devices.clear(); renderDevices(); renderStatusbar(); loadAnalysis(); });
  es.onerror = () => { cs.classList.remove('online'); cs.classList.add('offline'); $('#connText').textContent = '连接断开，重连中…'; };
}

// 设备操作
async function loadDevices() {
  try {
    const res = await fetch('/api/devices');
    const data = await res.json();
    if (data.ok) { devices = new Map(data.devices.map((d) => [d.id, d])); renderDevices(); renderStatusbar(); }
  } catch (e) { console.error('加载设备失败：', e); }
}

async function removeDevice(id) {
  if (!confirm('确定删除该设备吗？它的专属聊天记录会一并删除。')) return;
  try {
    const r = await fetch('/api/devices/' + encodeURIComponent(id) + '?chat=delete', { method: 'DELETE' });
    const j = await r.json();
    if (!j.ok) { alert(j.error || '删除失败'); return; }
    loadConversationList();
    toast('设备及其聊天记录已删除');
  } catch (e) { alert('删除失败：' + e.message); }
}

async function clearDevices() {
  if (!confirm('确定清空所有设备数据吗？')) return;
  try { await fetch('/api/devices', { method: 'DELETE' }); } catch (e) { console.error(e); }
}

// 设备弹窗（新增/编辑）
function openAddModal() {
  editingDeviceId = null;
  $('#deviceModalTitle').textContent = '添加设备';
  $('#dmIdRow').style.display = 'block';
  $('#dmId').value = '';
  $('#dmName').value = '';
  $('#dmSpecies').value = '';
  $('#dmCount').value = '';
  $('#dmArea').value = '';
  $('#dmStage').value = '';
  $('#dmWeight').value = '';
  $('#dmFeedDaily').value = '';
  $('#deviceModal').classList.add('show');
}

function openEditModal(id) {
  const d = devices.get(id);
  if (!d) return;
  editingDeviceId = id;
  $('#deviceModalTitle').textContent = '编辑设备';
  $('#dmIdRow').style.display = 'none';
  $('#dmName').value = d.name || '';
  $('#dmSpecies').value = (d.meta && d.meta.species) || '';
  $('#dmCount').value = (d.meta && d.meta.count) || '';
  $('#dmArea').value = (d.meta && d.meta.area) || '';
  $('#dmStage').value = (d.meta && d.meta.stage) || '';
  $('#dmWeight').value = (d.meta && d.meta.weight) || '';
  $('#dmFeedDaily').value = (d.meta && d.meta.feed_daily) || '';
  $('#deviceModal').classList.add('show');
}

async function saveDevice() {
  const id = editingDeviceId || $('#dmId').value.trim();
  if (!id) { alert('请填写设备 ID'); return; }
  const body = {
    name: $('#dmName').value.trim(),
    species: $('#dmSpecies').value,
    count: Number($('#dmCount').value) || 0,
    area: Number($('#dmArea').value) || 0,
    stage: $('#dmStage').value,
    feed_daily: Number($('#dmFeedDaily').value) || 0,
    weight: Number($('#dmWeight').value) || 0,
  };
  try {
    await fetch('/api/devices/' + encodeURIComponent(id) + '/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    $('#deviceModal').classList.remove('show');
    await loadDevices();
    loadAnalysis();
    // 新设备会有一个专属聊天框，刷新列表并自动进入
    await loadConversationList();
    const isNew = !editingDeviceId;
    editingDeviceId = id;
    if (isNew) {
      currentIndividual = 'device:' + id;
      $('#individualId').value = currentIndividual;
      loadIndividual();
    }
  } catch (e) { alert('保存失败：' + e.message); }
}

// 模拟上报
const SIM_POOL = [
  { id: 'esp32-01', name: '1号鸡舍', species: '鸡', base: { temperature: 26, humidity: 60 } },
  { id: 'esp32-02', name: '2号猪舍', species: '猪', base: { temperature: 20, humidity: 65 } },
  { id: 'esp32-03', name: '3号牛舍', species: '牛', base: { temperature: 15, humidity: 55 } }
];
let simIndex = 0;
async function simulate() {
  const item = SIM_POOL[simIndex % SIM_POOL.length];
  simIndex++;
  const vary = (v, r) => +(v + (Math.random() * r * 2 - r)).toFixed(1);
  const abnormal = Math.random() < 0.25;
  const body = {
    device_id: item.id, name: item.name, species: item.species,
    temperature: abnormal ? 42 : vary(item.base.temperature, 1.5),
    humidity: vary(item.base.humidity, 4),
    ammonia: abnormal ? 38 : vary(12, 5)
  };
  try {
    await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { console.error(e); }
}

// 图片上传
function handleImagePicked(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const thumb = addThumb(dataUrl);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataUrl, name: file.name })
      });
      const data = await res.json();
      if (data.ok && data.file_id) {
        pendingImages.push({ file_id: data.file_id, dataUrl, el: thumb });
      } else {
        thumb.remove();
        alert('图片上传失败：' + (data.error || '未知错误'));
      }
    } catch (err) {
      thumb.remove();
      alert('图片上传失败：' + err.message);
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function addThumb(dataUrl) {
  const box = $('#chatImages');
  const div = document.createElement('div');
  div.className = 'thumb';
  div.innerHTML = `<img src="${dataUrl}"><button class="rm">×</button>`;
  div.querySelector('.rm').addEventListener('click', () => {
    const idx = pendingImages.findIndex((p) => p.el === div);
    if (idx >= 0) pendingImages.splice(idx, 1);
    div.remove();
  });
  box.appendChild(div);
  return div;
}

// 聊天
function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

function addMessage(role, content, extra) {
  const box = $('#chatMessages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const avatar = role === 'user' ? '🧑‍🌾' : '🤖';
  const imgs = extra && extra.images ? extra.images.map((d) => `<img class="msg-own-image" src="${d}">`).join('') : '';
  const time = `<div class="msg-time">${fmtTime(extra && extra.ts)}</div>`;
  const copy = role === 'assistant' ? `<button class="msg-copy" type="button" title="复制">📋</button>` : '';
  div.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-bubble">${imgs}<p></p><div class="msg-footer">${time}${copy}</div></div>`;
  const p = div.querySelector('.msg-bubble p');
  if (role === 'assistant') p.innerHTML = renderMarkdown(content);
  else p.textContent = content;
  const cp = div.querySelector('.msg-copy');
  if (cp) cp.addEventListener('click', () => { navigator.clipboard.writeText(content).catch(() => {}); });
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function addTyping() {
  const box = $('#chatMessages');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `<div class="msg-avatar">🤖</div><div class="msg-bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// 工作流程可视化（只显示大标题）
const STEPS = ['🔍 识别物品或生物', '📚 检索物种知识库', '🌡 分析实时环境数据', '🩺 研判病因', '💊 生成防治方案'];
let stepTimer = null;

function startSteps() {
  const el = $('#chatSteps');
  if (!el) return;
  el.style.display = 'flex';
  let i = 0;
  const render = () => {
    el.innerHTML = STEPS.map((s, k) => `<span class="step ${k === i ? 'active' : k < i ? 'done' : ''}">${s}</span>`).join('');
  };
  render();
  if (stepTimer) clearInterval(stepTimer);
  stepTimer = setInterval(() => {
    if (i < STEPS.length - 1) i++;
    render();
  }, 1800);
}

function stopSteps() {
  if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
  const el = $('#chatSteps');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

// 个体档案
let currentIndividual = '';

async function saveIndividual(role, content) {
  if (!currentIndividual) return;
  try {
    await fetch('/api/conversations/' + encodeURIComponent(currentIndividual), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role, content, ts: Date.now() }] })
    });
    loadConversationList();
  } catch (e) {}
}

async function loadIndividual() {
  const id = ($('#individualId').value || '').trim();
  currentIndividual = id;
  const status = $('#individualStatus');
  const box = $('#chatMessages');
  if (!id) { status.textContent = ''; status.className = 'profile-status'; box.innerHTML = ''; return; }
  try {
    const res = await fetch('/api/conversations/' + encodeURIComponent(id));
    const data = await res.json();
    const msgs = (data && data.messages) || [];
    box.innerHTML = '';
    chatHistory = msgs.slice(-20).map((m) => ({ role: m.role, content: m.content }));
    if (msgs.length === 0) {
      status.textContent = '新个体 · 暂无记录';
      status.className = 'profile-status new';
      addMessage('assistant', '已为个体「' + id + '」建立档案。请描述它的状况，我会记录并持续跟踪。');
    } else {
      status.textContent = '已载入 ' + msgs.length + ' 条记录';
      status.className = 'profile-status ok';
      msgs.forEach((m) => addMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content, { ts: m.ts }));
    }
  } catch (e) {
    status.textContent = '载入失败';
    status.className = 'profile-status err';
  }
}

// 轻提示
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// 已建档案列表
async function loadConversationList() {
  const box = $('#chatConvos');
  if (!box) return;
  try {
    const res = await fetch('/api/conversations');
    const data = await res.json();
    const list = (data && data.conversations) || [];
    if (list.length === 0) {
      box.innerHTML = '<span class="convos-empty">暂无已建档案</span>';
      return;
    }
    const chip = (c) => {
      const label = c.name || c.id;
      const badge = c.bound ? '<span class="convo-bound" title="设备绑定，不可删除">设备</span>' : '';
      const delTitle = c.id === 'main' ? '清空主对话（聊天框保留）' : '删除聊天';
      const del = c.bound ? '' : '<span class="convo-del" data-del="' + escapeHtml(c.id) + '" title="' + delTitle + '">×</span>';
      const active = c.id === currentIndividual ? ' active' : '';
      return '<button class="convo-chip' + active + '" type="button" data-id="' + escapeHtml(c.id) + '">' +
        escapeHtml(label) + ' <span class="convo-count">' + c.count + '</span>' + badge + del + '</button>';
    };
    const main = list.find((c) => c.id === 'main');
    const others = list.filter((c) => c.id !== 'main');
    box.innerHTML =
      (main ? '<div class="convo-main-row">' + chip(main) + '</div>' : '') +
      (others.length ? '<span class="convos-label">聊天档案：</span>' + others.map(chip).join('') : '');
    box.querySelectorAll('.convo-chip').forEach((b) => {
      b.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        $('#individualId').value = b.getAttribute('data-id');
        loadIndividual();
      });
    });
    box.querySelectorAll('[data-del]').forEach((d) => {
      d.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = d.getAttribute('data-del');
        const isMain = id === 'main';
        const ans = prompt(
          (isMain
            ? '清空主对话？\n（主对话是常驻入口，不会删除，只会清空消息并恢复默认名称）\n\n'
            : '删除聊天「' + id + '」？\n\n') +
          '1 = ' + (isMain ? '清空' : '直接删除') + '\n' +
          '2 = ' + (isMain ? '清空' : '删除聊天框') + '，但把记录存入真实知识库\n\n' +
          '请输入 1 / 2（默认 1）',
          '1'
        );
        if (ans === null) return;
        const archive = String(ans).trim() === '2';
        try {
          const r = await fetch('/api/conversations/' + encodeURIComponent(id) + (archive ? '?archive=1' : ''), { method: 'DELETE' });
          const j = await r.json();
          if (!j.ok) { toast(j.error || '删除失败'); return; }
          if (currentIndividual === id) {
            currentIndividual = '';
            $('#individualId').value = '';
            $('#chatMessages').innerHTML = '';
          }
          loadConversationList();
          if (j.cleared) toast('主对话已清空' + (archive ? '，并存入 ' + (j.archived || 0) + ' 条记录到知识库' : ''));
          else if (archive) toast('已删除聊天，并存入 ' + (j.archived || 0) + ' 条记录到真实知识库');
          else toast('聊天已删除');
        } catch (err) { toast('删除失败：' + err.message); }
      });
    });
  } catch (e) { box.innerHTML = ''; }
}

// 市场行情
async function loadMarket() {
  $('#marketModal').classList.add('show');
  $('#marketTitle').textContent = '市场行情';
  $('#marketMeta').textContent = '加载中…';
  $('#marketBody').innerHTML = '';
  $('#marketBreed').style.display = 'none';
  try {
    const res = await fetch('/api/market');
    const data = await res.json();
    if (!data.ok) { $('#marketMeta').textContent = data.error || '加载失败'; return; }
    $('#marketMeta').innerHTML = '日期：' + escapeHtml(data.date) + '　来源：' + escapeHtml(data.source);
    $('#marketBody').innerHTML = '<div class="market-table">' +
      '<div class="market-row market-head"><span>物种</span><span>收购价</span><span>出售价</span><span>日涨跌</span><span>品种数</span></div>' +
      data.species.map((s) => {
        const cls = s.change > 0 ? 'up' : s.change < 0 ? 'down' : '';
        const sign = s.change > 0 ? '+' : '';
        return '<div class="market-row" data-species="' + escapeHtml(s.name) + '">' +
          '<span class="m-name">' + (s.icon || '') + ' ' + escapeHtml(s.name) + '</span>' +
          '<span>' + s.purchase + ' <em>' + escapeHtml(s.unit) + '</em></span>' +
          '<span>' + s.sale + ' <em>' + escapeHtml(s.unit) + '</em></span>' +
          '<span class="' + cls + '">' + sign + s.change + '%</span>' +
          '<span>' + s.breeds + '</span></div>';
      }).join('') + '</div>';
    $('#marketBody').querySelectorAll('[data-species]').forEach((row) => {
      row.addEventListener('click', () => loadBreedMarket(row.getAttribute('data-species')));
    });
  } catch (e) {
    $('#marketMeta').textContent = '网络错误：' + e.message;
  }
}

async function loadBreedMarket(speciesName) {
  const box = $('#marketBreed');
  box.style.display = 'block';
  box.innerHTML = '加载中…';
  try {
    const res = await fetch('/api/market/breeds?species=' + encodeURIComponent(speciesName));
    const data = await res.json();
    if (!data.ok) { box.textContent = data.error || '加载失败'; return; }
    box.innerHTML = '<div class="market-breed-title">' + escapeHtml(speciesName) + ' · 品种行情</div>' +
      '<div class="market-table">' +
      '<div class="market-row market-head"><span>品种</span><span>收购价</span><span>出售价</span><span></span><span></span></div>' +
      data.breeds.map((b) => '<div class="market-row"><span class="m-name">' + escapeHtml(b.name) + '</span><span>' + b.purchase + ' <em>' + escapeHtml(b.unit) + '</em></span><span>' + b.sale + ' <em>' + escapeHtml(b.unit) + '</em></span><span></span><span></span></div>').join('') +
      '</div>';
  } catch (e) { box.textContent = '网络错误：' + e.message; }
}

// 真实知识库（本场患病记录）
async function loadRealKb() {
  $('#realKbModal').classList.add('show');
  const box = $('#realKbBody');
  box.innerHTML = '加载中…';
  try {
    const res = await fetch('/api/real-knowledge');
    const data = await res.json();
    if (!data.ok) { box.textContent = data.error || '加载失败'; return; }
    let html = '<div class="rk-summary">患病记录 <b>' + data.total + '</b> 条 · AI 查询记录 <b>' + (data.queryTotal || 0) + '</b> 条</div>';
    if (data.parameters && data.parameters.length) {
      html += '<div class="rk-params">' + data.parameters.map((p) => {
        const env = [];
        if (p.avgTemperature !== null) env.push('平均温度 ' + p.avgTemperature + '°C');
        if (p.avgHumidity !== null) env.push('湿度 ' + p.avgHumidity + '%');
        if (p.avgCo2 !== null) env.push('CO2 ' + p.avgCo2 + 'ppm');
        return '<div class="rk-card"><div class="rk-disease">' + escapeHtml(p.disease) + '</div>' +
          '<div class="rk-count">' + p.count + ' 次</div>' +
          '<div class="rk-env">' + env.join(' · ') + '</div>' +
          (p.symptoms.length ? '<div class="rk-sym">常见症状：' + p.symptoms.map((s) => escapeHtml(s.symptom)).join('、') + '</div>' : '') +
          '</div>';
      }).join('') + '</div>';
    }
    // AI 查询记录（每次诊断/预警时的真实环境快照）
    if (data.queries && data.queries.length) {
      html += '<div class="rk-records-title">AI 查询记录（含当时环境与诊断内容）</div><div class="rk-queries">' +
        data.queries.slice(0, 20).map((q) => {
          const e = q.env || {};
          const env = [];
          if (e.temperature !== undefined) env.push('温度 ' + e.temperature + '°C');
          if (e.humidity !== undefined) env.push('湿度 ' + e.humidity + '%');
          if (e.co2 !== undefined) env.push('CO2 ' + e.co2 + 'ppm');
          if (e.ammonia !== undefined) env.push('氨气 ' + e.ammonia + 'ppm');
          const ans = String(q.answer || '');
          const short = ans.slice(0, 160);
          const answerHtml = ans
            ? '<div class="rk-answer">' +
              '<span class="rk-answer-short">答：' + escapeHtml(short) + (ans.length > 160 ? '…' : '') + '</span>' +
              '<span class="rk-answer-full" style="display:none">答：' + escapeHtml(ans) + '</span>' +
              (ans.length > 160 ? '<button class="rk-more" type="button">展开全文</button>' : '') +
              '</div>'
            : '';
          return '<div class="rk-record"><div class="rk-rec-head"><b>' +
            escapeHtml(q.species || q.deviceName || '查询') + '</b>' +
            (q.stage ? ' · ' + escapeHtml(q.stage) : '') +
            '<span class="rk-q-time">' + escapeHtml(String(q.time || '').replace('T', ' ').slice(0, 16)) + '</span>' +
            '<button class="rk-del" type="button" data-qdel="' + escapeHtml(q.id) + '">删除</button></div>' +
            '<div class="rk-rec-sub">问：' + escapeHtml(String(q.question || '').slice(0, 80)) + '</div>' +
            '<div class="rk-rec-env">' + (env.join(' · ') || '无环境数据') + '</div>' +
            answerHtml + '</div>';
        }).join('') + '</div>';
    }
    if (data.records && data.records.length) {
      html += '<div class="rk-records-title">患病记录</div><div class="rk-records">' + data.records.map((r) => {
        const env = r.env || {};
        return '<div class="rk-record"><div class="rk-rec-head"><b>' + escapeHtml(r.individualId || r.deviceName || '未命名') + '</b> · ' + escapeHtml(r.disease || '未分类') + '<button class="rk-del" type="button" data-del="' + escapeHtml(r.id) + '">删除</button></div>' +
          '<div class="rk-rec-sub">' + escapeHtml(r.time || '') + '　' + escapeHtml(r.symptoms || '无症状描述') + '</div>' +
          '<div class="rk-rec-env">温度 ' + (env.temperature !== undefined ? env.temperature : '—') + '°C · 湿度 ' + (env.humidity !== undefined ? env.humidity : '—') + '% · CO2 ' + (env.co2 !== undefined ? env.co2 : '—') + 'ppm</div></div>';
      }).join('') + '</div>';
    } else if (!data.queries || !data.queries.length) {
      html += '<div class="empty"><p>暂无记录</p><p class="empty-hint">在聊天窗口点「记录患病」保存患病情况；每次 AI 诊断/预警会自动记入查询记录</p></div>';
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('确定删除这条患病记录吗？')) return;
        try {
          await fetch('/api/illness/' + encodeURIComponent(btn.getAttribute('data-del')), { method: 'DELETE' });
          loadRealKb();
        } catch (err) { toast('删除失败：' + err.message); }
      });
    });
    box.querySelectorAll('[data-qdel]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('删除这条 AI 查询记录？')) return;
        try {
          const r = await fetch('/api/queries/' + encodeURIComponent(btn.getAttribute('data-qdel')), { method: 'DELETE' });
          const j = await r.json();
          if (!j.ok) { toast(j.error || '删除失败'); return; }
          loadRealKb();
        } catch (err) { toast('删除失败：' + err.message); }
      });
    });
    // 展开 / 收起完整回答
    box.querySelectorAll('.rk-more').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rec = btn.closest('.rk-record');
        if (!rec) return;
        const shortEl = rec.querySelector('.rk-answer-short');
        const fullEl = rec.querySelector('.rk-answer-full');
        if (!shortEl || !fullEl) return;
        const showingFull = fullEl.style.display !== 'none';
        fullEl.style.display = showingFull ? 'none' : 'block';
        shortEl.style.display = showingFull ? 'block' : 'none';
        btn.textContent = showingFull ? '展开全文' : '收起';
      });
    });
  } catch (e) { box.textContent = '网络错误：' + e.message; }
}

// 记录患病（生成本地文本）
async function recordIllness() {
  const disease = prompt('请输入患病类型（如：新城疫、球虫病）：', '');
  if (disease === null) return;
  const symptoms = prompt('请输入症状（如：拉稀、精神萎靡）：', '');
  if (symptoms === null) return;
  let deviceId = '';
  if (devices.size === 1) deviceId = [...devices.keys()][0];
  try {
    const res = await fetch('/api/illness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ individualId: currentIndividual, deviceId, disease, symptoms })
    });
    const data = await res.json();
    if (data.ok) {
      toast('已记录患病：' + disease + '（本地文本已生成）');
      loadRealKb();
    } else {
      toast('记录失败：' + (data.error || '未知错误'));
    }
  } catch (e) { toast('网络错误：' + e.message); }
}

// 预警记录（AI 预警结论文本）
async function loadWarnings() {
  $('#warningModal').classList.add('show');
  const box = $('#warningBody');
  box.innerHTML = '加载中…';
  try {
    const res = await fetch('/api/warnings');
    const data = await res.json();
    if (!data.ok) { box.textContent = data.error || '加载失败'; return; }
    const toolbar = '<div class="warning-toolbar"><button class="btn ghost" id="warningAdd" type="button">新增记录</button><span class="warning-tip">点击记录查看全文</span></div>';
    if (!data.files.length) {
      box.innerHTML = toolbar + '<div class="empty"><p>暂无预警记录</p><p class="empty-hint">在设备详情打开「AI 健康预警」后，结论会自动保存为文本</p></div>';
      bindWarningAdd();
      return;
    }
    box.innerHTML = toolbar + '<div class="warning-list">' + data.files.map((f) => {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})[^_]*_(.+)\.txt$/);
      const time = m ? (m[1] + ' ' + m[2] + ':' + m[3]) : f;
      const dev = m ? m[5].replace(/_/g, ' ') : '';
      return '<div class="warning-item" data-file="' + escapeHtml(f) + '">' +
        '<div class="warning-item-main"><div class="warning-item-dev">' + escapeHtml(dev) + '</div>' +
        '<div class="warning-item-time">' + escapeHtml(time) + '</div></div>' +
        '<button class="warning-del" type="button" data-del="' + escapeHtml(f) + '">删除</button></div>';
    }).join('') + '</div>' +
      '<div class="warning-view" id="warningView"><div class="empty-hint">点击左侧记录查看全文</div></div>';
    box.querySelectorAll('[data-file]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        openWarningFile(el.getAttribute('data-file'));
      });
    });
    box.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('确定删除这条预警记录吗？')) return;
        await fetch('/api/warnings/file?name=' + encodeURIComponent(btn.getAttribute('data-del')), { method: 'DELETE' });
        loadWarnings();
      });
    });
    bindWarningAdd();
  } catch (e) { box.textContent = '网络错误：' + e.message; }
}

function bindWarningAdd() {
  const add = $('#warningAdd');
  if (!add) return;
  add.addEventListener('click', async () => {
    const content = prompt('请输入预警记录内容：', '');
    if (!content) return;
    const device = prompt('设备名称（可留空）：', '') || '手动记录';
    try {
      await fetch('/api/warnings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, device })
      });
      loadWarnings();
    } catch (e) { toast('新增失败：' + e.message); }
  });
}

async function openWarningFile(name) {
  const view = $('#warningView');
  view.textContent = '加载中…';
  // 高亮当前选中的记录
  document.querySelectorAll('.warning-item').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-file') === name);
  });
  try {
    const res = await fetch('/api/warnings/file?name=' + encodeURIComponent(name));
    const data = await res.json();
    if (!data.ok) { view.textContent = data.error || '读取失败'; return; }
    view.innerHTML = '<pre class="warning-pre">' + escapeHtml(data.content) + '</pre>';
    view.scrollTop = 0;
  } catch (e) { view.textContent = '网络错误：' + e.message; }
}

// 新建对话：用输入框里的名字创建档案（任何名字都可以）
async function newConversation() {
  const name = ($('#individualId').value || '').trim() || '新聊天';
  const id = 'custom:' + Date.now();
  currentIndividual = id;
  chatHistory = [];
  pendingImages = [];
  $('#individualId').value = id;
  $('#individualStatus').textContent = '已创建 · ' + name;
  $('#individualStatus').className = 'profile-status ok';
  $('#chatImages').innerHTML = '';
  $('#chatMessages').innerHTML = '';
  try {
    await fetch('/api/conversations/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, messages: [] })
    });
  } catch (e) {}
  const welcome = '已创建聊天「' + name + '」。请描述情况，我会记录并持续跟踪。';
  addMessage('assistant', welcome);
  await saveIndividual('assistant', welcome);
  toast('已创建聊天：' + name);
  loadConversationList();
}

// 药品卡片：图片 + 购买链接
// 候选病种确认卡：展示病症图 + 确认按钮，确认后才继续下一步
function addCandidateCards(candidates, speciesName) {
  const box = $('#chatMessages');
  if (!box || !candidates || !candidates.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'cand-block';
  wrap.innerHTML =
    '<div class="cand-title">请确认是哪种病（点击图片查看真实症状）</div>' +
    '<div class="cand-list">' + candidates.map((c) =>
      '<a class="cand-card" href="' + escapeHtml(c.searchUrl || '#') + '" target="_blank" rel="noopener">' +
      '<img class="cand-img" src="' + escapeHtml(c.image || '') + '" alt="">' +
      '<div class="cand-name">' + escapeHtml(c.name || '') + '</div></a>').join('') + '</div>' +
    '<div class="cand-actions">' +
    candidates.map((c) => '<button class="btn primary cand-yes" type="button" data-name="' + escapeHtml(c.name || '') + '">是「' + escapeHtml(c.name || '') + '」</button>').join('') +
    '<button class="btn ghost cand-no" type="button">都不是，重新判断</button>' +
    '</div>' +
    '<div class="cand-hint">确认后我再给出详细的防治方案</div>';
  box.appendChild(wrap);

  wrap.querySelectorAll('.cand-yes').forEach((b) => {
    b.addEventListener('click', () => {
      const name = b.getAttribute('data-name');
      wrap.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      sendChat('确认是「' + name + '」，请给出详细的防治方案', []);
    });
  });
  const no = wrap.querySelector('.cand-no');
  if (no) no.addEventListener('click', () => {
    wrap.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    sendChat('都不是，请重新判断可能是什么病，并列出候选', []);
  });
  box.scrollTop = box.scrollHeight;
}

function addDrugCards(drugs) {
  const box = $('#chatMessages');
  if (!box || !drugs || !drugs.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'drug-block';
  wrap.innerHTML = '<div class="drug-title">推荐药品（点击前往购买）</div>' +
    drugs.map((d) => '<a class="drug-card" href="' + escapeHtml(d.link || '#') + '" target="_blank" rel="noopener">' +
      '<img class="drug-img" src="' + escapeHtml(d.image || '') + '" alt="">' +
      '<div class="drug-info"><div class="drug-name">' + escapeHtml(d.name || '') + '</div>' +
      '<div class="drug-note">' + escapeHtml(d.note || '') + '</div></div>' +
      '<span class="drug-go">去购买 ›</span></a>').join('');
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

async function sendChat(message, images) {
  const imgs = images.map((p) => p.dataUrl);
  addMessage('user', message, { images: imgs });
  if (currentIndividual) saveIndividual('user', message);
  const typing = addTyping();
  startSteps();
  const sendBtn = $('#chatSend');
  sendBtn.disabled = true;

  const hintTimer = setTimeout(() => {
    const bubble = typing.querySelector('.msg-bubble');
    if (bubble && !bubble.querySelector('.thinking-hint')) {
      const hint = document.createElement('div');
      hint.className = 'thinking-hint';
      hint.textContent = '⏳ 智能体正加速运行中，请耐心等待…';
      bubble.appendChild(hint);
    }
  }, 8000);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        images: images.map((p) => p.file_id),
        history: chatHistory,
        individualId: currentIndividual,
        city: savedCity()
      })
    });
    const data = await res.json();
    clearTimeout(hintTimer);
    typing.remove();
    stopSteps();

    if (data.ok) {
      const reply = data.reply;
      const content = typeof reply === 'string' ? reply
        : (reply && (reply.content || reply.message || reply.text)) || JSON.stringify(reply);
      addMessage('assistant', content);
      // 候选病种：先让用户确认，再继续下一步
      if (Array.isArray(data.candidates) && data.candidates.length) {
        addCandidateCards(data.candidates, data.speciesForCand);
      }
      if (Array.isArray(data.drugs) && data.drugs.length) addDrugCards(data.drugs);
      chatHistory.push({ role: 'user', content: message });
      chatHistory.push({ role: 'assistant', content });
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
      if (currentIndividual) saveIndividual('assistant', content);
    } else {
      addMessage('assistant', '⚠️ ' + (data.error || '请求失败'));
    }
  } catch (e) {
    clearTimeout(hintTimer);
    typing.remove();
    stopSteps();
    addMessage('assistant', '⚠️ 网络错误：' + e.message);
  } finally {
    sendBtn.disabled = false;
  }
}

// 登录
function showLogin() { $('#loginMask').classList.remove('hidden'); }
function hideLogin() { $('#loginMask').classList.add('hidden'); }

async function doLogin() {
  const u = $('#loginUser').value.trim();
  const p = $('#loginPass').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (data.ok) { localStorage.setItem('farm-login', '1'); hideLogin(); }
    else { $('#loginErr').textContent = data.error || '登录失败'; }
  } catch (e) { $('#loginErr').textContent = '网络错误：' + e.message; }
}

// 设备详情 + 摄像头
let detailTimer = null, recogTimer = null, currentDetailId = null;


// 饲料槽卡片：RFP602 薄膜压力传感器给槽内余量，每日投喂量由用户填写
function renderFeedCard(d) {
  const box = $('#detailExtra');
  if (!box) return;
  const feed = (d && d.feed) || {};
  const meta = (d && d.meta) || {};
  const daily = Number(feed.daily || meta.feed_daily) || 0;
  const level = (feed.level !== null && feed.level !== undefined) ? Number(feed.level) : null;
  const weight = feed.weight !== null && feed.weight !== undefined ? Number(feed.weight) : null;
  const abnormal = level !== null && level > 20;
  const st = level === null ? '等待传感器数据' : (abnormal ? '采食不足（剩料多）' : '采食正常');
  const cls = level === null ? '' : (abnormal ? 'danger' : 'ok');
  const barW = level === null ? 0 : Math.max(2, Math.min(100, level));
  box.innerHTML = '<div class="feed-card">' +
    '<div class="feed-title">饲料槽状况</div>' +
    '<div class="feed-bar"><i class="' + cls + '" style="width:' + barW + '%"></i></div>' +
    '<div class="feed-row"><span>每日投喂</span><b>' + (daily > 0 ? daily + ' kg' : '未填写') + '</b></div>' +
    '<div class="feed-row"><span>槽内余量</span><b>' + (level !== null ? level + '%' : '—') + '</b></div>' +
    '<div class="feed-row"><span>约剩余</span><b>' + (weight !== null ? weight + ' kg' : '—') + '</b></div>' +
    '<div class="feed-row"><span>状况</span><b class="feed-status ' + cls + '">' + st + '</b></div>' +
    '<div class="feed-hint">次日余量 ≤20% 为正常；超过 20% 说明剩料多、采食不足</div></div>';
}

function openDetail(id) {
  const d = devices.get(id);
  if (!d) return;
  currentDetailId = id;
  const sp = (d.meta && d.meta.species) ? speciesMap[d.meta.species] : null;
  $('#detailTitle').textContent = (sp ? sp.icon + ' ' : '') + (d.name || id);

  const metricsHtml = METRIC_ORDER.filter((k) => d.metrics && d.metrics[k] !== undefined).map((k) => {
    const m = d.metrics[k];
    const cls = m.severity === 'severe' ? 'high' : m.severity === 'mild' ? 'low' : 'normal';
    const norm = (d.normal && d.normal[k]) || normalRange(d.meta && d.meta.species, k);
    const normHtml = k === 'feed_level'
      ? `<div class="metric-normal">${feedStatus(m.value)} · 正常 ≤20%</div>`
      : (norm ? `<div class="metric-normal">正常 ${norm.min}~${norm.max}${norm.unit}</div>` : '');
    return `<div class="metric ${cls} metric-clickable" data-metric="${k}">
      <div class="metric-label">${escapeHtml(metricLabel(k))}</div>
      <div class="metric-value">${Number(m.value).toFixed(1)}<span class="metric-unit">${metricUnit(k)}</span></div>
      ${normHtml}</div>`;
  }).join('');
  // 识别数量 & 种群密度：和温湿度/二氧化碳放进同一个数据格子里
  const meta = d.meta || {};
  const userCount = Number(meta.count) || 0;
  const camCount = d.metrics && d.metrics.camera_count !== undefined ? Math.round(Number(d.metrics.camera_count.value)) : null;
  const dinfo = d.density || {};
  const densityVal = dinfo.actual;
  const ref = dinfo.ref;
  const missing = camCount != null && userCount > 0 && camCount < userCount;
  let statsHtml = `<div class="metric ${missing ? 'high' : 'normal'}">
    <div class="metric-label">识别数量</div>
    <div class="metric-value">${camCount != null ? camCount : '—'}<span class="metric-unit">只</span></div>
    <div class="metric-normal">${userCount > 0 ? '填写 ' + userCount + ' 只' + (missing ? ' · 少 ' + (userCount - camCount) + ' 只' : '') : '未填写数量'}</div>
  </div>`;
  const dCls = dinfo.status === 'high' ? 'high' : dinfo.status === 'low' ? 'low' : 'normal';
  statsHtml += `<div class="metric ${dCls}">
    <div class="metric-label">种群密度</div>
    <div class="metric-value">${densityVal != null ? densityVal : '—'}<span class="metric-unit">只/㎡</span></div>
    <div class="metric-normal">${ref ? '参考 ' + ref.min + '~' + ref.max + ' 只/㎡' : '未填写数量/面积'}</div>
  </div>`;
  $('#detailMetrics').innerHTML = (metricsHtml + statsHtml) || '<div class="empty">暂无数据</div>';
  $('#detailMetrics').querySelectorAll('[data-metric]').forEach((el) => {
    el.addEventListener('click', () => openMetricChart(id, el.getAttribute('data-metric')));
  });

  // 饲料槽状况卡
  renderFeedCard(d);

  $('#camImg').style.display = 'none';
  $('#camPlaceholder').style.display = 'block';
  $('#recogResult').innerHTML = '';
  $('#recogSwitch').checked = false;
  $('#detailModal').classList.add('show');

  // 有本机 IP 就直连视频流（低延迟）；否则用服务器快照兜底
  const localIp = d.meta && d.meta.local_ip;
  if (localIp) {
    startStream(localIp, (d.meta && d.meta.stream_port) || 81, id);
  } else {
    startCameraRefresh(id);
  }
}

function closeDetail() {
  $('#detailModal').classList.remove('show');
  if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
  if (recogTimer) { clearInterval(recogTimer); recogTimer = null; }
  const img = $('#camImg');
  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');   // 断开视频流
  currentDetailId = null;
}

// 局域网直连 MJPEG 视频流（低延迟）
function startStream(ip, port, id) {
  if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
  const img = $('#camImg');
  const ph = $('#camPlaceholder');
  let loaded = false;

  img.onload = () => {
    loaded = true;
    img.style.display = 'block';
    ph.style.display = 'none';
  };
  img.onerror = () => {
    if (loaded) return;
    img.style.display = 'none';
    ph.innerHTML = '<div class="cam-ph-icon">📷</div><p>视频流连接失败</p><p class="cam-ph-hint">可能不在同一局域网，已切回服务器快照</p>';
    ph.style.display = 'block';
    startCameraRefresh(id);
  };
  img.src = 'http://' + ip + ':' + port + '/stream?t=' + Date.now();

  // 5 秒内没出画面就回退快照
  setTimeout(() => {
    if (!loaded && currentDetailId === id) {
      img.style.display = 'none';
      ph.innerHTML = '<div class="cam-ph-icon">📷</div><p>视频流超时</p><p class="cam-ph-hint">已切回服务器快照</p>';
      ph.style.display = 'block';
      startCameraRefresh(id);
    }
  }, 5000);
}

function startCameraRefresh(id) {
  if (detailTimer) clearInterval(detailTimer);
  const refresh = () => {
    const img = $('#camImg');
    img.onerror = () => { img.style.display = 'none'; $('#camPlaceholder').style.display = 'block'; };
    img.onload = () => { img.style.display = 'block'; $('#camPlaceholder').style.display = 'none'; };
    img.src = '/api/camera/' + encodeURIComponent(id) + '?t=' + Date.now();
  };
  refresh();
  detailTimer = setInterval(refresh, 1500);
}

// AI 预警的工作状态（分步展示，避免干等）
const WARN_STEPS = ['读取设备实时数据', '检索本地知识库', '结合当地天气', 'AI 综合研判', '生成预警结论'];
let warnStepTimer = null;
let warnStepIdx = 0;

function renderWarnSteps(box, idx) {
  box.className = 'recog-result loading';
  const pct = Math.round(((idx + 1) / WARN_STEPS.length) * 100);
  box.innerHTML = '<div class="recog-head">AI 健康预警分析 · 进行中</div>' +
    '<div class="warn-progress"><div class="warn-progress-bar" style="width:' + pct + '%"></div></div>' +
    '<div class="warn-steps">' + WARN_STEPS.map((s, k) =>
      '<div class="warn-step ' + (k === idx ? 'active' : k < idx ? 'done' : '') + '">' +
      '<span class="ws-dot"></span><span>' + s + '</span></div>').join('') + '</div>' +
    '<div class="recog-time">正在分析，请稍候…（通常 10~30 秒）</div>';
}

function openRecogModal() {
  const src = $('#recogResult');
  const body = $('#recogModalBody');
  body.innerHTML = src.innerHTML;
  const zb = body.querySelector('.recog-zoom');
  if (zb) zb.remove();
  $('#recogModal').classList.add('show');
}

function startWarnSteps(box) {
  warnStepIdx = 0;
  if (warnStepTimer) clearInterval(warnStepTimer);
  renderWarnSteps(box, 0);
  warnStepTimer = setInterval(() => {
    if (warnStepIdx < WARN_STEPS.length - 1) {
      warnStepIdx++;
      renderWarnSteps(box, warnStepIdx);
    }
  }, 2500);
}

function stopWarnSteps() {
  if (warnStepTimer) { clearInterval(warnStepTimer); warnStepTimer = null; }
}

function startRecognition(id) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    const box = $('#recogResult');
    // 已有结果时不覆盖，只在角落提示「更新中」，避免把正在看的内容刷掉
    const hasResult = !!box.querySelector('.recog-head') && !box.classList.contains('loading');
    if (hasResult) {
      let tag = box.querySelector('.recog-updating');
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'recog-updating';
        tag.textContent = '更新中…';
        box.appendChild(tag);
      }
    } else {
      startWarnSteps(box);
    }
    try {
      const res = await fetch('/api/health/' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: localStorage.getItem('weather-city') || '' })
      });
      const data = await res.json();
      stopWarnSteps();
      if (data.ok) {
        const warn = /高风险|中风险|异常|生病|危险|死亡|长时间静止|未移动/.test(data.result || '');
        box.className = 'recog-result' + (warn ? ' warn' : '');
        box.innerHTML = '<div class="recog-head"><span>AI 健康预警分析</span><button class="recog-zoom" type="button">⛶ 放大</button></div>' +
          renderMarkdown(data.result || '') + '<div class="recog-time">' + new Date().toLocaleTimeString() + '</div>';
        const zb = box.querySelector('.recog-zoom');
        if (zb) zb.addEventListener('click', openRecogModal);
      } else {
        if (!hasResult) {
          box.className = 'recog-result';
          box.textContent = data.error || data.result || '分析失败';
        }
      }
    } catch (e) {
      stopWarnSteps();
      if (!hasResult) {
        box.className = 'recog-result';
        box.textContent = '分析请求失败：' + e.message;
      }
    }
    running = false;
  };
  run();
  // 5 分钟刷新一次（原来 60 秒太快，会打断阅读）
  recogTimer = setInterval(run, 300000);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  // 登录状态检查
  if (!localStorage.getItem('farm-login')) { showLogin(); }

  loadSpecies();
  loadDevices();
  loadAnalysis();
  loadConfig();
  loadWeather();
  connectSSE();

  // 登录
  $('#loginBtn').addEventListener('click', doLogin);
  $('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  $('#btnSimulate').addEventListener('click', simulate);
  $('#btnClear').addEventListener('click', clearDevices);
  $('#btnAddDevice').addEventListener('click', openAddModal);
  $('#btnRefreshAnalysis').addEventListener('click', loadAnalysis);
  // 手册模糊搜索
  $('#manualSearch').addEventListener('input', (e) => renderKnowledge(e.target.value));
  // 手册弹窗关闭
  $('#hbClose').addEventListener('click', closeHandbook);
  $('#handbookModal').addEventListener('click', (e) => { if (e.target === $('#handbookModal')) closeHandbook(); });
  $('#dmCancel').addEventListener('click', () => $('#deviceModal').classList.remove('show'));
  $('#dmSave').addEventListener('click', saveDevice);

  // 设备详情
  $('#detailClose').addEventListener('click', closeDetail);
  $('#detailModal').addEventListener('click', (e) => { if (e.target === $('#detailModal')) closeDetail(); });
  $('#recogSwitch').addEventListener('change', (e) => {
    if (!currentDetailId) return;
    if (e.target.checked) { startRecognition(currentDetailId); }
    else { if (recogTimer) { clearInterval(recogTimer); recogTimer = null; } }
  });

  $('#chatImageInput').addEventListener('change', handleImagePicked);

  const form = $('#chatForm');
  const input = $('#chatInput');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg && pendingImages.length === 0) return;
    const images = [...pendingImages];
    pendingImages = [];
    $('#chatImages').innerHTML = '';
    input.value = '';
    autoResize(input);
    sendChat(msg, images);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.dispatchEvent(new Event('submit')); }
  });
  input.addEventListener('input', () => autoResize(input));

  // 全屏 / 清空 / 个体档案 / 快捷提问
  $('#chatFullscreen').addEventListener('click', () => {
    $('#chatPanel').classList.toggle('fullscreen');
  });
  $('#chatClear').addEventListener('click', async () => {
    if (currentIndividual) {
      await fetch('/api/conversations/' + encodeURIComponent(currentIndividual), { method: 'DELETE' }).catch(() => {});
    }
    chatHistory = [];
    $('#chatMessages').innerHTML = '';
    addMessage('assistant', '对话已清空。' + (currentIndividual ? '个体「' + currentIndividual + '」的记录也已删除。' : ''));
  });
  $('#individualLoad').addEventListener('click', loadIndividual);
  $('#individualNew').addEventListener('click', newConversation);
  // 手册下拉栏：选中类别即弹出品种窗口
  $('#speciesSelect').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id) { openHandbook(id); e.target.value = ''; }
  });
  loadConversationList();
  $('#individualId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); loadIndividual(); }
  });
  $('#chatChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const q = chip.getAttribute('data-q');
    if (!q) return;
    input.value = q;
    autoResize(input);
    input.focus();
  });

  // 市场行情 / 真实知识库 / 记录患病
  $('#btnMarket').addEventListener('click', loadMarket);
  $('#btnRealKb').addEventListener('click', loadRealKb);
  $('#recordIllness').addEventListener('click', recordIllness);
  $('#marketClose').addEventListener('click', () => $('#marketModal').classList.remove('show'));
  $('#realKbClose').addEventListener('click', () => $('#realKbModal').classList.remove('show'));
  [$('#marketModal'), $('#realKbModal')].forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
  });
  // 放大 / 还原
  $('#realKbExpand').addEventListener('click', () => {
    const p = $('#realKbPanel');
    p.classList.toggle('expanded');
    $('#realKbExpand').textContent = p.classList.contains('expanded') ? '⛶ 还原' : '⛶ 放大';
  });
  $('#warningExpand').addEventListener('click', () => {
    const p = $('#warningPanel');
    p.classList.toggle('expanded');
    $('#warningExpand').textContent = p.classList.contains('expanded') ? '⛶ 还原' : '⛶ 放大';
  });
  $('#chartClose').addEventListener('click', () => $('#chartModal').classList.remove('show'));
  $('#chartModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
  // AI 预警放大弹窗
  $('#recogModalClose').addEventListener('click', () => $('#recogModal').classList.remove('show'));
  $('#recogModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
  // 预警记录
  $('#btnWarnings').addEventListener('click', loadWarnings);
  $('#warningClose').addEventListener('click', () => $('#warningModal').classList.remove('show'));
  $('#warningModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
  // 分析详情弹窗
  $('#analysisClose').addEventListener('click', () => $('#analysisModal').classList.remove('show'));
  $('#analysisModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
  // 数据诊断分析每 10 分钟自动刷新
  setInterval(loadAnalysis, 600000);
  // 点击天气打开详情弹窗（可搜索城市）
  $('#statWeather').addEventListener('click', openWeather);
  $('#statWeatherLabel').addEventListener('click', openWeather);
  $('#weatherClose').addEventListener('click', () => $('#weatherModal').classList.remove('show'));
  $('#weatherModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
  $('#weatherSearch').addEventListener('click', searchWeather);
  $('#weatherCity').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchWeather(); });
});

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    agentConnected = Boolean(data.agentConnected);
    const badge = $('#agentBadge');
    badge.textContent = agentConnected ? '已接入' : '待接入';
    badge.classList.toggle('connected', agentConnected);
  } catch (e) { console.error(e); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
