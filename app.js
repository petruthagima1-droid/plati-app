// ============================================
// STATE
// ============================================

let bills = [];          // array of {furnizor, suma, scadenta (Date), dataPlatii (Date), platit, rowIndex}
let history = [];        // array of {furnizor, suma, scadenta, dataPlatii} from ISTORIC
let accessToken = null;
let tokenExpiry = null;
let refreshTimerId = null;
let tokenClient = null;
let currentTab = "bills";
let editingBill = null;  // bill object being edited, or null for "new"
let syncStatusText = "—";
let syncStatusKind = "";

const STORAGE_KEY = "platiTrackerBills";
const TOKEN_KEY = "platiTrackerToken";
const TOKEN_EXP_KEY = "platiTrackerTokenExp";
const HAS_GRANTED_KEY = "platiTrackerHasGranted";

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

function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, date.getDate());
}

function addOneMonth(date) {
  return addMonths(date, 1);
}

function formatLei(n) {
  return Math.round(n).toLocaleString("ro-RO") + " lei";
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

function hasEverGranted() {
  return localStorage.getItem(HAS_GRANTED_KEY) === "true";
}

function initAuth() {
  // Restore token from localStorage if still valid (persists across app closures,
  // unlike sessionStorage which clears every time the app/tab is closed)
  const savedToken = localStorage.getItem(TOKEN_KEY);
  const savedExp = localStorage.getItem(TOKEN_EXP_KEY);
  if (savedToken && savedExp && Date.now() < Number(savedExp)) {
    accessToken = savedToken;
    tokenExpiry = Number(savedExp);
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    callback: (response) => {
      if (response.error) {
        if (!isSignedIn()) {
          setSyncStatus("Neconectat", "error");
        }
        return;
      }
      accessToken = response.access_token;
      tokenExpiry = Date.now() + (response.expires_in * 1000);
      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(TOKEN_EXP_KEY, String(tokenExpiry));
      localStorage.setItem(HAS_GRANTED_KEY, "true");
      renderConnectBar();
      scheduleTokenRefresh();
      refreshFromSheet();
    }
  });

  if (isSignedIn()) {
    scheduleTokenRefresh();
  } else if (hasEverGranted()) {
    // Previously granted access — try to reconnect quietly, without waiting for a tap
    signInSilently();
  }
}

// Renews the access token a few minutes before it expires, in the background.
function scheduleTokenRefresh() {
  if (refreshTimerId) clearTimeout(refreshTimerId);
  if (!tokenExpiry) return;
  const bufferMs = 5 * 60 * 1000; // refresh 5 minutes early
  const delay = Math.max(tokenExpiry - Date.now() - bufferMs, 0);
  refreshTimerId = setTimeout(signInSilently, delay);
}

// Attempts to get a fresh token without showing any prompt/popup, relying on the
// browser's existing Google session. May silently fail (e.g. Safari's tracking
// prevention can block this) — in that case the person just needs to tap "Conectează-te".
function signInSilently() {
  if (!tokenClient) return;
  tokenClient.requestAccessToken({ prompt: "" });
}

function signIn() {
  tokenClient.requestAccessToken();
}

function signOut() {
  accessToken = null;
  tokenExpiry = null;
  if (refreshTimerId) clearTimeout(refreshTimerId);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
  localStorage.removeItem(HAS_GRANTED_KEY);
  renderConnectBar();
  renderCurrentTab();
}

function isSignedIn() {
  return !!accessToken && !!tokenExpiry && Date.now() < tokenExpiry;
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
  return appendBillsToSheet([bill]);
}

async function appendBillsToSheet(billsArray) {
  const range = `${CONFIG.SHEET_NAME}!A:E`;
  const url = `${SHEETS_BASE}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const rows = billsArray.map(bill => [
    bill.furnizor,
    String(Math.round(bill.suma)),
    formatSheetDate(bill.scadenta),
    formatSheetDate(bill.dataPlatii),
    bill.platit ? "TRUE" : "FALSE"
  ]);
  const res = await fetch(url, {
    method: "POST",
    headers: sheetsHeaders(),
    body: JSON.stringify({ values: rows })
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

// History sheet: ISTORIC!A:D — FURNIZOR, SUMA, SCADENTA, DATA PLATII (no PLATIT col, no header)
async function fetchHistoryFromSheet() {
  const range = `ISTORIC!A1:D`;
  const url = `${SHEETS_BASE}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: sheetsHeaders() });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const values = data.values || [];
  const result = [];
  values.forEach(row => {
    if (row.length < 4) return;
    const furnizor = row[0];
    const suma = parseFloat(String(row[1]).replace(",", "")) || 0;
    const scadenta = parseSheetDate(row[2]);
    const dataPlatii = parseSheetDate(row[3]);
    if (!scadenta || !dataPlatii) return;
    result.push({ furnizor, suma, scadenta, dataPlatii });
  });
  // Most recently paid first
  result.sort((a, b) => b.dataPlatii - a.dataPlatii);
  return result;
}

// ============================================
// SYNC ORCHESTRATION
// ============================================

function setSyncStatus(text, kind) {
  syncStatusText = text;
  syncStatusKind = kind || "";
  renderConnectBar();
}

async function refreshFromSheet() {
  if (!isSignedIn()) {
    setSyncStatus("Neconectat", "error");
    return;
  }
  setSyncStatus("Se sincronizează…", "syncing");
  try {
    bills = await fetchBillsFromSheet();
    history = []; // invalidate; will be refetched when Istoric tab is opened
    saveToCache();
    const now = new Date();
    setSyncStatus("Sincronizat " + now.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" }));
    renderCurrentTab();
  } catch (e) {
    console.error(e);
    if (String(e).includes("401")) {
      // token expired mid-use — clear it and try a silent reconnect before giving up
      accessToken = null;
      tokenExpiry = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_EXP_KEY);
      renderConnectBar();
      if (hasEverGranted()) {
        setSyncStatus("Se reconectează…", "syncing");
        signInSilently();
      } else {
        setSyncStatus("Neconectat", "error");
      }
    } else {
      setSyncStatus("Eroare sincronizare", "error");
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

async function addRecurringBills(billsArray) {
  bills.push(...billsArray);
  saveToCache();
  renderCurrentTab();
  if (!isSignedIn()) return;
  showLoading(true);
  try {
    await appendBillsToSheet(billsArray);
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

// Applies a new amount to all future, unpaid bills sharing the same furnizor —
// used when editing a recurring payment ("aplică la toate plățile viitoare").
async function applyAmountToFutureSeries(furnizor, newSuma, excludeBill) {
  const candidates = bills.filter(b =>
    b !== excludeBill &&
    b.furnizor === furnizor &&
    !b.platit &&
    b.dataPlatii > excludeBill.dataPlatii
  );
  if (candidates.length === 0) return;
  showLoading(true);
  try {
    for (const b of candidates) {
      const updated = { ...b, suma: newSuma };
      if (isSignedIn()) {
        await updateBillInSheet(b, updated);
      }
      const idx = bills.indexOf(b);
      if (idx !== -1) bills[idx] = updated;
    }
    saveToCache();
    if (isSignedIn()) {
      await refreshFromSheet();
    } else {
      renderCurrentTab();
    }
  } catch (e) {
    console.error(e);
    setSyncStatus("Eroare la actualizarea seriei", "error");
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

// Blue/green palette for alternating pay-date groups
const GROUP_COLORS = [
  "#2F80ED", "#1F9E5B", "#3E96D6", "#2FAE7A", "#1E6FBF", "#38B58C"
];

function renderCurrentTab() {
  if (currentTab === "bills") renderBills();
  else renderHistory();
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

  const groupsHtml = groups
    .filter(group => group.unpaidTotal > 0)
    .map((group, gi) => {
    const color = GROUP_COLORS[gi % GROUP_COLORS.length];
    const unpaidBills = group.bills.filter(b => !b.platit);
    const billsHtml = unpaidBills.map((bill, bi) => {
      const overdue = startOfDay(bill.scadenta) < today;
      const billIndex = bills.indexOf(bill);
      return `
        <div class="bill" data-index="${billIndex}">
          <div class="checkbox" data-action="toggle" data-index="${billIndex}" style="border-color:${color}"></div>
          <div class="bill-info" data-action="edit" data-index="${billIndex}">
            <div class="furnizor">${escapeHtml(bill.furnizor)}</div>
            <div class="scadenta ${overdue ? "overdue" : ""}">Scadență: ${formatSheetDate(bill.scadenta)}${overdue ? '<span class="overdue-badge">scadent</span>' : ""}</div>
          </div>
          <div class="suma">${formatLei(bill.suma)}</div>
        </div>`;
    }).join("");

    return `
      <div class="group">
        <div class="group-header" style="background:${color}">
          <div class="date">${formatSheetDate(group.date)}</div>
          <div class="totals">${formatLei(group.unpaidTotal)}</div>
        </div>
        ${billsHtml}
      </div>`;
  }).join("");

  if (!groupsHtml) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="stamp">Totul e plătit</div>
        <p>Nu mai ai plăți restante.</p>
      </div>`;
    return;
  }

  main.innerHTML = groupsHtml;

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

function renderHistory() {
  const main = document.getElementById("mainContent");
  document.getElementById("fabAdd").classList.add("hidden");

  if (!isSignedIn()) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="stamp">Neconectat</div>
        <p>Conectează-te cu Google pentru a vedea istoricul.</p>
      </div>`;
    return;
  }

  if (history.length === 0) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="stamp">Se încarcă…</div>
        <p>Istoricul plăților se încarcă.</p>
      </div>`;
    fetchHistoryFromSheet()
      .then(h => { history = h; if (currentTab === "history") renderHistory(); })
      .catch(e => {
        console.error(e);
        main.innerHTML = `
          <div class="empty-state">
            <div class="stamp">Eroare</div>
            <p>Nu am putut încărca foaia "ISTORIC".</p>
          </div>`;
      });
    return;
  }

  main.innerHTML = history.map(h => `
    <div class="history-row">
      <div>
        <div class="furnizor">${escapeHtml(h.furnizor)}</div>
        <div class="dates">Scadență ${formatSheetDate(h.scadenta)} · Plătit ${formatSheetDate(h.dataPlatii)}</div>
      </div>
      <div class="suma">${formatLei(h.suma)}</div>
    </div>`).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================
// CONNECT BAR (sign in / sync / sign out — lives on the main page)
// ============================================

function renderConnectBar() {
  const bar = document.getElementById("connectBar");
  if (!bar) return;
  if (!isSignedIn()) {
    bar.innerHTML = `<button class="btn-connect" id="btnConnectMain">Conectează-te cu Google</button>`;
    document.getElementById("btnConnectMain").addEventListener("click", signIn);
  } else {
    bar.innerHTML = `
      <div class="connect-status">
        <span class="status-text ${syncStatusKind}">${syncStatusText}</span>
        <button class="link-btn" id="btnSyncNow2" title="Sincronizează">↻</button>
        <button class="link-btn danger text" id="btnSignOut2">Deconectare</button>
      </div>`;
    document.getElementById("btnSyncNow2").addEventListener("click", refreshFromSheet);
    document.getElementById("btnSignOut2").addEventListener("click", signOut);
  }
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
  document.getElementById("duplicateRow").style.display = bill ? "flex" : "none";
  document.getElementById("fieldRecurring").style.display = bill ? "none" : "block";
  document.getElementById("inputRecurringMonths").value = "";
  document.getElementById("fieldApplyFuture").style.display = bill ? "block" : "none";
  document.getElementById("inputApplyFuture").checked = false;
  document.getElementById("editModalOverlay").classList.remove("hidden");
}

function duplicateModal() {
  if (!editingBill) return;
  const base = editingBill;
  closeEditModal();
  // Open as a "new" entry, pre-filled with the same supplier/amount,
  // advanced by one pay period (useful for recurring monthly bills)
  editingBill = null;
  document.getElementById("modalTitle").textContent = "Plată nouă (duplicat)";
  document.getElementById("inputFurnizor").value = base.furnizor;
  document.getElementById("inputSuma").value = Math.round(base.suma);
  document.getElementById("inputScadenta").value = dateToInputValue(addOneMonth(base.scadenta));
  document.getElementById("inputDataPlatii").value = dateToInputValue(addOneMonth(base.dataPlatii));
  document.getElementById("deleteRow").style.display = "none";
  document.getElementById("duplicateRow").style.display = "none";
  document.getElementById("fieldRecurring").style.display = "block";
  document.getElementById("inputRecurringMonths").value = "";
  document.getElementById("fieldApplyFuture").style.display = "none";
  document.getElementById("inputApplyFuture").checked = false;
  document.getElementById("editModalOverlay").classList.remove("hidden");
}

function closeEditModal() {
  document.getElementById("editModalOverlay").classList.add("hidden");
  editingBill = null;
}

async function saveModal() {
  const furnizor = document.getElementById("inputFurnizor").value.trim();
  const suma = parseFloat(document.getElementById("inputSuma").value);
  const scadenta = inputValueToDate(document.getElementById("inputScadenta").value);
  const dataPlatii = inputValueToDate(document.getElementById("inputDataPlatii").value);

  if (!furnizor || isNaN(suma)) {
    alert("Completează furnizorul și suma.");
    return;
  }

  if (editingBill) {
    const oldBill = editingBill;
    const newBill = { ...oldBill, furnizor, suma, scadenta, dataPlatii };
    const applyFuture = document.getElementById("inputApplyFuture").checked;
    closeEditModal();
    await updateBill(oldBill, newBill);
    if (applyFuture) {
      await applyAmountToFutureSeries(oldBill.furnizor, suma, oldBill);
    }
  } else {
    const months = parseInt(document.getElementById("inputRecurringMonths").value, 10);
    closeEditModal();
    if (months && months > 1) {
      const billsArray = [];
      for (let i = 0; i < months; i++) {
        billsArray.push({
          furnizor, suma,
          scadenta: addMonths(scadenta, i),
          dataPlatii: addMonths(dataPlatii, i),
          platit: false,
          rowIndex: null
        });
      }
      await addRecurringBills(billsArray);
    } else {
      await addBill({ furnizor, suma, scadenta, dataPlatii, platit: false, rowIndex: null });
    }
  }
}

function deleteModal() {
  if (!editingBill) return;
  if (confirm(`Ștergi "${editingBill.furnizor}"?`)) {
    deleteBill(editingBill);
    closeEditModal();
  }
}

// ============================================
// PULL TO REFRESH
// ============================================

function initPullToRefresh() {
  const main = document.getElementById("mainContent");
  const indicator = document.getElementById("pullIndicator");
  let startY = 0;
  let pulling = false;
  const threshold = 70;

  main.addEventListener("touchstart", (e) => {
    if (window.scrollY > 0) { pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  main.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const delta = e.touches[0].clientY - startY;
    if (delta > 10 && window.scrollY === 0) {
      indicator.classList.add("visible");
      indicator.textContent = delta > threshold ? "↑ Eliberează pentru sincronizare" : "↓ Trage pentru sincronizare";
    } else {
      indicator.classList.remove("visible");
    }
  }, { passive: true });

  main.addEventListener("touchend", (e) => {
    if (!pulling) return;
    const delta = (e.changedTouches[0].clientY - startY);
    indicator.classList.remove("visible");
    if (delta > threshold && window.scrollY === 0) {
      if (isSignedIn()) {
        refreshFromSheet();
      } else {
        setSyncStatus("Neconectat", "error");
      }
    }
    pulling = false;
  });
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
  renderConnectBar();

  document.getElementById("fabAdd").addEventListener("click", () => openEditModal(null));
  document.getElementById("btnCancel").addEventListener("click", closeEditModal);
  document.getElementById("btnSave").addEventListener("click", saveModal);
  document.getElementById("btnDelete").addEventListener("click", deleteModal);
  document.getElementById("btnDuplicate").addEventListener("click", duplicateModal);

  initPullToRefresh();

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
    } else if (hasEverGranted()) {
      setSyncStatus("Se reconectează…", "syncing");
    } else {
      setSyncStatus("Neconectat", "error");
    }
  };
  document.head.appendChild(script);
});
