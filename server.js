'use strict';

/**
 * 养殖环境实时监测系统 —— 后端服务
 *
 * 功能：
 *  1. 接收 ESP32 通过 POST 发送的环境数据（JSON），并自动按设备分隔存储
 *  2. 提供 REST 接口查询设备数据
 *  3. 通过 SSE（Server-Sent Events）实时推送数据到网页状态栏
 *  4. 预留 /api/chat 智能体接口（可转发到你自己的智能体）
 *  5. 数据持久化到本地 JSON 文件
 *
 * 无第三方依赖，纯 Node.js 内置模块实现。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// 配置
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('[启动] 读取 config.json 失败，使用默认配置：', e.message);
  config = {};
}

const PORT = Number(process.env.PORT) || config.port || 3000;
const HOST = process.env.HOST || config.host || '0.0.0.0';
const DATA_DIR = path.join(ROOT, config.dataDir || 'data');
const DATA_FILE = path.join(DATA_DIR, 'devices.json');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
const ILLNESS_FILE = path.join(DATA_DIR, 'illness.json');
const ILLNESS_DIR = path.join(DATA_DIR, 'illness');
const WARNING_DIR = path.join(DATA_DIR, 'warnings');
const HISTORY_LIMIT = Number(config.historyLimit) || 500;
const OFFLINE_AFTER_MS = Number(config.offlineAfterMs) || 120000;
// 单个指标多久没更新算失效。传感器偶发读失败时保留上一次的值，超过这个时间才丢弃
const STALE_AFTER_MS = Number(config.staleAfterMs) || 30000;
const THRESHOLDS = config.thresholds || {};
// 智能体配置：环境变量优先，便于部署时不把密钥写入配置文件
const AGENT = Object.assign({}, config.agent || {}, {
  apiKey: process.env.COZE_API_KEY || (config.agent && config.agent.apiKey) || '',
  botId: process.env.COZE_BOT_ID || (config.agent && config.agent.botId) || ''
});
const SPECIES = require('./species');   // 家禽家畜物种知识库
const MARKET = require('./market');     // 市场行情模块
const AUTH = config.auth || { username: '1', password: '1' };

// 物种未单独定义时使用的通用正常范围（CO2 / 土壤 / 饲料槽）
const DEFAULT_NORMAL = {
  co2: { min: 0, max: 2500, unit: 'ppm' },
  soil: { min: 20, max: 100, unit: '%' },
  feed_level: { min: 0, max: 20, unit: '%' }
};

function normalFor(speciesName, key) {
  const sp = SPECIES.find((s) => s.name === speciesName);
  return (sp && sp.normal && sp.normal[key]) || DEFAULT_NORMAL[key] || null;
}

// 状态存储
// devices: { [deviceId]: { id, name, lastSeen, latest, history[], meta } }
let devices = new Map();
let sseClients = new Set();
// cameraFrames: deviceId -> { buf: Buffer, ts: number }  最新摄像头画面
let cameraFrames = new Map();
// 识别节流：deviceId -> 上次识别时间戳
let lastRecognize = new Map();
// 个体对话档案：个体编号 -> [{role, content, ts}]
let conversations = new Map();

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 从磁盘恢复数据
function loadDevices() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const [id, d] of Object.entries(raw)) {
        devices.set(id, d);
      }
      console.log(`[启动] 已从磁盘恢复 ${devices.size} 台设备数据`);
    }
  } catch (e) {
    console.error('[启动] 恢复设备数据失败：', e.message);
  }
}

// 个体对话档案：加载/保存
function loadConversations() {
  try {
    if (fs.existsSync(CONV_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
      for (const [id, list] of Object.entries(raw)) {
        if (Array.isArray(list)) conversations.set(id, list);
      }
      console.log(`[启动] 已恢复 ${conversations.size} 个个体对话档案`);
    }
  } catch (e) {
    console.error('[启动] 恢复对话档案失败：', e.message);
  }
}

let convSaveTimer = null;
function saveConversations() {
  if (convSaveTimer) return;
  convSaveTimer = setTimeout(() => {
    convSaveTimer = null;
    try {
      fs.writeFileSync(CONV_FILE, JSON.stringify(Object.fromEntries(conversations), null, 2), 'utf8');
    } catch (e) {
      console.error('[会话] 写入失败：', e.message);
    }
  }, 300);
}

// 会话元数据：id -> { name, bound, deviceId }
const CONV_META_FILE = path.join(DATA_DIR, 'conversation-meta.json');
let conversationMeta = new Map();

function loadConversationMeta() {
  try {
    if (fs.existsSync(CONV_META_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONV_META_FILE, 'utf8'));
      for (const [id, m] of Object.entries(raw)) conversationMeta.set(id, m);
    }
  } catch (e) { console.error('[会话] 元数据加载失败：', e.message); }
}

function saveConversationMeta() {
  try { fs.writeFileSync(CONV_META_FILE, JSON.stringify(Object.fromEntries(conversationMeta), null, 2), 'utf8'); }
  catch (e) { console.error('[会话] 元数据保存失败：', e.message); }
}

// 每台有物种的设备自动生成一个绑定会话（名称 = 物种·阶段），另有一个主聊天
function ensureDeviceChats() {
  let changed = false;
  for (const d of devices.values()) {
    if (!d.meta || !d.meta.species) continue;
    const id = 'device:' + d.id;
    // 聊天名优先用用户给设备起的名字，其次用「物种 · 阶段」
    const fallback = d.meta.species + (d.meta.stage ? ' · ' + d.meta.stage : '');
    const name = (d.meta.nameSet && d.name) ? d.name : (d.name && d.name !== d.id ? d.name : fallback);
    if (!conversations.has(id)) { conversations.set(id, []); changed = true; }
    const m = conversationMeta.get(id) || {};
    if (m.name !== name || m.bound !== true || m.deviceId !== d.id) {
      conversationMeta.set(id, { name, bound: true, deviceId: d.id });
      changed = true;
    }
  }
  if (!conversations.has('main')) { conversations.set('main', []); changed = true; }
  const mm = conversationMeta.get('main');
  if (!mm || (!mm.nameSet && mm.name !== '主对话')) {
    conversationMeta.set('main', Object.assign({ bound: false, deviceId: '' }, mm || {}, { name: '主对话' }));
    changed = true;
  }
  if (changed) { saveConversations(); saveConversationMeta(); }
}

// 患病记录（本地文本 + 真实知识库）
let illnessRecords = [];

function loadIllness() {
  try {
    if (fs.existsSync(ILLNESS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ILLNESS_FILE, 'utf8'));
      if (Array.isArray(raw)) illnessRecords = raw;
    }
  } catch (e) { console.error('[患病] 加载失败：', e.message); }
  if (!fs.existsSync(ILLNESS_DIR)) fs.mkdirSync(ILLNESS_DIR, { recursive: true });
}

function saveIllness() {
  try { fs.writeFileSync(ILLNESS_FILE, JSON.stringify(illnessRecords, null, 2), 'utf8'); }
  catch (e) { console.error('[患病] 保存失败：', e.message); }
}

// 查询记录：每次 AI 诊断/预警时，把当时的真实环境数据一并存下来，作为本地知识库的来源
const QUERY_FILE = path.join(DATA_DIR, 'queries.json');
let queryRecords = [];

function loadQueries() {
  try {
    if (fs.existsSync(QUERY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUERY_FILE, 'utf8'));
      if (Array.isArray(raw)) queryRecords = raw;
    }
  } catch (e) { console.error('[查询] 加载失败：', e.message); }
}

function saveQueries() {
  try { fs.writeFileSync(QUERY_FILE, JSON.stringify(queryRecords.slice(-1000), null, 2), 'utf8'); }
  catch (e) { console.error('[查询] 保存失败：', e.message); }
}

// 取设备当前环境快照（用于写进查询记录）
function snapshotEnv(device) {
  let d = device;
  if (!d) {
    d = [...devices.values()].find((x) => x.latest && Object.keys(x.latest).length > 1);
  }
  if (!d || !d.latest) return {};
  const out = {};
  for (const [k, v] of Object.entries(d.latest)) {
    if (k === 'time') continue;
    out[k] = v;
  }
  return out;
}

function recordQuery(rec) {
  const r = {
    id: 'q-' + now(),
    ts: now(),
    time: isoTime(now()),
    deviceId: String(rec.deviceId || '').trim(),
    deviceName: String(rec.deviceName || '').trim(),
    species: String(rec.species || '').trim(),
    stage: String(rec.stage || '').trim(),
    question: String(rec.question || '').slice(0, 300),
    answer: String(rec.answer || '').slice(0, 800),
    env: rec.env || {}
  };
  queryRecords.push(r);
  if (queryRecords.length > 1000) queryRecords.shift();
  saveQueries();
  return r;
}

// 把一个聊天档案里的问答整理后写入本地知识库，返回条数
function archiveConversation(id) {
  const msgs = conversations.get(id) || [];
  const meta = conversationMeta.get(id) || {};
  const dev = meta.deviceId ? devices.get(meta.deviceId) : null;
  const env = snapshotEnv(dev || null);
  const species = (dev && dev.meta && dev.meta.species) || '';
  const stage = (dev && dev.meta && dev.meta.stage) || '';
  const who = meta.name || id;
  let count = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    let answer = '';
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'assistant') { answer = msgs[j].content || ''; break; }
    }
    const q = String(m.content || '').trim();
    if (!q) continue;
    // 聊天时已经记过的，不重复写入
    if (queryRecords.some((r) => r.question === q && r.deviceName === who)) continue;
    recordQuery({
      deviceId: (dev && dev.id) || '',
      deviceName: who,
      species,
      stage,
      question: q,
      answer,
      env
    });
    count++;
  }
  return count;
}

// ───── 扣子知识库同步：把当天的新记录整理成文档推到扣子 ─────
async function uploadKbDocument(name, text, separator) {
  const kb = config.knowledgeBase || {};
  if (!kb.dataset_id) throw new Error('未配置知识库 ID');
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  // 有分隔符时按分隔符切段（每条记录一段，检索更准），否则自动分段
  const chunkStrategy = separator
    ? { chunk_type: 1, separator, max_tokens: 800, remove_extra_spaces: false, remove_urls_emails: false }
    : { chunk_type: 0 };
  const resp = await fetch('https://api.coze.cn/open_api/knowledge/document/create', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + (AGENT.apiKey || ''),
      'Content-Type': 'application/json',
      'Agw-Js-Conv': 'str'          // 不加这个头会返回 400
    },
    body: JSON.stringify({
      dataset_id: String(kb.dataset_id),
      document_bases: [{ name, source_info: { file_base64: b64, file_type: 'txt' } }],
      chunk_strategy: chunkStrategy
    })
  });
  const data = await resp.json();
  if (!data || data.code !== 0) throw new Error((data && data.msg) || '上传失败');
  return (data.document_infos && data.document_infos[0]) || null;
}

let kbSyncedDate = '';
let kbSyncing = false;
async function syncKnowledgeBase() {
  const kb = config.knowledgeBase || {};
  if (!kb.dataset_id || !kb.auto) return 0;
  if (kbSyncing) return 0;          // 防止并发重复上传
  const today = new Date().toISOString().slice(0, 10);
  if (kbSyncedDate === today) return 0;
  const recs = queryRecords.filter((r) => String(r.time || '').startsWith(today));
  if (!recs.length) return 0;

  kbSyncing = true;
  try {
    const lines = ['# 养殖场病例记录 ' + today, ''];
    // 目录：方便检索时定位
    lines.push('## 记录目录');
    recs.forEach((r, i) => {
      lines.push((i + 1) + '. ' + (r.time || '') + ' ' + (r.species || '') +
        (r.stage ? '（' + r.stage + '）' : '') + ' ' + (r.deviceName || ''));
    });
    lines.push('');

    // 每条记录用 ===== 分隔（上传时按这个切段，检索更精准）
    recs.forEach((r, i) => {
      const e = r.env || {};
      const env = [];
      if (e.temperature !== undefined) env.push('温度 ' + e.temperature + '°C');
      if (e.humidity !== undefined) env.push('湿度 ' + e.humidity + '%');
      if (e.co2 !== undefined) env.push('CO2 ' + e.co2 + 'ppm');
      if (e.ammonia !== undefined) env.push('氨气 ' + e.ammonia + 'ppm');
      lines.push('=====');
      lines.push('## 记录 ' + (i + 1));
      lines.push('时间：' + (r.time || ''));
      lines.push('物种：' + (r.species || '未填写') + (r.stage ? '（' + r.stage + '）' : ''));
      lines.push('设备：' + (r.deviceName || '未填写'));
      lines.push('环境：' + (env.join('，') || '无环境数据'));
      lines.push('问题：' + (r.question || ''));
      lines.push('结论：' + (r.answer || ''));
      lines.push('');
    });

    await uploadKbDocument('病例_' + today + '.txt', lines.join('\n'), '=====');
    kbSyncedDate = today;
    console.log('[知识库] 已同步 ' + recs.length + ' 条记录到扣子');
    return recs.length;
  } finally {
    kbSyncing = false;
  }
}

function recordIllness(body) {
  const b = body || {};
  const deviceId = String(b.deviceId || '').trim();
  const dev = deviceId ? devices.get(deviceId) : null;
  const latest = (dev && dev.latest) || {};
  const ts = now();
  const rec = {
    id: 'ill-' + ts,
    ts,
    time: isoTime(ts),
    individualId: String(b.individualId || '').trim(),
    deviceId,
    deviceName: (dev && dev.name) || '',
    species: (dev && dev.meta && dev.meta.species) || String(b.species || ''),
    disease: String(b.disease || '').trim(),
    symptoms: String(b.symptoms || '').trim(),
    note: String(b.note || '').trim(),
    env: {
      temperature: latest.temperature,
      humidity: latest.humidity,
      co2: latest.co2,
      ammonia: latest.ammonia,
      light: latest.light,
      soil: latest.soil,
      flame: latest.flame
    }
  };
  illnessRecords.push(rec);
  if (illnessRecords.length > 2000) illnessRecords.shift();
  saveIllness();

  // 每个事件写一个本地文本文件
  const safeName = (rec.individualId || rec.deviceId || 'record').replace(/[\\/:*?"<>|]/g, '_');
  const fname = new Date(ts).toISOString().replace(/[:.]/g, '-') + '_' + safeName + '.txt';
  const lines = [
    '患病记录',
    '============================================',
    '时间：' + rec.time,
    '个体档案：' + (rec.individualId || '未填写'),
    '设备：' + (rec.deviceName || rec.deviceId || '未关联'),
    '物种：' + (rec.species || '未知'),
    '患病类型：' + (rec.disease || '未填写'),
    '症状：' + (rec.symptoms || '未填写'),
    '备注：' + (rec.note || '无'),
    '',
    '【患病时的环境数据】',
    ...Object.entries(rec.env).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => '  ' + k + '：' + v),
    ''
  ];
  try { fs.writeFileSync(path.join(ILLNESS_DIR, fname), lines.join('\n'), 'utf8'); }
  catch (e) { console.error('[患病] 文本写入失败：', e.message); }
  return rec;
}

function listIllness() {
  return illnessRecords.slice(-300).reverse();
}

function buildRealKnowledge() {
  const byDisease = {};
  for (const r of illnessRecords) {
    const d = r.disease || '未分类';
    if (!byDisease[d]) byDisease[d] = { disease: d, count: 0, temp: [], hum: [], co2: [], symptoms: {}, species: {} };
    const g = byDisease[d];
    g.count++;
    if (r.env && r.env.temperature !== undefined) g.temp.push(Number(r.env.temperature));
    if (r.env && r.env.humidity !== undefined) g.hum.push(Number(r.env.humidity));
    if (r.env && r.env.co2 !== undefined) g.co2.push(Number(r.env.co2));
    if (r.symptoms) g.symptoms[r.symptoms] = (g.symptoms[r.symptoms] || 0) + 1;
    if (r.species) g.species[r.species] = (g.species[r.species] || 0) + 1;
  }
  const avg = (arr) => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  const parameters = Object.values(byDisease).map((g) => ({
    disease: g.disease,
    count: g.count,
    avgTemperature: avg(g.temp),
    avgHumidity: avg(g.hum),
    avgCo2: avg(g.co2),
    symptoms: Object.entries(g.symptoms).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ symptom: k, count: v })),
    species: Object.entries(g.species).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, count: v }))
  }));
  return {
    total: illnessRecords.length,
    parameters,
    records: listIllness(),
    queries: queryRecords.slice(-50).reverse(),
    queryTotal: queryRecords.length
  };
}

// 按问题关键词挑相关历史记录（物种 / 设备 / 日期），保证问到什么就带什么
function pickRelevantQueries(message, limit) {
  const text = String(message || '');
  const all = queryRecords.slice().reverse();          // 最近的在前
  if (!all.length) return [];

  const speciesHit = SPECIES.filter((s) => s.name && text.includes(s.name)).map((s) => s.name);
  const deviceHit = [...devices.values()]
    .filter((d) => d.name && d.name.length >= 2 && text.includes(d.name))
    .map((d) => d.name);

  // 日期：2026-11-02 或 11月2日 / 11-02
  const dates = [];
  let m;
  const re1 = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
  while ((m = re1.exec(text))) dates.push(m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'));
  const re2 = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  while ((m = re2.exec(text))) dates.push('-MM-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0'));

  const matched = all.filter((r) => {
    if (speciesHit.length && !speciesHit.includes(r.species)) return false;
    if (deviceHit.length && !deviceHit.includes(r.deviceName)) return false;
    if (dates.length) {
      const t = String(r.time || '');
      const ok = dates.some((d) => (d.startsWith('-MM-') ? t.slice(5, 10) === d.slice(4) : t.startsWith(d)));
      if (!ok) return false;
    }
    return true;
  });

  // 命中就用命中的，没命中退回最近的
  const list = matched.length ? matched : all;
  return list.slice(0, limit || 8);
}

function buildRealKnowledgeContext(message) {
  const rk = buildRealKnowledge();
  const lines = [];
  for (const p of rk.parameters.slice(0, 8)) {
    const env = [];
    if (p.avgTemperature !== null) env.push('平均温度 ' + p.avgTemperature + '°C');
    if (p.avgHumidity !== null) env.push('平均湿度 ' + p.avgHumidity + '%');
    if (p.avgCo2 !== null) env.push('平均CO2 ' + p.avgCo2 + 'ppm');
    const sym = (p.symptoms || []).slice(0, 3).map((s) => s.symptom).join('、');
    const spi = (p.species || []).map((s) => s.name).join('、');
    lines.push('· ' + p.disease + '：本场记录 ' + p.count + ' 次' +
      (spi ? '；发病物种 ' + spi : '') +
      (sym ? '；主要症状 ' + sym : '') +
      '；' + (env.join('，') || '无环境数据'));
  }
  if (rk.queries && rk.queries.length) {
    const picked = pickRelevantQueries(message, 8);
    lines.push('· 相关历史查询记录（含当时的真实环境）：');
    for (const q of picked) {
      const e = q.env || {};
      const env = [];
      if (e.temperature !== undefined) env.push('温度 ' + e.temperature + '°C');
      if (e.humidity !== undefined) env.push('湿度 ' + e.humidity + '%');
      if (e.co2 !== undefined) env.push('CO2 ' + e.co2 + 'ppm');
      if (e.ammonia !== undefined) env.push('氨气 ' + e.ammonia + 'ppm');
      const who = q.species || q.deviceName || q.deviceId || '查询';
      lines.push('  - ' + String(q.time || '').slice(0, 16).replace('T', ' ') +
        ' ' + who + (q.stage ? '（' + q.stage + '）' : '') +
        '：' + (env.join('，') || '无环境数据') +
        '；问题：' + String(q.question || '').slice(0, 60) +
        '；结论：' + String(q.answer || '').replace(/\s+/g, ' ').slice(0, 120));
    }
  }
  if (!lines.length) return '';
  return '【本场真实知识库（历史病例 + 查询记录，最高优先级）】\n' + lines.join('\n') +
    '\n· 以上均为本场实际发生的记录，判断时必须优先参考。';
}

// 环境指标中文名（用于生成偏离说明）
const METRIC_LABELS = {
  temperature: '温度', humidity: '湿度', ammonia: '氨气', co2: '二氧化碳', h2s: '硫化氢',
  light: '光照', soil: '土壤湿度', water: '水位', flame: '火焰', wind: '风速',
  pressure: '气压', rain: '降雨量', pm25: 'PM2.5', noise: '噪声', o2: '氧气',
  soil_temp: '土壤温度', feed_level: '饲料槽余量', feed_weight: '饲料槽重量',
  camera_count: '画面数量'
};

// 对比该物种/阶段正常范围，列出当前偏离的指标
function envAnomalies(device) {
  const summary = deviceSummary(device);
  const normal = summary.normal || {};
  const out = [];
  for (const [k, m] of Object.entries(summary.metrics || {})) {
    const n = normal[k] || THRESHOLDS[k];
    if (!n) continue;
    if (m.value < n.min || m.value > n.max) {
      out.push({
        key: k,
        label: METRIC_LABELS[k] || k,
        value: m.value,
        unit: n.unit || '',
        min: n.min,
        max: n.max,
        dir: m.value < n.min ? '偏低' : '偏高'
      });
    }
  }
  return out;
}

// ───── 候选病种：从回答里识别病名，生成确认卡片（图片 + 真实症状图链接） ─────
function diseaseCard(name, symptoms, speciesName) {
  const sym = String(symptoms || '').replace(/\s+/g, ' ');
  const short = sym.slice(0, 24);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="150">' +
    '<rect width="220" height="150" rx="14" fill="#fdf3e7" stroke="#ecdfc9"/>' +
    '<rect x="18" y="18" width="184" height="34" rx="8" fill="#fbe0c8"/>' +
    '<text x="110" y="41" font-size="15" text-anchor="middle" fill="#b45309">' + escapeXml(String(name).slice(0, 10)) + '</text>' +
    '<text x="110" y="72" font-size="11" text-anchor="middle" fill="#8a7a66">典型症状</text>' +
    '<text x="110" y="94" font-size="10" text-anchor="middle" fill="#6b3d1f">' + escapeXml(short) + '</text>' +
    '<text x="110" y="126" font-size="10" text-anchor="middle" fill="#2f9e5b">点击查看真实症状图</text>' +
    '</svg>';
  return {
    name,
    symptoms: sym,
    image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    searchUrl: 'https://www.bing.com/images/search?q=' +
      encodeURIComponent((speciesName || '') + ' ' + name + ' 症状')
  };
}

// 在回答中匹配该物种的常见病，最多 3 个
function extractCandidates(content, speciesName) {
  const text = String(content || '');
  const sp = SPECIES.find((s) => s.name === speciesName);
  if (!sp || !Array.isArray(sp.diseases)) return [];
  const out = [];
  for (const d of sp.diseases) {
    if (d && d.name && text.includes(d.name)) {
      out.push(diseaseCard(d.name, d.symptoms, speciesName));
    }
  }
  return out.slice(0, 3);
}

// 从回答中提取【推荐药品】段落，生成图片与购买链接
function extractDrugs(content) {
  const text = String(content || '');
  // 兼容「【推荐药品】」「### 推荐药品」「**推荐药品**」等写法
  const head = text.match(/(?:【推荐药品】|#{1,6}\s*推荐药品|推荐药品\s*[:：]|推荐药品)/);
  if (!head) return [];
  const section = text.slice(head.index + head[0].length).split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const line of section) {
    if (/^#{1,6}\s/.test(line) || /^【/.test(line)) break;   // 到下一个标题就停
    if (/^(提醒|注意|以上|请|如|若)/.test(line) && !/^[-·*•]/.test(line)) continue;
    const m = line.match(/^[-·*•]?\s*([^：:]{2,20})[：:]\s*(.+)$/);
    if (!m) continue;
    const name = m[1].replace(/^[-·*•\s]+/, '').replace(/\*\*/g, '').trim();
    if (!name || name.length > 20) continue;
    if (out.some((x) => x.name === name)) continue;
    out.push(drugItem(name, m[2].trim()));
  }
  return out.slice(0, 6);
}

function drugItem(name, note) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">' +
    '<rect width="120" height="120" rx="16" fill="#fde8d4"/>' +
    '<rect x="44" y="26" width="32" height="44" rx="10" fill="#e0762e" opacity="0.18"/>' +
    '<rect x="52" y="34" width="16" height="28" rx="8" fill="#e0762e"/>' +
    '<text x="60" y="92" font-size="12" text-anchor="middle" fill="#6b3d1f">' + escapeXml(String(name).slice(0, 8)) + '</text>' +
    '</svg>';
  return {
    name,
    note,
    image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    link: 'https://s.taobao.com/search?q=' + encodeURIComponent(name + ' 兽药')
  };
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 健康预警：优先依据实时环境数据，再结合本场记录与物种通用知识
function buildHealthPrompt(device) {
  const summary = deviceSummary(device);
  const sp = SPECIES.find((s) => s.name === summary.meta.species);
  const latest = device.latest || {};
  const env = [];
  if (latest.temperature !== undefined) env.push('温度 ' + latest.temperature + '°C');
  if (latest.humidity !== undefined) env.push('湿度 ' + latest.humidity + '%');
  if (latest.co2 !== undefined) env.push('二氧化碳 ' + latest.co2 + 'ppm');
  if (latest.ammonia !== undefined) env.push('氨气 ' + latest.ammonia + 'ppm');
  if (latest.light !== undefined) env.push('光照 ' + latest.light + '%');
  if (latest.feed_level !== undefined) {
    const fd = Number(summary.feed.daily) || 0;
    env.push('饲料槽余量 ' + latest.feed_level + '%' +
      (fd > 0 ? '（每日投喂 ' + fd + 'kg，约剩 ' + summary.feed.weight + 'kg）' : '') +
      (Number(latest.feed_level) > 20 ? '，剩料偏多，提示采食不足' : '，采食正常'));
  }
  if (latest.camera_count !== undefined) env.push('摄像头识别数量 ' + latest.camera_count + ' 只');
  if (device.meta && device.meta.camera_status) {
    env.push('画面识别：' + String(device.meta.camera_status).replace(/\s+/g, ' ').slice(0, 140));
  }
  const dinfo = densityInfo(device);
  if (dinfo.actual != null) env.push('种群密度 ' + dinfo.actual + ' 只/㎡');

  const anomalies = envAnomalies(device);
  const anomalyText = anomalies.length
    ? anomalies.map((a) => a.label + ' ' + a.value + a.unit + '（正常 ' + a.min + '~' + a.max + a.unit + '，' + a.dir + '）').join('；')
    : '各项指标均在正常范围内';

  const diseases = ((sp && sp.diseases) || [])
    .map((d) => '- ' + d.name + '：症状 ' + d.symptoms + '；诱因 ' + d.factors)
    .join('\n');
  const real = buildRealKnowledgeContext('');

  // 画面识别状态：成功识别则结合画面，未识别则明确告知用户后仅用数据判断
  const camStatus = (device.meta && device.meta.camera_status) || '';
  const camCount = latest.camera_count;
  const camOk = !!(camStatus || camCount !== undefined);
  const camBlock = camOk
    ? '【画面识别（已获取到特征）】\n' +
      (camCount !== undefined
        ? '画面中识别到动物数量：' + camCount + ' 只\n'
        : '画面中动物数量：未识别（画面不清晰，不要猜测或编造具体数字）\n') +
      (camStatus ? String(camStatus).replace(/\s+/g, ' ').slice(0, 300) : '') +
      '\n· 请把画面中的活动状态、异常表现与环境数据结合判断；数量未识别时不要写具体只数。'
    : '【画面识别】\n未检测到物体或物体状况（摄像头无画面或未完成识别）。\n' +
      '· 请在结论开头明确写出「因未检测到物体状况，本次判断仅基于环境数据、历史记录与通用知识」，然后再给出后续预警。';

  return [
    '【任务】你是养殖场智能预警助手。本系统的核心优势是实时环境监测，请【首先】基于下面的实时环境数据（尤其是超标项）分析病因与风险，再结合画面识别、本场历史记录与物种通用知识。',
    '画面识别结果必须作为判断依据之一：识别到动物时，必须说明画面中的数量与活动状态；未识别到时，必须说明这一点后再给出判断。',
    '',
    '【实时环境数据（核心依据，优先分析）】',
    env.join('，') || '暂无数据',
    '【指标偏离情况】' + anomalyText,
    '',
    camBlock,
    '',
    real || '【本场真实知识库】暂无历史记录。',
    '',
    '【个体状态】',
    '物种：' + (summary.meta.species || '未知'),
    '成长阶段：' + (summary.meta.stage || '未填写'),
    '体重：' + (summary.meta.weight ? summary.meta.weight + ' kg' : '未填写'),
    '数量：' + (summary.meta.count || '未知') + ' 只/头',
    '面积：' + (summary.meta.area || '未知') + ' ㎡',
    '',
    '【该物种常见疫病与诱因（通用知识）】',
    diseases || '暂无',
    '',
    '【判断规则】1. 优先分析环境超标项与疾病的因果关系，这是本系统最可靠的依据；2. 其次参考本场历史记录；3. 最后参考通用知识。冲突时说明差异。',
    '',
    '【输出要求】请务必详细、分点展开，不要只写一两句。',
    '一、总体风险判断：给出风险等级（低/中/高），明确指出由哪几项环境指标驱动，并说明画面识别结果（动物数量、活动状态）是否支持该判断；若未识别到画面，先说明「因未检测到物体状况，本次判断仅基于环境数据与历史记录」。',
    '二、可能疾病清单：按可能性从高到低排列，每种疾病给出：可能性（百分比）、判断依据（重点写环境数据、成长阶段、体重、病前征兆）。',
    '三、防治方案：针对每种疾病，分三个阶段详细给出：',
    '  【病前预防】环境管理（温湿度/通风/密度/光照）、免疫程序、消毒制度、饲料营养、日常观察要点；',
    '  【病中处置】隔离观察、对症治疗、用药方向（注明需兽医确认）、环境调整、防止扩散；',
    '  【病后恢复】彻底消毒、康复期营养、复检与观察、防复发措施、记录归档。',
    '四、若判断需要用药，请在最后单独输出一段：',
    '  【推荐药品】',
    '  - 药品名：用途与用法简述',
    '  （每种药一行，只写确实需要的药）',
    '五、若信息不足，请说明还需要补充哪些数据，不要编造。'
  ].join('\n');
}

// 保存 AI 预警结论为本地文本（每个文件记录设备与时间）
function saveWarning(dev, content) {
  try {
    if (!fs.existsSync(WARNING_DIR)) fs.mkdirSync(WARNING_DIR, { recursive: true });
    const ts = now();
    const deviceLabel = (dev.name || dev.id || 'device').replace(/[\\/:*?"<>|]/g, '_');
    const fname = new Date(ts).toISOString().replace(/[:.]/g, '-') + '_' + deviceLabel + '.txt';
    const lines = [
      'AI 健康预警记录',
      '============================================',
      '设备名称：' + (dev.name || ''),
      '设备 ID：' + (dev.id || ''),
      '物种：' + ((dev.meta && dev.meta.species) || '未知'),
      '成长阶段：' + ((dev.meta && dev.meta.stage) || '未填写'),
      '体重：' + ((dev.meta && dev.meta.weight) ? dev.meta.weight + ' kg' : '未填写'),
      '记录时间：' + isoTime(ts),
      '',
      '【预警结论】',
      String(content || ''),
      ''
    ];
    fs.writeFileSync(path.join(WARNING_DIR, fname), lines.join('\n'), 'utf8');
    return fname;
  } catch (e) {
    console.error('[预警] 写入失败：', e.message);
    return null;
  }
}

// 持久化（节流：最多每秒写一次）
let saveTimer = null;
let dirty = false;
function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(devices), null, 2), 'utf8');
    } catch (e) {
      console.error('[持久化] 写入失败：', e.message);
    }
  }, 1000);
}

// 工具函数
function now() {
  return Date.now();
}

function isoTime(ts) {
  return new Date(ts).toISOString();
}

// 从 IP 生成默认设备名（形如 esp32-192.168.1.5）
function deviceNameFromIp(ip) {
  return ip ? 'esp32-' + ip.replace(/[^0-9a-zA-Z]/g, '-') : 'esp32-unknown';
}

// 解析请求 URL。用 WHATWG URL 而不是已弃用的 url.parse，
// query 仍摊平成普通对象，调用方照旧写 parsed.query.city
function parseUrl(req) {
  const host = req.headers.host || 'localhost';
  const u = new URL(req.url, 'http://' + host);
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  return { pathname: u.pathname, query, searchParams: u.searchParams };
}

// 解析设备 ID：优先 URL 路径 > 查询参数 > JSON body > 客户端 IP
function resolveDeviceId(req, body) {
  const parsed = parseUrl(req);
  const q = parsed.query || {};

  // 1) URL 路径 /api/data/:deviceId
  const m = parsed.pathname.match(/^\/api\/data\/([^/]+)$/);
  if (m && m[1] && m[1].trim()) return decodeURIComponent(m[1].trim());

  // 2) 查询参数
  const qKey = q.device || q.device_id || q.deviceId || q.id;
  if (qKey) return String(qKey).trim();

  // 3) JSON body 字段
  if (body && typeof body === 'object') {
    const bKey = body.device_id || body.deviceId || body.device || body.id || body.mac || body.esp_id;
    if (bKey) return String(bKey).trim();
  }

  // 4) 回退：客户端 IP
  const ip = getClientIp(req);
  return deviceNameFromIp(ip);
}

// 解析设备自定义名称
function resolveDeviceName(body) {
  if (body && typeof body === 'object') {
    const n = body.name || body.device_name || body.alias;
    if (n && String(n).trim()) return String(n).trim();
  }
  return null;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// 判断字段是否为数值
function isNumeric(v) {
  return typeof v === 'number' && isFinite(v);
}

// 提取环境指标（温度、湿度，以及其它数值字段）
function extractMetrics(body) {
  const metrics = {};
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      if (isNumeric(v) && !['id', 'device_id', 'deviceId', 'mac', 'timestamp', 'ts', 'time', 'rssi'].includes(k)) {
        metrics[k] = v;
      }
    }
  }
  return metrics;
}

// 判断某个指标是否越限
function evaluateMetric(key, value) {
  const t = THRESHOLDS[key];
  if (!t) return 'normal';
  if (value < t.min) return 'low';
  if (value > t.max) return 'high';
  return 'normal';
}

// 数据写入
function upsertDevice(deviceId, name, body, ip) {
  const ts = now();
  let device = devices.get(deviceId);
  if (!device) {
    device = {
      id: deviceId,
      name: deviceId,
      createdAt: ts,
      lastSeen: ts,
      ip: ip || '',
      latest: {},
      history: [],
      meta: {}
    };
    devices.set(deviceId, device);
  }

  device.lastSeen = ts;
  if (ip) device.ip = ip;
  // 设备名称由用户在「编辑设备」中填写，不采用 ESP32 上报的 name

  // 记录设备元数据（物种/数目/面积/自定义阈值）
  if (body && typeof body === 'object') {
    for (const key of ['min_temperature', 'max_temperature', 'min_humidity', 'max_humidity']) {
      if (isNumeric(body[key])) device.meta[key] = body[key];
    }
    if (body.species != null && String(body.species).trim()) device.meta.species = String(body.species).trim();
    if (body.count != null && !isNaN(Number(body.count))) device.meta.count = Number(body.count);
    if (body.area != null && !isNaN(Number(body.area))) device.meta.area = Number(body.area);
    if (body.stage != null && String(body.stage).trim()) device.meta.stage = String(body.stage).trim();
    if (body.weight != null && !isNaN(Number(body.weight))) device.meta.weight = Number(body.weight);
    if (body.local_ip != null && String(body.local_ip).trim()) device.meta.local_ip = String(body.local_ip).trim();
    if (body.stream_port != null) device.meta.stream_port = Number(body.stream_port) || 81;
  }

  const metrics = extractMetrics(body);
  const latest = { time: ts, ...metrics };
  // 传感器偶发失败时，payload 里会直接缺这个字段（例如 DHT11 读失败就不带温湿度）。
  // 如果整条替换 latest，页面上对应卡片就会一会儿有一会儿没有。
  // 这里沿用上一刻的值，配合 deviceSummary 里的超时判定，
  // 短暂失败保留旧值，真的失效了才让指标消失。
  if (device.latest) {
    for (const [k, v] of Object.entries(device.latest)) {
      if (k === 'time') continue;
      if (latest[k] === undefined) latest[k] = v;
    }
  }
  device.fieldSeen = device.fieldSeen || {};
  for (const k of Object.keys(metrics)) device.fieldSeen[k] = ts;
  // 摄像头数量来自 AI 识别，单独记时，避免按传感器超时把它清掉
  if (device.latest && device.latest.camera_count !== undefined && metrics.camera_count === undefined) {
    if (!device.fieldSeen.camera_count) device.fieldSeen.camera_count = ts;
  }

  device.latest = latest;
  device.history.push(latest);
  if (device.history.length > HISTORY_LIMIT) {
    device.history.splice(0, device.history.length - HISTORY_LIMIT);
  }

  markDirty();
  return device;
}

// 广播到所有 SSE 客户端
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      // 忽略写入失败，客户端断开时由 close 清理
    }
  }
}

// 组装返回给前端/接口的设备摘要
// 种群密度：数量 / 面积，并与物种参考密度对比
function parseDensityRange(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*[~\-－—～]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { min: Number(m[1]), max: Number(m[2]) };
}

function computeDensity(device) {
  const count = Number(device.meta && device.meta.count) || 0;
  const area = Number(device.meta && device.meta.area) || 0;
  if (count > 0 && area > 0) return Number((count / area).toFixed(2));
  return null;
}

function densityInfo(device) {
  const sp = SPECIES.find((s) => s.name === (device.meta && device.meta.species));
  const actual = computeDensity(device);
  const ref = sp ? parseDensityRange(sp.density) : null;
  let status = 'unknown';
  if (actual != null && ref) {
    status = actual < ref.min ? 'low' : actual > ref.max ? 'high' : 'normal';
  }
  return { actual, ref, status, refText: (sp && sp.density) || '' };
}

// 成长阶段对适宜环境的影响（幼年需更暖、更湿；老年略偏暖）
function stageAdjustedNormal(speciesName, stage) {
  const sp = SPECIES.find((s) => s.name === speciesName);
  const base = Object.assign({}, DEFAULT_NORMAL, (sp && sp.normal) || {});
  const adj = { temperature: 0, humidity: 0, co2: 0, soil: 0, feed_level: 0 };
  if (stage === '幼年' || stage === '幼崽') { adj.temperature = 2; adj.humidity = 3; adj.co2 = -500; }
  else if (stage === '老年') { adj.temperature = 1; adj.co2 = -300; }
  const out = {};
  for (const [k, r] of Object.entries(base)) {
    out[k] = { min: Math.max(0, r.min + (adj[k] || 0)), max: r.max + (adj[k] || 0), unit: r.unit };
  }
  return out;
}

// 超标程度：轻微超出为 mild（黄），超出范围 20% 以上为 severe（红）
function severityOf(key, value, speciesName) {
  const sp = SPECIES.find((s) => s.name === speciesName);
  const norm = sp && sp.normal && sp.normal[key];
  const t = norm || THRESHOLDS[key];
  if (!t) return 'normal';
  const range = (t.max - t.min) || 1;
  let over = 0;
  if (value < t.min) over = (t.min - value) / range;
  else if (value > t.max) over = (value - t.max) / range;
  else return 'normal';
  return over >= 0.2 ? 'severe' : 'mild';
}

function deviceSummary(device) {
  const latest = device.latest || {};
  const metrics = {};
  const speciesName = (device.meta && device.meta.species) || '';
  const seen = device.fieldSeen || {};
  const tsNow = now();
  const online = tsNow - (device.lastSeen || 0) < OFFLINE_AFTER_MS;
  for (const [k, v] of Object.entries(latest)) {
    if (k === 'time') continue;
    // 只有设备在线时才按超时剔除指标：单个传感器短时失败时，
    // 旧值先留着（页面不闪）；真的停了超过 staleAfterMs 才消失。
    // 设备整体离线时保留最后一次读数，页面靠离线条区分，不能再把值抹掉。
    if (online && k !== 'camera_count') {
      const t = seen[k];
      if (t && tsNow - t > STALE_AFTER_MS) continue;
    }
    metrics[k] = { value: v, status: evaluateMetric(k, v), severity: severityOf(k, v, speciesName) };
    if (seen[k]) metrics[k].updatedAt = seen[k];
  }

  // online 已在上方计算

  // 饲料槽：传感器给槽内余量百分比，每日投喂量由用户填
  // 规则：次日剩余 ≤20% 说明吃干净了（正常）；>20% 说明采食不足
  const feedDaily = Number(device.meta && device.meta.feed_daily) || 0;
  const feedLevel = latest.feed_level !== undefined ? Number(latest.feed_level) : null;
  if (feedLevel !== null && metrics.feed_level) {
    const over = feedLevel > 20;
    metrics.feed_level.status = over ? 'high' : 'normal';
    metrics.feed_level.severity = over ? (feedLevel > 40 ? 'severe' : 'mild') : 'normal';
  }
  const feed = {
    daily: feedDaily,
    level: feedLevel,
    weight: (feedDaily > 0 && feedLevel !== null) ? Number(((feedDaily * feedLevel) / 100).toFixed(2)) : null,
    status: feedLevel === null ? 'unknown' : (feedLevel > 20 ? 'abnormal' : 'normal')
  };

  return {
    id: device.id,
    name: device.name,
    ip: device.ip || '',
    status: online ? 'online' : 'offline',
    lastSeen: device.lastSeen,
    lastSeenText: isoTime(device.lastSeen),
    createdAt: device.createdAt,
    metrics,
    feed,
    meta: {
      species: (device.meta && device.meta.species) || '',
      count: (device.meta && device.meta.count) || 0,
      area: (device.meta && device.meta.area) || 0,
      stage: (device.meta && device.meta.stage) || '',
      weight: (device.meta && device.meta.weight) || 0,
      feed_daily: feedDaily,
      camera_status: (device.meta && device.meta.camera_status) || '',
      camera_time: (device.meta && device.meta.camera_time) || '',
      local_ip: (device.meta && device.meta.local_ip) || '',
      stream_port: (device.meta && device.meta.stream_port) || 81
    },
    normal: stageAdjustedNormal((device.meta && device.meta.species) || '', (device.meta && device.meta.stage) || ''),
    density: densityInfo(device),
    history: (device.history || []).slice(-200)
  };
}

// 静态文件
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: '资源不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(data);
  });
}

// HTTP 响应
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    const MAX = 20 * 1024 * 1024; // 20MB（支持图片上传）
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error('JSON 解析失败：' + e.message);
    err.status = 400;
    throw err;
  }
}

// 天气（Open-Meteo 免费接口）：高低温、湿度、风速风向、阵风、降水、云量、气压、紫外线
const WMO_DESC = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹'
};

const WIND_DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
function windDirName(deg) {
  if (deg === undefined || deg === null) return '';
  return WIND_DIRS[Math.round(Number(deg) / 45) % 8] + '风';
}

// 极端天气提示（供数据分析与 AI 预警参考）
function weatherRisks(w) {
  const risks = [];
  const code = Number(w.code);
  const wind = Number(w.wind) || 0;
  const temp = Number(w.temperature);
  if (code >= 95) risks.push('雷暴');
  if (code >= 80) risks.push('强降水');
  if (code >= 71 && code <= 77) risks.push('降雪');
  if (wind >= 10.8) risks.push('大风（可能破坏棚舍）');
  else if (wind >= 8) risks.push('风力较大');
  if (!isNaN(temp) && temp <= 0) risks.push('低温冰冻');
  if (!isNaN(temp) && temp >= 35) risks.push('高温热应激');
  return risks;
}

// AQI 等级（US AQI）
function aqiLevel(v) {
  if (v === undefined || v === null) return '';
  const n = Number(v);
  if (n <= 50) return '优';
  if (n <= 100) return '良';
  if (n <= 150) return '轻度污染';
  if (n <= 200) return '中度污染';
  if (n <= 300) return '重度污染';
  return '严重污染';
}

let weatherCache = { key: '', ts: 0, data: null };
const WEATHER_TTL = 10 * 60 * 1000;

// 城市名 → 经纬度：从完整名称逐步截短重试（「重庆渝北区」→「重庆渝北」→「重庆」）
async function geocodeCity(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const tries = [raw];
  const stripped = raw.replace(/[区县市镇乡]+$/, '');
  if (stripped && stripped !== raw) tries.push(stripped);
  // 中文名超过 2 字时，再用前 2 字兜底（「重庆渝北区」→「重庆」）
  if (/^[\u4e00-\u9fa5]{3,}$/.test(raw)) {
    const head = raw.slice(0, 2);
    if (!tries.includes(head)) tries.push(head);
  }
  for (const t of tries) {
    try {
      const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
        encodeURIComponent(t) + '&count=1&language=zh&format=json';
      const geoData = await (await fetch(geoUrl)).json();
      const hit = geoData.results && geoData.results[0];
      if (hit) return hit;
    } catch (e) { /* 继续尝试下一个名称 */ }
  }
  return null;
}

async function getWeather(cityName) {
  const key = String(cityName || '').trim() || process.env.WEATHER_CITY || (config.weather && config.weather.city) || '广州';
  if (weatherCache.key === key && Date.now() - weatherCache.ts < WEATHER_TTL) return weatherCache.data;

  let lat = (config.weather && config.weather.lat) || 23.13;
  let lon = (config.weather && config.weather.lon) || 113.26;
  let city = (config.weather && config.weather.city) || '广州';
  let matched = false;

  // 城市名 → 经纬度
  if (key && key !== ((config.weather && config.weather.city) || '')) {
    const hit = await geocodeCity(key);
    if (hit) {
      lat = hit.latitude;
      lon = hit.longitude;
      city = hit.name || key;      // 用解析到的真实地名，避免张冠李戴
      matched = true;
    } else {
      // 明确报错，不再偷偷用默认城市的数据冒充
      const err = { ok: false, error: '未找到「' + key + '」，请换个名称试试（如「重庆」「重庆渝中」）' };
      weatherCache = { key, ts: Date.now(), data: err };
      return err;
    }
  }

  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,pm2_5' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,uv_index_max' +
    '&timezone=Asia%2FShanghai&forecast_days=3';
  const data = await (await fetch(u)).json();
  const c = data.current || {};

  // 空气质量：PM2.5 雾霾、PM10、CO、NO2、SO2、O3、AQI
  let air = null;
  try {
    const au = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lat + '&longitude=' + lon +
      '&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi&timezone=Asia%2FShanghai';
    const ad = await (await fetch(au)).json();
    const a = ad.current || {};
    air = {
      pm25: a.pm2_5,
      pm10: a.pm10,
      co: a.carbon_monoxide,
      no2: a.nitrogen_dioxide,
      so2: a.sulphur_dioxide,
      o3: a.ozone,
      aqi: a.us_aqi,
      level: aqiLevel(a.us_aqi)
    };
  } catch (e) { air = null; }

  // 本场传感器实测（CO2、氨气等，天气接口不提供）
  const farm = { co2: null, ammonia: null, temperature: null, humidity: null, devices: 0 };
  let co2Sum = 0, co2N = 0, nh3Sum = 0, nh3N = 0;
  for (const d of devices.values()) {
    if (!d.latest) continue;
    if (d.latest.co2 !== undefined) { co2Sum += Number(d.latest.co2); co2N++; }
    if (d.latest.ammonia !== undefined) { nh3Sum += Number(d.latest.ammonia); nh3N++; }
  }
  if (co2N) farm.co2 = Math.round(co2Sum / co2N);
  if (nh3N) farm.ammonia = Math.round((nh3Sum / nh3N) * 10) / 10;
  farm.devices = devices.size;

  const hourly = [];
  if (data.hourly && data.hourly.time) {
    const nowIso = c.time || '';
    let start = data.hourly.time.findIndex((t) => t >= nowIso);
    if (start < 0) start = 0;
    for (let i = start; i < Math.min(start + 24, data.hourly.time.length); i++) {
      hourly.push({
        time: String(data.hourly.time[i]).slice(11, 16),
        temperature: data.hourly.temperature_2m[i],
        humidity: data.hourly.relative_humidity_2m[i],
        precipProb: data.hourly.precipitation_probability[i],
        wind: data.hourly.wind_speed_10m[i],
        pm25: data.hourly.pm2_5 ? data.hourly.pm2_5[i] : null
      });
    }
  }

  const daily = [];
  if (data.daily && data.daily.time) {
    for (let i = 0; i < data.daily.time.length; i++) {
      daily.push({
        date: String(data.daily.time[i]).slice(5),
        code: data.daily.weather_code[i],
        desc: WMO_DESC[data.daily.weather_code[i]] || '',
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        precip: data.daily.precipitation_sum[i],
        wind: data.daily.wind_speed_10m_max[i],
        uv: data.daily.uv_index_max[i]
      });
    }
  }

  const out = {
    city,
    lat,
    lon,
    code: c.weather_code,
    desc: WMO_DESC[c.weather_code] || '',
    temperature: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    apparent: c.apparent_temperature,
    precipitation: c.precipitation,
    cloud: c.cloud_cover,
    pressure: c.surface_pressure,
    wind: c.wind_speed_10m,
    windDir: windDirName(c.wind_direction_10m),
    windDirDeg: c.wind_direction_10m,
    gust: c.wind_gusts_10m,
    risks: weatherRisks({ code: c.weather_code, wind: c.wind_speed_10m, temperature: c.temperature_2m }),
    air,
    farm,
    hourly,
    daily,
    updatedAt: now()
  };
  weatherCache = { key, ts: Date.now(), data: out };
  return out;
}

// 生成天气摘要文本（给智能体用）
function buildWeatherContext(w) {
  if (!w || !w.ok) return '';
  const parts = [];
  parts.push('地区 ' + w.city);
  if (w.desc) parts.push(w.desc);
  if (w.temperature !== undefined) parts.push('气温 ' + w.temperature + '°C');
  if (w.apparent !== undefined) parts.push('体感 ' + w.apparent + '°C');
  if (w.humidity !== undefined) parts.push('湿度 ' + w.humidity + '%');
  if (w.wind !== undefined) parts.push(w.windDir ? w.windDir + ' ' + w.wind + 'm/s' : '风速 ' + w.wind + 'm/s');
  if (w.gust !== undefined) parts.push('阵风 ' + w.gust + 'm/s');
  if (w.precipitation !== undefined) parts.push('降水 ' + w.precipitation + 'mm');
  if (w.cloud !== undefined) parts.push('云量 ' + w.cloud + '%');
  if (w.pressure !== undefined) parts.push('气压 ' + w.pressure + 'hPa');
  if (w.risks && w.risks.length) parts.push('⚠ 需注意：' + w.risks.join('、'));
  return parts.join('，');
}

// 路由
const server = http.createServer(async (req, res) => {
  const parsed = parseUrl(req);
  const pathname = parsed.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  try {
    // 1. 接收 ESP32 数据
    if (req.method === 'POST' && (pathname === '/api/data' || /^\/api\/data\/[^/]+$/.test(pathname))) {
      const body = await parseJsonBody(req);
      const deviceId = resolveDeviceId(req, body);
      const name = resolveDeviceName(body) || deviceId;
      const device = upsertDevice(deviceId, name, body, getClientIp(req));
      const summary = deviceSummary(device);
      broadcast('device-data', summary);
      sendJson(res, 200, { ok: true, device: summary });
      return;
    }

    // 2. 查询设备列表
    if (req.method === 'GET' && pathname === '/api/devices') {
      const list = [...devices.values()]
        .map(deviceSummary)
        .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
      sendJson(res, 200, { ok: true, count: list.length, devices: list });
      return;
    }

    // 3. 查询单台设备
    const singleMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (req.method === 'GET' && singleMatch) {
      const id = decodeURIComponent(singleMatch[1]);
      const device = devices.get(id);
      if (!device) {
        sendJson(res, 404, { ok: false, error: '设备不存在' });
        return;
      }
      sendJson(res, 200, { ok: true, device: deviceSummary(device) });
      return;
    }

    // 4. 删除设备
    if (req.method === 'DELETE' && singleMatch) {
      const id = decodeURIComponent(singleMatch[1]);
      // chat = delete | keep | archive （默认一起删除）
      const chatAction = parsed.query.chat || 'delete';
      if (devices.delete(id)) {
        markDirty();
        const chatId = 'device:' + id;
        let archived = 0;
        if (conversations.has(chatId)) {
          if (chatAction === 'delete') {
            conversations.delete(chatId);
            conversationMeta.delete(chatId);
          } else if (chatAction === 'archive') {
            archived = archiveConversation(chatId);
            conversations.delete(chatId);
            conversationMeta.delete(chatId);
          } else {
            // 保留：解绑成普通聊天，之后仍可查看
            conversationMeta.set(chatId, Object.assign({}, conversationMeta.get(chatId) || {}, { bound: false, deviceId: '' }));
          }
          saveConversations();
          saveConversationMeta();
        }
        broadcast('device-removed', { id });
        sendJson(res, 200, { ok: true, removed: id, chatAction, archived });
      } else {
        sendJson(res, 404, { ok: false, error: '设备不存在' });
      }
      return;
    }

    // 4.5 更新设备元数据（物种/数目/面积/名称）
    const metaMatch = pathname.match(/^\/api\/devices\/([^/]+)\/meta$/);
    if ((req.method === 'POST' || req.method === 'PUT') && metaMatch) {
      const id = decodeURIComponent(metaMatch[1]);
      let device = devices.get(id);
      if (!device) {
        // 允许通过「添加设备」预先创建（尚无数据）
        device = {
          id: id, name: id, createdAt: now(), lastSeen: 0,
          ip: '', latest: {}, history: [], meta: {}
        };
        devices.set(id, device);
      }
      const body = await parseJsonBody(req);
      if (body && typeof body === 'object') {
        if (body.species != null) device.meta.species = String(body.species).trim();
        if (body.count != null && !isNaN(Number(body.count))) device.meta.count = Number(body.count);
        if (body.area != null && !isNaN(Number(body.area))) device.meta.area = Number(body.area);
        if (body.stage != null) device.meta.stage = String(body.stage).trim();
        if (body.weight != null && !isNaN(Number(body.weight))) device.meta.weight = Number(body.weight);
        if (body.feed_daily != null && !isNaN(Number(body.feed_daily))) device.meta.feed_daily = Number(body.feed_daily);
        if (body.name != null && String(body.name).trim()) {
          device.name = String(body.name).trim();
          device.meta.nameSet = true;   // 用户自定义名称，ESP32 上报不再覆盖
        }
      }
      markDirty();
      // 新增/修改设备后，立即生成或同步它专属的聊天框
      ensureDeviceChats();
      const summary = deviceSummary(device);
      broadcast('device-updated', summary);
      sendJson(res, 200, { ok: true, device: summary });
      return;
    }

    // 5. 清空全部设备
    if (req.method === 'DELETE' && pathname === '/api/devices') {
      devices.clear();
      markDirty();
      broadcast('devices-cleared', {});
      sendJson(res, 200, { ok: true });
      return;
    }

    // 6. SSE 实时推送
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(': connected\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ time: now() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // 7. 上传图片（上传到扣子，返回 file_id）
    if (req.method === 'POST' && pathname === '/api/upload') {
      const body = await parseJsonBody(req);
      const data = (body && (body.data || body.base64)) || '';
      const name = (body && body.name) || 'image.png';
      if (!data) {
        sendJson(res, 400, { ok: false, error: '缺少图片数据' });
        return;
      }
      try {
        const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
        const fileId = await uploadToCoze(buf, name);
        sendJson(res, 200, { ok: true, file_id: fileId });
      } catch (e) {
        console.error('[上传图片] 失败：', e.message);
        sendJson(res, 500, { ok: false, error: '图片上传失败：' + e.message });
      }
      return;
    }

    // 7.9 个体对话档案
    if (req.method === 'GET' && pathname === '/api/conversations') {
      ensureDeviceChats();
      const list = [...conversations.entries()].map(([id, msgs]) => {
        const m = conversationMeta.get(id) || {};
        return {
          id,
          name: m.name || id,
          bound: !!m.bound,
          deviceId: m.deviceId || '',
          count: msgs.length,
          lastTs: msgs.length ? (msgs[msgs.length - 1].ts || 0) : 0
        };
      }).sort((a, b) => {
        if (a.id === 'main') return -1;
        if (b.id === 'main') return 1;
        return (b.bound ? 1 : 0) - (a.bound ? 1 : 0) || b.lastTs - a.lastTs;
      });
      sendJson(res, 200, { ok: true, conversations: list });
      return;
    }
    const convMatch = pathname.match(/^\/api\/conversations\/(.+)$/);
    if (convMatch) {
      const id = decodeURIComponent(convMatch[1]).trim();
      if (!id) { sendJson(res, 400, { ok: false, error: '缺少个体编号' }); return; }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, id, messages: conversations.get(id) || [] });
        return;
      }
      if (req.method === 'POST') {
        const body = await parseJsonBody(req);
        const list = conversations.get(id) || [];
        const incoming = Array.isArray(body && body.messages) ? body.messages
          : (body && body.role ? [{ role: body.role, content: body.content }] : []);
        for (const m of incoming) {
          if (!m || !m.role) continue;
          list.push({ role: String(m.role), content: String(m.content || ''), ts: m.ts || now() });
        }
        while (list.length > 400) list.shift();
        conversations.set(id, list);
        // 新建的自定义聊天：保存名称
        if (body && body.name && !conversationMeta.has(id)) {
          conversationMeta.set(id, { name: String(body.name).trim(), bound: false, deviceId: '' });
          saveConversationMeta();
        }
        saveConversations();
        sendJson(res, 200, { ok: true, id, count: list.length, messages: list });
        return;
      }
      if (req.method === 'DELETE') {
        const m = conversationMeta.get(id) || {};
        if (m.bound) { sendJson(res, 403, { ok: false, error: '设备绑定的聊天不能删除' }); return; }
        const archive = parsed.query.archive === '1';
        // 主对话是常驻入口：删除等于清空消息，聊天框保留
        if (id === 'main') {
          const archived = archive ? archiveConversation('main') : 0;
          conversations.set('main', []);
          saveConversations();
          sendJson(res, 200, { ok: true, cleared: true, archived });
          return;
        }
        let archived = 0;
        if (archive) archived = archiveConversation(id);
        conversations.delete(id);
        conversationMeta.delete(id);
        saveConversations();
        saveConversationMeta();
        sendJson(res, 200, { ok: true, archived });
        return;
      }
    }

    // 7.95 市场行情
    if (req.method === 'GET' && pathname === '/api/market') {
      const date = MARKET.dayStr();
      const remote = await MARKET.fetchRemote((config.market && config.market.url) || '');
      const remoteMap = new Map((remote || []).map((r) => [r.name, r]));
      const list = SPECIES.map((sp) => {
        const p = MARKET.priceFor(sp.name, date);
        const r = remoteMap.get(sp.name);
        return {
          id: sp.id,
          name: sp.name,
          icon: sp.icon,
          unit: (r && r.unit) || p.unit,
          purchase: r ? r.purchase : p.purchase,
          sale: r ? r.sale : p.sale,
          change: r ? 0 : p.change,
          breeds: (sp.breeds || []).length
        };
      });
      sendJson(res, 200, {
        ok: true,
        date,
        source: remote ? '远程行情源' : '本地行情模型（示例数据）',
        updatedAt: now(),
        species: list
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/market/breeds') {
      const spName = new URL(req.url, 'http://x').searchParams.get('species') || '';
      const sp = SPECIES.find((s) => s.name === spName);
      if (!sp) { sendJson(res, 404, { ok: false, error: '物种不存在' }); return; }
      const date = MARKET.dayStr();
      const list = (sp.breeds || []).map((b) => {
        const p = MARKET.breedPrice(sp.name, b.name, date);
        return { name: b.name, unit: p.unit, purchase: p.purchase, sale: p.sale };
      });
      sendJson(res, 200, { ok: true, date, species: sp.name, breeds: list });
      return;
    }

    // 7.96 患病记录（本地文本）
    if (req.method === 'POST' && pathname === '/api/illness') {
      const body = await parseJsonBody(req);
      const rec = recordIllness(body);
      sendJson(res, 200, { ok: true, record: rec });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/illness') {
      sendJson(res, 200, { ok: true, records: listIllness() });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/real-knowledge') {
      sendJson(res, 200, Object.assign({ ok: true }, buildRealKnowledge()));
      return;
    }

    // 手动触发：把当天记录同步到扣子知识库
    if (req.method === 'POST' && pathname === '/api/kb/sync') {
      try {
        const n = await syncKnowledgeBase();
        sendJson(res, 200, { ok: true, synced: n, datasetId: (config.knowledgeBase || {}).dataset_id || '' });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '同步失败：' + e.message });
      }
      return;
    }

    // 7.99 今日天气（Open-Meteo 免费接口）
    if (req.method === 'GET' && pathname === '/api/weather') {
      const cityParam = new URL(req.url, 'http://x').searchParams.get('city') || '';
      try {
        const w = await getWeather(cityParam);
        sendJson(res, 200, Object.assign({ ok: true }, w));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: '天气获取失败：' + e.message });
      }
      return;
    }

    // 7.97 健康预警分析（大模型）
    const healthMatch = pathname.match(/^\/api\/health\/([^/]+)$/);
    if (req.method === 'POST' && healthMatch) {
      const id = decodeURIComponent(healthMatch[1]);
      const dev = devices.get(id);
      if (!dev) { sendJson(res, 404, { ok: false, error: '设备不存在' }); return; }
      let hb = {};
      try { hb = await parseJsonBody(req); } catch (e) { hb = {}; }
      const city = (hb && hb.city) || parsed.query.city || '';
      let prompt = buildHealthPrompt(dev);
      // 结合当地天气作为外部诱因（寒潮导致发烧、大风雷暴损坏棚舍等）
      try {
        const w = await getWeather(city);
        if (w) {
          prompt += '\n\n【当地天气（外部环境参考）】\n' + buildWeatherContext(Object.assign({ ok: true }, w)) +
            '\n· 请结合天气判断外部诱因：如寒潮/高温应激引发发烧或采食下降、大风雷暴损坏棚舍导致环境骤变、连阴雨导致垫料潮湿诱发球虫等。';
        }
      } catch (e) { /* 天气获取失败不影响预警 */ }
      try {
        const reply = await handleCozeChat(prompt, [], [], (hb && hb.city) || '');
        const result = reply.ok ? (reply.reply && reply.reply.content) : (reply.error || '分析失败');
        let file = null;
        if (reply.ok && result) {
          file = saveWarning(dev, result);
          // 记录本次预警（含真实环境快照），作为本地知识库来源
          recordQuery({
            deviceId: dev.id,
            deviceName: dev.name || dev.id,
            species: (dev.meta && dev.meta.species) || '',
            stage: (dev.meta && dev.meta.stage) || '',
            question: '健康预警分析：' + ((dev.meta && dev.meta.species) || '') + '（' + ((dev.meta && dev.meta.stage) || '未填写') + '）',
            answer: result,
            env: snapshotEnv(dev)
          });
        }
        sendJson(res, 200, { ok: reply.ok, result, warningFile: file, drugs: extractDrugs(result) });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '分析失败：' + e.message });
      }
      return;
    }

    // 7.98 预警记录查询
    if (req.method === 'GET' && pathname === '/api/warnings') {
      let files = [];
      try {
        if (fs.existsSync(WARNING_DIR)) files = fs.readdirSync(WARNING_DIR).filter((f) => f.endsWith('.txt')).sort().reverse();
      } catch (e) {}
      sendJson(res, 200, { ok: true, files });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/warnings/file') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      const safe = path.basename(name);
      const fp = path.join(WARNING_DIR, safe);
      if (!safe || !fp.startsWith(WARNING_DIR) || !fs.existsSync(fp)) { sendJson(res, 404, { ok: false, error: '文件不存在' }); return; }
      sendJson(res, 200, { ok: true, name: safe, content: fs.readFileSync(fp, 'utf8') });
      return;
    }
    if (req.method === 'DELETE' && pathname === '/api/warnings/file') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      const safe = path.basename(name);
      const fp = path.join(WARNING_DIR, safe);
      if (!safe || !fp.startsWith(WARNING_DIR) || !fs.existsSync(fp)) { sendJson(res, 404, { ok: false, error: '文件不存在' }); return; }
      try { fs.unlinkSync(fp); } catch (e) { sendJson(res, 500, { ok: false, error: '删除失败' }); return; }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/warnings') {
      const body = await parseJsonBody(req);
      const content = String((body && body.content) || '').trim();
      const device = String((body && body.device) || '手动记录');
      if (!content) { sendJson(res, 400, { ok: false, error: '内容不能为空' }); return; }
      const fname = saveWarning({ name: device, id: '' }, content);
      sendJson(res, 200, { ok: true, file: fname });
      return;
    }
    // 删除患病记录
    const illnessDel = pathname.match(/^\/api\/illness\/([^/]+)$/);
    if (req.method === 'DELETE' && illnessDel) {
      const iid = decodeURIComponent(illnessDel[1]);
      const before = illnessRecords.length;
      illnessRecords = illnessRecords.filter((r) => r.id !== iid);
      if (illnessRecords.length === before) { sendJson(res, 404, { ok: false, error: '记录不存在' }); return; }
      saveIllness();
      sendJson(res, 200, { ok: true });
      return;
    }

    // 删除单条 AI 查询记录（真实知识库）
    const queryDel = pathname.match(/^\/api\/queries\/([^/]+)$/);
    if (req.method === 'DELETE' && queryDel) {
      const qid = decodeURIComponent(queryDel[1]);
      const before = queryRecords.length;
      queryRecords = queryRecords.filter((r) => r.id !== qid);
      if (queryRecords.length === before) { sendJson(res, 404, { ok: false, error: '记录不存在' }); return; }
      saveQueries();
      sendJson(res, 200, { ok: true });
      return;
    }

    // 8. 智能体聊天接口
    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await parseJsonBody(req);
      const message = (body && (body.message || body.text || body.prompt)) || '';
      const images = (body && Array.isArray(body.images)) ? body.images : [];
      if (!String(message).trim() && images.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少 message 或图片' });
        return;
      }
      const reply = await handleChat(body);
      // 记录本次查询（含真实环境快照），作为本地知识库来源
      try {
        const msg = String(message || '').trim();
        const meaningful = msg.length >= 4 && !/^(你好|您好|hi|hello|在吗|test|测试)$/i.test(msg);
        if (reply.ok && meaningful) {
          const individualId = String((body && body.individualId) || '').trim();
          // 优先按会话绑定的设备取环境，避免串到别的设备
          const convMeta = conversationMeta.get(individualId) || {};
          const devId = convMeta.deviceId || '';
          const dev = devId ? devices.get(devId)
            : [...devices.values()].find((d) => d.latest && Object.keys(d.latest).length > 1);
          recordQuery({
            deviceId: (dev && dev.id) || '',
            deviceName: convMeta.name || individualId || ((dev && dev.name) || ''),
            species: (dev && dev.meta && dev.meta.species) || '',
            stage: (dev && dev.meta && dev.meta.stage) || '',
            question: msg,
            answer: (reply.reply && reply.reply.content) || '',
            env: snapshotEnv(dev || null)
          });
          // 主聊天：按提问内容自动命名
          if (individualId === 'main') {
            const m = conversationMeta.get('main') || { name: '主聊天', bound: false, deviceId: '' };
            m.name = '主对话 · ' + msg.slice(0, 12);
            m.nameSet = true;
            conversationMeta.set('main', m);
            saveConversationMeta();
          }
        }
      } catch (e) { console.error('[查询] 记录失败：', e.message); }
      reply.drugs = extractDrugs(reply.reply && reply.reply.content);

      // 候选病种：供前端展示病症图让用户确认，确认后再继续
      if (reply.ok) {
        const msgText = String(message || '');
        // 用户已经在确认/否认，不再重复弹确认卡
        const isConfirm = /^确认是|^都不是/.test(msgText.trim());
        const spHit = SPECIES.find((s) => s.name && msgText.includes(s.name));
        const firstDev = devices.values().next().value;
        const spForCand = (spHit && spHit.name) || ((firstDev && firstDev.meta && firstDev.meta.species) || '');
        reply.candidates = isConfirm ? [] : extractCandidates(reply.reply && reply.reply.content, spForCand);
        reply.speciesForCand = spForCand;
        reply.pendingConfirm = reply.candidates.length > 0;
      }

      sendJson(res, 200, reply);
      return;
    }

    // 8. 登录校验
    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await parseJsonBody(req);
      const u = String(body && (body.username || body.user) || '');
      const p = String(body && (body.password || body.pwd) || '');
      if (u === AUTH.username && p === AUTH.password) {
        sendJson(res, 200, { ok: true, token: 'farm-session-' + Date.now() });
      } else {
        sendJson(res, 401, { ok: false, error: '账号或密码错误' });
      }
      return;
    }

    // 8.1 摄像头：接收实时画面帧
    const camMatch = pathname.match(/^\/api\/camera\/([^/]+)$/);
    if (req.method === 'POST' && camMatch) {
      const id = decodeURIComponent(camMatch[1]);
      const body = await parseJsonBody(req);
      const data = (body && (body.data || body.base64 || body.frame)) || '';
      if (!data) { sendJson(res, 400, { ok: false, error: '缺少画面数据' }); return; }
      const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
      const prev = cameraFrames.get(id);
      cameraFrames.set(id, { buf, ts: now(), prevBuf: prev ? prev.buf : null, prevTs: prev ? prev.ts : 0 });
      broadcast('camera-frame', { id, ts: now() });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && camMatch) {
      const id = decodeURIComponent(camMatch[1]);
      const f = cameraFrames.get(id);
      if (!f) { sendJson(res, 404, { ok: false, error: '暂无画面' }); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(f.buf);
      return;
    }

    // 8.2 摄像头：AI 识别预警
    const recMatch = pathname.match(/^\/api\/camera\/([^/]+)\/recognize$/);
    if (req.method === 'POST' && recMatch) {
      const id = decodeURIComponent(recMatch[1]);
      const f = cameraFrames.get(id);
      if (!f) { sendJson(res, 400, { ok: false, error: '暂无画面，无法识别' }); return; }
      const last = lastRecognize.get(id) || 0;
      if (now() - last < 10000) {
        sendJson(res, 200, { ok: true, throttled: true, result: '识别过于频繁，请稍候…' });
        return;
      }
      lastRecognize.set(id, now());
      try {
        const images = [];
        if (f.prevBuf) images.push(await uploadToCoze(f.prevBuf, 'frame_prev.jpg'));
        images.push(await uploadToCoze(f.buf, 'frame_now.jpg'));
        const prompt = '这是养殖监控的连续两帧画面（相隔约1秒）。请严格按以下格式回答：\n' +
          '第一行只写「数量：X」或「数量：未知」。\n' +
          '· 只有画面清晰、动物轮廓可辨认、能逐个点清时才写具体数字；\n' +
          '· 如果画面模糊、光线不足、动物被遮挡、距离太远、数量过多难以点清，一律写「数量：未知」，绝对不要猜测或估算；\n' +
          '第二行写动物种类（看不清就写「种类：未知」）；\n' +
          '第三行对比两帧判断动物是否移动、移动快慢（无法判断就写「移动：无法判断」）；\n' +
          '如有动物长时间静止不动（可能生病、死亡或异常），请明确预警。\n' +
          '注意：宁可写「未知」，也不要给出不确定的数字。';

        const reply = await handleCozeChat(prompt, [], images);
        const content = reply.ok ? (reply.reply && reply.reply.content) : (reply.error || '识别失败');

        // 只认「数量：」这一行；写「未知/无法判断」就不写数量，其他行的模糊描述不影响
        let detected = null;
        const text = String(content || '');
        const cntLine = text.match(/数量\s*[:：]\s*([^\n，。；]{1,20})/);
        if (cntLine) {
          const v = cntLine[1].trim();
          const num = v.match(/^(\d{1,4})/);
          const unknown = /未知|不明|无法|不清|看不清|难以/.test(v);
          if (num && !unknown) {
            const n = Number(num[1]);
            if (n > 0 && n <= 5000) detected = n;
          }
        }

        if (devices.has(id)) {
          const dev = devices.get(id);
          dev.latest = dev.latest || {};
          if (detected != null) {
            dev.latest.camera_count = detected;
          } else if (dev.latest.camera_count !== undefined) {
            delete dev.latest.camera_count;   // 这次没识别出，清掉旧数量，避免误导
          }
          // 识别状态（种类/移动/异常）存到 meta，供预警提示词使用
          dev.meta = dev.meta || {};
          dev.meta.camera_status = String(content || '').slice(0, 400);
          dev.meta.camera_time = isoTime(now());
          markDirty();
          broadcast('device-update', deviceSummary(dev));
        }
        sendJson(res, 200, { ok: reply.ok, result: content, detectedCount: detected });
      } catch (e) {
        console.error('[识别] 失败：', e.message);
        sendJson(res, 500, { ok: false, error: '识别失败：' + e.message });
      }
      return;
    }

    // 9. 物种知识库
    if (req.method === 'GET' && pathname === '/api/species') {
      sendJson(res, 200, { ok: true, species: SPECIES });
      return;
    }

    // 8.5 数据分析（异常识别 + 正常值对比 + 结论）
    if (req.method === 'GET' && pathname === '/api/analysis') {
      // 当地天气作为外部诱因参考（如大风雷暴损坏棚舍导致环境异常）
      let w = null;
      try { w = await getWeather(parsed.query.city || ''); } catch (e) { w = null; }
      const wBrief = w ? {
        city: w.city, desc: w.desc, temperature: w.temperature,
        humidity: w.humidity, wind: w.wind, windDir: w.windDir, risks: w.risks
      } : null;

      const results = [...devices.values()].map((d) => {
        const r = analyzeDevice(d);
        r.weather = wBrief;
        if (w && w.risks && w.risks.length && r.anomalies.length) {
          r.weatherNote = '当地天气' + (w.desc || '') + '（' + w.risks.join('、') +
            '），可能是造成环境异常的外部因素，请检查棚舍结构、排水与通风设施是否受损。';
          r.conclusion += ' ' + r.weatherNote;
        } else if (w && w.risks && w.risks.length) {
          r.weatherNote = '当地天气' + (w.desc || '') + '（' + w.risks.join('、') + '），请提前做好防护。';
        }
        return r;
      });
      const alerts = [];
      for (const r of results) {
        for (const a of r.anomalies) {
          alerts.push({ deviceId: r.id, device: r.name, species: r.species, key: a.key, label: a.label, value: a.value, unit: a.unit, normal: a.normal, status: a.status });
        }
      }
      sendJson(res, 200, { ok: true, weather: wBrief, results, alerts, alertCount: alerts.length });
      return;
    }

    // 9. 公开配置（不含密钥）
    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, {
        ok: true,
        agentConnected: Boolean(AGENT.apiUrl || (AGENT.type === 'coze' && AGENT.botId)),
        thresholds: THRESHOLDS,
        offlineAfterMs: OFFLINE_AFTER_MS
      });
      return;
    }

    // 9. 健康检查
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), devices: devices.size });
      return;
    }

    // 10. 静态文件
    if (req.method === 'GET') {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (e) {
    console.error('[请求错误]', req.method, req.url, e.message);
    sendJson(res, e.status || 500, { ok: false, error: e.message || '服务器内部错误' });
  }
});

// 智能体
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 生成当前环境数据摘要，供智能体判断病因
function buildEnvironmentContext() {
  const list = [...devices.values()].filter(
    (d) => d.latest && Object.keys(d.latest).some((k) => k !== 'time')
  );
  if (list.length === 0) return '';

  const lines = [];
  for (const d of list) {
    const l = d.latest;
    const parts = [];
    if (l.temperature !== undefined) parts.push(`温度 ${l.temperature}°C`);
    if (l.humidity !== undefined) parts.push(`湿度 ${l.humidity}%`);
    if (l.soil !== undefined) parts.push(`土壤湿度 ${l.soil}%`);
    if (l.water !== undefined) parts.push(`水位 ${l.water}%`);
    if (l.light !== undefined) parts.push(`光照 ${l.light}%`);
    if (l.flame !== undefined) parts.push(l.flame === 1 ? '火焰：⚠️有火情' : '火焰：安全');
    if (l.co2 !== undefined) parts.push(`二氧化碳 ${l.co2}ppm`);
    if (l.h2s !== undefined) parts.push(`硫化氢 ${l.h2s}ppm`);
    if (l.wind !== undefined) parts.push(`风速 ${l.wind}m/s`);
    if (l.pressure !== undefined) parts.push(`气压 ${l.pressure}hPa`);
    if (l.rain !== undefined) parts.push(`降雨${l.rain}mm`);
    if (l.pm25 !== undefined) parts.push(`PM2.5 ${l.pm25}μg/m³`);
    if (l.noise !== undefined) parts.push(`噪声 ${l.noise}dB`);
    if (l.o2 !== undefined) parts.push(`氧气 ${l.o2}%`);
    if (l.soil_temp !== undefined) parts.push(`土壤温度 ${l.soil_temp}°C`);
    if (l.feed_level !== undefined) {
      const fd = Number(d.meta && d.meta.feed_daily) || 0;
      parts.push(`饲料槽余量 ${l.feed_level}%` +
        (fd > 0 ? `（每日投喂 ${fd}kg，约剩 ${((fd * Number(l.feed_level)) / 100).toFixed(2)}kg）` : '') +
        (Number(l.feed_level) > 20 ? '，剩料偏多提示采食不足' : '，采食正常'));
    }
    if (l.feed_activity !== undefined) parts.push(`进食活动 ${l.feed_activity}`);
    if (l.camera_count !== undefined) parts.push(`摄像头识别数量 ${l.camera_count} 只`);
    if (d.meta && d.meta.camera_status) {
      parts.push('画面识别：' + String(d.meta.camera_status).replace(/\s+/g, ' ').slice(0, 140));
    } else if (l.camera_count === undefined) {
      parts.push('画面识别：未检测到物体状况（无画面或未识别）');
    }
    const dinfo = densityInfo(d);
    if (dinfo.actual != null) {
      const ref = dinfo.ref ? `，参考 ${dinfo.ref.min}~${dinfo.ref.max} 只/㎡` : '';
      parts.push(`种群密度 ${dinfo.actual} 只/㎡${ref}`);
    }
    if (d.meta && d.meta.stage) parts.push('成长阶段 ' + d.meta.stage);
    if (d.meta && d.meta.weight) parts.push('体重 ' + d.meta.weight + 'kg');
    const online = (Date.now() - (d.lastSeen || 0)) < OFFLINE_AFTER_MS ? '在线' : '离线';
    if (parts.length) lines.push(`· ${d.name || d.id}（${online}）：${parts.join('，')}`);
  }
  return lines.length ? lines.join('\n') : '';
}

// 生成养殖对象（物种）的正常环境/饮食/患病因子摘要
function buildSpeciesContext(message) {
  const speciesSet = new Set();
  // 1) 在线设备涉及的物种
  for (const d of devices.values()) {
    const s = d.meta && d.meta.species;
    if (s) speciesSet.add(s);
  }
  // 2) 用户问题里提到的物种（问牛就带牛的疫病库，不受在线设备限制）
  const text = String(message || '');
  if (text) {
    for (const sp of SPECIES) {
      if (sp.name && text.includes(sp.name)) speciesSet.add(sp.name);
    }
  }
  if (speciesSet.size === 0) return '';

  const labels = { temperature: '温度', humidity: '湿度', ammonia: '氨气', soil: '土壤湿度', water: '水位', light: '光照' };
  const parts = [];
  for (const name of speciesSet) {
    const sp = SPECIES.find((s) => s.name === name);
    if (!sp) continue;
    const norm = Object.entries(sp.normal || {})
      .map(([k, r]) => `${labels[k] || k} ${r.min}~${r.max}${r.unit}`)
      .join('，');
    const diseases = (sp.diseases || []).map((d) => `${d.name}（症状：${d.symptoms}；诱因：${d.factors}）`).join('；');
    const extra = [];
    if (sp.density) extra.push('养殖密度：' + sp.density);
    if (sp.ventilation) extra.push('通风：' + sp.ventilation);
    if (sp.lighting) extra.push('光照：' + sp.lighting);
    if (sp.water) extra.push('饮水：' + sp.water);
    if (sp.immunity) extra.push('免疫：' + sp.immunity);
    if (sp.hygiene) extra.push('卫生消毒：' + sp.hygiene);
    if (sp.mistakes) extra.push('常见误区：' + sp.mistakes);
    const breedCount = (sp.breeds || []).length;
    const breedNames = (sp.breeds || []).slice(0, 8).map((b) => b.name).join('、');
    parts.push(`【${sp.name}】正常环境：${norm}。环境要求：${sp.environment} 饮食：${sp.diet} ${extra.join(' ')} 常见疫病与诱因：${diseases} 该物种含 ${breedCount} 个品种（如 ${breedNames} 等），请结合品种特性与实时数据综合判断。`);
  }
  return parts.join('\n');
}
function analyzeDevice(device) {
  const summary = deviceSummary(device);
  const latest = device.latest || {};
  const species = SPECIES.find((s) => s.name === summary.meta.species);
  const anomalies = [];
  const comparisons = [];

  const defs = [
    { key: 'temperature', label: '温度', unit: '°C' },
    { key: 'humidity', label: '湿度', unit: '%' },
    { key: 'ammonia', label: '氨气', unit: 'ppm' },
    { key: 'soil', label: '土壤湿度', unit: '%' },
    { key: 'water', label: '水位', unit: '%' },
    { key: 'light', label: '光照', unit: '%' },
    { key: 'flame', label: '火焰', unit: '' },
    { key: 'co2', label: '二氧化碳', unit: 'ppm' },
    { key: 'h2s', label: '硫化氢', unit: 'ppm' },
    { key: 'wind', label: '风速', unit: 'm/s' },
    { key: 'pressure', label: '气压', unit: 'hPa' },
    { key: 'rain', label: '降雨量', unit: 'mm' },
    { key: 'pm25', label: 'PM2.5', unit: 'μg/m³' },
    { key: 'noise', label: '噪声', unit: 'dB' },
    { key: 'o2', label: '氧气', unit: '%' },
    { key: 'soil_temp', label: '土壤温度', unit: '°C' },
    { key: 'feed_level', label: '饲料槽余量', unit: '%' },
    { key: 'feed_activity', label: '进食活动', unit: '' }
  ];

  for (const def of defs) {
    const v = latest[def.key];
    if (v === undefined) continue;
    let status = evaluateMetric(def.key, v);   // 全局阈值判断
    const entry = { key: def.key, label: def.label, value: v, unit: def.unit, status };
    const normal = normalFor(species && species.name, def.key);
    if (normal) {
      entry.normal = { min: normal.min, max: normal.max };
      if (v < normal.min) status = 'low';
      else if (v > normal.max) status = 'high';
      else status = 'normal';
      entry.status = status;
    }
    comparisons.push(entry);
    if (status !== 'normal') anomalies.push(entry);
  }

  // 种群密度（数量 / 面积，与物种参考密度对比）
  const dinfo = densityInfo(device);
  if (dinfo.actual != null) {
    const entry = {
      key: 'density', label: '种群密度', value: dinfo.actual, unit: '只/㎡',
      status: dinfo.status === 'unknown' ? 'normal' : dinfo.status,
      note: dinfo.refText
    };
    if (dinfo.ref) entry.normal = { min: dinfo.ref.min, max: dinfo.ref.max };
    comparisons.push(entry);
    if (entry.status !== 'normal') anomalies.push(entry);
  }

  let conclusion;
  if (anomalies.length === 0) {
    conclusion = species
      ? `${summary.name}：各项环境指标均在 ${species.name} 的正常范围内，环境良好。`
      : `${summary.name}：环境正常。`;
  } else {
    const parts = anomalies.map((a) => {
      const norm = a.normal ? `（正常 ${a.normal.min}~${a.normal.max}${a.unit}）` : '';
      const dir = a.status === 'high' ? '偏高' : '偏低';
      return `${a.label} ${a.value}${a.unit}${norm} ${dir}`;
    });
    conclusion = `${summary.name}：存在 ${anomalies.length} 项环境异常——${parts.join('；')}。请排查通风、温控、湿度与卫生状况，避免诱发疫病。`;
  }

  return { id: summary.id, name: summary.name, species: summary.meta.species, anomalies, comparisons, conclusion };
}

// 将扣子的多模态内容（object_string）转成可显示的 markdown
function cozeContentToMarkdown(content, contentType) {
  if (contentType !== 'object_string') return String(content);
  try {
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) return String(content);
    const parts = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && item.text) {
        parts.push(item.text);
      } else if (item.type === 'image') {
        if (item.file_url) parts.push(`![图片](${item.file_url})`);
        // 仅 file_id 的图片无法直接公开展示（需账号授权），这里跳过
      }
    }
    return parts.join('\n');
  } catch (e) {
    return String(content);
  }
}

// 上传图片到扣子，返回 file_id
async function uploadToCoze(buffer, filename) {
  const baseUrl = AGENT.baseUrl || 'https://api.coze.cn';
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(baseUrl + '/v1/files/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (AGENT.apiKey || AGENT.token || '') },
      body: form,
      signal: ctrl.signal
    });
    const data = await resp.json();
    if (!data || data.code !== 0) {
      throw new Error((data && (data.msg || data.code)) || '上传失败');
    }
    return data.data && data.data.id;
  } finally {
    clearTimeout(timer);
  }
}

async function handleChat(body) {
  const message = String(body.message || body.text || body.prompt || '');
  const individualId = String((body && body.individualId) || '').trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const images = Array.isArray(body.images) ? body.images : [];

  // 个体档案：若指定编号且已有记录，载入该个体最近 20 条对话作为上下文
  let hist = history;
  if (individualId && conversations.has(individualId)) {
    hist = (conversations.get(individualId) || []).slice(-20)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  }

  // 对话规则：信息不全时先提问，避免臆测
  const rules = [
    '【工作规则】',
    '1. 如果用户提供的信息不完整（缺少物种/品种、日龄、症状、持续时间、环境数据等关键信息），请先暂停分析，用简洁的问题向用户询问缺失的信息；得到补充后再继续，绝不编造或假设。',
    '2. 回答先给结论，再给依据，最后给具体处置建议，分点简洁。',
    '3. 判断顺序：先分析实时环境数据（尤其是超标项）与该物种疾病的因果关系——这是本系统最可靠的依据；再参考本场历史记录；最后参考通用知识。冲突时说明差异。',
    '4. 必须优先参考该个体的既往病史；如果是复诊，请说明与上次相比的变化（好转/恶化/无变化）。',
    '5. 给出治疗方案后，提醒用户：等个体好转后回来告知，以便记录疗效、更新档案。',
    '6. 如果判断需要用药，请在回答末尾单独输出一段：',
    '   【推荐药品】',
    '   - 药品名：用途与用法简述',
    '   （每种药一行，只写确实需要的药）'
  ].join('\n');
  const profile = individualId ? `【当前个体档案】${individualId}\n` : '';
  const historySummary = hist.length
    ? '【该个体既往记录（请优先参考）】\n' + hist
        .map((m) => (m.role === 'user' ? '主人：' : '兽医：') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 160))
        .join('\n') + '\n\n'
    : '';
  const fullMessage = rules + '\n' + profile + historySummary + message;

  // 扣子（Coze）智能体
  if (AGENT.type === 'coze' && AGENT.botId) {
    return await handleCozeChat(fullMessage, hist, images, (body && body.city) || '');
  }

  // 已配置外部智能体：转发请求
  if (AGENT.apiUrl) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (AGENT.apiKey) headers['Authorization'] = `Bearer ${AGENT.apiKey}`;

      const resp = await fetchAgent(AGENT.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, history })
      });
      const data = await resp.json().catch(() => null);
      if (data && typeof data === 'object') return { ok: true, reply: data, from: 'agent' };
      return { ok: true, reply: { role: 'assistant', content: String(data) }, from: 'agent' };
    } catch (e) {
      console.error('[智能体] 转发失败：', e.message);
      return { ok: false, error: '智能体接口调用失败：' + e.message, from: 'agent' };
    }
  }

  // 未配置：返回占位回复
  return {
    ok: true,
    from: 'placeholder',
    reply: {
      role: 'assistant',
      content: '【智能体占位回复】\n\n这里是预留的智能体聊天区。接入扣子（Coze）智能体：在 config.json 里把 agent.type 设为 "coze"，并填上 botId 和 apiKey。\n\n你可以先问我：\n· 鸡出现精神萎靡、拉稀，可能是什么病？\n· 猪圈温度过高会有什么影响？'
    }
  };
}

// 扣子（Coze）智能体：流式对话，解析 SSE 取回复
async function handleCozeChat(message, history, images, city) {
  const baseUrl = AGENT.baseUrl || 'https://api.coze.cn';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (AGENT.apiKey || AGENT.token || '')
  };

  // 组装消息（历史 + 本次）
  const msgs = [];
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const c = String(h.content || h.text || '');
    if (c.trim()) msgs.push({ role, content: c, content_type: 'text' });
  }

  // 注入当前环境数据 + 养殖对象患病因子，让智能体结合实时环境判断病因
  const envCtx = buildEnvironmentContext();
  const speciesCtx = buildSpeciesContext(message);
  const realCtx = buildRealKnowledgeContext(message);
  // 当地天气（外部诱因）
  let weatherCtx = '';
  try {
    const w = await getWeather(city || '');
    if (w) weatherCtx = buildWeatherContext(Object.assign({ ok: true }, w));
  } catch (e) { weatherCtx = ''; }

  let contextBlock = '';
  // 实时环境数据是本系统的核心优势，放最前优先判断
  if (envCtx) contextBlock += `【当前养殖环境实时数据（核心依据，优先分析）】\n${envCtx}\n\n`;
  if (weatherCtx) contextBlock += `【当地天气（外部环境诱因）】\n${weatherCtx}\n\n`;
  if (realCtx) contextBlock += `${realCtx}\n\n`;
  if (speciesCtx) contextBlock += `【养殖对象与患病因子（通用知识）】\n${speciesCtx}\n\n`;
  const questionText = contextBlock
    ? `${contextBlock}【用户问题】${message}\n\n请优先基于实时环境数据（尤其是超标项）分析病因与风险，并结合当地天气判断外部诱因；再参考本场历史记录与物种通用知识；需要用药时在末尾给出【推荐药品】段落。`
    : message;

  // 本次消息：有图片用 object_string（多模态），否则纯文本
  if (images && images.length > 0) {
    const objs = [];
    if (questionText.trim()) objs.push({ type: 'text', text: questionText });
    for (const id of images) {
      if (id) objs.push({ type: 'image', file_id: String(id) });
    }
    msgs.push({ role: 'user', content: JSON.stringify(objs), content_type: 'object_string' });
  } else {
    msgs.push({ role: 'user', content: questionText, content_type: 'text' });
  }

  try {
    // 扣子免费额度有瞬时/分钟限流，遇到 4028 自动等几秒重试
    let text = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetchAgent(baseUrl + '/v3/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bot_id: AGENT.botId,
          user_id: AGENT.userId || 'web-user',
          stream: true,             // 流式（auto_save_history=false 时必须是 true）
          auto_save_history: false,
          additional_messages: msgs
        })
      });
      text = await resp.text();
      if (!/4028|Insufficient coze credits/i.test(text)) break;
      if (attempt < 2) {
        console.log('[扣子] 额度限流，' + (2 + attempt * 2) + ' 秒后重试…');
        await sleep(2000 + attempt * 2000);
      }
    }

    // 非流式错误会返回 JSON
    if (text.trim().startsWith('{')) {
      let errData;
      try { errData = JSON.parse(text); } catch (e) { errData = null; }
      const err = (errData && (errData.msg || errData.code)) || '未知错误';
      return { ok: false, error: '扣子接口返回错误：' + err, from: 'coze' };
    }

    // 解析 SSE：event 名在单独一行，data 在下一行
    let answer = '';
    let currentEvent = '';
    let failMsg = '';
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('event:')) {
        currentEvent = t.slice(6).trim();
      } else if (t.startsWith('data:')) {
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const ev = JSON.parse(payload);
          if (currentEvent === 'conversation.chat.failed') {
            failMsg = (ev && ev.last_error && (ev.last_error.msg || ev.last_error.code)) || '扣子返回失败';
          }
          if (currentEvent === 'conversation.message.delta' && ev && typeof ev.content === 'string' && ev.content && ev.content_type === 'text') {
            answer += ev.content;
          } else if (currentEvent === 'conversation.message.completed' && ev && ev.type === 'answer' && ev.content) {
            answer = cozeContentToMarkdown(ev.content, ev.content_type);   // 完整答案，覆盖累加结果
          }
        } catch (e) { /* 跳过无法解析的行 */ }
      }
    }

    // 扣子返回失败（如额度不足）时，把真实原因带回前端
    if (!answer.trim() && failMsg) {
      const friendly = /credit|quota|balance/i.test(failMsg)
        ? '扣子额度不足（' + failMsg + '），请等待额度刷新或升级套餐'
        : failMsg;
      return { ok: false, error: friendly, from: 'coze' };
    }
    if (!answer.trim()) answer = '（未收到回复）';
    return { ok: true, from: 'coze', reply: { role: 'assistant', content: answer } };
  } catch (e) {
    console.error('[扣子] 调用失败：', e.message);
    return { ok: false, error: '扣子接口调用失败：' + e.message, from: 'coze' };
  }
}

function fetchAgent(url, options) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(u, { method: options.method, headers: options.headers, timeout: AGENT.timeoutMs || 30000 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch (e) {
          body = raw;
        }
        resolve({
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(raw),
          status: res.statusCode
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// 启动
loadDevices();
loadConversations();
loadConversationMeta();
loadIllness();
loadQueries();
ensureDeviceChats();

// 每小时把当天新增记录同步到扣子知识库（同一天只推一次）
setInterval(() => {
  syncKnowledgeBase().catch((e) => console.error('[知识库] 同步失败：', e.message));
}, 3600 * 1000);
setTimeout(() => {
  syncKnowledgeBase().catch((e) => console.error('[知识库] 同步失败：', e.message));
}, 30000);

server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('  养殖环境实时监测系统已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  console.log('  局域网访问: http://' + HOST + ':' + PORT);
  console.log('----------------------------------------------------');
  console.log('  ESP32 上报接口:  POST http://<本机IP>:' + PORT + '/api/data');
  console.log('  多设备区分:      通过 URL 路径 /api/data/<设备ID>、');
  console.log('                    查询参数 ?device=<设备ID>、');
  console.log('                    或 JSON 里的 device_id 字段');
  console.log('  智能体接口:      POST http://<本机IP>:' + PORT + '/api/chat');
  console.log('====================================================');
});

// 定时检查离线状态并推送（每 30 秒）
setInterval(() => {
  const changed = [];
  for (const d of devices.values()) {
    if (now() - d.lastSeen >= OFFLINE_AFTER_MS && d._onlineFlag !== false) {
      d._onlineFlag = false;
      changed.push(deviceSummary(d));
    } else if (now() - d.lastSeen < OFFLINE_AFTER_MS && d._onlineFlag !== true) {
      d._onlineFlag = true;
      changed.push(deviceSummary(d));
    }
  }
  if (changed.length) broadcast('device-status', { devices: changed });
}, 30000);
