# TG Tool — Deployment Guide

## Overview

Backend: FastAPI on Render.com (free tier)
Frontend: Static files served by FastAPI (no separate hosting needed)
Domain: TgTool.xyz via GoDaddy → CNAME to Render

---

## Step 1 — Push to GitHub

1. Create a new repo at github.com (e.g. `tgtool`)
2. In `D:/TG/TgToolWeb/`:
   ```
   git init
   git add .
   git commit -m "initial"
   git remote add origin https://github.com/YOUR_USERNAME/tgtool.git
   git push -u origin main
   ```

---

## Step 2 — Deploy on Render

1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo (`tgtool`)
3. Render will auto-detect `render.yaml` — settings will pre-fill:
   - Runtime: Python
   - Build: `pip install -r requirements.txt`
   - Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Go to **Environment** tab and add:
   - `TELEGRAM_API_ID` → your API ID from my.telegram.org
   - `TELEGRAM_API_HASH` → your API hash
5. Click **Deploy**. Wait ~2 min for first build.
6. Note your Render URL: `https://tgtool.onrender.com`

> Free tier sleeps after 15 min of inactivity (cold start ~30s).
> Upgrade to Starter ($7/mo) for always-on.

---

## Step 3 — Connect GoDaddy Domain

1. Log in to GoDaddy → Manage DNS for **TgTool.xyz**
2. Add a **CNAME** record:
   - Name: `@` (root) — GoDaddy may require `www` for CNAME
   - Value: `tgtool.onrender.com`
   - TTL: 600
3. For root domain (`tgtool.xyz`), GoDaddy requires **ALIAS / ANAME** or forwarding:
   - Option A: Add CNAME for `www` → `tgtool.onrender.com`, then set up HTTP forwarding from `tgtool.xyz` → `www.tgtool.xyz`
   - Option B: Use Cloudflare (free) as nameservers — add CNAME with proxy for root domain

4. In Render → your service → **Settings** → **Custom Domains**:
   - Add `www.tgtool.xyz` (and/or `tgtool.xyz`)
   - Render will issue a free TLS cert automatically

5. DNS propagation: 5–30 min typically

---

## Env Variables Reference

| Variable          | Where to get it                         |
|-------------------|-----------------------------------------|
| TELEGRAM_API_ID   | https://my.telegram.org → App API     |
| TELEGRAM_API_HASH | https://my.telegram.org → App API     |

These are your app's API credentials — every user authenticates with their own phone/code via the web UI. Your API ID is shared infrastructure (like an app token), not a user credential.

---

## File Structure

```
TgToolWeb/
├── main.py              # FastAPI backend
├── requirements.txt
├── render.yaml          # Render deployment config
├── .gitignore
├── DEPLOY.md            # This file
└── static/
    ├── index.html       # SPA
    ├── style.css
    ├── app.js
    ├── background.jpg
    ├── logo_horizontal.png
    └── favicon.png
```

---

## Local Testing

```bash
cd D:/TG/TgToolWeb
pip install -r requirements.txt

# Set env vars (Windows PowerShell)
$env:TELEGRAM_API_ID   = "12345678"
$env:TELEGRAM_API_HASH = "yourhashere"

uvicorn main:app --reload --port 8000
# Open http://localhost:8000
```
