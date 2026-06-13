// ============================================
// STATE
// ============================================

let bills = [];          // array of {furnizor, suma, scadenta (Date), dataPlatii (Date), platit, rowIndex}
let accessToken = null;
let tokenClient = null;
let currentTab = "bills";
let editingBill = null;  // bill object being edited, or null for "new"

const STORAGE_KEY = "platiTrackerBills";
const TOKEN_KEY = "platiTrackerToken";
const TOKEN_EXP_KEY = "platiTrackerTokenExp";

// ============================================
// DATE HELPERS  (sheet format: dd.MM.yyyy)
// ============================================

function parseSheetDate(str) {
  // "30.06.2026" -> Date
  const parts = str.split(".");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  return new Date(y, m - 1, d);
}

function formatSheetDate(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}.${m}.${y}`;
}

function dateToInputValue(date) {
  // yyyy-MM-dd for <input type="date">
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${y}-${m}-${d}`;
}

function inputValueToDate(value) {
  // "2026-06-30" -> Date (local)
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function nextPayDate() {
  const today = new Date();
  const day = today.getDate();
  let target;
  if (day < 1) target = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (day < 15) target = new Date(today.getFullYear(), today.getMonth(), 15);
  else target = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return target;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// ============================================
// LOCAL CACHE
// ============================================

function saveToCache() {
  const serializable = bills.map(b => ({
    ...b,
    scadenta: b.scadenta.toISOString(),
    dataPlatii: b.dataPlatii.toISOString()
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function loadFromCache() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    bills = parsed.map(b => ({
      ...b,
      scadenta: new Date(b.scadenta),
      dataPlatii: new Date(b.dataPlatii)
    }));
  } catch (e) {
    console.error("Cache parse error", e);
  }
}

// ============================================
// AUTH  (Google Identity Services — token model)
// ============================================

function initAuth() {
  // Restore token from sessionStorage if still valid
  const savedToken = sessionStorage.getItem(TOKEN_KEY);
  const savedExp = sessionStorage.getItem(TOKEN_EXP_KEY);
  if (savedToken && savedExp && Date.now() < Number(savedExp)) {
    accessToken = savedToken;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    callback: (response) => {
      if (response.error) {
        setSyncStatus("Eroare autentificare", "error");
        return;
      }
      accessToken = response.access_token;
      const expiresAt = Date.now() + (response.expires_in * 1000);
      sessionStorage.setItem(TOKEN_KEY, accessToken);
      sessionStorage.setItem(TOKEN_EXP_KEY, String(expiresAt));
      renderSettings();
      refreshFromSheet();
    }
  });
}

function signIn() {
  tokenClient.requestAccessToken();
}

function signOut() {
  accessToken = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_EXP_KEY);
  renderSettings();
}

function isSignedIn() {
  return !!accessToken;
}

// ============================================
// SHEETS API
// ============================================

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function sheetsHeaders() {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };
}

async function fetchBillsFromSheet() {
  const range = `${CONFIG.SHEET_NAME}!A2:E`;
  const url = `${SHEETS_BASE}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: sheetsHeaders() });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const values = data.values || [];
  const result = [];
  values.forEach((row, i) => {
    if (row.length < 4) return;
    const furnizor = row[0];
    const suma = parseFloat(String(row[1]).replace(",", "")) || 0;
    const scadenta = parseSheetDate(row[2]);
    const dataPlatii = parseSheetDate(row[3]);
    if (!scadenta || !dataPlatii) return;
    const platit = row.length >= 5 ? (row[4] === "TRUE" || row[4] === true || row[4] === "1") : false;
    result.push({
      furnizor, suma, scadenta, dataPlatii, platit,
      rowIndex: i + 2 // header is row 1
    });
  });
  return result;
}

async function appendBillToSheet(bill) {
  const range = `${CONFIG.SHEET_NAME}!A:E`;
  const url = `${SHEETS_BASE}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const row = [
    bill.furnizor,
    String(Math.round(bill.suma)),
    formatSheetDate(bill.scadenta),
    formatSheetDate(bill.dataPlatii),
    bill.platit ? "TRUE" : "FALSE"
  ];
  const res = await fetch(url, {
    method: "POST",
    headers: sheetsHeaders(),
    body: JSON.stringify({ values: [row] })
  });
  if (!res.ok) throw new Error(`Append failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Find the current row index of a bill by matching its content,
// since the sheet's onEdit script re-sorts/moves rows after every edit.
async function findRowIndex(bill) {
  const current = await fetchBillsFromSheet();
  const match = current.find(b =>
    b.furnizor === bill.furnizor &&
    b.suma === bill.suma &&
    isSameDay(b.scadenta, bill.scadenta) &&
    isSameDay(b.dataPlatii, bill.dataPlatii) &&
    b.platit === bill.platit
  );
  return match ? match.rowIndex : null;
}

async function writeRow(bill, rowIndex) {
  const range = `${CONFIG.SHEET_NAME}!A${rowIndex}:E${rowIndex}`;
  const url = `${SHEETS_BASE}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const row = [
    bill.furnizor,
    String(Math.round(bill.suma)),
    formatSheetDate(bill.scadenta),
    formatSheetDate(bill.dataPlatii),
    bill.platit ? "TRUE" : "FALSE"
  ];
  const res = await fetch(url, {
    method: "PUT",
    headers: sheetsHeaders(),
    body: JSON.stringify({ range, values: [row] })
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status} ${await res.text()}`);
}

async function updateBillInSheet(oldBill, newBill) {
  const rowIndex = await findRowIndex(oldBill);
  if (rowIndex === null) {
    throw new Error("Plata nu a fost găsită în foaie (poate a fost mutată în ISTORIC).");
  }
  await writeRow(newBill, rowIndex);
}

async function deleteBillFromSheet(bill) {
  const rowIndex = await findRowIndex(bill);
  if (rowIndex === null) {
    throw new Error("Plata nu a fost găsită în foaie (poate a fost deja mutată).");
  }
  const url = `${SHEETS_BASE}/${CONFIG.SPREADSHEET_ID}:batchUpdate`;
  const body = {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: CONFIG.SHEET_GID,
          dimension: "ROWS",
          startIndex: rowIndex - 1,
          endIndex: rowIndex
        }
      }
    }]
  };
  const res = await fetch(url, {
    method: "POST",
    headers: sheetsHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
}

// ============================================
// SYNC ORCHESTRATION
// ============================================

function setSyncStatus(text, kind) {
  const el = document.getElementById("syncStatus");
  el.textContent = text;
  el.className = "sync-status" + (kind ? " " + kind : "");
}

async function refreshFromSheet() {
  if (!isSignedIn()) {
    setSyncStatus("Neconectat", "error");
    return;
  }
  setSyncStatus("Se sincronizează…", "syncing");
  try {
    bills = await fetchBillsFromSheet();
    saveToCache();
    const now = new Date();
    setSyncStatus("Sincronizat " + now.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" }));
    renderCurrentTab();
  } catch (e) {
    console.error(e);
    setSyncStatus("Eroare sincronizare", "error");
    if (String(e).includes("401")) {
      // token expired
      accessToken = null;
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_EXP_KEY);
      renderSettings();
    }
  }
}

async function addBill(bill) {
  bills.push(bill);
  saveToCache();
  renderCurrentTab();
  if (!isSignedIn()) return;
  showLoading(true);
  try {
    await appendBillToSheet(bill);
    await refreshFromSheet();
  } catch (e) {
    console.error(e);
    setSyncStatus("Eroare la adăugare", "error");
  } finally {
    showLoading(false);
  }
}

async function updateBill(oldBill, newBill) {
  const idx = bills.indexOf(oldBill);
  if (idx !== -1) bills[idx] = newBill;
  saveToCache();
  renderCurrentTab();
  if (!isSignedIn()) return;
  showLoading(true);
  try {
    await updateBillInSheet(oldBill, newBill);
    await refreshFromSheet();
  } catch (e) {
    console.error(e);
    setSyncStatus("Eroare la salvare", "error");
  } finally {
    showLoading(false);
  }
}

async function deleteBill(bill) {
  bills = bills.filter(b => b !== bill);
  saveToCache();
  renderCurrentTab();
  if (!isSignedIn()) return;
  showLoading(true);
  try {
    await deleteBillFromSheet(bill);
    await refreshFromSheet();
  } catch (e) {
    console.error(e);
    setSyncStatus("Eroare la ștergere", "error");
  } finally {
    showLoading(false);
  }
}

function togglePaid(bill) {
  const newBill = { ...bill, platit: !bill.platit };
  updateBill(bill, newBill);
}

function showLoading(show) {
  document.getElementById("loadingOverlay").classList.toggle("hidden", !show);
}

// ============================================
// GROUPING
// ============================================

function groupByPayDate() {
  const groups = {};
  bills.forEach(bill => {
    const key = startOfDay(bill.dataPlatii).getTime();
    if (!groups[key]) groups[key] = { date: bill.dataPlatii, bills: [] };
    groups[key].bills.push(bill);
  });
  return Object.values(groups)
    .map(g => {
      g.bills.sort((a, b) => a.scadenta - b.scadenta);
      g.total = g.bills.reduce((s, b) => s + b.suma, 0);
      g.unpaidTotal = g.bills.filter(b => !b.platit).reduce((s, b) => s + b.suma, 0);
      return g;
    })
    .sort((a, b) => a.date - b.date);
}

// ============================================
// RENDERING
// ============================================

const GROUP_COLORS = [
  "#D1E9FF", "#FFF9C4", "#E1BEE7", "#FFCCBC", "#D1FFD1", "#FFD1DC", "#B2EBF2", "#FFE082", "#CFD8DC", "#F8BBD0"
];

function renderCurrentTab() {
  if (currentTab === "bills") renderBills();
  else if (currentTab === "summary") renderSummary();
  else renderSettings();
}

function renderBills() {
  const main = document.getElementById("mainContent");
  document.getElementById("fabAdd").classList.remove("hidden");

  const groups = groupByPayDate();

  if (groups.length === 0) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="stamp">Nimic de plătit</div>
        <p>Apasă + pentru a adăuga o plată.</p>
      </div>`;
    return;
  }

  const today = startOfDay(new Date());

  main.innerHTML = groups.map((group, gi) => {
    const settled = group.unpaidTotal === 0;
    const color = GROUP_COLORS[gi % GROUP_COLORS.length];
    const billsHtml = group.bills.map((bill, bi) => {
      const overdue = !bill.platit && startOfDay(bill.scadenta) < today;
      const billIndex = bills.indexOf(bill);
      return `
        <div class="bill ${bill.platit ? "paid" : ""}" style="background:${color}33" data-index="${billIndex}">
          <div class="checkbox ${bill.platit ? "checked" : ""}" data-action="toggle" data-index="${billIndex}">${bill.platit ? "✓" : ""}</div>
          <div class="bill-info" data-action="edit" data-index="${billIndex}">
            <div class="furnizor">${escapeHtml(bill.furnizor)}</div>
            <div class="scadenta ${overdue ? "overdue" : ""}">Scadență: ${formatSheetDate(bill.scadenta)}</div>
          </div>
          <div class="suma">${Math.round(bill.suma)}</div>
        </div>`;
    }).join("");

    return `
      <div class="group">
        <div class="group-header ${settled ? "settled" : ""}">
          <div class="date">${formatSheetDate(group.date)}</div>
          <div class="totals">
            <div>${Math.round(group.total)} lei</div>
            ${!settled ? `<div class="remaining">rest: ${Math.round(group.unpaidTotal)}</div>` : ""}
          </div>
        </div>
        ${billsHtml}
      </div>`;
  }).join("");

  // Attach handlers
  main.querySelectorAll('[data-action="toggle"]').forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const bill = bills[Number(el.dataset.index)];
      togglePaid(bill);
    });
  });
  main.querySelectorAll('[data-action="edit"]').forEach(el => {
    el.addEventListener("click", () => {
      const bill = bills[Number(el.dataset.index)];
      openEditModal(bill);
    });
  });
}

function renderSummary() {
  const main = document.getElementById("mainContent");
  document.getElementById("fabAdd").classList.add("hidden");

  const groups = groupByPayDate();

  if (groups.length === 0) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="stamp">Fără date</div>
        <p>Adaugă plăți în tab-ul "Plăți".</p>
      </div>`;
    return;
  }

  main.innerHTML = groups.map(group => {
    const settled = group.unpaidTotal === 0;
    return `
      <div class="summary-row ${settled ? "settled" : ""}">
        <div>
          <div class="date">${formatSheetDate(group.date)}</div>
          <div class="count">${group.bills.length} plăți</div>
        </div>
        <div class="amounts">
          <div class="total">${Math.round(group.total)} lei</div>
          ${!settled ? `<div class="remaining">rest: ${Math.round(group.unpaidTotal)} lei</div>` : ""}
        </div>
      </div>`;
  }).join("");
}

function renderSettings() {
  const main = document.getElementById("mainContent");
  document.getElementById("fabAdd").classList.add("hidden");

  main.innerHTML = `
    <div class="settings-section">
      <h3>Google Sheets</h3>
      ${isSignedIn()
        ? `<div class="badge">✓ Conectat</div>
           <div class="modal-actions" style="margin-top:0;">
             <button class="btn" id="btnSyncNow">Sincronizează acum</button>
             <button class="btn danger" id="btnSignOut">Deconectează</button>
           </div>`
        : `<div class="badge signed-out">○ Neconectat</div>
           <p>Conectează-te cu contul Google care deține acest spreadsheet pentru a sincroniza plățile.</p>
           <div class="modal-actions">
             <button class="btn primary" id="btnSignIn">Conectează-te cu Google</button>
           </div>`
      }
    </div>
    <div class="settings-section">
      <h3>Despre</h3>
      <p>Spreadsheet: ${CONFIG.SPREADSHEET_ID}<br>Tab: ${CONFIG.SHEET_NAME}</p>
      <p>Bifarea unei plăți o marchează ca plătită. Scriptul tău din Google Sheets o va muta automat în "ISTORIC" — la următoarea sincronizare va dispărea din această listă, exact ca în foaia de calcul.</p>
    </div>`;

  const signInBtn = document.getElementById("btnSignIn");
  if (signInBtn) signInBtn.addEventListener("click", signIn);

  const signOutBtn = document.getElementById("btnSignOut");
  if (signOutBtn) signOutBtn.addEventListener("click", signOut);

  const syncBtn = document.getElementById("btnSyncNow");
  if (syncBtn) syncBtn.addEventListener("click", refreshFromSheet);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================
// MODAL (add/edit)
// ============================================

function openEditModal(bill) {
  editingBill = bill;
  document.getElementById("modalTitle").textContent = bill ? "Editează plata" : "Plată nouă";
  document.getElementById("inputFurnizor").value = bill ? bill.furnizor : "";
  document.getElementById("inputSuma").value = bill ? Math.round(bill.suma) : "";
  document.getElementById("inputScadenta").value = dateToInputValue(bill ? bill.scadenta : new Date());
  document.getElementById("inputDataPlatii").value = dateToInputValue(bill ? bill.dataPlatii : nextPayDate());
  document.getElementById("deleteRow").style.display = bill ? "flex" : "none";
  document.getElementById("editModalOverlay").classList.remove("hidden");
}

function closeEditModal() {
  document.getElementById("editModalOverlay").classList.add("hidden");
  editingBill = null;
}

function saveModal() {
  const furnizor = document.getElementById("inputFurnizor").value.trim();
  const suma = parseFloat(document.getElementById("inputSuma").value);
  const scadenta = inputValueToDate(document.getElementById("inputScadenta").value);
  const dataPlatii = inputValueToDate(document.getElementById("inputDataPlatii").value);

  if (!furnizor || isNaN(suma)) {
    alert("Completează furnizorul și suma.");
    return;
  }

  if (editingBill) {
    const newBill = { ...editingBill, furnizor, suma, scadenta, dataPlatii };
    updateBill(editingBill, newBill);
  } else {
    addBill({ furnizor, suma, scadenta, dataPlatii, platit: false, rowIndex: null });
  }
  closeEditModal();
}

function deleteModal() {
  if (!editingBill) return;
  if (confirm(`Ștergi "${editingBill.furnizor}"?`)) {
    deleteBill(editingBill);
    closeEditModal();
  }
}

// ============================================
// TAB SWITCHING
// ============================================

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll("nav.tabs button").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  renderCurrentTab();
}

// ============================================
// INIT
// ============================================

window.addEventListener("DOMContentLoaded", () => {
  loadFromCache();
  renderCurrentTab();

  document.getElementById("fabAdd").addEventListener("click", () => openEditModal(null));
  document.getElementById("btnCancel").addEventListener("click", closeEditModal);
  document.getElementById("btnSave").addEventListener("click", saveModal);
  document.getElementById("btnDelete").addEventListener("click", deleteModal);

  document.querySelectorAll("nav.tabs button").forEach(b => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });

  // Load Google Identity Services script
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.onload = () => {
    initAuth();
    if (isSignedIn()) {
      refreshFromSheet();
    } else {
      setSyncStatus("Neconectat", "error");
    }
  };
  document.head.appendChild(script);
});
