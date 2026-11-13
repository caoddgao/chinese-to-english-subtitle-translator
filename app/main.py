import json
import re
import time
import uuid
from pathlib import Path
from flask import Flask, request, jsonify, Response, send_from_directory, abort
from werkzeug.utils import secure_filename
from openai import OpenAI

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR.parent / "static"
REFERENCES_DIR = BASE_DIR / "references"
UPLOADS_DIR = BASE_DIR / "uploads"
CONVERSATIONS_DIR = BASE_DIR / "conversations"
CONFIG_FILE = BASE_DIR / "config.json"

for d in (REFERENCES_DIR, UPLOADS_DIR, CONVERSATIONS_DIR):
    d.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024

# ---- Model registry ----
# Each model declares which provider it belongs to. The provider picks the
# baseURL + API key + whether it should stream "thinking" content.
HUNYUAN_BASE_URL = "https://tokenhub.tencentmaas.com/v1"
QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"

# Built-in model seeds. Used the first time the app boots (no config.json yet)
# or when the user clears their models. After that, models live in config.json
# and are managed through the UI (enable / disable / add / refresh from API).
#
# Each model record on disk has these fields:
#   id        - model id sent in chat completions
#   label     - display name shown in UI dropdowns
#   provider  - "hunyuan" or "qwen"
#   thinking  - True if the model emits reasoning_content
#   vision    - True if the model accepts image inputs
#   enabled   - shown in topbar dropdown when True
#   source    - "builtin" | "manual" | "qwen"   (controls deletability / refresh behavior)
#   user_modified - {"thinking"?: True, "vision"?: True} flags marking which
#                   capability bits the user changed by hand; "qwen" refresh
#                   skips overwriting them.
DEFAULT_MODELS = [
    # 翻译型,主打初稿
    {"id": "hy-mt2-pro",     "label": "混元 hy-mt2-pro (翻译专用)", "provider": "hunyuan", "thinking": False, "vision": False, "enabled": True, "source": "builtin"},
    {"id": "hy3-preview",    "label": "混元 hy3-preview",          "provider": "hunyuan", "thinking": False, "vision": False, "enabled": True, "source": "builtin"},
    {"id": "deepseek-v4-pro","label": "混元 deepseek-v4-pro",      "provider": "hunyuan", "thinking": False, "vision": False, "enabled": True, "source": "builtin"},
    # Qwen 系列,讨论 + 兜底翻译
    {"id": "qwen3.7-max",  "label": "Qwen 3.7 Max",              "provider": "qwen",    "thinking": True,  "vision": False, "enabled": True, "source": "builtin"},
    {"id": "qwen3.6-max",  "label": "Qwen 3.6 Max",              "provider": "qwen",    "thinking": True,  "vision": False, "enabled": True, "source": "builtin"},
    {"id": "qwen3.6-plus", "label": "Qwen 3.6 Plus (支持图文)",   "provider": "qwen",    "thinking": True,  "vision": True,  "enabled": True, "source": "builtin"},
]
MAX_ENABLED_MODELS = 10
DEFAULT_TRANSLATE_MODEL = "hy-mt2-pro"
DEFAULT_CHAT_MODEL = "qwen3.7-max"


def _guess_capabilities(model_id):
    """Heuristic vision/thinking flags from a Qwen model id."""
    s = model_id.lower()
    vision = any(k in s for k in ("vl", "vision", "omni"))
    thinking = any(k in s for k in ("qwq", "reasoner", "-r1", "qwen3"))
    return {"thinking": thinking, "vision": vision}

DEFAULT_SYSTEM_PROMPT = (
    "You are a professional subtitle translator specializing in Chinese-to-English translation "
    "for Chinese TV dramas. Produce natural, idiomatic English that fits subtitle reading speed. "
    "Maintain consistent terminology with the reference materials provided. "
    "Keep translated lines concise and faithful to the original meaning."
)

ALLOWED_REF_EXT = (".txt", ".srt")
TRANSLATE_BATCH_SIZE = 60
MERGE_MAX_CHARS = 18
MERGE_MAX_GAP_MS = 400
TITLE_MAX_LEN = 20


# ---------- config ----------

def load_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    else:
        cfg = {}
    cfg.setdefault("hunyuan_key", "")
    cfg.setdefault("qwen_key", "")
    cfg.setdefault("prompts", [])
    cfg.setdefault("default_prompt_id", None)
    # Seed model registry on first run (or if user wiped it).
    if not cfg.get("models"):
        cfg["models"] = [dict(m) for m in DEFAULT_MODELS]
    else:
        # Backfill new fields for configs written before model-management existed.
        for m in cfg["models"]:
            m.setdefault("enabled", True)
            m.setdefault("source", "manual")
            m.setdefault("thinking", False)
            m.setdefault("vision", False)
    # ---- Migration: old configs had a flat `system_prompt` string. ----
    legacy = cfg.pop("system_prompt", None) if "system_prompt" in cfg else None
    if legacy or not cfg["prompts"]:
        # Seed at least one prompt so the user always has somewhere to start.
        content = legacy or DEFAULT_SYSTEM_PROMPT
        cfg["prompts"].append({
            "id": uuid.uuid4().hex[:12],
            "name": "默认指令",
            "content": content,
        })
        cfg["default_prompt_id"] = cfg["prompts"][0]["id"]
    # Ensure default points to something valid; otherwise pick first.
    pids = {p["id"] for p in cfg["prompts"]}
    if cfg.get("default_prompt_id") not in pids:
        cfg["default_prompt_id"] = cfg["prompts"][0]["id"] if cfg["prompts"] else None
    return cfg


def save_config(update):
    cfg = load_config()
    cfg.update(update)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def _find_model(cfg, model_id):
    for m in cfg.get("models", []):
        if m["id"] == model_id:
            return m
    return None


def _lookup_model(model_id):
    """Return model_meta or None (no key/client check)."""
    return _find_model(load_config(), model_id)


def _get_client_for_model(model_id):
    """Return (OpenAI client, model_meta) or (None, error_string)."""
    cfg = load_config()
    meta = _find_model(cfg, model_id)
    if not meta:
        return None, f"Unknown model: {model_id}"
    if meta["provider"] == "hunyuan":
        key = cfg.get("hunyuan_key", "")
        if not key:
            return None, "Hunyuan API key not set"
        return OpenAI(api_key=key, base_url=HUNYUAN_BASE_URL), meta
    if meta["provider"] == "qwen":
        key = cfg.get("qwen_key", "")
        if not key:
            return None, "Qwen API key not set"
        return OpenAI(api_key=key, base_url=QWEN_BASE_URL), meta
    return None, f"Unsupported provider for model: {model_id}"


# ---------- SRT helpers ----------

_TIME_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
)


def _ts_to_ms(h, m, s, ms):
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(ms)


def _ms_to_ts(ms):
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    blocks = re.split(r"\n{2,}", text)
    entries = []
    for block in blocks:
        parts = block.strip().split("\n")
        if len(parts) < 2:
            continue
        time_idx = None
        for i, line in enumerate(parts):
            if _TIME_RE.search(line):
                time_idx = i
                break
        if time_idx is None:
            continue
        idx = parts[time_idx - 1].strip() if time_idx >= 1 else str(len(entries) + 1)
        time_line = parts[time_idx].strip()
        m = _TIME_RE.search(time_line)
        start_ms = _ts_to_ms(*m.group(1, 2, 3, 4))
        end_ms = _ts_to_ms(*m.group(5, 6, 7, 8))
        content_lines = [p for p in parts[time_idx + 1:] if p.strip()]
        entries.append({
            "index": idx,
            "time": time_line,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "lines": content_lines,
        })
    return entries


def build_srt(entries):
    blocks = []
    for i, e in enumerate(entries, 1):
        block = f"{i}\r\n{e['time']}\r\n" + "\r\n".join(e["lines"])
        blocks.append(block)
    return "\r\n\r\n".join(blocks) + "\r\n"


def merge_small_fragments(entries):
    if not entries:
        return entries
    merged = [dict(entries[0])]
    for e in entries[1:]:
        prev = merged[-1]
        prev_text = "".join(prev["lines"])
        cur_text = "".join(e["lines"])
        gap = e["start_ms"] - prev["end_ms"]
        combined_len = len(prev_text) + len(cur_text)
        prev_ends_sentence = bool(re.search(r"[。！？!?.…]$", prev_text))
        if (
            not prev_ends_sentence
            and combined_len <= MERGE_MAX_CHARS
            and 0 <= gap <= MERGE_MAX_GAP_MS
        ):
            new_time = f"{_ms_to_ts(prev['start_ms'])} --> {_ms_to_ts(e['end_ms'])}"
            merged[-1] = {
                "index": prev["index"],
                "time": new_time,
                "start_ms": prev["start_ms"],
                "end_ms": e["end_ms"],
                "lines": [prev_text + cur_text],
            }
        else:
            merged.append(dict(e))
    for i, e in enumerate(merged, 1):
        e["index"] = str(i)
    return merged


def entries_to_translation_input(entries):
    return "\n".join(f"{e['index']}|{' '.join(e['lines'])}" for e in entries)


def parse_translation_output(text):
    result = {}
    for line in text.strip().split("\n"):
        line = line.strip()
        if not line or "|" not in line:
            continue
        idx, _, content = line.partition("|")
        result[idx.strip()] = content.strip()
    return result


# ---------- Reference library ----------

def list_reference_files():
    return sorted(
        f.name for f in REFERENCES_DIR.iterdir()
        if f.is_file() and f.suffix.lower() in ALLOWED_REF_EXT
    )


def build_reference_text():
    parts = []
    for name in list_reference_files():
        path = REFERENCES_DIR / name
        content = path.read_text(encoding="utf-8", errors="replace")
        parts.append(f"=== {name} ===\n{content}")
    return "\n\n".join(parts)


def safe_reference_path(filename):
    safe = secure_filename(filename or "")
    if not safe or not safe.lower().endswith(ALLOWED_REF_EXT):
        return None
    candidate = (REFERENCES_DIR / safe).resolve()
    try:
        candidate.relative_to(REFERENCES_DIR.resolve())
    except ValueError:
        return None
    return candidate


# ---------- Conversation storage ----------

def _conv_path(conv_id):
    safe = secure_filename(conv_id or "")
    if not safe or not re.fullmatch(r"[A-Za-z0-9_-]+", safe):
        return None
    p = (CONVERSATIONS_DIR / f"{safe}.json").resolve()
    try:
        p.relative_to(CONVERSATIONS_DIR.resolve())
    except ValueError:
        return None
    return p


def _now_ms():
    return int(time.time() * 1000)


def _new_conv(title=None, model=None, prompt_id=None):
    cid = uuid.uuid4().hex[:12]
    if prompt_id is None:
        # default to whatever the user currently has as default
        prompt_id = load_config().get("default_prompt_id")
    conv = {
        "id": cid,
        "title": title or "新对话",
        "model": model or DEFAULT_CHAT_MODEL,
        "prompt_id": prompt_id,
        "created_at": _now_ms(),
        "updated_at": _now_ms(),
        "messages": [],   # [{role, content, images?, meta?}]
    }
    _write_conv(conv)
    return conv


def _read_conv(cid):
    p = _conv_path(cid)
    if not p or not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_conv(conv):
    p = _conv_path(conv["id"])
    if not p:
        return False
    with open(p, "w", encoding="utf-8") as f:
        json.dump(conv, f, ensure_ascii=False, indent=2)
    return True


def _list_convs():
    out = []
    for f in CONVERSATIONS_DIR.glob("*.json"):
        try:
            with open(f, "r", encoding="utf-8") as fh:
                c = json.load(fh)
            out.append({
                "id": c.get("id"),
                "title": c.get("title", "未命名"),
                "model": c.get("model"),
                "prompt_id": c.get("prompt_id"),
                "updated_at": c.get("updated_at", 0),
                "created_at": c.get("created_at", 0),
                "message_count": len(c.get("messages", [])),
            })
        except Exception:
            continue
    out.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
    return out


def _auto_title(first_user_text):
    if not first_user_text:
        return "新对话"
    t = first_user_text.strip().replace("\n", " ")
    if len(t) > TITLE_MAX_LEN:
        t = t[:TITLE_MAX_LEN] + "…"
    return t or "新对话"


# ---------- Routes: static ----------

@app.route("/")
def index():
    return send_from_directory(str(STATIC_DIR), "index.html")


# ---------- Routes: config ----------

def _mask(k):
    if not k:
        return ""
    return k[:6] + "****" + k[-4:] if len(k) > 10 else "****"


@app.route("/api/config", methods=["GET"])
def get_config():
    cfg = load_config()
    # Topbar dropdown only sees enabled models, capped at MAX_ENABLED_MODELS.
    enabled = [m for m in cfg.get("models", []) if m.get("enabled")][:MAX_ENABLED_MODELS]
    return jsonify({
        "hunyuan_key_set": bool(cfg.get("hunyuan_key")),
        "qwen_key_set": bool(cfg.get("qwen_key")),
        "hunyuan_key_masked": _mask(cfg.get("hunyuan_key", "")),
        "qwen_key_masked": _mask(cfg.get("qwen_key", "")),
        "prompts": cfg.get("prompts", []),
        "default_prompt_id": cfg.get("default_prompt_id"),
        "models": enabled,
        "max_enabled_models": MAX_ENABLED_MODELS,
        "default_translate_model": DEFAULT_TRANSLATE_MODEL,
        "default_chat_model": DEFAULT_CHAT_MODEL,
    })


@app.route("/api/config", methods=["POST"])
def set_config():
    """Only API keys are settable here. Prompts have their own routes."""
    data = request.get_json(silent=True) or {}
    update = {}
    for key in ("hunyuan_key", "qwen_key"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            update[key] = val.strip()
    save_config(update)
    return jsonify({"ok": True})


# ---------- Routes: prompts ----------

def _find_prompt(cfg, pid):
    for p in cfg.get("prompts", []):
        if p["id"] == pid:
            return p
    return None


@app.route("/api/prompts", methods=["GET"])
def prompts_list():
    cfg = load_config()
    return jsonify({
        "items": cfg.get("prompts", []),
        "default_prompt_id": cfg.get("default_prompt_id"),
    })


@app.route("/api/prompts", methods=["POST"])
def prompts_create():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "未命名").strip()[:60]
    content = data.get("content") or ""
    if not isinstance(content, str):
        return jsonify({"error": "content must be string"}), 400
    cfg = load_config()
    prompt = {"id": uuid.uuid4().hex[:12], "name": name, "content": content}
    cfg["prompts"].append(prompt)
    # If this is the first ever prompt, also set as default.
    if not cfg.get("default_prompt_id"):
        cfg["default_prompt_id"] = prompt["id"]
    save_config({"prompts": cfg["prompts"], "default_prompt_id": cfg["default_prompt_id"]})
    return jsonify(prompt)


@app.route("/api/prompts/<pid>", methods=["PATCH"])
def prompts_update(pid):
    data = request.get_json(silent=True) or {}
    cfg = load_config()
    prompt = _find_prompt(cfg, pid)
    if not prompt:
        abort(404)
    if "name" in data and isinstance(data["name"], str) and data["name"].strip():
        prompt["name"] = data["name"].strip()[:60]
    if "content" in data and isinstance(data["content"], str):
        prompt["content"] = data["content"]
    save_config({"prompts": cfg["prompts"]})
    return jsonify(prompt)


@app.route("/api/prompts/<pid>", methods=["DELETE"])
def prompts_delete(pid):
    cfg = load_config()
    prompt = _find_prompt(cfg, pid)
    if not prompt:
        abort(404)
    cfg["prompts"] = [p for p in cfg["prompts"] if p["id"] != pid]
    # If we deleted the default, pick a new one (first remaining, or None)
    if cfg.get("default_prompt_id") == pid:
        cfg["default_prompt_id"] = cfg["prompts"][0]["id"] if cfg["prompts"] else None
    save_config({"prompts": cfg["prompts"], "default_prompt_id": cfg["default_prompt_id"]})
    return jsonify({"ok": True, "default_prompt_id": cfg["default_prompt_id"]})


@app.route("/api/prompts/default", methods=["POST"])
def prompts_set_default():
    data = request.get_json(silent=True) or {}
    pid = data.get("id")
    cfg = load_config()
    if not _find_prompt(cfg, pid):
        return jsonify({"error": "Prompt not found"}), 404
    save_config({"default_prompt_id": pid})
    return jsonify({"ok": True, "default_prompt_id": pid})


# ---------- Routes: models ----------

def _model_public(m):
    return {
        "id": m["id"],
        "label": m.get("label") or m["id"],
        "provider": m.get("provider", "qwen"),
        "thinking": bool(m.get("thinking")),
        "vision": bool(m.get("vision")),
        "enabled": bool(m.get("enabled")),
        "source": m.get("source", "manual"),
    }


@app.route("/api/models", methods=["GET"])
def models_list():
    """Full model inventory (enabled + disabled)."""
    cfg = load_config()
    enabled_count = sum(1 for m in cfg["models"] if m.get("enabled"))
    return jsonify({
        "items": [_model_public(m) for m in cfg["models"]],
        "enabled_count": enabled_count,
        "max_enabled": MAX_ENABLED_MODELS,
    })


@app.route("/api/models", methods=["POST"])
def models_create():
    """Add a manual model. Body: id, label?, provider, thinking?, vision?"""
    data = request.get_json(silent=True) or {}
    mid = (data.get("id") or "").strip()
    if not mid:
        return jsonify({"error": "id required"}), 400
    provider = data.get("provider")
    if provider not in ("hunyuan", "qwen"):
        return jsonify({"error": "provider must be hunyuan or qwen"}), 400
    cfg = load_config()
    if _find_model(cfg, mid):
        return jsonify({"error": "model id already exists"}), 409
    new_model = {
        "id": mid,
        "label": (data.get("label") or mid).strip()[:80],
        "provider": provider,
        "thinking": bool(data.get("thinking")),
        "vision": bool(data.get("vision")),
        "enabled": bool(data.get("enabled", True)),
        "source": "manual",
    }
    # Enforce dropdown cap: if already at the limit, force new entry disabled.
    if new_model["enabled"] and sum(1 for m in cfg["models"] if m.get("enabled")) >= MAX_ENABLED_MODELS:
        new_model["enabled"] = False
    cfg["models"].append(new_model)
    save_config({"models": cfg["models"]})
    return jsonify(_model_public(new_model))


@app.route("/api/models/<mid>", methods=["PATCH"])
def models_update(mid):
    """Update label / capability flags / enabled state."""
    data = request.get_json(silent=True) or {}
    cfg = load_config()
    m = _find_model(cfg, mid)
    if not m:
        abort(404)
    if "label" in data and isinstance(data["label"], str) and data["label"].strip():
        m["label"] = data["label"].strip()[:80]
    # Track user-edited capability bits so a later Qwen refresh won't clobber them.
    if "thinking" in data:
        m["thinking"] = bool(data["thinking"])
        m.setdefault("user_modified", {})["thinking"] = True
    if "vision" in data:
        m["vision"] = bool(data["vision"])
        m.setdefault("user_modified", {})["vision"] = True
    if "enabled" in data:
        want = bool(data["enabled"])
        if want and not m.get("enabled"):
            # Trying to enable - respect the cap.
            cur = sum(1 for x in cfg["models"] if x.get("enabled"))
            if cur >= MAX_ENABLED_MODELS:
                return jsonify({
                    "error": f"已达启用上限 {MAX_ENABLED_MODELS}，请先禁用其他模型"
                }), 400
        m["enabled"] = want
    save_config({"models": cfg["models"]})
    return jsonify(_model_public(m))


@app.route("/api/models/<mid>", methods=["DELETE"])
def models_delete(mid):
    """Delete a manual or built-in model. Qwen-scanned models can only be disabled."""
    cfg = load_config()
    m = _find_model(cfg, mid)
    if not m:
        abort(404)
    if m.get("source") == "qwen":
        return jsonify({"error": "扫描得到的 Qwen 模型只能禁用，不能删除"}), 400
    cfg["models"] = [x for x in cfg["models"] if x["id"] != mid]
    save_config({"models": cfg["models"]})
    return jsonify({"ok": True})


@app.route("/api/models/refresh", methods=["POST"])
def models_refresh():
    """Pull Qwen's /v1/models list and merge into config.

    Merge rules (per user spec, Q4-B + protection):
      - New ids -> added as disabled, source="qwen", capabilities guessed
      - Existing id with source="qwen" -> label updated; capability bits
        replaced UNLESS user_modified marks them as hand-edited
      - Existing id with source!="qwen" (manual/builtin) -> left alone
      - Ids that disappeared from API -> kept (we never auto-delete)
    """
    cfg = load_config()
    key = cfg.get("qwen_key", "")
    if not key:
        return jsonify({"error": "未配置 Qwen API Key，无法拉取"}), 400

    try:
        client = OpenAI(api_key=key, base_url=QWEN_BASE_URL)
        resp = client.models.list()
        items = list(resp.data) if hasattr(resp, "data") else []
    except Exception as e:
        return jsonify({"error": f"拉取失败: {e}"}), 502

    existing_by_id = {m["id"]: m for m in cfg["models"]}
    added = 0
    updated = 0
    for it in items:
        # SDK returns Model objects; fall back to dict access.
        mid = getattr(it, "id", None) or (it.get("id") if isinstance(it, dict) else None)
        if not mid:
            continue
        guess = _guess_capabilities(mid)
        existing = existing_by_id.get(mid)
        if existing is None:
            cfg["models"].append({
                "id": mid,
                "label": mid,
                "provider": "qwen",
                "thinking": guess["thinking"],
                "vision": guess["vision"],
                "enabled": False,
                "source": "qwen",
            })
            added += 1
        elif existing.get("source") == "qwen":
            um = existing.get("user_modified") or {}
            # Only overwrite cap bits the user hasn't touched.
            if not um.get("thinking"):
                existing["thinking"] = guess["thinking"]
            if not um.get("vision"):
                existing["vision"] = guess["vision"]
            updated += 1
        # source=manual/builtin -> skip entirely
    save_config({"models": cfg["models"]})
    return jsonify({
        "ok": True,
        "added": added,
        "updated": updated,
        "total_in_api": len(items),
    })


# ---------- Routes: references ----------

@app.route("/api/references", methods=["GET"])
def list_references():
    return jsonify({"files": list_reference_files()})


@app.route("/api/references", methods=["POST"])
def upload_reference():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    path = safe_reference_path(f.filename)
    if path is None:
        return jsonify({"error": "Only .txt and .srt files are allowed"}), 400
    f.save(str(path))
    return jsonify({"ok": True, "name": path.name})


@app.route("/api/references/<path:filename>", methods=["DELETE"])
def delete_reference(filename):
    path = safe_reference_path(filename)
    if path is None or not path.exists() or not path.is_file():
        abort(404)
    path.unlink()
    return jsonify({"ok": True})


@app.route("/api/references/<path:filename>", methods=["GET"])
def read_reference(filename):
    path = safe_reference_path(filename)
    if path is None or not path.exists() or not path.is_file():
        abort(404)
    return jsonify({
        "name": path.name,
        "content": path.read_text(encoding="utf-8", errors="replace"),
    })


# ---------- Routes: conversations ----------

@app.route("/api/conversations", methods=["GET"])
def conversations_list():
    return jsonify({"items": _list_convs()})


@app.route("/api/conversations", methods=["POST"])
def conversations_create():
    data = request.get_json(silent=True) or {}
    conv = _new_conv(
        title=data.get("title"),
        model=data.get("model"),
        prompt_id=data.get("prompt_id"),
    )
    return jsonify(conv)


@app.route("/api/conversations/<cid>", methods=["GET"])
def conversations_get(cid):
    conv = _read_conv(cid)
    if not conv:
        abort(404)
    return jsonify(conv)


@app.route("/api/conversations/<cid>", methods=["PATCH"])
def conversations_update(cid):
    conv = _read_conv(cid)
    if not conv:
        abort(404)
    data = request.get_json(silent=True) or {}
    if "title" in data and isinstance(data["title"], str) and data["title"].strip():
        conv["title"] = data["title"].strip()[:60]
    if "model" in data and _find_model(load_config(), data["model"]):
        conv["model"] = data["model"]
    if "prompt_id" in data:
        # Validate against known prompts (or allow null to fall back to default).
        pid = data["prompt_id"]
        if pid is None:
            conv["prompt_id"] = None
        else:
            cfg = load_config()
            if _find_prompt(cfg, pid):
                conv["prompt_id"] = pid
            else:
                return jsonify({"error": "Unknown prompt_id"}), 400
    conv["updated_at"] = _now_ms()
    _write_conv(conv)
    return jsonify(conv)


@app.route("/api/conversations/<cid>", methods=["DELETE"])
def conversations_delete(cid):
    p = _conv_path(cid)
    if not p or not p.exists():
        abort(404)
    p.unlink()
    return jsonify({"ok": True})


def _append_message(conv, role, content, images=None, meta=None):
    msg = {"role": role, "content": content}
    if images:
        msg["images"] = images
    if meta:
        msg["meta"] = meta
    conv["messages"].append(msg)
    if conv["title"] in ("", "新对话", "未命名") and role == "user":
        # Lock in an auto title once the first real user message arrives.
        first_text = content if isinstance(content, str) else ""
        if first_text:
            conv["title"] = _auto_title(first_text)
    conv["updated_at"] = _now_ms()
    _write_conv(conv)


# ---------- Routes: translate (SSE) ----------

def _sse(event):
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _resolve_prompt_content(cfg, prompt_id):
    """Resolve a system-prompt string by prompt_id, falling back to default."""
    if prompt_id:
        p = _find_prompt(cfg, prompt_id)
        if p:
            return p.get("content") or DEFAULT_SYSTEM_PROMPT
    # fall back to configured default, then to built-in
    if cfg.get("default_prompt_id"):
        p = _find_prompt(cfg, cfg["default_prompt_id"])
        if p:
            return p.get("content") or DEFAULT_SYSTEM_PROMPT
    return DEFAULT_SYSTEM_PROMPT


def _build_system_prompt_with_refs(cfg, prompt_id=None):
    sp = _resolve_prompt_content(cfg, prompt_id)
    ref = build_reference_text()
    if ref:
        sp += "\n\n--- Reference Materials ---\n" + ref
    return sp


@app.route("/api/translate", methods=["POST"])
def translate():
    """
    POST multipart: file=<srt>, plus form/query params:
        model      (default hy-mt2-pro)
        merge      ('1'/'0', default '1')
        conv_id    (optional; if given, attach result as messages)
    Streams SSE events: start / batch / error / done(srt).
    """
    model_id = (request.values.get("model") or DEFAULT_TRANSLATE_MODEL).strip()

    # Cheap validations first.
    meta = _lookup_model(model_id)
    if not meta:
        return jsonify({"error": f"Unknown model: {model_id}"}), 400

    if "file" not in request.files:
        return jsonify({"error": "No SRT file uploaded"}), 400
    srt_file = request.files["file"]
    raw = srt_file.read().decode("utf-8-sig", errors="replace")
    entries = parse_srt(raw)
    if not entries:
        return jsonify({"error": "Could not parse SRT file"}), 400

    # Acquire client now (may fail on missing API key).
    client, meta_or_err = _get_client_for_model(model_id)
    if client is None:
        return jsonify({"error": meta_or_err}), 400

    do_merge = (request.values.get("merge", "1") != "0")
    work_entries = merge_small_fragments(entries) if do_merge else entries

    conv_id = request.values.get("conv_id") or None
    conv = _read_conv(conv_id) if conv_id else None

    cfg = load_config()
    system_prompt = _build_system_prompt_with_refs(
        cfg, prompt_id=(conv.get("prompt_id") if conv else None)
    )

    stem = Path(srt_file.filename or "output.srt").stem
    out_name = f"{stem}_EN.srt"
    total_entries = len(work_entries)
    batches = [
        work_entries[i:i + TRANSLATE_BATCH_SIZE]
        for i in range(0, total_entries, TRANSLATE_BATCH_SIZE)
    ]
    total_batches = len(batches)

    def generate():
        yield _sse({
            "type": "start",
            "model": model_id,
            "model_label": meta["label"],
            "filename": stem + ".srt",
            "output_filename": out_name,
            "total_entries": total_entries,
            "total_batches": total_batches,
            "batch_size": TRANSLATE_BATCH_SIZE,
        })

        # Persist a user-side message so the history shows what was uploaded.
        if conv is not None:
            _append_message(
                conv, "user",
                f"[上传字幕] {srt_file.filename or 'subtitle.srt'} · {total_entries} 条 · 模型 {meta['label']}",
                meta={"kind": "translate_request", "filename": srt_file.filename, "total_entries": total_entries, "model": model_id},
            )

        translated_map = {}
        done_entries = 0
        kwargs = {}
        # Qwen requires explicit toggle; turn thinking OFF for translation drafts.
        if meta["provider"] == "qwen":
            kwargs["extra_body"] = {"enable_thinking": False}

        try:
            for i, batch in enumerate(batches, 1):
                user_msg = (
                    "Translate the following Chinese subtitle lines to English. "
                    "Each line is formatted as: INDEX|Chinese text\n"
                    "Return ONLY lines in the same format: INDEX|English translation\n"
                    "Keep one output line per input line. No commentary.\n\n"
                    + entries_to_translation_input(batch)
                )
                resp = client.chat.completions.create(
                    model=model_id,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_msg},
                    ],
                    **kwargs,
                )
                translated_map.update(
                    parse_translation_output(resp.choices[0].message.content or "")
                )
                done_entries += len(batch)
                yield _sse({
                    "type": "batch",
                    "index": i,
                    "total": total_batches,
                    "done_entries": done_entries,
                    "total_entries": total_entries,
                })
        except Exception as e:
            yield _sse({"type": "error", "text": str(e)})
            if conv is not None:
                _append_message(conv, "assistant", f"[翻译失败] {e}", meta={"kind": "translate_error"})
            return

        out_entries = []
        for e in work_entries:
            en = translated_map.get(e["index"], "").strip()
            out_entries.append({
                "index": e["index"],
                "time": e["time"],
                "lines": [en] if en else e["lines"],
            })
        out_text = build_srt(out_entries)

        if conv is not None:
            _append_message(
                conv, "assistant",
                f"[翻译完成] {out_name} · 共 {total_entries} 条,分 {total_batches} 批",
                meta={
                    "kind": "translate_result",
                    "output_filename": out_name,
                    "total_entries": total_entries,
                    "total_batches": total_batches,
                    "model": model_id,
                },
            )

        yield _sse({"type": "done", "filename": out_name, "srt": out_text})

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- Routes: chat (streaming, persisted) ----------

@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    model_id = (data.get("model") or DEFAULT_CHAT_MODEL).strip()

    # Cheap validations first, so users get accurate errors before key checks.
    meta = _lookup_model(model_id)
    if not meta:
        return jsonify({"error": f"Unknown model: {model_id}"}), 400

    user_text = (data.get("message") or "").strip()
    images = data.get("images") or []
    conv_id = data.get("conv_id")
    if not user_text and not images:
        return jsonify({"error": "Empty message"}), 400

    if images and not meta.get("vision"):
        return jsonify({"error": f"模型 {meta['label']} 不支持图文输入,请选 qwen3.6-plus"}), 400

    if conv_id:
        conv = _read_conv(conv_id)
        if conv is None:
            return jsonify({"error": "Conversation not found"}), 404
    else:
        conv = None

    # Acquire client (may fail on missing API key).
    client, meta_or_err = _get_client_for_model(model_id)
    if client is None:
        return jsonify({"error": meta_or_err}), 400

    cfg = load_config()
    system_prompt = _build_system_prompt_with_refs(
        cfg, prompt_id=(conv.get("prompt_id") if conv else None)
    )

    # Build conversation history from the stored conv (text only for the model).
    messages = [{"role": "system", "content": system_prompt}]
    if conv is not None:
        for m in conv.get("messages", []):
            role = m.get("role")
            content = m.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content:
                messages.append({"role": role, "content": content})

    if images:
        user_content = []
        if user_text:
            user_content.append({"type": "text", "text": user_text})
        for url in images:
            user_content.append({"type": "image_url", "image_url": {"url": url}})
    else:
        user_content = user_text

    messages.append({"role": "user", "content": user_content})

    # Persist the user turn before kicking off the stream.
    if conv is not None:
        _append_message(conv, "user", user_text, images=images if images else None,
                        meta={"model": model_id})

    kwargs = {"stream": True}
    if meta["provider"] == "qwen" and meta.get("thinking"):
        kwargs["extra_body"] = {"enable_thinking": True}

    def generate():
        assistant_text_chunks = []
        try:
            stream = client.chat.completions.create(
                model=model_id,
                messages=messages,
                **kwargs,
            )
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta is None:
                    continue
                thinking = getattr(delta, "reasoning_content", None)
                content_piece = getattr(delta, "content", None)
                if thinking:
                    yield _sse({"type": "thinking", "text": thinking})
                if content_piece:
                    assistant_text_chunks.append(content_piece)
                    yield _sse({"type": "content", "text": content_piece})
            full_text = "".join(assistant_text_chunks).strip()
            if conv is not None and full_text:
                _append_message(conv, "assistant", full_text, meta={"model": model_id})
            yield _sse({"type": "done"})
        except Exception as e:
            err = str(e)
            yield _sse({"type": "error", "text": err})
            if conv is not None:
                _append_message(conv, "assistant", f"[错误] {err}", meta={"kind": "chat_error", "model": model_id})
            yield _sse({"type": "done"})

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    app.run(debug=False, host="127.0.0.1", port=5000)
