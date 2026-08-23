# Plăți — Tracker de plăți (Web App)

O aplicație web (PWA) care ține evidența plăților tale, sincronizată cu
Google Sheet-ul tău. Funcționează în Safari pe iPhone, fără Mac, fără App Store,
100% gratuit.

## Ce face
- Afișează plățile grupate pe data plății (1 sau 15 a fiecărei luni)
- Adaugă / editează / șterge plăți
- Bifează "PLATIT" — la sincronizare, scriptul tău din Sheets mută automat
  plata în "ISTORIC" (exact ca până acum)
- Calculează automat totalurile "de plătit" pe fiecare dată (ca în coloanele G/H)
- Se instalează pe ecranul principal ca o aplicație (Add to Home Screen)

---

## PAS 1: Configurează Google Cloud (gratuit)

1. Mergi la https://console.cloud.google.com/
2. Creează un proiect nou (orice nume, ex: "Plati Tracker")
3. Activează **Google Sheets API**:
   - Meniu → APIs & Services → Library → caută "Google Sheets API" → Enable
4. Configurează ecranul de consimțământ OAuth:
   - APIs & Services → OAuth consent screen
   - User Type: **External**
   - Completează nume aplicație, email-ul tău
   - La "Scopes", adaugă: `https://www.googleapis.com/auth/spreadsheets`
   - La "Test users", adaugă contul tău de Google (cel care deține spreadsheet-ul)
5. Creează credențiale OAuth:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Name: orice (ex: "Plati Web")
   - **Authorized JavaScript origins**: adaugă URL-ul unde vei găzdui aplicația
     (vezi Pasul 2 — de obicei `https://username.github.io`)
   - Salvează — vei primi un **Client ID** de forma:
     `123456789-abc123.apps.googleusercontent.com`

---

## PAS 2: Găzduiește aplicația gratuit (GitHub Pages)

Cea mai simplă variantă, 100% gratuită:

1. Creează un cont GitHub (gratuit) dacă nu ai deja: https://github.com
2. Creează un repository nou, public, ex: `plati-app`
3. Încarcă toate fișierele din acest folder (`index.html`, `app.js`, `config.js`,
   `manifest.json`, `icon.svg`) — fie prin upload direct din browser
   (Add file → Upload files), fie cu git
4. Activează GitHub Pages:
   - Settings → Pages → Source: "Deploy from a branch" → Branch: `main` → folder `/ (root)`
   - Salvează. După 1-2 minute, aplicația va fi disponibilă la:
     `https://username.github.io/plati-app/`
5. Revino la Google Cloud Console → Credentials → editează clientul OAuth →
   adaugă exact acest URL (fără slash la final) la **Authorized JavaScript origins**:
   `https://username.github.io`

---

## PAS 3: Configurează aplicația

Editează `config.js` (direct pe GitHub: click pe fișier → ✏️ Edit):

```javascript
const CONFIG = {
  GOOGLE_CLIENT_ID: "123456789-abc123.apps.googleusercontent.com", // de la Pas 1
  SPREADSHEET_ID: "1lRHy8kdx597HZa4U60XzMZ3k44F-sY_B8n205He6X2Y",   // deja corect
  SHEET_NAME: "2026",  // numele tab-ului — deja corect
  SHEET_GID: 0         // gid-ul tab-ului din URL (#gid=XXXX) — verifică
};
```

Pentru `SHEET_GID`: deschide spreadsheet-ul, dă click pe tab-ul "2026",
și verifică numărul după `#gid=` din URL. Dacă e `#gid=0`, lasă `0`.

Salvează (commit). GitHub Pages se va actualiza automat în ~1 minut.

---

## PAS 4: Instalează pe iPhone

1. Deschide `https://username.github.io/plati-app/` în **Safari** (nu Chrome —
   doar Safari permite "Add to Home Screen" ca PWA pe iOS)
2. Apasă butonul de Share (pătrat cu săgeată) → "Add to Home Screen"
3. Apasă "Add" — vei avea o iconiță pe ecranul principal, ca o aplicație normală
4. Deschide aplicația din iconiță → tab "Setări" → "Conectează-te cu Google"
   → autentifică-te cu contul care deține spreadsheet-ul

---

## Cum funcționează cu scriptul tău

Scriptul tău Apps Script (`onEdit`) face automat:
- Sortare după coloana D (data plății)
- Colorare pe grupuri de date
- Mutarea rândurilor bifate (PLATIT=TRUE) în foaia "ISTORIC"
- Recalcularea coloanelor G/H

Aplicația web respectă acest flux:
- Când bifezi o plată, aplicația scrie `TRUE` pe coloana E
- La următoarea sincronizare, plata bifată **va fi dispărut** din listă —
  e normal, înseamnă că scriptul a mutat-o în ISTORIC
- Pentru editare/ștergere, aplicația caută rândul curent după conținut
  (furnizor + sumă + date), nu după poziție, pentru că scriptul reordonează
  rândurile constant
- Coloanele G/H rămân gestionate de scriptul tău; tab-ul "Sumar" din aplicație
  calculează aceleași totaluri independent, doar pentru afișare

---

## Costuri

Totul este gratuit:
- Google Cloud + Sheets API: gratuit (cotă gratuită generoasă)
- GitHub + GitHub Pages: gratuit pentru repo-uri publice
- Nicio nevoie de Mac, Xcode, sau cont de dezvoltator Apple

## Observații
- Token-ul de autentificare Google ține ~1 oră; la expirare, apasă din nou
  "Conectează-te cu Google" din Setări
- Datele se salvează și local (localStorage), deci aplicația funcționează
  offline pentru vizualizare — sincronizarea se face când ai conexiune
