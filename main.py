#!/usr/bin/env python3
"""
TgTool.xyz — Telegram Tools Web Backend
Zero server-side storage: session strings live in the user's browser only.
API_ID / API_HASH are the site-owner's Telegram app credentials (env vars).
"""
import asyncio, csv, io, itertools, os, re, tempfile, time, uuid, zipfile
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from telethon import TelegramClient, errors, functions, types
from telethon.sessions import StringSession
from telethon.tl.functions.messages import (
    GetCommonChatsRequest, GetFullChatRequest, GetStickerSetRequest,
)
from telethon.tl.functions.channels import GetParticipantsRequest
from telethon.tl.types import (
    Channel, Chat,
    ChannelParticipantCreator, ChannelParticipantsAdmins,
    ChatParticipantCreator, InputStickerSetShortName,
)

# ── Config ────────────────────────────────────────────────────────────────────
API_ID   = int(os.environ.get("TELEGRAM_API_ID",   "0"))
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="TgTool", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://tgtool.xyz", "https://www.tgtool.xyz",
                   "http://localhost:8000"],   # dev
    allow_methods=["*"], allow_headers=["*"],
)

# ── In-memory download store (bytes only, never touches disk) ─────────────────
_dl: dict[str, tuple[bytes, str, float]] = {}   # token → (data, filename, expiry)

def _save_dl(data: bytes, filename: str, ttl: int = 300) -> str:
    _purge_dl()
    tok = str(uuid.uuid4())
    _dl[tok] = (data, filename, time.time() + ttl)
    return tok

def _purge_dl():
    now = time.time()
    for k in [k for k, (_, _, exp) in list(_dl.items()) if now > exp]:
        del _dl[k]

# ── Telethon helpers ──────────────────────────────────────────────────────────
def _client(session: str) -> TelegramClient:
    return TelegramClient(StringSession(session), API_ID, API_HASH)

def _csv(header: list, rows: list) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")

def _safe(s: str) -> str:
    return re.sub(r"[^\w\s\-]", "", s).strip() or "export"

async def _resolve(c: TelegramClient, ref: str):
    ref = ref.strip()
    m = re.search(r"t\.me/\+([A-Za-z0-9_\-]+)", ref)
    if m:
        return await c(functions.messages.ImportChatInviteRequest(hash=m.group(1)))
    if ref.startswith("https://t.me/"):
        ref = ref[len("https://t.me/"):].strip("/@")
    elif ref.startswith("@"):
        ref = ref[1:]
    return await c.get_entity(ref)

# ── Pydantic request models ───────────────────────────────────────────────────
class PhoneReq(BaseModel):
    phone: str

class SignInReq(BaseModel):
    phone: str
    code: str
    password: str = ""
    phone_code_hash: str
    partial_session: str

class SessionReq(BaseModel):
    session: str

# ══════════════════════════════════════════════════════════════════════════════
# AUTH
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/auth/send_code")
async def send_code(req: PhoneReq):
    c = _client("")
    await c.connect()
    try:
        r = await c.send_code_request(req.phone)
        return {"phone_code_hash": r.phone_code_hash,
                "partial_session": c.session.save()}
    except errors.PhoneNumberInvalidError:
        return JSONResponse({"error": "Invalid phone number"}, 400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, 500)
    finally:
        await c.disconnect()


@app.post("/api/auth/sign_in")
async def sign_in(req: SignInReq):
    c = _client(req.partial_session)
    await c.connect()
    me = None
    try:
        await c.sign_in(req.phone, req.code,
                        phone_code_hash=req.phone_code_hash)
    except errors.SessionPasswordNeededError:
        if not req.password:
            await c.disconnect()
            return JSONResponse({"error": "2FA required", "need_2fa": True}, 401)
        try:
            await c.sign_in(password=req.password)
        except errors.PasswordHashInvalidError:
            await c.disconnect()
            return JSONResponse({"error": "Wrong 2FA password"}, 401)
    except errors.PhoneCodeInvalidError:
        await c.disconnect()
        return JSONResponse({"error": "Invalid code"}, 401)
    except Exception as e:
        await c.disconnect()
        return JSONResponse({"error": str(e)}, 500)

    me      = await c.get_me()
    session = c.session.save()
    await c.disconnect()
    return {
        "session": session,
        "user": {"id": me.id, "username": me.username or "",
                 "first_name": me.first_name or "",
                 "last_name":  me.last_name  or ""},
    }


@app.post("/api/auth/verify")
async def verify(req: SessionReq):
    c = _client(req.session)
    await c.connect()
    try:
        if not await c.is_user_authorized():
            return JSONResponse({"error": "Not authorized"}, 401)
        me = await c.get_me()
        return {"user": {"id": me.id, "username": me.username or "",
                         "first_name": me.first_name or "",
                         "last_name":  me.last_name  or ""}}
    finally:
        await c.disconnect()

# ══════════════════════════════════════════════════════════════════════════════
# DIALOGS LIST
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/dialogs")
async def dialogs(req: SessionReq):
    c = _client(req.session)
    await c.connect()
    try:
        out = []
        async for d in c.iter_dialogs():
            e = d.entity
            if isinstance(e, Channel):
                kind = "Supergroup" if e.megagroup else "Channel"
            elif isinstance(e, Chat):
                kind = "Group"
            else:
                continue
            out.append({"id": e.id, "title": getattr(e, "title", ""), "type": kind})
        return out
    finally:
        await c.disconnect()

# ══════════════════════════════════════════════════════════════════════════════
# DOWNLOAD
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/download/{token}")
async def download(token: str):
    if token not in _dl:
        return JSONResponse({"error": "Token expired or not found"}, 404)
    data, filename, _ = _dl.pop(token)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# ══════════════════════════════════════════════════════════════════════════════
# TGS → GIF  (file-upload endpoint, not WebSocket)
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/tools/tgs_to_gif")
async def tgs_to_gif(
    files:  list[UploadFile] = File(...),
    width:  int = Form(512),
    height: int = Form(512),
    fps:    int = Form(30),
):
    try:
        import rlottie_python as rl
    except ImportError:
        return JSONResponse({"error": "rlottie-python not available on this server"}, 500)

    width  = max(16, min(width,  1024))
    height = max(16, min(height, 1024))
    fps    = max(5,  min(fps,    60))

    zip_buf = io.BytesIO()
    ok = err = 0

    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            raw  = await f.read()
            stem = Path(f.filename or "sticker").stem
            tmp_in = tmp_out = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".tgs", delete=False) as tf:
                    tf.write(raw); tmp_in = tf.name
                with tempfile.NamedTemporaryFile(suffix=".gif", delete=False) as tf:
                    tmp_out = tf.name

                anim = rl.LottieAnimation.from_tgs(tmp_in)
                anim.save_animation(tmp_out, fps=fps, width=width, height=height)

                with open(tmp_out, "rb") as gf:
                    zf.writestr(f"{stem}.gif", gf.read())
                ok += 1
            except Exception as ex:
                zf.writestr(f"{stem}_ERROR.txt", str(ex))
                err += 1
            finally:
                for p in [tmp_in, tmp_out]:
                    if p:
                        try: os.unlink(p)
                        except Exception: pass

    ts       = time.strftime("%Y%m%d_%H%M%S")
    filename = f"converted_gifs_{ts}.zip"
    tok      = _save_dl(zip_buf.getvalue(), filename)
    return {"token": tok, "ok": ok, "err": err, "filename": filename}

# ══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET TOOL RUNNER
# ══════════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/tool")
async def ws_tool(ws: WebSocket):
    await ws.accept()

    try:
        msg = await asyncio.wait_for(ws.receive_json(), timeout=15)
    except Exception:
        return

    tool    = msg.get("tool", "")
    session = msg.get("session", "")
    params  = msg.get("params", {})

    async def log(text: str):
        try: await ws.send_json({"type": "log", "text": text})
        except Exception: pass

    async def done(token: str, count: int, filename: str):
        try: await ws.send_json({"type": "done",
                                  "token": token, "count": count, "filename": filename})
        except Exception: pass

    async def err(text: str):
        try: await ws.send_json({"type": "error", "text": text})
        except Exception: pass

    c = _client(session)
    await c.connect()
    try:
        if not await c.is_user_authorized():
            await err("Session expired — please log in again."); return

        dispatch = {
            "export_members": _export_members,
            "export_all":     _export_all,
            "export_full":    _export_full,
            "common_chats":   _common_chats,
            "boosters":       _boosters,
            "resolve_ids":    _resolve_ids,
            "emoji_pack":     _emoji_pack,
        }
        fn = dispatch.get(tool)
        if fn: await fn(c, params, log, done, err)
        else:  await err(f"Unknown tool: {tool}")

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try: await err(str(e))
        except Exception: pass
    finally:
        await c.disconnect()
        try: await ws.close()
        except Exception: pass

# ══════════════════════════════════════════════════════════════════════════════
# TOOL IMPLEMENTATIONS
# ══════════════════════════════════════════════════════════════════════════════

async def _export_members(c, p, log, done, err):
    ref = p.get("chat_ref", "")
    if not ref: return await err("No chat specified")
    await log("Resolving chat…")
    try:   entity = await _resolve(c, ref)
    except Exception as e: return await err(f"Could not resolve: {e}")

    title = getattr(entity, "title", str(getattr(entity, "id", "")))
    await log(f"Exporting members from: {title}")
    rows = []
    try:
        async for u in c.iter_participants(entity, aggressive=True):
            rows.append([u.id, u.username or "", u.first_name or "",
                         u.last_name or "", bool(getattr(u, "bot", False))])
            if len(rows) % 100 == 0: await log(f"  Collected {len(rows):,}…")
    except errors.ChatAdminRequiredError:
        return await err("Admin rights required to view members")

    filename = f"{_safe(title)}_members_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    tok = _save_dl(_csv(["id","username","first_name","last_name","is_bot"], rows), filename)
    await done(tok, len(rows), filename)


async def _export_all(c, p, log, done, err):
    selected = set(p.get("entity_ids", []))
    if not selected: return await err("No chats selected")

    await log("Loading your chats…")
    to_export = []
    async for d in c.iter_dialogs():
        if getattr(d.entity, "id", None) in selected:
            to_export.append(d.entity)
    await log(f"Exporting {len(to_export)} chats…")

    zip_buf = io.BytesIO()
    summary = []
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, ent in enumerate(to_export, 1):
            title = getattr(ent, "title", str(ent.id))
            await log(f"[{i}/{len(to_export)}] {title}…")
            try:
                rows = []
                async for u in c.iter_participants(ent):
                    rows.append([u.id, u.username or "", u.first_name or "", u.last_name or ""])
                zf.writestr(f"{_safe(title)}.csv",
                            _csv(["id","username","first_name","last_name"], rows))
                summary.append([title, ent.id, len(rows)])
                await log(f"  → {len(rows):,} members")
            except errors.ChatAdminRequiredError:
                await log("  → Skipped (no access)")
            except Exception as e:
                await log(f"  → Error: {e}")
            await asyncio.sleep(0.5)

        zf.writestr("summary.csv", _csv(["title","chat_id","member_count"], summary))

    filename = f"all_chats_{time.strftime('%Y%m%d_%H%M%S')}.zip"
    tok = _save_dl(zip_buf.getvalue(), filename)
    await done(tok, len(summary), filename)


async def _export_full(c, p, log, done, err):
    ref     = p.get("chat_ref", "")
    stop_at = int(p.get("stop_at", 5000))
    if not ref: return await err("No chat specified")

    await log("Resolving chat…")
    try:   entity = await _resolve(c, ref)
    except Exception as e: return await err(f"Could not resolve: {e}")

    title      = getattr(entity, "title", str(getattr(entity, "id", "")))
    is_channel = isinstance(entity, Channel) and entity.broadcast
    is_mega    = isinstance(entity, Channel) and entity.megagroup
    seen: dict[int, list] = {}

    if is_mega or isinstance(entity, Chat):
        await log("Supergroup — aggressive scan…")
        async for u in c.iter_participants(entity, aggressive=True):
            if getattr(u, "bot", False): continue
            seen[u.id] = [u.id, u.username or "", u.first_name or "", u.last_name or ""]
            if len(seen) % 100 == 0: await log(f"  Collected {len(seen):,}…")
            if len(seen) >= stop_at: break

    elif is_channel:
        await log("Channel — search-based scan…")
        chars = "qwertyuiopasdfghjklzxcvbnm0123456789"
        queries = itertools.chain(chars,
                                  (a + b for a, b in itertools.product(chars, repeat=2)))
        for query in queries:
            try:
                async for u in c.iter_participants(entity, search=query):
                    if getattr(u, "bot", False): continue
                    seen[u.id] = [u.id, u.username or "", u.first_name or "", u.last_name or ""]
                    if len(seen) >= stop_at: break
            except errors.FloodWaitError as fw:
                await log(f"  Flood wait {fw.seconds}s…")
                await asyncio.sleep(fw.seconds + 1)
            if len(seen) >= stop_at:
                await log(f"  Reached limit ({stop_at:,}). Stopping.")
                break
            if len(seen) % 300 == 0 and len(seen):
                await log(f"  Collected {len(seen):,}…")
            await asyncio.sleep(0.6)

    filename = f"{_safe(title)}_deep_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    tok = _save_dl(_csv(["id","username","first_name","last_name"],
                         list(seen.values())), filename)
    await done(tok, len(seen), filename)


async def _common_chats(c, p, log, done, err):
    usernames = [u.strip().lstrip("@") for u in p.get("usernames", []) if u.strip()]
    if not usernames: return await err("No usernames provided")

    zip_buf = io.BytesIO()
    total   = 0
    with zipfile.ZipFile(zip_buf, "w") as zf:
        for uname in usernames:
            await log(f"Looking up @{uname}…")
            try:   user = await c.get_entity(uname)
            except Exception as e:
                await log(f"  Not found: {e}"); continue

            chats, max_id = [], 0
            while True:
                res = await c(GetCommonChatsRequest(user_id=user, max_id=max_id, limit=100))
                if not res.chats: break
                chats.extend(res.chats); max_id = res.chats[-1].id
                if len(res.chats) < 100: break
            await log(f"  {len(chats)} shared chats — fetching owners…")

            rows = []
            for chat in chats:
                name = getattr(chat, "title", "Unnamed")
                kind = ("Supergroup" if isinstance(chat, Channel) and chat.megagroup
                        else "Channel" if isinstance(chat, Channel) else "Group")
                owner_u, owner_id = "N/A", "N/A"
                try:
                    if isinstance(chat, Channel):
                        r = await c(GetParticipantsRequest(
                            channel=chat,
                            filter=ChannelParticipantsAdmins(),
                            offset=0, limit=100, hash=0))
                        for part in r.participants:
                            if isinstance(part, ChannelParticipantCreator):
                                for u in r.users:
                                    if u.id == part.user_id:
                                        owner_u  = f"@{u.username}" if u.username else f"id:{u.id}"
                                        owner_id = u.id
                    elif isinstance(chat, Chat):
                        full = await c(GetFullChatRequest(chat_id=chat.id))
                        um   = {u.id: u for u in full.users}
                        for part in full.full_chat.participants.participants:
                            if isinstance(part, ChatParticipantCreator):
                                u = um.get(part.user_id)
                                if u:
                                    owner_u  = f"@{u.username}" if u.username else f"id:{u.id}"
                                    owner_id = u.id
                except Exception:
                    pass
                rows.append([name, kind, chat.id, owner_u, owner_id])
                await asyncio.sleep(0.25)

            zf.writestr(f"{uname}_common_chats.csv",
                        _csv(["chat_name","type","chat_id","owner_username","owner_id"], rows))
            total += len(rows)

    filename = f"common_chats_{time.strftime('%Y%m%d_%H%M%S')}.zip"
    tok = _save_dl(zip_buf.getvalue(), filename)
    await done(tok, total, filename)


async def _boosters(c, p, log, done, err):
    ref = p.get("chat_ref", "")
    if not ref: return await err("No chat specified")
    await log("Resolving channel…")
    try:   entity = await _resolve(c, ref)
    except Exception as e: return await err(f"Could not resolve: {e}")

    await log("Fetching boosters…")
    rows, offset = [], 0
    while True:
        try:
            res = await c(functions.premium.GetBoostsList(
                peer=entity, offset=offset, limit=100))
        except AttributeError:
            return await err("Telethon version too old — update with: pip install -U telethon")
        boosts = getattr(res, "boosts", []) or []
        if not boosts: break
        um = {u.id: u for u in (getattr(res, "users", []) or [])}
        for b in boosts:
            uid = getattr(b, "user_id", None); u = um.get(uid)
            rows.append([uid,
                         getattr(u, "username",   "") or "",
                         getattr(u, "first_name", "") or "",
                         getattr(u, "last_name",  "") or "",
                         bool(getattr(u, "premium", False)),
                         str(getattr(b, "date",    "")),
                         str(getattr(b, "expire",  "") or getattr(b, "expires", ""))])
        offset += len(boosts)
        await log(f"  Fetched {offset:,} boosters…")

    title    = getattr(entity, "title", "channel")
    filename = f"{_safe(title)}_boosters_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    tok = _save_dl(_csv(
        ["user_id","username","first_name","last_name","is_premium","boosted_at","expires_at"],
        rows), filename)
    await done(tok, len(rows), filename)


async def _resolve_ids(c, p, log, done, err):
    handles = [h.strip().lstrip("@") for h in p.get("handles", []) if h.strip()]
    if not handles: return await err("No usernames provided")

    results = []
    for i, h in enumerate(handles, 1):
        try:
            ent = await c.get_entity(h)
            results.append([h, ent.id, "OK"])
            await log(f"[{i}/{len(handles)}] @{h} → {ent.id}")
        except errors.FloodWaitError as fw:
            await log(f"  Flood wait {fw.seconds}s…")
            await asyncio.sleep(fw.seconds + 1)
            results.append([h, "", "FLOOD_WAIT"])
        except (errors.UsernameNotOccupiedError, errors.UsernameInvalidError):
            results.append([h, "", "NOT_FOUND"])
            await log(f"[{i}/{len(handles)}] @{h} → NOT FOUND")
        except Exception as e:
            results.append([h, "", "ERROR"])
            await log(f"[{i}/{len(handles)}] @{h} → ERROR: {e}")
        await asyncio.sleep(0.5)

    filename = f"resolved_ids_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    tok = _save_dl(_csv(["username","id","status"], results), filename)
    await done(tok, len(results), filename)


async def _emoji_pack(c, p, log, done, err):
    raw = p.get("pack_name", "")
    m   = re.search(r"t\.me/(?:addstickers|addemoji)/([A-Za-z0-9_]+)", raw, re.I)
    pack_name = m.group(1) if m else raw.strip().lstrip("@").split("/")[-1]
    if not pack_name: return await err("Invalid pack name or link")

    await log(f"Looking up pack: {pack_name}…")
    try:
        result = await c(GetStickerSetRequest(
            stickerset=InputStickerSetShortName(pack_name), hash=0))
    except Exception as e:
        return await err(f"Pack not found: {e}")

    await log(f"Pack: {result.set.title} ({result.set.count} stickers)")
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w") as zf:
        for i, doc in enumerate(result.documents, 1):
            data  = await c.download_file(doc, bytes)
            attrs = getattr(doc, "attributes", [])
            is_tgs = any(getattr(a, "mime_type", "") == "application/x-tgsticker"
                         for a in attrs)
            ext = "tgs" if is_tgs else "webm"
            zf.writestr(f"{i:03d}_{doc.id}.{ext}", data)
            if i % 10 == 0 or i == result.set.count:
                await log(f"  Downloaded {i}/{result.set.count}")

    safe     = _safe(result.set.title) or pack_name
    filename = f"{safe}_pack.zip"
    tok      = _save_dl(zip_buf.getvalue(), filename)
    await done(tok, result.set.count, filename)

# ══════════════════════════════════════════════════════════════════════════════
# STATIC FILES + SPA FALLBACK
# ══════════════════════════════════════════════════════════════════════════════
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/{full_path:path}")
async def spa(full_path: str = ""):
    return FileResponse("static/index.html")
