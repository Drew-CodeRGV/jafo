"""
jafo — OSINT exposure demonstration (edge/sandbox only).

A deliberately-scoped DEMONSTRATION of how trivially off-the-shelf OSINT tooling
fuses a name heard on open public-safety radio with public internet profiles.
It is intended to be shown to professionals (including law enforcement) to
illustrate the privacy exposure that unencrypted-radio + open tooling creates.

Design guarantees / guardrails:
  * EDGE-ONLY. Gated so it is never served from the public hub (jafo.live).
  * OPT-IN. Off unless JAFO_OSINT_DEMO is truthy in the node's .env.
  * NEUTRAL framing. Matches are automated handle-guesses, UNVERIFIED, and may be
    an entirely different person. A radio mention implies nothing about guilt or
    involvement (callers, victims, witnesses, and bystanders are named too).

Mechanism: derive candidate usernames from a spoken name, scan a small curated
set of mainstream platforms via the `user-scanner` CLI, and return any public
profiles found (platform, url, avatar). The high false-positive rate of
name->handle guessing is itself part of the lesson.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile

# ---- configuration (all overridable via the node .env) ----------------------
def _truthy(v: str) -> bool:
    return (v or "").strip().lower() in ("1", "true", "yes", "on")

OSINT_DEMO_ENABLED = _truthy(os.environ.get("JAFO_OSINT_DEMO", ""))

# `user-scanner` CLI. Default to the services venv's bin, else PATH.
USER_SCANNER_BIN = os.environ.get("JAFO_USER_SCANNER_BIN", "").strip() or (
    shutil.which("user-scanner") or "user-scanner"
)

# Curated, mainstream, non-adult/dating modules — fast and avatar-bearing.
DEFAULT_MODULES = [
    "github", "instagram", "tiktok", "reddit", "x", "youtube", "twitch",
    "pinterest", "spotify", "soundcloud", "medium", "gravatar", "linktree",
    "steam", "vimeo", "flickr", "dribbble",
]
OSINT_MODULES = [
    m.strip() for m in os.environ.get("JAFO_OSINT_MODULES", ",".join(DEFAULT_MODULES)).split(",")
    if m.strip()
]

MAX_CANDIDATES = int(os.environ.get("JAFO_OSINT_MAX_CANDIDATES", "3"))
PER_SITE_TIMEOUT = os.environ.get("JAFO_OSINT_SITE_TIMEOUT", "8")       # seconds, passed to -t
SCAN_TIMEOUT = int(os.environ.get("JAFO_OSINT_TIMEOUT", "45"))          # overall subprocess wall-clock

# Tokens that are clearly not a civilian name — skip scanning these.
_STOPWORDS = {
    "officer", "unit", "units", "dispatch", "dispatcher", "suspect", "subject",
    "complainant", "caller", "victim", "sergeant", "sgt", "lieutenant", "lt",
    "captain", "chief", "deputy", "sheriff", "trooper", "unknown", "male", "female",
    "driver", "passenger", "rp", "ems", "fire", "pd", "county", "city",
    "dps", "hcso", "mpd", "epd", "usbp", "swat", "k9", "fd", "so", "ppd",
}


def enabled() -> bool:
    """OSINT demo is active only when explicitly opted in via .env."""
    return OSINT_DEMO_ENABLED


# ---- name -> candidate handles ----------------------------------------------
def looks_like_name(name: str) -> bool:
    n = (name or "").strip()
    if len(n) < 3:
        return False
    toks = [t for t in re.split(r"\s+", n) if t]
    # keep only alphabetic, non-stopword tokens (drops "unit", "247", "10-4", …)
    name_toks = [t for t in toks
                 if t.lower() not in _STOPWORDS and re.fullmatch(r"[A-Za-z][A-Za-z'\-]+", t)]
    return any(len(t) >= 3 for t in name_toks)


def candidate_handles(name: str) -> list[str]:
    """Derive a few plausible usernames from a spoken name. Intentionally fuzzy."""
    clean = re.sub(r"[^A-Za-z0-9 ]", " ", name or "").strip()
    parts = [p for p in clean.split() if p.lower() not in _STOPWORDS]
    if not parts:
        return []
    first = parts[0].lower()
    last = parts[-1].lower() if len(parts) > 1 else ""
    cands: list[str] = []
    if last and last != first:
        cands += [f"{first}{last}", f"{first}.{last}", f"{first}_{last}", f"{first[0]}{last}"]
    cands.append(first)
    seen, out = set(), []
    for c in cands:
        if len(c) >= 4 and c not in seen:
            seen.add(c)
            out.append(c)
    return out[:MAX_CANDIDATES]


# ---- user-scanner invocation + parse ----------------------------------------
_FOUND = {"found", "registered", "taken"}


def _scan_handle(handle: str) -> list[dict]:
    """Run user-scanner for one handle against the curated modules; parse JSON."""
    with tempfile.TemporaryDirectory() as td:
        out_path = os.path.join(td, "result.json")
        cmd = [USER_SCANNER_BIN, "-u", handle,
               "-m", *OSINT_MODULES,
               "-f", "json", "-o", out_path,
               "-t", str(PER_SITE_TIMEOUT), "--no-pdf-media", "--no-nsfw"]
        try:
            subprocess.run(cmd, timeout=SCAN_TIMEOUT, capture_output=True, text=True)
        except Exception:
            return []
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return []
    results = []
    for r in (data if isinstance(data, list) else []):
        if (r.get("status") or "").strip().lower() not in _FOUND:
            continue
        media = r.get("media") or {}
        extra = r.get("extra") or {}
        results.append({
            "platform": r.get("site_name"),
            "url": r.get("url"),
            "avatar": media.get("avatar") or media.get("image") or media.get("photo"),
            "bio": extra.get("bio") or extra.get("description"),
            "handle": handle,
        })
    return results


def lookup_name(name: str) -> dict:
    """Full lookup for one name: candidates -> scan -> deduped matches."""
    handles = candidate_handles(name)
    matches: list[dict] = []
    for h in handles:
        matches.extend(_scan_handle(h))
    seen, uniq = set(), []
    for m in matches:
        key = m.get("url")
        if key and key not in seen:
            seen.add(key)
            uniq.append(m)
    return {"name": name, "candidates": handles, "matches": uniq}


def extract_persons(incident_json: str) -> list[str]:
    """Pull civilian-looking names from the stored enrichment JSON."""
    if not incident_json:
        return []
    try:
        payload = json.loads(incident_json)
    except Exception:
        return []
    persons = payload.get("persons_mentioned") or []
    out, seen = [], set()
    for p in persons:
        p = (p or "").strip()
        key = p.lower()
        if p and key not in seen and looks_like_name(p):
            seen.add(key)
            out.append(p)
    return out
