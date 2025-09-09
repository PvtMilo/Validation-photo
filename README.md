Here’s a drop-in **`README.md`** you can put in your repo. It’s step-by-step, “idiot-proof,” and covers: pre-event QR generation (8,000 or any number), printing, reset flows, deleting QR files, dslrBooth setup, running the app, and troubleshooting.

---

# XSO Lock — Setup & Operations Guide

A fullscreen Electron overlay that locks **dslrBooth** until a guest scans a **pre-generated** QR code. Overlay hides after a valid scan; when the operator presses **Done** in dslrBooth, it **relocks** automatically via a local webhook.

* **Single monitor**, **offline OK**
* **2D scanner** in **keyboard-wedge** mode (sends **Enter** after data)
* **Single-use** tokens: `ISSUED → IN_USE → COMPLETED/CANCELLED`
* **Esc** minimizes overlay (config flag, enabled by default)
* Overlay reappears only on **`event_type=session_end`** hook

---

## 0) Prerequisites (Windows)

1. Windows 10/11
2. Node.js 18+ (22.x recommended) → `node -v`
3. dslrBooth (Windows) installed & camera working
4. Your 2D scanner configured as **keyboard wedge** with **Enter** suffix
   (Test in Notepad: scan should type text + newline)

---

## 1) Install the App

In your project folder (e.g., `D:\Repository\overlapp`):

```bash
npm install
```

> If `tokens.json` is missing, create an empty one:

```bash
# PowerShell
'[]' | Set-Content -Path tokens.json -Encoding UTF8
```

---

## 2) Pre-Event: Generate QR Codes (any amount, e.g., 8,000)

You can generate any count and any batch id. The generator creates PNG images, `tokens.csv`, `labels.pdf`, and appends tokens to `tokens.json`.

**Examples:**

```bash
# Generate 10 for testing
node tools/generate-qr.js --count 10 --out qr/B2025-09-08-A --batch B2025-09-08-A

# Generate 8,000 for production batch
node tools/generate-qr.js --count 8000 --out qr/B2025-09-08-A --batch B2025-09-08-A
```

* Output folder: `qr/<BATCH_ID>/`
* Files: `00001-<uuid8>.png …`, `tokens.csv`, `labels.pdf`, `batch.json`
* The app’s `tokens.json` gets **appended** with all new tokens in **ISSUED** state.

**Printing:** open `labels.pdf` and print. This is your master sheet for distribution.

**Sanity check:**

* Open a few PNGs; scan shows payload like `ciu:1|B2025-09-08-A|<uuid>|<sig>`
* Open `tokens.json` and confirm the same count in **ISSUED** state

---

## 3) Clean-up / Reset During Rehearsal (before event day)

When practicing, you’ll want to **reset statuses** or **delete a batch**.
**Stop the app** before modifying `tokens.json`.

### 3.1 Reset statuses (keep the same printed codes)

> **Backup first:**

```powershell
Copy-Item tokens.json tokens.json.bak -ErrorAction SilentlyContinue
```

**Reset ALL tokens to `ISSUED`:**

```powershell
node -e "const fs=require('fs');let t=JSON.parse(fs.readFileSync('tokens.json','utf8'));for(const x of t){x.status='ISSUED';x.claimed_at=null;x.completed_at=null}fs.writeFileSync('tokens.json',JSON.stringify(t,null,2));console.log('Reset',t.length,'tokens');"
```

**Reset only a specific batch to `ISSUED` (replace the ID):**

```powershell
$B='B2025-09-08-A'; node -e "const fs=require('fs');const B=process.env.B;let t=JSON.parse(fs.readFileSync('tokens.json','utf8'));let c=0;for(const x of t){if(x.batch_id===B){x.status='ISSUED';x.claimed_at=null;x.completed_at=null;c++}}fs.writeFileSync('tokens.json',JSON.stringify(t,null,2));console.log('Reset',c,'tokens in batch',B);" 
```

**Reset only `IN_USE` tokens to `ISSUED`:**

```powershell
node -e "const fs=require('fs');let t=JSON.parse(fs.readFileSync('tokens.json','utf8'));let c=0;for(const x of t){if(x.status==='IN_USE'){x.status='ISSUED';x.claimed_at=null;x.completed_at=null;c++}}fs.writeFileSync('tokens.json',JSON.stringify(t,null,2));console.log('Reset',c,'IN_USE tokens');"
```

**Reset one specific UUID:**

```powershell
$U='<uuid-here>'; node -e "const fs=require('fs');const U=process.env.U;let t=JSON.parse(fs.readFileSync('tokens.json','utf8'));let c=0;for(const x of t){if(x.uuid===U){x.status='ISSUED';x.claimed_at=null;x.completed_at=null;c++}}fs.writeFileSync('tokens.json',JSON.stringify(t,null,2));console.log('Reset',c,'token(s) to ISSUED');"
```

> Prefer PowerShell on Windows. On Git Bash, pass env vars like:
> `U='<uuid>' node -e "…process.env.U…"`

### 3.2 Delete QR files for a batch (optional)

If you want to **trash the generated images** and start fresh:

```powershell
# Remove only the image files
Remove-Item -Path qr\B2025-09-08-A\*.png -Force

# Or nuke the entire batch folder (images + CSV + PDF + summary)
Remove-Item -Recurse -Force qr\B2025-09-08-A
```

> **Important:** Deleting PNGs does **not** remove entries from `tokens.json`.
> If you are discarding the batch completely, either:
>
> * regenerate with a **new** `--batch NEW_ID` (recommended), or
> * filter the old batch **out** of `tokens.json`:
>
>   ```powershell
>   $B='B2025-09-08-A'; node -e "const fs=require('fs');const B=process.env.B;let t=JSON.parse(fs.readFileSync('tokens.json','utf8'));t=t.filter(x=>x.batch_id!==B);fs.writeFileSync('tokens.json',JSON.stringify(t,null,2));console.log('Removed batch',B);"
>   ```

---

## 4) Configure dslrBooth (one-time)

In **dslrBooth → Settings → General → Triggers**:

* Set **URL** to:

  ```
  http://127.0.0.1:5858/hook
  ```

  dslrBooth will call this URL with `?event_type=<phase>`.
  The app **ignores everything** except **`event_type=session_end`** (when you press **Done**).

* (Optional security) add a secret:

  ```
  http://127.0.0.1:5858/hook?secret=MYSECRET
  ```

  Then set an environment variable so the app requires it:

  ```powershell
  setx HOOK_SECRET "MYSECRET"
  ```

  (Close and re-open your terminal / restart the app after setting env vars.)

---

## 5) Run the App

```bash
npm start
```

* Overlay shows **“Scan QR to Start”** (always-on-top, fullscreen).
* **Scan** a printed QR → overlay **hides**; token becomes **IN\_USE**.
* Do the normal dslrBooth flow (countdown, capture, share/print).
* Press **Done** → dslrBooth sends `event_type=session_end` → overlay **relocks**, token becomes **COMPLETED**.

**Controls:**

* **Esc** (while locked): minimize overlay (enabled by default)
* **Ctrl + Shift + L**: force relock (overlay shows; any `IN_USE` token becomes `CANCELLED`)

**Diagnostics:**

* Browser: `http://127.0.0.1:5858/health` → `{ ok: true }`
* Dev QR preview: `http://127.0.0.1:5858/debug/qr.png?id=1` (and `id=2`)

---

## 6) Event-Day SOP (Operator)

1. Start **dslrBooth** and leave it ready.
2. Start **XSO Lock**: `npm start` (overlay appears).
3. Guest scans a printed QR → overlay hides.
4. Run session in dslrBooth (take photos, share/print).
5. Operator presses **Done** → overlay returns ready for next guest.
6. If needed:

   * **Esc** minimizes overlay while locked (for quick peek).
   * **Ctrl+Shift+L** force relocks (cancels current token).

---

## 7) Advanced Config (Environment Variables)

Set these via **PowerShell** `setx NAME VALUE` then restart the app:

* `BATCH_ID` — default batch id (for dev QR preview filter)
* `HMAC_SECRET` — HMAC secret for signing/verification (keep private)
* `PORT` — HTTP port (default 5858)
* `HOOK_SECRET` — if set, webhook must include `?secret=...`
* `MIN_SECONDS_BEFORE_SESSION_END` — grace window (seconds) to ignore ultra-early hooks; default **3**.
  If “Done” happens much later (after printing/sharing), bump to **6–10**:

  ```powershell
  setx MIN_SECONDS_BEFORE_SESSION_END 6
  ```

---

## 8) File & Folder Layout

```
xso-lock/
  package.json
  config.js
  main.js
  preload.js
  tokens.json                  # token store (ISSUED/IN_USE/COMPLETED/CANCELLED)
  tools/
    generate-qr.js            # QR batch generator (PNGs, CSV, PDF, summary)
  renderer/
    index.html
    styles.css
  qr/
    <BATCH_ID>/
      00001-<uuid8>.png
      ...
      tokens.csv
      labels.pdf
      batch.json
```

---

## 9) Troubleshooting

**Overlay relocks during countdown**
– Fixed by design: app **ignores** all events except `event_type=session_end`.
– If you still see early relocks, check your dslrBooth URL is `/hook` (not hard-coded `/hook/session_end`), and watch the console logs.

**Scan not recognized**
– Ensure scanner appends **Enter**. Test in Notepad.
– In overlay, you don’t click anything—hidden input auto-focuses.

**“QR bukan untuk event ini”**
– Your generated `--batch` and the app’s `BATCH_ID` don’t match. Regenerate or align `BATCH_ID`.

**“QR sudah digunakan”** on fresh codes
– You likely reused a code from a previous run. Reset statuses (see §3.1) or generate a new batch id.

**tokens.json corrupted / empty**
– Replace file contents with `[]`, then re-generate or reset.

**Port in use**
– Change `PORT` and update dslrBooth URL accordingly.

**Esc shows desktop**
– In production, enable Windows **Assigned Access / Shell Launcher** so minimizing only exposes dslrBooth, not the desktop/taskbar.

---

## 10) Best Practices

* Use a **new `--batch` id** for each event (clean reporting, easy archiving).
* Print from **`labels.pdf`** to ensure consistent sizing.
* Keep **`tokens.json`** under versioned backup during rehearsals.
* For big events, consider migrating the token store to SQLite (WAL) later.

---

## 11) Quick Command Reference

```bash
# Install deps
npm install

# Generate 10 dev codes
node tools/generate-qr.js --count 10 --out qr/B2025-09-08-A --batch B2025-09-08-A

# Generate 8000 prod codes
node tools/generate-qr.js --count 8000 --out qr/B2025-09-08-A --batch B2025-09-08-A

# Reset ALL tokens to ISSUED
node -e "const fs=require('fs');let t=JSON.parse(fs.readFileSync('tokens.json','utf8'));for(const x of t){x.status='ISSUED';x.claimed_at=null;x.completed_at=null}fs.writeFileSync('tokens.json',JSON.stringify(t,null,2));"

# Remove an entire batch folder (PowerShell)
Remove-Item -Recurse -Force qr\B2025-09-08-A

# Start overlay
npm start
```

---

If you want, I can also generate a **printable 1-page SOP** for operators with only the 8–10 steps they need on event day.
# Validation-photo
