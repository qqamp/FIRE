/* ============================================================
   modules/deviation/deviation.js — 模組2：組合偏離視覺化
   - 貼上 CSV/表格 → 解析 → 存入共享持股資料（holdings）
   - 實際佔比由現值自動換算（現值缺漏才用 CSV 佔比欄）
   - 現金以代號「現金 / CASH / $」當一列，納入組合總值
   - 輸出：分類層級 treemap（squarified，依設定分類法上色）、
           實際 vs 目標偏離橫條（>5 個百分點高亮）、觸發點燈號列
   - 純診斷，不產出任何買賣建議
   ============================================================ */
import { getHoldings, setHoldings } from '../../core/store.js';
import { getSettings, activeLayers, isExempt } from '../../core/settings.js';

export const id = 'deviation';
export const title = '組合偏離';

const LAYER_COLORS = ['#e0b25a', '#6e9bc0', '#7fbf9a', '#c98b6b', '#9a86c4', '#d4a13c', '#5f9ea0', '#bf7f8a'];
const CASH_COLOR = '#5a626c';

const DEMO = `代號,現值,實際佔比,目標佔比,分類層級
NVDA,1800000,,20,半導體 / 算力
AVGO,900000,,10,半導體 / 算力
ASML,800000,,8,設備 / 製造
TSM,1200000,,12,設備 / 製造
MSFT,1000000,,12,雲端 / 基礎建設
AMZN,700000,,8,雲端 / 基礎建設
GOOGL,900000,,10,模型 / 平台
PLTR,600000,,6,應用 / 軟體
VRT,500000,,6,終端 / 週邊
現金,1100000,,8,現金`;

export function unmount() {}

/* ---------- 工具 ---------- */
function fmt(n) { return (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US'); }
function fmt1(n) { return (n == null || !isFinite(n)) ? '—' : n.toFixed(1); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function isCash(t) { return /^(現金|cash|\$|cash\$|現金\$)$/i.test(String(t).trim()); }
function num(s) { const v = parseFloat(String(s == null ? '' : s).replace(/[%,\s]/g, '')); return isNaN(v) ? null : v; }

/* ---------- CSV 解析 ---------- */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let rows = lines.map(l => l.split(/\t|,/).map(c => c.trim()));
  if (rows.length && num(rows[0][1]) == null) rows = rows.slice(1);
  return rows.map(c => {
    let ticker = c[0] || '', value = num(c[1]), pctGiven = null, target = 0, layer = '未分類';
    if (c.length >= 5) { pctGiven = num(c[2]); target = num(c[3]) || 0; layer = c[4] || '未分類'; }
    else if (c.length === 4) { target = num(c[2]) || 0; layer = c[3] || '未分類'; }
    else if (c.length === 3) { layer = c[2] || '未分類'; }
    return { ticker: ticker.trim(), value, pctGiven, target, layer: String(layer).trim() };
  }).filter(r => r.ticker);
}

function holdingsToCSV(h) {
  if (!h.length) return '';
  return '代號,現值,實際佔比,目標佔比,分類層級\n' +
    h.map(r => `${r.ticker},${r.value},,${r.target},${r.layer}`).join('\n');
}

/* ---------- 計算 ---------- */
function analyze(rows) {
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  const items = rows.map(r => {
    const actual = (r.value != null && total > 0) ? r.value / total * 100
      : (r.pctGiven != null ? r.pctGiven : 0);
    return {
      ticker: r.ticker, value: r.value || 0, layer: r.layer,
      actual, target: r.target || 0, dev: actual - (r.target || 0),
      cash: isCash(r.ticker),
    };
  });
  const cash = items.filter(i => i.cash).reduce((s, i) => s + i.actual, 0);
  const byLayer = {};
  items.forEach(i => { byLayer[i.layer] = (byLayer[i.layer] || 0) + i.actual; });
  return { total, items, cashPct: cash, byLayer };
}

/* ---------- squarified treemap ---------- */
function worstRatio(row, side) {
  const sum = row.reduce((s, c) => s + c.area, 0);
  const mx = Math.max(...row.map(c => c.area)), mn = Math.min(...row.map(c => c.area));
  return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
}
function squarify(children, rect, out) {
  if (!children.length) return;
  if (children.length === 1) { out.push({ ...children[0], ...rect }); return; }
  const { x, y, w, h } = rect;
  const side = Math.min(w, h);
  let row = [children[0]]; let i = 1;
  while (i < children.length) {
    const next = row.concat(children[i]);
    if (worstRatio(row, side) >= worstRatio(next, side)) { row = next; i++; } else break;
  }
  const rowArea = row.reduce((s, c) => s + c.area, 0);
  if (w >= h) {
    const rw = rowArea / h; let cy = y;
    row.forEach(c => { const ch = c.area / rw; out.push({ ...c, x, y: cy, w: rw, h: ch }); cy += ch; });
    squarify(children.slice(row.length), { x: x + rw, y, w: w - rw, h }, out);
  } else {
    const rh = rowArea / w; let cx = x;
    row.forEach(c => { const cw = c.area / rh; out.push({ ...c, x: cx, y, w: cw, h: rh }); cx += cw; });
    squarify(children.slice(row.length), { x, y: y + rh, w, h: h - rh }, out);
  }
}
function buildTreemap(items, W, H) {
  const data = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const total = data.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return [];
  const scaled = data.map(i => ({ ...i, area: i.value / total * (W * H) }));
  const out = [];
  squarify(scaled, { x: 0, y: 0, w: W, h: H }, out);
  return out;
}

/* ---------- 色彩對應 ---------- */
function layerColorMap(items) {
  const layers = []; const seen = new Set();
  activeLayers().forEach(l => { if (!seen.has(l)) { seen.add(l); layers.push(l); } });
  items.forEach(i => { if (!i.cash && !seen.has(i.layer)) { seen.add(i.layer); layers.push(i.layer); } });
  const map = {};
  let ci = 0;
  layers.forEach(l => { map[l] = LAYER_COLORS[ci % LAYER_COLORS.length]; ci++; });
  return map;
}

/* ---------- 渲染輸出 ---------- */
function renderOutput(view, rows) {
  const box = view.querySelector('#dv-out');
  if (!rows.length) {
    box.innerHTML = `<div class="placeholder" style="margin:20px 0"><div class="tag">尚無資料</div><h2>貼上持股或載入示範資料</h2><p>在左側貼上 CSV／表格文字後按「解析並儲存」，或按「載入示範資料」看效果。</p></div>`;
    return;
  }
  const a = analyze(rows);
  const s = getSettings();
  const colors = layerColorMap(a.items);

  const W = 1000, H = 520;
  const tiles = buildTreemap(a.items, W, H);
  const tileSVG = tiles.map(t => {
    const col = t.cash ? CASH_COLOR : (colors[t.layer] || '#888');
    const big = t.w > 70 && t.h > 34;
    const label = big ? `
      <text x="${t.x + 8}" y="${t.y + 20}" fill="#0f1115" font-family="IBM Plex Sans" font-size="15" font-weight="700">${esc(t.ticker)}</text>
      <text x="${t.x + 8}" y="${t.y + 38}" fill="rgba(15,17,21,0.72)" font-family="IBM Plex Mono" font-size="12">${fmt1(t.actual)}%</text>` : '';
    return `<g><rect x="${t.x + 1}" y="${t.y + 1}" width="${Math.max(0, t.w - 2)}" height="${Math.max(0, t.h - 2)}" rx="3" fill="${col}"><title>${esc(t.ticker)} · ${t.layer} · ${fmt(t.value)} · ${fmt1(t.actual)}%</title></rect>${label}</g>`;
  }).join('');
  const usedLayers = [...new Set(a.items.map(i => i.cash ? '現金' : i.layer))];
  const legend = usedLayers.map(l => {
    const col = l === '現金' ? CASH_COLOR : (colors[l] || '#888');
    return `<span class="leg-i"><i style="background:${col}"></i>${esc(l)}</span>`;
  }).join('');

  const maxDev = Math.max(5, ...a.items.map(i => Math.abs(i.dev)));
  const devRows = a.items.slice().sort((x, y) => y.actual - x.actual).map(i => {
    const hot = Math.abs(i.dev) > 5;
    const frac = Math.min(1, Math.abs(i.dev) / maxDev);
    const half = frac * 50;
    const bar = i.dev >= 0
      ? `<div class="dv-fill over${hot ? ' hot' : ''}" style="left:50%;width:${half}%"></div>`
      : `<div class="dv-fill under${hot ? ' hot' : ''}" style="left:${50 - half}%;width:${half}%"></div>`;
    return `<tr class="${hot ? 'dv-hotrow' : ''}">
      <td class="dv-tk">${esc(i.ticker)}${i.cash ? ' <span class="tr-muted">(現金)</span>' : ''}</td>
      <td class="num">${fmt1(i.actual)}%</td>
      <td class="num">${fmt1(i.target)}%</td>
      <td class="dv-track-cell"><div class="dv-track"><div class="dv-center"></div>${bar}</div></td>
      <td class="num dv-dev ${hot ? 'hot' : ''}">${i.dev >= 0 ? '+' : ''}${fmt1(i.dev)}</td>
    </tr>`;
  }).join('');

  const lamps = [];
  a.items.filter(i => !i.cash).forEach(i => {
    if (i.actual >= s.concentration.single) {
      if (isExempt(i.ticker)) {
        lamps.push(`<div class="lampcard exempt"><div class="lc-k">${esc(i.ticker)}</div><div class="lc-v">${fmt1(i.actual)}%</div><div class="lc-x"><span class="badge">豁免</span> 超過集中度觸發點但在豁免清單</div></div>`);
      } else {
        const strong = i.actual >= s.concentration.strong;
        lamps.push(`<div class="lampcard ${strong ? 'bad' : 'warn'}"><div class="lc-k">${esc(i.ticker)}</div><div class="lc-v">${fmt1(i.actual)}%</div><div class="lc-x">${strong ? `超過強檢視觸發點 ${s.concentration.strong}%` : `超過集中度觸發點 ${s.concentration.single}%`}，建議走三層判讀</div></div>`);
      }
    }
  });
  {
    const cp = a.cashPct;
    if (cp < s.cash.low) lamps.push(`<div class="lampcard warn"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">低於舒適區間下緣 ${s.cash.low}%</div></div>`);
    else if (cp > s.cash.high) lamps.push(`<div class="lampcard warn"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">高於舒適區間上緣 ${s.cash.high}%</div></div>`);
    else lamps.push(`<div class="lampcard ok"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">落在舒適區間 ${s.cash.low}–${s.cash.high}%</div></div>`);
  }
  Object.entries(a.byLayer).forEach(([layer, pct]) => {
    if (layer === '現金' || isCash(layer)) return;
    if (pct > s.categoryCap) lamps.push(`<div class="lampcard warn"><div class="lc-k">${esc(layer)}</div><div class="lc-v">${fmt1(pct)}%</div><div class="lc-x">分類合計超過上限 ${s.categoryCap}%</div></div>`);
  });

  box.innerHTML = `
    <div class="zone">
      <div class="q">觸發點燈號</div>
      <div class="lampgrid">${lamps.join('')}</div>
      <div class="chartnote">門檻來自設定頁：集中度 ${s.concentration.single}% / ${s.concentration.strong}%，現金舒適區間 ${s.cash.low}–${s.cash.high}%，分類上限 ${s.categoryCap}%。此處僅做診斷呈現，不含任何買賣建議。</div>
    </div>

    <div class="zone">
      <div class="q">分類層級 treemap</div>
      <div class="panel">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">${tileSVG}</svg>
        <div class="tr-legend">${legend}</div>
      </div>
    </div>

    <div class="zone">
      <div class="q">實際 vs 目標偏離（偏離 &gt; 5 個百分點高亮）</div>
      <div class="tr-tablewrap">
        <table class="tr-table dv-table">
          <thead><tr><th>標的</th><th>實際</th><th>目標</th><th style="text-align:center">偏離（← 不足　超出 →）</th><th>偏離值</th></tr></thead>
          <tbody>${devRows}</tbody>
        </table>
      </div>
      <div class="chartnote">組合總值 ${fmt(a.total)}（含現金）。偏離值＝實際佔比 − 目標佔比（百分點）。</div>
    </div>`;
}

function doParse(view, save) {
  const text = view.querySelector('#dv-input').value;
  const rows = parseCSV(text);
  if (save && rows.length) {
    setHoldings(rows.map(r => ({ ticker: r.ticker, value: r.value || 0, target: r.target || 0, layer: r.layer })));
    flash(view, '已解析並儲存 ✓');
  }
  renderOutput(view, rows);
}

function flash(view, msg) {
  const m = view.querySelector('#dv-msg');
  if (m) { m.textContent = msg; setTimeout(() => { if (m) m.textContent = ''; }, 2500); }
}

export function mount(view) {
  const existing = getHoldings();
  const prefill = existing.length ? holdingsToCSV(existing) : '';

  view.innerHTML = `
    <header><div class="brand">
      <h1>組合偏離視覺化</h1>
      <p>貼上你的持股，工具把「實際長相」攤開來看：分類層級 treemap、每檔實際 vs 目標的偏離、以及對照你設定門檻的觸發點燈號。這裡只做診斷呈現，不告訴你該買該賣。資料只存在你的瀏覽器，並與分批建倉計算器共用。</p>
    </div></header>

    <div class="grid">
      <div class="controls">
        <div class="panel">
          <div class="seclabel">貼上持股</div>
          <div class="field">
            <div class="sub">欄位：代號, 現值, 實際佔比(可空), 目標佔比, 分類層級。實際佔比一律由現值自動換算，該欄可留空、也可整欄省略（改填 4 欄：代號, 現值, 目標佔比, 分類層級）。現金請用代號「現金」或 CASH 當一列。逗號或 Tab 分隔皆可，可含表頭。</div>
            <textarea id="dv-input" rows="12" placeholder="代號,現值,實際佔比,目標佔比,分類層級&#10;NVDA,1800000,,20,半導體 / 算力&#10;現金,1100000,,8,現金">${esc(prefill)}</textarea>
          </div>
          <div class="savebar">
            <button class="btn-primary" id="dv-parse" type="button">解析並儲存</button>
            <button class="btn-ghost" id="dv-demo" type="button">載入示範資料</button>
            <button class="btn-ghost" id="dv-clear" type="button">清空</button>
            <span class="savemsg" id="dv-msg"></span>
          </div>
        </div>
      </div>

      <div class="results" id="dv-out"></div>
    </div>`;

  const q = id => view.querySelector('#' + id);
  q('dv-parse').addEventListener('click', () => doParse(view, true));
  q('dv-demo').addEventListener('click', () => { q('dv-input').value = DEMO; doParse(view, true); });
  q('dv-clear').addEventListener('click', () => {
    if (confirm('清空輸入並從共享持股資料移除？')) { q('dv-input').value = ''; setHoldings([]); renderOutput(view, []); flash(view, '已清空'); }
  });

  renderOutput(view, existing.length ? parseCSV(prefill) : []);
}
