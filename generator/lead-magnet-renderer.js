'use strict';

// --- Shared CSS ---
const SHARED_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --ink: #0a0a0a;
  --cream: #FDFCF9;
  --primary: #4f46e5;
  --primary-light: #6366f1;
  --primary-dark: #4338ca;
  --success: #059669;
  --success-light: #d1fae5;
  --warning: #d97706;
  --warning-light: #fef3c7;
  --danger: #dc2626;
  --danger-light: #fee2e2;
  --gray-100: #f3f4f6;
  --gray-200: #e5e7eb;
  --gray-300: #d1d5db;
  --gray-400: #9ca3af;
  --gray-500: #6b7280;
  --gray-600: #4b5563;
  --gray-700: #374151;
  --radius: 16px;
  --radius-sm: 10px;
}

body {
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--cream);
  color: var(--ink);
  line-height: 1.7;
  font-size: 17px;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4 { font-family: 'Fraunces', Georgia, serif; line-height: 1.2; }

.container {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 24px;
}

.header {
  text-align: center;
  margin-bottom: 48px;
}

.header-brand {
  font-family: 'Fraunces', serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--primary);
  text-transform: uppercase;
  letter-spacing: 2px;
  margin-bottom: 8px;
}

.header-badge {
  display: inline-block;
  background: linear-gradient(135deg, var(--primary), var(--primary-light));
  color: white;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 16px;
  border-radius: 100px;
  margin-bottom: 24px;
  font-family: 'Outfit', sans-serif;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.header h1 {
  font-size: 2.75rem;
  font-weight: 700;
  color: var(--ink);
  margin-bottom: 12px;
  letter-spacing: -1px;
}

.header .subtitle {
  font-size: 1.15rem;
  color: var(--gray-500);
  max-width: 600px;
  margin: 0 auto;
}

.card {
  background: white;
  border-radius: var(--radius);
  box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 40px rgba(0,0,0,0.08);
  padding: 32px;
  margin-bottom: 24px;
}

.card-header {
  font-size: 1.35rem;
  font-weight: 600;
  margin-bottom: 20px;
  color: var(--ink);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px 32px;
  border: none;
  border-radius: 100px;
  font-family: 'Outfit', sans-serif;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary {
  background: var(--primary);
  color: white;
}
.btn-primary:hover { background: var(--primary-dark); transform: translateY(-1px); }

.btn-outline {
  background: transparent;
  color: var(--primary);
  border: 2px solid var(--primary);
}
.btn-outline:hover { background: var(--primary); color: white; }

.btn-sm { padding: 8px 20px; font-size: 14px; }

.progress-bar-container {
  background: var(--gray-200);
  border-radius: 100px;
  height: 10px;
  overflow: hidden;
  margin-bottom: 8px;
}

.progress-bar-fill {
  height: 100%;
  border-radius: 100px;
  background: linear-gradient(90deg, var(--primary), var(--primary-light));
  transition: width 0.5s ease;
}

.result-panel {
  background: linear-gradient(135deg, var(--primary), var(--primary-light));
  color: white;
  border-radius: var(--radius);
  padding: 40px;
  text-align: center;
  margin: 32px 0;
  display: none;
}

.result-panel.visible { display: block; }

.result-panel h2 { color: white; font-size: 2rem; margin-bottom: 8px; }
.result-panel .result-score { font-size: 4rem; font-weight: 700; font-family: 'Fraunces', serif; }
.result-panel .result-label { font-size: 1.25rem; opacity: 0.9; margin-top: 8px; }
.result-panel .result-desc { margin-top: 16px; opacity: 0.85; max-width: 500px; margin-left: auto; margin-right: auto; }

.cta-section {
  text-align: center;
  padding: 48px 24px;
  margin-top: 32px;
}

.cta-section h2 {
  font-size: 1.75rem;
  margin-bottom: 12px;
}

.cta-section p {
  color: var(--gray-500);
  margin-bottom: 24px;
  max-width: 500px;
  margin-left: auto;
  margin-right: auto;
}

.footer {
  text-align: center;
  padding: 32px;
  color: var(--gray-400);
  font-size: 14px;
  border-top: 1px solid var(--gray-200);
  margin-top: 48px;
}

.footer strong { color: var(--gray-600); }

@media (max-width: 640px) {
  .container { padding: 24px 16px; }
  .header h1 { font-size: 2rem; }
  .card { padding: 20px; }
}

@media print {
  body { background: white; }
  .btn, .cta-section { display: none; }
  .card { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; }
}
`;

// --- Shared HTML shell ---
function wrapHTML(title, subtitle, typeLabel, bodyHTML, scriptJS = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — Mortar Metrics</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="header-brand">Mortar Metrics</div>
    <div class="header-badge">${esc(typeLabel)}</div>
    <h1>${esc(title)}</h1>
    <p class="subtitle">${esc(subtitle)}</p>
  </div>
  ${bodyHTML}
  <div class="cta-section">
    <h2>Want a custom version for your firm?</h2>
    <p>We build personalized marketing strategies that deliver signed cases, not just leads.</p>
    <a href="https://mortarmetrics.com" class="btn btn-primary">Book a Free Strategy Call</a>
  </div>
  <div class="footer">
    Built by <strong>Mortar Metrics</strong> — Legal Marketing That Delivers Cases
  </div>
</div>
${scriptJS ? `<script>${scriptJS}</script>` : ''}
</body>
</html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Type renderers ---

function renderScorecard(data) {
  const questions = data.sections || [];
  const tiers = data.result_tiers || [
    { min: 0, max: 3, label: 'Needs Work', description: 'Significant room for improvement.', color: '#dc2626' },
    { min: 4, max: 6, label: 'Fair', description: 'You have a foundation but gaps remain.', color: '#d97706' },
    { min: 7, max: 9, label: 'Good', description: 'Solid performance with room to optimize.', color: '#2563eb' },
    { min: 10, max: 100, label: 'Excellent', description: 'Top-tier performance. Keep it up!', color: '#059669' }
  ];

  let html = '';
  questions.forEach((q, i) => {
    const options = (q.options || []).map((opt, j) =>
      `<label class="sc-option">
        <input type="radio" name="q${i}" value="${opt.score || 0}" onchange="updateScore()">
        <span class="sc-option-text">${esc(opt.label)}</span>
      </label>`
    ).join('');
    html += `<div class="card sc-question" data-q="${i}">
      <div class="sc-num">Question ${i + 1} of ${questions.length}</div>
      <h3 style="font-size:1.1rem;margin-bottom:16px;">${esc(q.question)}</h3>
      <div class="sc-options">${options}</div>
    </div>`;
  });

  html += `<div style="text-align:center;margin:24px 0;">
    <button class="btn btn-primary" onclick="showResults()" id="scoreBtn" disabled>Calculate My Score</button>
  </div>
  <div class="result-panel" id="resultPanel">
    <div class="result-score" id="scoreValue">0</div>
    <div class="result-label" id="scoreLabel"></div>
    <div class="result-desc" id="scoreDesc"></div>
  </div>`;

  const style = `<style>
.sc-num { font-size: 12px; color: var(--gray-400); font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.sc-options { display: flex; flex-direction: column; gap: 8px; }
.sc-option { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 2px solid var(--gray-200); border-radius: var(--radius-sm); cursor: pointer; transition: all 0.2s; }
.sc-option:hover { border-color: var(--primary-light); background: #f5f3ff; }
.sc-option input:checked + .sc-option-text { font-weight: 600; }
.sc-option:has(input:checked) { border-color: var(--primary); background: #eef2ff; }
.sc-option input { accent-color: var(--primary); }
</style>`;

  const script = `
var tiers = ${JSON.stringify(tiers).replace(/<\//g, '<\\/')};
function updateScore() {
  var radios = document.querySelectorAll('input[type=radio]:checked');
  document.getElementById('scoreBtn').disabled = radios.length < ${questions.length};
}
function showResults() {
  var total = 0;
  document.querySelectorAll('input[type=radio]:checked').forEach(function(r) { total += parseInt(r.value) || 0; });
  var maxScore = ${questions.length} * 3;
  var pct = maxScore > 0 ? Math.round((total / maxScore) * 100) : 0;
  document.getElementById('scoreValue').textContent = pct + '/100';
  var tier = tiers.find(function(t) { return pct >= t.min && pct <= t.max; }) || tiers[tiers.length - 1];
  document.getElementById('scoreLabel').textContent = tier.label;
  document.getElementById('scoreDesc').textContent = tier.description;
  var panel = document.getElementById('resultPanel');
  panel.style.background = 'linear-gradient(135deg, ' + tier.color + ', ' + tier.color + 'cc)';
  panel.classList.add('visible');
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}`;

  return { body: style + html, script };
}

function renderCalculator(data) {
  const sec = data.sections || data;
  const inputs = sec.inputs || [];
  const resultLabel = sec.result_label || 'Your Result';
  const formulaDesc = sec.formula_description || '';

  let inputsHTML = inputs.map((inp, i) =>
    `<div class="calc-field">
      <label for="calc${i}">${esc(inp.label)} ${inp.unit ? `<span class="calc-unit">(${esc(inp.unit)})</span>` : ''}</label>
      <input type="number" id="calc${i}" class="calc-input" placeholder="${esc(inp.placeholder || '')}" value="${inp.default || ''}" oninput="calculate()">
    </div>`
  ).join('');

  let html = `<div class="card">
    <h3 class="card-header">Enter Your Numbers</h3>
    ${inputsHTML}
    ${formulaDesc ? `<p style="font-size:14px;color:var(--gray-500);margin-top:16px;font-style:italic;">${esc(formulaDesc)}</p>` : ''}
  </div>
  <div class="result-panel visible" id="calcResult" style="background:linear-gradient(135deg,var(--primary),var(--primary-light));">
    <h2>${esc(resultLabel)}</h2>
    <div class="result-score" id="calcValue">$0</div>
    <div class="result-desc" id="calcBreakdown"></div>
  </div>`;

  const style = `<style>
.calc-field { margin-bottom: 20px; }
.calc-field label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 15px; }
.calc-unit { font-weight: 400; color: var(--gray-400); }
.calc-input { width: 100%; padding: 12px 16px; border: 2px solid var(--gray-200); border-radius: var(--radius-sm); font-size: 17px; font-family: 'Outfit', sans-serif; transition: border-color 0.2s; }
.calc-input:focus { outline: none; border-color: var(--primary); }
</style>`;

  const script = `
function calculate() {
  var vals = [];
  ${inputs.map((_, i) => `vals.push(parseFloat(document.getElementById('calc${i}').value) || 0);`).join('\n  ')}
  var result = vals[0];
  if (vals.length >= 2) result = vals[0] * vals[1];
  if (vals.length >= 3) result = result * (vals[2] / 100);
  var formatted = result >= 1000 ? '$' + result.toLocaleString('en-US', {maximumFractionDigits: 0}) : result.toFixed(1);
  document.getElementById('calcValue').textContent = formatted;
}
calculate();`;

  return { body: style + html, script };
}

function renderChecklist(data) {
  const categories = data.sections || [];
  const totalItems = categories.reduce((sum, cat) => sum + (cat.items?.length || 0), 0);

  let html = `<div class="card" style="padding:20px 32px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-weight:600;font-size:15px;" id="checkProgress">0 of ${totalItems} completed</span>
      <span style="font-weight:700;color:var(--primary);font-size:15px;" id="checkPct">0%</span>
    </div>
    <div class="progress-bar-container"><div class="progress-bar-fill" id="checkBar" style="width:0%"></div></div>
  </div>`;

  categories.forEach((cat, ci) => {
    const items = (cat.items || []).map((item, ii) =>
      `<label class="cl-item">
        <input type="checkbox" onchange="updateChecklist()">
        <span>${esc(item)}</span>
      </label>`
    ).join('');
    html += `<div class="card">
      <h3 class="card-header">${esc(cat.category)}</h3>
      <div class="cl-items">${items}</div>
    </div>`;
  });

  const style = `<style>
.cl-items { display: flex; flex-direction: column; gap: 4px; }
.cl-item { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s; }
.cl-item:hover { background: var(--gray-100); }
.cl-item input { accent-color: var(--primary); margin-top: 4px; width: 18px; height: 18px; flex-shrink: 0; }
.cl-item:has(input:checked) span { text-decoration: line-through; color: var(--gray-400); }
</style>`;

  const script = `
function updateChecklist() {
  var total = document.querySelectorAll('.cl-item input').length;
  var checked = document.querySelectorAll('.cl-item input:checked').length;
  var pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  document.getElementById('checkProgress').textContent = checked + ' of ' + total + ' completed';
  document.getElementById('checkPct').textContent = pct + '%';
  document.getElementById('checkBar').style.width = pct + '%';
}`;

  return { body: style + html, script };
}

function renderAudit(data) {
  const criteria = data.sections || [];

  let html = `<div class="card" style="padding:20px 32px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-weight:600;font-size:15px;" id="auditProgress">Rate each criterion below</span>
      <span style="font-weight:700;color:var(--primary);font-size:15px;" id="auditGrade">--</span>
    </div>
    <div class="progress-bar-container"><div class="progress-bar-fill" id="auditBar" style="width:0%"></div></div>
  </div>`;

  criteria.forEach((c, i) => {
    html += `<div class="card audit-card" data-idx="${i}">
      <h3 style="font-size:1.05rem;margin-bottom:12px;">${esc(c.criterion)}</h3>
      <div class="audit-btns">
        <button class="audit-btn pass" onclick="rateAudit(${i},'pass',this)">Pass</button>
        <button class="audit-btn warn" onclick="rateAudit(${i},'warn',this)">Warning</button>
        <button class="audit-btn fail" onclick="rateAudit(${i},'fail',this)">Fail</button>
      </div>
      <div class="audit-detail">
        <div class="audit-good"><strong>Good:</strong> ${esc(c.what_good_looks_like)}</div>
        <div class="audit-bad"><strong>Red flag:</strong> ${esc(c.red_flag)}</div>
      </div>
    </div>`;
  });

  html += `<div class="result-panel" id="auditResult">
    <div class="result-score" id="auditScore">--</div>
    <div class="result-label" id="auditLabel"></div>
  </div>`;

  const style = `<style>
.audit-btns { display: flex; gap: 8px; margin-bottom: 16px; }
.audit-btn { padding: 8px 20px; border: 2px solid var(--gray-200); border-radius: 100px; background: white; font-family: 'Outfit', sans-serif; font-weight: 600; font-size: 14px; cursor: pointer; transition: all 0.2s; }
.audit-btn.pass:hover, .audit-btn.pass.active { background: var(--success-light); border-color: var(--success); color: var(--success); }
.audit-btn.warn:hover, .audit-btn.warn.active { background: var(--warning-light); border-color: var(--warning); color: var(--warning); }
.audit-btn.fail:hover, .audit-btn.fail.active { background: var(--danger-light); border-color: var(--danger); color: var(--danger); }
.audit-detail { font-size: 14px; color: var(--gray-500); }
.audit-good { margin-bottom: 4px; }
</style>`;

  const script = `
var auditRatings = {};
function rateAudit(idx, rating, btn) {
  auditRatings[idx] = rating;
  var card = btn.closest('.audit-card');
  card.querySelectorAll('.audit-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  updateAudit();
}
function updateAudit() {
  var total = ${criteria.length};
  var rated = Object.keys(auditRatings).length;
  var pct = total > 0 ? Math.round((rated / total) * 100) : 0;
  document.getElementById('auditBar').style.width = pct + '%';
  document.getElementById('auditProgress').textContent = rated + ' of ' + total + ' rated';
  if (rated === total && total > 0) {
    var pass = Object.values(auditRatings).filter(function(r) { return r === 'pass'; }).length;
    var grade = Math.round((pass / total) * 100);
    document.getElementById('auditScore').textContent = grade + '%';
    document.getElementById('auditLabel').textContent = grade >= 80 ? 'Great — Minor tweaks needed' : grade >= 50 ? 'Fair — Key areas need attention' : 'Needs Work — Critical gaps found';
    var panel = document.getElementById('auditResult');
    panel.style.background = grade >= 80 ? 'linear-gradient(135deg,#059669,#10b981)' : grade >= 50 ? 'linear-gradient(135deg,#d97706,#f59e0b)' : 'linear-gradient(135deg,#dc2626,#ef4444)';
    panel.classList.add('visible');
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}`;

  return { body: style + html, script };
}

function renderBenchmark(data) {
  const metrics = data.sections || [];

  let rows = metrics.map(m => {
    const unit = m.unit || '';
    return `<div class="card bench-card">
      <h3 style="font-size:1rem;margin-bottom:16px;">${esc(m.metric)}</h3>
      <div class="bench-row">
        <div class="bench-bar-group">
          <div class="bench-label">Bottom 25%</div>
          <div class="bench-bar-track"><div class="bench-bar" style="width:25%;background:var(--danger);">${esc(m.bottom_25)}${esc(unit)}</div></div>
        </div>
        <div class="bench-bar-group">
          <div class="bench-label">Average</div>
          <div class="bench-bar-track"><div class="bench-bar" style="width:55%;background:var(--warning);">${esc(m.average)}${esc(unit)}</div></div>
        </div>
        <div class="bench-bar-group">
          <div class="bench-label">Top 10%</div>
          <div class="bench-bar-track"><div class="bench-bar" style="width:85%;background:var(--success);">${esc(m.top_10)}${esc(unit)}</div></div>
        </div>
        <div class="bench-bar-group">
          <div class="bench-label" style="color:var(--primary);font-weight:700;">Your Firm</div>
          <div class="bench-bar-track"><div class="bench-bar bench-your" style="width:5%;background:var(--primary);" data-metric="${esc(m.metric)}"><input type="number" class="bench-input" placeholder="Enter" oninput="updateBench(this)"></div></div>
        </div>
      </div>
    </div>`;
  }).join('');

  const style = `<style>
.bench-row { display: flex; flex-direction: column; gap: 10px; }
.bench-bar-group { display: flex; align-items: center; gap: 12px; }
.bench-label { width: 100px; font-size: 13px; font-weight: 500; flex-shrink: 0; }
.bench-bar-track { flex: 1; background: var(--gray-100); border-radius: 100px; height: 32px; overflow: visible; position: relative; }
.bench-bar { height: 100%; border-radius: 100px; display: flex; align-items: center; justify-content: flex-end; padding-right: 12px; color: white; font-size: 13px; font-weight: 600; min-width: 60px; transition: width 0.5s ease; }
.bench-input { width: 70px; border: none; background: rgba(255,255,255,0.9); border-radius: 6px; padding: 4px 8px; font-size: 13px; font-family: 'Outfit', sans-serif; text-align: center; }
.bench-input:focus { outline: 2px solid var(--primary); }
</style>`;

  const script = `
function updateBench(input) {
  var val = parseFloat(input.value) || 0;
  var bar = input.closest('.bench-bar');
  var pct = Math.min(Math.max(val, 5), 100);
  bar.style.width = pct + '%';
}`;

  return { body: style + rows, script };
}

function renderSwipeFile(data) {
  const templates = data.sections || [];

  let tabs = templates.map((t, i) =>
    `<button class="swipe-tab ${i === 0 ? 'active' : ''}" onclick="showTemplate(${i})">${esc(t.title)}</button>`
  ).join('');

  let panels = templates.map((t, i) =>
    `<div class="swipe-panel ${i === 0 ? 'visible' : ''}" id="swipe${i}">
      <div class="swipe-usecase"><strong>Use when:</strong> ${esc(t.use_case)}</div>
      <div class="swipe-copy" id="swipeCopy${i}">${esc(t.copy)}</div>
      <button class="btn btn-outline btn-sm" onclick="copyTemplate(${i})">Copy to Clipboard</button>
      <span class="copy-confirm" id="copyConfirm${i}"></span>
    </div>`
  ).join('');

  const html = `<div class="card">
    <div class="swipe-tabs">${tabs}</div>
    ${panels}
  </div>`;

  const style = `<style>
.swipe-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
.swipe-tab { padding: 8px 16px; border: 2px solid var(--gray-200); border-radius: 100px; background: white; font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
.swipe-tab.active { background: var(--primary); color: white; border-color: var(--primary); }
.swipe-panel { display: none; }
.swipe-panel.visible { display: block; }
.swipe-usecase { font-size: 14px; color: var(--gray-500); margin-bottom: 16px; padding: 8px 12px; background: var(--gray-100); border-radius: var(--radius-sm); }
.swipe-copy { white-space: pre-wrap; font-size: 15px; line-height: 1.8; padding: 20px; background: var(--cream); border: 1px solid var(--gray-200); border-radius: var(--radius-sm); margin-bottom: 16px; }
.copy-confirm { font-size: 13px; color: var(--success); font-weight: 600; margin-left: 8px; }
</style>`;

  const script = `
function showTemplate(idx) {
  document.querySelectorAll('.swipe-tab').forEach(function(t,i) { t.classList.toggle('active', i===idx); });
  document.querySelectorAll('.swipe-panel').forEach(function(p,i) { p.classList.toggle('visible', i===idx); });
}
function copyTemplate(idx) {
  var text = document.getElementById('swipeCopy' + idx).textContent;
  navigator.clipboard.writeText(text).then(function() {
    document.getElementById('copyConfirm' + idx).textContent = 'Copied!';
    setTimeout(function() { document.getElementById('copyConfirm' + idx).textContent = ''; }, 2000);
  });
}`;

  return { body: style + html, script };
}

function renderBlueprint(data) {
  const phases = data.sections || [];

  let html = `<div class="bp-timeline">`;
  phases.forEach((p, i) => {
    const steps = (p.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
    html += `<div class="card bp-phase">
      <div class="bp-phase-num">Phase ${i + 1}</div>
      <h3 style="font-size:1.15rem;margin-bottom:4px;">${esc(p.phase?.replace(/^Phase \d+[:\s]*/i, '') || p.phase)}</h3>
      <div class="bp-timeline-label">${esc(p.timeline)}</div>
      <ul class="bp-steps">${steps}</ul>
      <div class="bp-outcome"><strong>Expected outcome:</strong> ${esc(p.outcome)}</div>
    </div>`;
  });
  html += `</div>`;

  const style = `<style>
.bp-timeline { position: relative; }
.bp-timeline::before { content: ''; position: absolute; left: 32px; top: 0; bottom: 0; width: 3px; background: var(--gray-200); }
.bp-phase { position: relative; margin-left: 48px; }
.bp-phase-num { position: absolute; left: -56px; top: 32px; width: 32px; height: 32px; background: var(--primary); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; z-index: 1; }
.bp-timeline-label { font-size: 13px; color: var(--primary); font-weight: 600; margin-bottom: 12px; }
.bp-steps { padding-left: 20px; margin-bottom: 16px; }
.bp-steps li { margin-bottom: 6px; color: var(--gray-700); }
.bp-outcome { font-size: 14px; color: var(--gray-500); padding: 10px 14px; background: var(--success-light); border-radius: var(--radius-sm); border-left: 3px solid var(--success); }
</style>`;

  return { body: style + html, script: '' };
}

function renderCheatSheet(data) {
  const sections = data.sections || [];
  const colors = ['#4f46e5', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

  let html = '';
  sections.forEach((sec, i) => {
    const color = colors[i % colors.length];
    const rows = (sec.rows || []).map(r =>
      `<div class="cs-row">
        <span class="cs-label">${esc(r.label)}</span>
        <span class="cs-value">${esc(r.value)}</span>
      </div>`
    ).join('');
    html += `<div class="card">
      <h3 class="card-header" style="border-left:4px solid ${color};padding-left:16px;">${esc(sec.heading)}</h3>
      <div class="cs-rows">${rows}</div>
    </div>`;
  });

  const style = `<style>
.cs-rows { display: flex; flex-direction: column; }
.cs-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--gray-100); }
.cs-row:last-child { border-bottom: none; }
.cs-label { font-weight: 500; color: var(--gray-700); flex: 1; }
.cs-value { font-weight: 700; color: var(--ink); text-align: right; font-family: 'Fraunces', serif; font-size: 1.1rem; }
</style>`;

  return { body: style + html, script: '' };
}

function renderToolkit(data) {
  const tools = data.sections || [];
  const categories = [...new Set(tools.map(t => t.category))];

  let filterBtns = `<button class="tk-filter active" onclick="filterTools('all')">All</button>` +
    categories.map(c => `<button class="tk-filter" onclick="filterTools('${esc(c).replace(/'/g, '\\&#39;')}')">${esc(c)}</button>`).join('');

  let cards = tools.map(t =>
    `<div class="card tk-card" data-cat="${esc(t.category)}">
      <div class="tk-cat">${esc(t.category)}</div>
      <h3 style="font-size:1.1rem;margin-bottom:8px;">${esc(t.name)}</h3>
      <p style="color:var(--gray-500);font-size:15px;margin-bottom:12px;">${esc(t.description)}</p>
      <div class="tk-why"><strong>Why you need this:</strong> ${esc(t.why)}</div>
    </div>`
  ).join('');

  const html = `<div class="tk-filters">${filterBtns}</div>
  <div class="tk-grid">${cards}</div>`;

  const style = `<style>
.tk-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
.tk-filter { padding: 8px 16px; border: 2px solid var(--gray-200); border-radius: 100px; background: white; font-family: 'Outfit', sans-serif; font-size: 14px; cursor: pointer; transition: all 0.2s; }
.tk-filter.active { background: var(--primary); color: white; border-color: var(--primary); }
.tk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.tk-cat { font-size: 12px; font-weight: 600; color: var(--primary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.tk-why { font-size: 14px; color: var(--gray-600); padding: 10px 14px; background: var(--gray-100); border-radius: var(--radius-sm); }
.tk-card.hidden { display: none; }
</style>`;

  const script = `
function filterTools(cat) {
  document.querySelectorAll('.tk-filter').forEach(function(b) { b.classList.remove('active'); });
  event.target.classList.add('active');
  document.querySelectorAll('.tk-card').forEach(function(c) {
    c.classList.toggle('hidden', cat !== 'all' && c.dataset.cat !== cat);
  });
}`;

  return { body: style + html, script };
}

function renderWorksheet(data) {
  const sections = data.sections || [];

  let html = '';
  sections.forEach((sec, i) => {
    const prompts = (sec.prompts || []).map((p, j) => {
      if (p.type === 'textarea') {
        return `<div class="ws-field">
          <label>${esc(p.label)}</label>
          <textarea class="ws-textarea" rows="4" placeholder="Write your answer here..."></textarea>
        </div>`;
      } else if (p.type === 'number') {
        return `<div class="ws-field">
          <label>${esc(p.label)}</label>
          <input type="number" class="ws-input" placeholder="Enter a number">
        </div>`;
      }
      return `<div class="ws-field">
        <label>${esc(p.label)}</label>
        <input type="text" class="ws-input" placeholder="Type your answer...">
      </div>`;
    }).join('');

    html += `<div class="card">
      <h3 class="card-header">${esc(sec.heading)}</h3>
      ${sec.guidance ? `<p class="ws-guidance">${esc(sec.guidance)}</p>` : ''}
      ${prompts}
    </div>`;
  });

  html += `<div style="text-align:center;margin:24px 0;">
    <button class="btn btn-outline" onclick="window.print()">Print / Save as PDF</button>
  </div>`;

  const style = `<style>
.ws-guidance { font-size: 14px; color: var(--gray-500); margin-bottom: 20px; padding: 12px 16px; background: var(--gray-100); border-radius: var(--radius-sm); border-left: 3px solid var(--primary); }
.ws-field { margin-bottom: 20px; }
.ws-field label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 15px; }
.ws-input, .ws-textarea { width: 100%; padding: 12px 16px; border: 2px solid var(--gray-200); border-radius: var(--radius-sm); font-size: 16px; font-family: 'Outfit', sans-serif; transition: border-color 0.2s; }
.ws-input:focus, .ws-textarea:focus { outline: none; border-color: var(--primary); }
.ws-textarea { resize: vertical; }
</style>`;

  return { body: style + html, script: '' };
}

// --- Main renderer ---

const RENDERERS = {
  scorecard: renderScorecard,
  calculator: renderCalculator,
  checklist: renderChecklist,
  audit: renderAudit,
  benchmark: renderBenchmark,
  swipe_file: renderSwipeFile,
  blueprint: renderBlueprint,
  cheat_sheet: renderCheatSheet,
  toolkit: renderToolkit,
  worksheet: renderWorksheet
};

const TYPE_LABELS = {
  scorecard: 'Free Scorecard',
  calculator: 'Free Calculator',
  checklist: 'Free Checklist',
  audit: 'Free Audit',
  benchmark: 'Free Benchmark Report',
  swipe_file: 'Free Swipe File',
  blueprint: 'Free Blueprint',
  cheat_sheet: 'Free Cheat Sheet',
  toolkit: 'Free Toolkit',
  worksheet: 'Free Worksheet'
};

function renderLeadMagnetHTML(data) {
  if (!data || !data.type) {
    throw new Error('Lead magnet data missing or no type specified');
  }

  const renderer = RENDERERS[data.type];
  if (!renderer) {
    throw new Error(`Unknown lead magnet type: ${data.type}`);
  }

  const { body, script } = renderer(data);
  const typeLabel = TYPE_LABELS[data.type] || 'Free Resource';

  return wrapHTML(
    data.title || 'Lead Magnet',
    data.subtitle || '',
    typeLabel,
    body,
    script
  );
}

module.exports = { renderLeadMagnetHTML };
