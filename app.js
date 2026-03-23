let transactions = [];
let categorised = {};
let decisions = {};

const fmt = n => `£${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

window.onload = () => {
  const saved = localStorage.getItem('tax_api_key');
  if (saved) document.getElementById('apiKey').value = saved;

  document.getElementById('apiKey').addEventListener('change', () => {
    localStorage.setItem('tax_api_key', document.getElementById('apiKey').value.trim());
  });

  const uploadZone = document.getElementById('uploadZone');
  uploadZone.addEventListener('click', () => document.getElementById('csvFile').click());
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag'));
  uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });
  document.getElementById('csvFile').addEventListener('change', e => handleFile(e.target.files[0]));
};

function setStage(stage) {
  document.querySelectorAll('.stage').forEach(s => s.classList.remove('active'));
  document.getElementById('stage-' + stage).classList.add('active');
  const idx = { upload: 0, processing: 1, review: 2, summary: 3 };
  const cur = idx[stage];
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById('step' + i);
    el.className = 'progress-step' + (i < cur ? ' done' : i === cur ? ' active' : '');
  }
}

function goBack(stage) {
  setStage(stage);
  if (stage === 'review') renderReview();
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.style.display = 'block';
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { inQuotes = !inQuotes; }
    else if (line[i] === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += line[i]; }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.replace(/"/g, '').toLowerCase().trim());

  const dateIdx = headers.findIndex(h => h.includes('date'));
  const descIdx = headers.findIndex(h =>
    h.includes('counter party') || h.includes('counterparty') ||
    h.includes('description') || h.includes('merchant')
  );
  const refIdx = headers.findIndex(h => h.includes('reference'));
  const amtIdx = headers.findIndex(h => h.includes('amount'));
  const catIdx = headers.findIndex(h => h.includes('spending category') || h.includes('category'));
  const typeIdx = headers.findIndex(h => h === 'type' || h.includes('transaction type'));

  const txns = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    const raw = (cols[amtIdx] || '').replace(/[£,\s]/g, '');
    const amount = parseFloat(raw);
    if (isNaN(amount) || amount === 0) continue;
    txns.push({
      id: `t${i}`,
      date: (cols[dateIdx] || '').replace(/"/g, ''),
      description: (cols[descIdx] || cols[refIdx] || 'Unknown').replace(/"/g, ''),
      reference: (cols[refIdx] || '').replace(/"/g, ''),
      amount,
      starlingCat: (cols[catIdx] || '').replace(/"/g, ''),
      transactionType: (cols[typeIdx] || '').replace(/"/g, ''),
      type: amount > 0 ? 'income' : 'outgoing'
    });
  }
  return txns;
}

async function handleFile(file) {
  if (!file?.name?.endsWith('.csv')) { showError('Upload a CSV file.'); return; }
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) { showError('Add your API key first.'); return; }

  try {
    document.getElementById('errorMsg').style.display = 'none';
    const text = await file.text();
    transactions = parseCSV(text);
    if (transactions.length === 0) { showError('No transactions found. Check your CSV format.'); return; }

    const income = transactions.filter(t => t.type === 'income');
    const outgoings = transactions.filter(t => t.type === 'outgoing');
    document.getElementById('processingInfo').textContent =
      `Found ${income.length} income · ${outgoings.length} outgoings — asking Claude to categorise...`;
    setStage('processing');

    const results = await aiCategorise(outgoings);
    categorised = {};
    results.forEach(r => { categorised[r.id] = r; });

    outgoings.forEach(t => {
      if (!categorised[t.id]) {
        categorised[t.id] = { id: t.id, category: 'review', reason: 'Not categorised — please review' };
      }
    });

    decisions = {};
    renderReview();
    setStage('review');
  } catch(e) {
    showError('Something went wrong: ' + e.message);
    setStage('upload');
  }
}

function getGroupKey(description) {
  return description.trim().toUpperCase().split(/[\s\*\-\_\/]/)[0].substring(0, 20);
}

function groupTransactions(txns) {
  const groups = {};
  txns.forEach(t => {
    const key = getGroupKey(t.description);
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });
  return groups;
}

function renderReview() {
  const outgoings = transactions.filter(t => t.type === 'outgoing');
  const reviewItems = outgoings.filter(t => categorised[t.id]?.category === 'review');
  const autoDeductible = outgoings.filter(t => categorised[t.id]?.category === 'deductible');
  const autoIgnore = outgoings.filter(t => categorised[t.id]?.category === 'ignore');

  const autoInfo = document.getElementById('autoInfo');
  autoInfo.textContent = `✓ Claude auto-categorised ${autoDeductible.length} deductible and ${autoIgnore.length} personal expenses. ${reviewItems.length} need your review.`;
  autoInfo.style.display = 'block';

  const container = document.getElementById('reviewGroups');
  container.innerHTML = '';

  if (reviewItems.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:60px 40px;color:#444;font-size:14px;">Claude categorised everything. Nothing to review.</div>';
    document.getElementById('reviewCta').disabled = false;
    document.getElementById('reviewCta').textContent = 'See Results →';
    return;
  }

  document.getElementById('reviewLabel').textContent = `Human review · ${reviewItems.length} items to check`;

  const groups = groupTransactions(reviewItems);

  Object.entries(groups).forEach(([key, items]) => {
    const groupTotal = items.reduce((s, t) => s + Math.abs(t.amount), 0);
    const allDeductible = items.every(t => decisions[t.id] === true);
    const allIgnore = items.every(t => decisions[t.id] === false);

    const div = document.createElement('div');
    div.className = 'group';
    div.id = 'group-' + key;

    div.innerHTML = `
      <div class="group-header" onclick="toggleGroup('${key}')">
        <div class="group-toggle" id="toggle-${key}">▶</div>
        <div class="group-name">${items[0].description}</div>
        <div class="group-meta">${items.length} transaction${items.length > 1 ? 's' : ''}</div>
        <div class="group-total">${fmt(groupTotal)}</div>
        <div class="group-btns" onclick="event.stopPropagation()">
          <button class="btn-d ${allDeductible ? 'on' : ''}" onclick="setGroupDecision('${key}', true)">Deductible</button>
          <button class="btn-i ${allIgnore ? 'on' : ''}" onclick="setGroupDecision('${key}', false)">Ignore</button>
        </div>
      </div>
      <div class="group-items" id="items-${key}">
        ${items.map(t => `
          <div class="group-item" id="gi-${t.id}">
            <div class="gi-date">${t.date}</div>
            <div class="gi-desc">
              ${t.description}
              <div style="font-size:11px;color:#3A3A3A;margin-top:2px;">${[t.reference, t.starlingCat, t.transactionType].filter(Boolean).join(' · ')}</div>
            </div>
            <div class="gi-amount">${fmt(t.amount)}</div>
            <div class="group-btns">
              <button class="btn-d ${decisions[t.id] === true ? 'on' : ''}" onclick="setDecision('${t.id}', true, '${key}')">Deductible</button>
              <button class="btn-i ${decisions[t.id] === false ? 'on' : ''}" onclick="setDecision('${t.id}', false, '${key}')">Ignore</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    container.appendChild(div);
  });

  updateCta();
}

function toggleGroup(key) {
  const items = document.getElementById('items-' + key);
  const toggle = document.getElementById('toggle-' + key);
  const isOpen = items.classList.contains('open');
  items.classList.toggle('open', !isOpen);
  toggle.textContent = isOpen ? '▶' : '▼';
}

function setDecision(id, isDeductible, groupKey) {
  decisions[id] = isDeductible;
  const item = document.getElementById('gi-' + id);
  if (item) {
    item.querySelector('.btn-d').classList.toggle('on', isDeductible === true);
    item.querySelector('.btn-i').classList.toggle('on', isDeductible === false);
  }
  updateGroupButtons(groupKey);
  updateCta();
}

function setGroupDecision(key, isDeductible) {
  const outgoings = transactions.filter(t => t.type === 'outgoing');
  const reviewItems = outgoings.filter(t => categorised[t.id]?.category === 'review');
  const groups = groupTransactions(reviewItems);
  const items = groups[key] || [];

  items.forEach(t => {
    decisions[t.id] = isDeductible;
    const item = document.getElementById('gi-' + t.id);
    if (item) {
      item.querySelector('.btn-d').classList.toggle('on', isDeductible === true);
      item.querySelector('.btn-i').classList.toggle('on', isDeductible === false);
    }
  });

  updateGroupButtons(key);
  updateCta();
}

function updateGroupButtons(key) {
  const outgoings = transactions.filter(t => t.type === 'outgoing');
  const reviewItems = outgoings.filter(t => categorised[t.id]?.category === 'review');
  const groups = groupTransactions(reviewItems);
  const items = groups[key] || [];

  const allDeductible = items.every(t => decisions[t.id] === true);
  const allIgnore = items.every(t => decisions[t.id] === false);

  const groupEl = document.getElementById('group-' + key);
  if (groupEl) {
    groupEl.querySelector('.btn-d').classList.toggle('on', allDeductible);
    groupEl.querySelector('.btn-i').classList.toggle('on', allIgnore);
  }
}

function updateCta() {
  const outgoings = transactions.filter(t => t.type === 'outgoing');
  const reviewItems = outgoings.filter(t => categorised[t.id]?.category === 'review');
  const remaining = reviewItems.filter(t => decisions[t.id] === undefined).length;
  const cta = document.getElementById('reviewCta');
  cta.disabled = remaining > 0;
  cta.textContent = remaining > 0 ? `${remaining} items left` : 'See Results →';
}

function goToSummary() {
  const income = transactions.filter(t => t.type === 'income');
  const outgoings = transactions.filter(t => t.type === 'outgoing');

  const totalIncome = income.reduce((s, t) => s + t.amount, 0);
  const totalOutgoing = Math.abs(outgoings.reduce((s, t) => s + t.amount, 0));

  const taxDeductible = outgoings.reduce((s, t) => {
    const cat = categorised[t.id]?.category;
    if (cat === 'deductible') return s + Math.abs(t.amount);
    if (cat === 'review' && decisions[t.id] === true) return s + Math.abs(t.amount);
    return s;
  }, 0);

  const taxableIncome = Math.max(0, totalIncome - taxDeductible);
  const personalAllowance = 12570;
  const taxOwed = Math.max(0, (taxableIncome - personalAllowance) * 0.20);

  document.getElementById('sumIncome').textContent = fmt(totalIncome);
  document.getElementById('sumOutgoings').textContent = fmt(totalOutgoing);
  document.getElementById('sumDeductible').textContent = fmt(taxDeductible);
  document.getElementById('sumTax').textContent = fmt(taxOwed);

  document.getElementById('incomeHdr').textContent = `Income · ${income.length} transactions`;
  document.getElementById('incomeList').innerHTML = income.map(t => `
    <div class="txn">
      <div class="txn-date">${t.date}</div>
      <div class="txn-desc">${t.description}</div>
      <div class="txn-amt inc">+${fmt(t.amount)}</div>
    </div>
  `).join('');

  document.getElementById('outgoingsHdr').textContent = `Outgoings · ${outgoings.length} transactions`;
  document.getElementById('outgoingsList').innerHTML = outgoings.map(t => {
    const cat = categorised[t.id]?.category;
    const isDeductible = cat === 'deductible' || (cat === 'review' && decisions[t.id] === true);
    const chip = isDeductible
      ? `<span class="chip chip-tax">Deductible</span>`
      : `<span class="chip chip-per">Ignore</span>`;
    return `
      <div class="txn">
        <div class="txn-date">${t.date}</div>
        <div class="txn-desc">${t.description}</div>
        ${chip}
        <div class="txn-amt out">-${fmt(t.amount)}</div>
      </div>
    `;
  }).join('');

  setStage('summary');
}

function downloadCSV() {
  const income = transactions.filter(t => t.type === 'income');
  const outgoings = transactions.filter(t => t.type === 'outgoing');

  const rows = [['Date', 'Description', 'Reference', 'Category', 'Type', 'Amount', 'Tag']];

  income.forEach(t => {
    rows.push([t.date, `"${t.description}"`, `"${t.reference}"`, t.starlingCat, t.transactionType, t.amount.toFixed(2), 'Income']);
  });

  outgoings.forEach(t => {
    const cat = categorised[t.id]?.category;
    const isDeductible = cat === 'deductible' || (cat === 'review' && decisions[t.id] === true);
    const label = isDeductible ? 'Deductible' : 'Ignore';
    rows.push([t.date, `"${t.description}"`, `"${t.reference}"`, t.starlingCat, t.transactionType, Math.abs(t.amount).toFixed(2), label]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tax-summary.csv';
  a.click();
  URL.revokeObjectURL(url);
}
