/* ═══════════════════════════════════════════════════════
   StockVision Pro — Frontend Logic
═══════════════════════════════════════════════════════ */

'use strict';

// ── Utilitaire debounce (doit être déclaré en premier) ─
function debounce(fn, delay) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}

// ── State ──────────────────────────────────────────────
let currentTicker  = null;
let currentPeriod  = '1y';
let currentData    = null;
let watchlist      = JSON.parse(localStorage.getItem('svp_watchlist') || '[]');
let chartInstances = {};

// ── Popular stocks ─────────────────────────────────────
const POPULAR = [
  { ticker:'AAPL',  name:'Apple' },
  { ticker:'MSFT',  name:'Microsoft' },
  { ticker:'NVDA',  name:'Nvidia' },
  { ticker:'TSLA',  name:'Tesla' },
  { ticker:'AMZN',  name:'Amazon' },
  { ticker:'GOOGL', name:'Alphabet' },
  { ticker:'META',  name:'Meta' },
  { ticker:'MC.PA', name:'LVMH' },
  { ticker:'TTE.PA',name:'TotalEnergies'},
  { ticker:'OR.PA', name:"L'Oréal" },
  { ticker:'AIR.PA',name:'Airbus' },
  { ticker:'BNP.PA',name:'BNP Paribas' },
];

// ── Glossary ───────────────────────────────────────────
const GLOSSARY = [
  { term:'P/E (Price/Earnings)', def:'Le rapport entre le prix de l\'action et le bénéfice par action. Un P/E élevé peut indiquer que les investisseurs anticipent une forte croissance future.' },
  { term:'Volatilité annualisée', def:'Mesure de l\'amplitude des variations du prix. Plus ce chiffre est élevé, plus l\'action est risquée.' },
  { term:'Ratio de Sharpe', def:'Rapport rendement/risque. Un Sharpe > 1 est considéré comme bon. Plus il est élevé, meilleure est la récompense par unité de risque.' },
  { term:'Bêta (β)', def:'Sensibilité par rapport au marché global. β > 1 : plus volatil que le marché. β < 1 : moins volatil. β < 0 : évolue en sens inverse du marché.' },
  { term:'Drawdown maximum', def:'La pire perte subie depuis un sommet. Un drawdown de -30% signifie que l\'action a déjà chuté de 30% à son pire moment.' },
  { term:'VaR 95%', def:'Value at Risk : la perte maximale probable sur une journée avec 95% de confiance. Par exemple, -2% signifie que vous ne perdrez pas plus de 2% 19 jours sur 20.' },
  { term:'RSI (14j)', def:'Indicateur de momentum (0-100). RSI > 70 = potentiellement suracheté (signal de prudence). RSI < 30 = potentiellement survendu (peut être une opportunité).' },
  { term:'MACD', def:'Indicateur de tendance et de momentum. Quand la ligne MACD croise la ligne signal vers le haut, c\'est un signal d\'achat potentiel.' },
  { term:'Bandes de Bollinger', def:'Deux bandes qui encadrent le prix. Le prix proche de la bande supérieure peut signaler une surexposition, proche de la bande inférieure une sous-évaluation.' },
  { term:'Rendement dividende', def:'Le pourcentage du prix de l\'action versé chaque année en dividendes. Un dividende stable est signe de santé financière.' },
  { term:'ROE (Retour sur FP)', def:'Mesure de la rentabilité des capitaux propres. Un ROE > 15% est généralement considéré comme bon.' },
  { term:'Dette/Fonds Propres', def:'Ratio d\'endettement. Un ratio élevé signifie que l\'entreprise est très endettée, ce qui augmente le risque en cas de ralentissement économique.' },
];

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  buildPopularGrid();
  buildWatchlistUI();
  buildGlossary();
  bindEvents();
  setMarketStatus();
});

function bindEvents() {
  // Search
  const input = document.getElementById('searchInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = input.value.trim().toUpperCase();
      if (v) { loadStock(v); hideSuggestions(); }
    }
  });
  input.addEventListener('input', handleSearchInput);
  document.addEventListener('click', e => { if (!e.target.closest('.search-wrapper')) hideSuggestions(); });

  // Period buttons
  document.querySelectorAll('.period-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      if (currentTicker) loadStock(currentTicker, currentPeriod);
    })
  );

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // AI analysis
  document.getElementById('launchAiBtn').addEventListener('click', () => {
    if (currentTicker) loadAIAnalysis(currentTicker);
  });

  // Watchlist toggle
  document.getElementById('watchlistBtn').addEventListener('click', () => {
    if (currentTicker) toggleWatchlist(currentTicker);
  });
  document.getElementById('clearWatchlist').addEventListener('click', () => {
    watchlist = []; saveWatchlist(); buildWatchlistUI();
  });

  // Compare (sidebar)
  document.getElementById('compareBtn').addEventListener('click', () => {
    const v = document.getElementById('compareInput').value.trim();
    if (v) { switchTab('compare'); runCompare(v); }
  });

  // Compare (main tab)
  document.getElementById('compareBtnMain').addEventListener('click', () => {
    const v = document.getElementById('compareInputMain').value.trim();
    if (v) runCompare(v);
  });
}

// ══════════════════════════════════════════════════════
// SEARCH — dynamique via Yahoo Finance
// ══════════════════════════════════════════════════════
function handleSearchInput(e) {
  const q = e.target.value.trim();
  if (!q || q.length < 2) { hideSuggestions(); return; }

  // Affiche "Recherche en cours…" immédiatement
  const box = document.getElementById('searchSuggestions');
  box.innerHTML = '<div class="suggestion-loading"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Recherche en cours…</div>';
  box.classList.remove('hidden');

  fetchSuggestions(q);
}

const fetchSuggestions = debounce(async (q) => {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const items = await res.json();
    if (!items || items.length === 0) {
      showSuggestionsEmpty(q);
    } else {
      showSuggestions(items);
    }
  } catch {
    hideSuggestions();
  }
}, 380);

function showSuggestions(items) {
  const box = document.getElementById('searchSuggestions');
  box.innerHTML = items.map(s => `
    <div class="suggestion-item" onclick="selectSuggestion('${s.symbol}')">
      <div>
        <span class="suggestion-name">${s.name}</span>
        <span class="suggestion-exchange">${s.exchange ? ' · ' + s.exchange : ''}</span>
      </div>
      <div style="display:flex;align-items:center;gap:.4rem">
        <span class="suggestion-type">${s.type}</span>
        <span class="suggestion-ticker">${s.symbol}</span>
      </div>
    </div>`).join('');
  box.classList.remove('hidden');
}

function showSuggestionsEmpty(q) {
  const box = document.getElementById('searchSuggestions');
  box.innerHTML = `<div class="suggestion-loading">Aucun résultat pour « ${q} ». Essayez le symbole exact (ex : MC.PA pour LVMH).</div>`;
  box.classList.remove('hidden');
}

function selectSuggestion(symbol) {
  hideSuggestions();
  document.getElementById('searchInput').value = '';
  loadStock(symbol);
}

function hideSuggestions() {
  document.getElementById('searchSuggestions').classList.add('hidden');
}

// ══════════════════════════════════════════════════════
// LOAD STOCK
// ══════════════════════════════════════════════════════
async function loadStock(ticker, period) {
  ticker = ticker.toUpperCase().trim();
  period = period || currentPeriod;
  currentTicker = ticker;
  currentPeriod = period;

  showLoading('Chargement des données pour ' + ticker + '…');
  hideSuggestions();
  document.getElementById('searchInput').value = '';

  try {
    const res = await fetch(`/api/stock/${ticker}?period=${period}`);
    const data = await res.json();

    if (data.error) { toast('Erreur : ' + data.error, 'error'); hideLoading(); return; }

    currentData = data;
    showDashboard(data);
    resetAITab();
  } catch (e) {
    toast('Erreur réseau : ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

function showDashboard(data) {
  document.getElementById('welcomeScreen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');

  const { company, financials, risk, chart } = data;

  // Header
  const logo = document.getElementById('stockLogo');
  if (company.logo) { logo.src = company.logo; logo.classList.remove('hidden'); }
  else logo.classList.add('hidden');

  document.getElementById('stockName').textContent     = company.name;
  document.getElementById('stockTicker').textContent   = company.symbol;
  document.getElementById('stockExchange').textContent = company.exchange;
  document.getElementById('stockMeta').textContent     = [company.sector, company.industry, company.country].filter(Boolean).join(' · ');
  document.getElementById('currentPrice').textContent  = fmt(financials.current_price);
  document.getElementById('currency').textContent      = company.currency;

  const ch = financials.day_change;
  const cp = financials.day_change_pct;
  const sign = ch >= 0 ? '+' : '';
  const cls  = ch >= 0 ? 'positive' : 'negative';
  document.getElementById('dayChange').innerHTML = `<span class="${cls}">${sign}${fmt(ch)} (${sign}${fmt(cp)}%)</span>`;

  // Watchlist button
  const wlBtn = document.getElementById('watchlistBtn');
  wlBtn.textContent = watchlist.includes(company.symbol) ? '★' : '☆';
  wlBtn.classList.toggle('active', watchlist.includes(company.symbol));

  // KPI row
  renderKPIs(financials, risk);

  // Charts
  destroyCharts();
  renderPriceChart(chart);
  renderVolumeChart(chart);

  // Performance
  renderPerformance(risk);
  renderRiskCards(risk);

  // Company info
  document.getElementById('companyDescription').textContent = company.description || '(Description non disponible)';
  renderCompanyDetails(company, financials);

  // Technical tab charts
  renderRSIChart(chart, risk);
  renderMACDChart(chart, risk);
  renderBollingerChart(chart);
  renderReturnsChart(chart);

  // Fundamentals
  renderFundamentals(financials);

  switchTab('overview');
}

// ── KPIs ────────────────────────────────────────────────
function renderKPIs(fin, risk) {
  const items = [
    { label: 'Capitalisation', value: fmtMarketCap(fin.market_cap), hint: '' },
    { label: 'P/E Ratio',      value: fin.pe_ratio || '—', hint: 'Trailing' },
    { label: 'P/E Forward',    value: fin.forward_pe || '—', hint: 'Prévisionnel' },
    { label: 'P/B Ratio',      value: fin.pb_ratio || '—', hint: '' },
    { label: 'Dividende',      value: fin.dividend_yield ? fin.dividend_yield + '%' : '—', hint: 'Annuel' },
    { label: 'BPA (EPS)',      value: fin.eps || '—', hint: '' },
    { label: '52S Haut',       value: fmt(fin.week52_high), hint: '' },
    { label: '52S Bas',        value: fmt(fin.week52_low), hint: '' },
    { label: 'Volume',         value: fmtVol(fin.volume), hint: 'Aujourd\'hui' },
    { label: 'Vol. Moy.',      value: fmtVol(fin.avg_volume), hint: '30j' },
    { label: 'Bêta',           value: risk.beta, hint: 'vs S&P 500' },
    { label: 'RSI (14j)',      value: risk.current_rsi, hint: rsiHint(risk.current_rsi) },
  ];

  document.getElementById('kpiRow').innerHTML = items.map(i => `
    <div class="kpi-card">
      <span class="kpi-label">${i.label}</span>
      <span class="kpi-value">${i.value}</span>
      ${i.hint ? `<span class="kpi-hint">${i.hint}</span>` : ''}
    </div>`).join('');
}

// ── Performance & Risk cards ────────────────────────────
function renderPerformance(risk) {
  const items = [
    { label: '1 Semaine', value: risk.returns_1w },
    { label: '1 Mois',    value: risk.returns_1m },
    { label: '3 Mois',    value: risk.returns_3m },
    { label: '6 Mois',    value: risk.returns_6m },
    { label: '1 An',      value: risk.returns_1y },
    { label: 'Annualisé', value: risk.annual_return },
  ];
  document.getElementById('performanceCards').innerHTML = items.map(i => {
    const cls = i.value >= 0 ? 'positive' : 'negative';
    const sign = i.value >= 0 ? '+' : '';
    return `<div class="perf-card">
      <span class="perf-label">${i.label}</span>
      <span class="perf-value ${cls}">${sign}${fmt(i.value)}%</span>
    </div>`;
  }).join('');
}

function renderRiskCards(risk) {
  const score = risk.risk_score;
  const gaugeColor = score <= 3 ? '#10b981' : score <= 6 ? '#f59e0b' : '#ef4444';
  const riskLabel  = score <= 3 ? 'Faible' : score <= 5 ? 'Modéré' : score <= 7 ? 'Élevé' : 'Très élevé';

  document.getElementById('riskCards').innerHTML = `
    <div class="risk-row">
      <span class="risk-key">Score de risque</span>
      <span class="risk-val">${score}/10 — <span style="color:${gaugeColor}">${riskLabel}</span></span>
    </div>
    <div class="risk-gauge-wrap">
      <div class="risk-gauge-bar">
        <div class="risk-gauge-fill" style="width:${score*10}%;background:${gaugeColor}"></div>
      </div>
    </div>
    <div class="risk-row"><span class="risk-key">Volatilité annuelle</span><span class="risk-val">${fmt(risk.annual_volatility)}%</span></div>
    <div class="risk-row"><span class="risk-key">Ratio de Sharpe</span><span class="risk-val">${fmt(risk.sharpe_ratio)}</span></div>
    <div class="risk-row"><span class="risk-key">Drawdown max.</span><span class="risk-val negative">${fmt(risk.max_drawdown)}%</span></div>
    <div class="risk-row"><span class="risk-key">VaR 95% (1 jour)</span><span class="risk-val negative">${fmt(risk.var_95)}%</span></div>
    <div class="risk-row"><span class="risk-key">Position 52 semaines</span><span class="risk-val">${risk.week52_position}%</span></div>
  `;
}

// ── Company details ─────────────────────────────────────
function renderCompanyDetails(company, fin) {
  document.getElementById('companyDetails').innerHTML = [
    { label: 'Secteur',   value: company.sector },
    { label: 'Industrie', value: company.industry },
    { label: 'Pays',      value: company.country },
    { label: 'Employés',  value: fmtNumber(company.employees) },
    { label: 'Site web',  value: company.website ? `<a href="${company.website}" target="_blank" style="color:var(--blue)">${company.website}</a>` : '—' },
    { label: 'Marge nette', value: fin.profit_margin ? fin.profit_margin + '%' : '—' },
    { label: 'ROE',       value: fin.roe ? fin.roe + '%' : '—' },
    { label: 'Free Cash Flow', value: fmtMarketCap(fin.free_cashflow) },
  ].map(d => `<div class="detail-item"><span class="detail-label">${d.label}</span><span class="detail-value">${d.value || '—'}</span></div>`).join('');
}

// ── Fundamentals ────────────────────────────────────────
function renderFundamentals(fin) {
  document.getElementById('valuationMetrics').innerHTML = [
    { key: 'P/E Trailing',  val: fin.pe_ratio  || '—', hint: 'Price / Earnings' },
    { key: 'P/E Forward',   val: fin.forward_pe || '—', hint: 'Prévisionnel' },
    { key: 'P/B Ratio',     val: fin.pb_ratio   || '—', hint: 'Price / Book' },
    { key: 'P/S Ratio',     val: fin.ps_ratio   || '—', hint: 'Price / Sales' },
    { key: 'PEG Ratio',     val: fin.peg_ratio  || '—', hint: 'P/E / Croissance' },
    { key: 'Dividende',     val: fin.dividend_yield ? fin.dividend_yield + '%' : '—', hint: 'Rendement annuel' },
    { key: 'BPA (EPS)',     val: fin.eps || '—', hint: '' },
    { key: 'Capi. bours.', val: fmtMarketCap(fin.market_cap), hint: '' },
  ].map(r => metricRow(r.key, r.val, r.hint)).join('');

  document.getElementById('profitabilityMetrics').innerHTML = [
    { key: 'Marge brute',    val: fin.gross_margin   ? fin.gross_margin   + '%' : '—' },
    { key: 'Marge EBITDA',   val: fin.ebitda_margin  ? fin.ebitda_margin  + '%' : '—' },
    { key: 'Marge nette',    val: fin.profit_margin  ? fin.profit_margin  + '%' : '—' },
    { key: 'ROE',            val: fin.roe ? fin.roe + '%' : '—', hint: 'Retour sur fonds propres' },
    { key: 'ROA',            val: fin.roa ? fin.roa + '%' : '—', hint: 'Retour sur actifs' },
    { key: 'Revenu total',   val: fmtMarketCap(fin.revenue) },
    { key: 'Free Cash Flow', val: fmtMarketCap(fin.free_cashflow) },
  ].map(r => metricRow(r.key, r.val, r.hint || '')).join('');

  document.getElementById('structureMetrics').innerHTML = [
    { key: 'Dette / FP',    val: fin.debt_equity   || '—', hint: 'Levier financier' },
    { key: 'Ratio courant', val: fin.current_ratio || '—', hint: 'Liquidités court terme' },
    { key: 'Ratio rapide',  val: fin.quick_ratio   || '—', hint: 'Sans stocks' },
    { key: 'Plus haut 52S', val: fmt(fin.week52_high) },
    { key: 'Plus bas 52S',  val: fmt(fin.week52_low) },
    { key: 'Volume moyen',  val: fmtVol(fin.avg_volume) },
    { key: 'Employés',      val: fmtNumber(fin.employees) },
  ].map(r => metricRow(r.key, r.val, r.hint || '')).join('');
}

function metricRow(key, val, hint) {
  return `<div class="metric-row">
    <div><span class="metric-key">${key}</span>${hint ? `<br><span class="metric-hint">${hint}</span>` : ''}</div>
    <span class="metric-val">${val}</span>
  </div>`;
}

function buildGlossary() {
  document.getElementById('glossaryGrid').innerHTML = GLOSSARY.map(g =>
    `<div class="glossary-item"><div class="glossary-term">${g.term}</div><div class="glossary-def">${g.def}</div></div>`
  ).join('');
}

// ══════════════════════════════════════════════════════
// CHARTS
// ══════════════════════════════════════════════════════
const chartDefaults = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, backgroundColor: '#1c2540', borderColor: '#2d3748', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#94a3b8' } },
  scales: {
    x: { ticks: { color: '#64748b', maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } },
    y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.06)' } },
  },
};

function destroyCharts() {
  Object.values(chartInstances).forEach(c => { try { c.destroy(); } catch(e){} });
  chartInstances = {};
}

function getCtx(id) {
  const canvas = document.getElementById(id);
  return canvas ? canvas.getContext('2d') : null;
}

function renderPriceChart(chart) {
  const ctx = getCtx('priceChart'); if (!ctx) return;
  const trimFn = arr => arr.map(v => v === null ? null : parseFloat(v));
  chartInstances.price = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chart.dates,
      datasets: [
        { label:'Prix', data: trimFn(chart.close), borderColor:'#3b82f6', borderWidth:2, pointRadius:0, tension:0.1, fill: false },
        { label:'MM20', data: trimFn(chart.ma20),  borderColor:'#f59e0b', borderWidth:1.5, pointRadius:0, borderDash:[4,4], tension:0.1, fill:false },
        { label:'MM50', data: trimFn(chart.ma50),  borderColor:'#a855f7', borderWidth:1.5, pointRadius:0, borderDash:[4,4], tension:0.1, fill:false },
        { label:'MM200',data: trimFn(chart.ma200), borderColor:'#ef4444', borderWidth:1.5, pointRadius:0, borderDash:[4,4], tension:0.1, fill:false },
      ],
    },
    options: { ...chartDefaults, spanGaps: true },
  });
}

function renderVolumeChart(chart) {
  const ctx = getCtx('volumeChart'); if (!ctx) return;
  const colors = chart.close.map((v, i) => i === 0 ? '#3b82f6' : (v >= chart.close[i-1] ? 'rgba(16,185,129,.6)' : 'rgba(239,68,68,.6)'));
  chartInstances.volume = new Chart(ctx, {
    type: 'bar',
    data: { labels: chart.dates, datasets: [{ label:'Volume', data: chart.volume, backgroundColor: colors, borderWidth: 0 }] },
    options: { ...chartDefaults },
  });
}

function renderRSIChart(chart, risk) {
  const ctx = getCtx('rsiChart'); if (!ctx) return;
  const badge = document.getElementById('rsiValue');
  const rsi = risk.current_rsi;
  badge.textContent = rsi;
  badge.style.background = rsi > 70 ? 'rgba(239,68,68,.2)' : rsi < 30 ? 'rgba(16,185,129,.2)' : 'rgba(59,130,246,.15)';
  badge.style.color = rsi > 70 ? '#ef4444' : rsi < 30 ? '#10b981' : '#3b82f6';

  chartInstances.rsi = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chart.dates,
      datasets: [{ label:'RSI', data: chart.rsi, borderColor:'#a855f7', borderWidth:2, pointRadius:0, tension:0.1, fill:false, spanGaps:true }],
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        annotation: { annotations: {
          ob: { type:'line', yMin:70, yMax:70, borderColor:'rgba(239,68,68,.5)', borderWidth:1, borderDash:[4,4] },
          os: { type:'line', yMin:30, yMax:30, borderColor:'rgba(16,185,129,.5)', borderWidth:1, borderDash:[4,4] },
        }}
      },
      scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min:0, max:100 } },
    },
  });
}

function renderMACDChart(chart, risk) {
  const ctx = getCtx('macdChart'); if (!ctx) return;
  const macd = risk.current_macd;
  const sig  = risk.macd_signal_val;
  const badge = document.getElementById('macdSignal');
  const isBullish = macd > sig;
  badge.textContent = isBullish ? '↑ Haussier' : '↓ Baissier';
  badge.style.background = isBullish ? 'rgba(16,185,129,.2)'  : 'rgba(239,68,68,.2)';
  badge.style.color       = isBullish ? '#10b981' : '#ef4444';

  const histColors = (chart.macd_hist || []).map(v => (v || 0) >= 0 ? 'rgba(16,185,129,.6)' : 'rgba(239,68,68,.6)');
  chartInstances.macd = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: chart.dates,
      datasets: [
        { type:'line', label:'MACD',   data:chart.macd,        borderColor:'#3b82f6', borderWidth:2, pointRadius:0, tension:0.1, fill:false, spanGaps:true },
        { type:'line', label:'Signal', data:chart.macd_signal, borderColor:'#f59e0b', borderWidth:1.5, borderDash:[3,3], pointRadius:0, tension:0.1, fill:false, spanGaps:true },
        { type:'bar',  label:'Histo',  data:chart.macd_hist,   backgroundColor:histColors, borderWidth:0 },
      ],
    },
    options: { ...chartDefaults },
  });
}

function renderBollingerChart(chart) {
  const ctx = getCtx('bollingerChart'); if (!ctx) return;
  chartInstances.bollinger = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chart.dates,
      datasets: [
        { label:'Bande sup.',  data:chart.bb_upper, borderColor:'rgba(239,68,68,.5)', borderWidth:1, borderDash:[3,3], pointRadius:0, fill:false, tension:0.1, spanGaps:true },
        { label:'Milieu',      data:chart.bb_mid,   borderColor:'rgba(148,163,184,.4)', borderWidth:1, borderDash:[3,3], pointRadius:0, fill:false, tension:0.1, spanGaps:true },
        { label:'Bande inf.',  data:chart.bb_lower, borderColor:'rgba(16,185,129,.5)', borderWidth:1, borderDash:[3,3], pointRadius:0, fill:1, tension:0.1, backgroundColor:'rgba(59,130,246,.05)', spanGaps:true },
        { label:'Prix',        data:chart.close,    borderColor:'#3b82f6', borderWidth:2, pointRadius:0, fill:false, tension:0.1 },
      ],
    },
    options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display:true, labels:{ color:'#94a3b8', font:{size:10} } } } },
  });
}

function renderReturnsChart(chart) {
  const ctx = getCtx('returnsChart'); if (!ctx) return;
  const returns = (chart.returns_pct || []).filter(v => v !== null);
  const min = Math.min(...returns), max = Math.max(...returns);
  const bins = 40;
  const step = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  const labels = [];
  for (let i = 0; i < bins; i++) {
    const lo = min + i * step;
    labels.push(fmt(lo));
    returns.forEach(r => { if (r >= lo && r < lo + step) counts[i]++; });
  }
  const barColors = labels.map(l => parseFloat(l) >= 0 ? 'rgba(16,185,129,.7)' : 'rgba(239,68,68,.7)');
  chartInstances.returns = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label:'Fréquence', data:counts, backgroundColor:barColors, borderWidth:0 }] },
    options: { ...chartDefaults },
  });
}

// ══════════════════════════════════════════════════════
// AI ANALYSIS
// ══════════════════════════════════════════════════════
async function loadAIAnalysis(ticker) {
  document.getElementById('aiPlaceholder').classList.add('hidden');
  document.getElementById('aiLoading').classList.remove('hidden');
  document.getElementById('aiResults').classList.add('hidden');

  try {
    const res  = await fetch(`/api/ai-analysis/${ticker}?period=${currentPeriod}`);
    const data = await res.json();

    if (data.error) {
      toast('Erreur IA : ' + data.error, 'error');
      document.getElementById('aiPlaceholder').classList.remove('hidden');
      return;
    }

    renderAIResults(data);
  } catch (e) {
    toast('Erreur réseau : ' + e.message, 'error');
    document.getElementById('aiPlaceholder').classList.remove('hidden');
  } finally {
    document.getElementById('aiLoading').classList.add('hidden');
  }
}

function renderAIResults(d) {
  // Badge recommendation
  const badge = document.getElementById('aiRecBadge');
  badge.textContent = d.recommendation || '—';
  badge.className   = `rec-badge rec-${d.recommendation}`;

  // Conviction bar
  const conv = d.score_conviction || 0;
  document.getElementById('convictionBar').style.width = (conv * 10) + '%';
  document.getElementById('convictionVal').textContent  = conv + '/10';

  // Risk badge
  const riskKey = (d.niveau_risque || '').replace(/\s/g, '-');
  document.getElementById('aiRiskBadge').textContent  = d.niveau_risque || '—';
  document.getElementById('aiRiskBadge').className    = `risk-badge-ai risk-${riskKey}`;

  document.getElementById('aiHorizon').textContent   = d.horizon || '—';
  document.getElementById('aiResume').textContent    = d.resume  || '';

  // Lists
  renderList('aiStrengths',  d.points_forts   || []);
  renderList('aiWeaknesses', d.points_faibles || []);
  renderList('aiCatalysts',  d.catalyseurs    || []);
  renderList('aiRisks',      d.risques_cles   || []);

  // Analyses
  document.getElementById('aiTechnical').textContent   = d.analyse_technique   || '—';
  document.getElementById('aiFundamental').textContent = d.analyse_fondamentale || '—';
  document.getElementById('aiRisk').textContent        = d.analyse_risque       || '—';

  // Price target bar
  if (d.prix_cible_bas && d.prix_cible_haut && currentData) {
    renderPriceTarget(d.prix_cible_bas, d.prix_cible_haut, currentData.financials.current_price);
  }

  // Advice
  document.getElementById('aiAdvice').textContent      = d.conseil_debutant     || '—';
  document.getElementById('aiAllocation').textContent  = d.position_portefeuille || '—';

  document.getElementById('aiResults').classList.remove('hidden');
}

function renderList(id, items) {
  document.getElementById(id).innerHTML = items.map(i => `<li>${i}</li>`).join('');
}

function renderPriceTarget(lo, hi, cur) {
  const range = hi - lo;
  const curPct = Math.min(100, Math.max(0, (cur - lo) / (range || 1) * 100));
  document.getElementById('priceTargetBar').innerHTML = `
    <div class="pt-labels">
      <span>Bas : ${fmt(lo)}</span>
      <span>Actuel : ${fmt(cur)}</span>
      <span>Haut : ${fmt(hi)}</span>
    </div>
    <div class="pt-bar-outer">
      <div class="pt-bar-range" style="left:0;width:100%"></div>
      <div class="pt-bar-current" style="left:${curPct}%"></div>
    </div>
    <div class="pt-legend">
      <span><span style="display:inline-block;width:8px;height:8px;background:var(--blue);opacity:.5;border-radius:2px"></span> Zone cible</span>
      <span><span style="display:inline-block;width:4px;height:12px;background:var(--yellow);border-radius:2px"></span> Prix actuel</span>
    </div>`;
}

function resetAITab() {
  document.getElementById('aiPlaceholder').classList.remove('hidden');
  document.getElementById('aiLoading').classList.add('hidden');
  document.getElementById('aiResults').classList.add('hidden');
}

// ══════════════════════════════════════════════════════
// COMPARE
// ══════════════════════════════════════════════════════
async function runCompare(input) {
  const tickers = input.split(',').map(t => t.trim()).filter(Boolean).join(',');
  document.getElementById('compareLoading').classList.remove('hidden');
  document.getElementById('compareResults').classList.add('hidden');

  try {
    const res  = await fetch(`/api/compare?tickers=${encodeURIComponent(tickers)}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) { toast('Aucune donnée trouvée.', 'error'); return; }
    renderCompare(data);
  } catch (e) {
    toast('Erreur : ' + e.message, 'error');
  } finally {
    document.getElementById('compareLoading').classList.add('hidden');
  }
}

const COMPARE_COLORS = ['#3b82f6','#10b981','#f59e0b','#a855f7','#ef4444','#06b6d4'];

function renderCompare(items) {
  // Normalize chart data to % returns from start
  const ctx = getCtx('compareChart');
  if (ctx) {
    if (chartInstances.compare) { chartInstances.compare.destroy(); }
    const datasets = items.map((item, i) => {
      const start = item.chart_close[0] || 1;
      return {
        label: item.ticker,
        data:  item.chart_close.map(v => parseFloat(((v - start) / start * 100).toFixed(2))),
        borderColor: COMPARE_COLORS[i % COMPARE_COLORS.length],
        borderWidth: 2, pointRadius: 0, tension: 0.1, fill: false,
      };
    });
    chartInstances.compare = new Chart(ctx, {
      type: 'line',
      data: { labels: items[0].chart_dates, datasets },
      options: {
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, legend: { display:true, labels:{ color:'#94a3b8', font:{size:11} } } },
        scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, ticks: { ...chartDefaults.scales.y.ticks, callback: v => v + '%' } } },
      },
    });
  }

  // Table
  const cols = ['Ticker','Nom','Prix','Rendement 1A','Volatilité','Sharpe','Bêta','P/E','Dividende','Drawdown Max'];
  const header = `<thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
  const body = items.map(item => {
    const retCls = item.ytd_return >= 0 ? 'positive' : 'negative';
    const retSign = item.ytd_return >= 0 ? '+' : '';
    return `<tr>
      <td class="ticker-cell" onclick="loadStock('${item.ticker}')" style="cursor:pointer">${item.ticker}</td>
      <td>${item.name}</td>
      <td>${fmt(item.current_price)} ${item.currency}</td>
      <td class="${retCls}">${retSign}${fmt(item.ytd_return)}%</td>
      <td>${fmt(item.annual_vol)}%</td>
      <td>${fmt(item.sharpe)}</td>
      <td>${fmt(item.beta)}</td>
      <td>${item.pe || '—'}</td>
      <td>${item.div_yield ? item.div_yield + '%' : '—'}</td>
      <td class="negative">${fmt(item.max_drawdown)}%</td>
    </tr>`;
  }).join('');
  document.getElementById('compareTable').innerHTML = header + `<tbody>${body}</tbody>`;

  document.getElementById('compareResults').classList.remove('hidden');
}

// ══════════════════════════════════════════════════════
// POPULAR GRID & WATCHLIST
// ══════════════════════════════════════════════════════
function buildPopularGrid() {
  document.getElementById('popularGrid').innerHTML = POPULAR.map(s =>
    `<div class="popular-chip" onclick="loadStock('${s.ticker}')">
      <span class="chip-ticker">${s.ticker}</span>
      <span class="chip-name">${s.name}</span>
    </div>`).join('');
}

function toggleWatchlist(ticker) {
  const idx = watchlist.indexOf(ticker);
  if (idx >= 0) { watchlist.splice(idx, 1); toast(ticker + ' retiré de la liste', 'info'); }
  else           { watchlist.push(ticker);   toast(ticker + ' ajouté à la liste', 'success'); }
  saveWatchlist();
  buildWatchlistUI();
  const btn = document.getElementById('watchlistBtn');
  btn.textContent = watchlist.includes(ticker) ? '★' : '☆';
  btn.classList.toggle('active', watchlist.includes(ticker));
}

function saveWatchlist() { localStorage.setItem('svp_watchlist', JSON.stringify(watchlist)); }

function buildWatchlistUI() {
  const el = document.getElementById('watchlistContainer');
  if (watchlist.length === 0) {
    el.className = 'watchlist-empty';
    el.innerHTML = '<p>Recherchez une action et cliquez sur ★ pour l\'ajouter</p>';
  } else {
    el.className = '';
    el.innerHTML = watchlist.map(t =>
      `<div class="watchlist-item">
        <span class="wl-ticker" onclick="loadStock('${t}')">${t}</span>
        <button class="wl-remove" onclick="toggleWatchlist('${t}')">✕</button>
      </div>`
    ).join('');
  }
}

// ══════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(c => {
    const id = c.id.replace('tab-', '');
    c.classList.toggle('hidden', id !== tabId);
  });
  // Resize charts on tab switch
  setTimeout(() => Object.values(chartInstances).forEach(c => { try { c.resize(); } catch(e){} }), 50);
}

// ══════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════
function showLoading(msg) {
  document.getElementById('loadingMsg').textContent = msg || 'Chargement…';
  document.getElementById('loadingOverlay').classList.remove('hidden');
}
function hideLoading() { document.getElementById('loadingOverlay').classList.add('hidden'); }

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast';
  if (type === 'error')   el.style.borderColor = 'var(--red)';
  else if (type === 'success') el.style.borderColor = 'var(--green)';
  else el.style.borderColor = 'var(--border)';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function fmt(v) { return v === null || v === undefined ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function fmtMarketCap(v) {
  if (!v) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(2) + ' B$';
  if (abs >= 1e9)  return (v / 1e9).toFixed(2)  + ' Md$';
  if (abs >= 1e6)  return (v / 1e6).toFixed(2)  + ' M$';
  return v.toLocaleString('fr-FR');
}

function fmtVol(v)    { if (!v) return '—'; if (v >= 1e9) return (v/1e9).toFixed(2)+'B'; if (v >= 1e6) return (v/1e6).toFixed(2)+'M'; if (v >= 1e3) return (v/1e3).toFixed(0)+'K'; return v; }
function fmtNumber(v) { if (!v || v === 'N/A') return '—'; return Number(v).toLocaleString('fr-FR'); }
function rsiHint(rsi) { if (rsi > 70) return 'Suracheté'; if (rsi < 30) return 'Survendu'; return 'Neutre'; }

function setMarketStatus() {
  const now = new Date();
  const h = now.getUTCHours();
  const d = now.getUTCDay();
  const isOpen = d >= 1 && d <= 5 && h >= 14 && h < 21;
  const el = document.getElementById('marketStatus');
  el.textContent = isOpen ? '● NYSE Ouvert' : '○ NYSE Fermé';
  el.style.color = isOpen ? 'var(--green)' : 'var(--text3)';
}
