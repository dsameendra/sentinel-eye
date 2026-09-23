"""Settings model, storage and validation. One JSON file, chmod 600 (it holds credentials)."""
import json, os, re, secrets, threading
from pathlib import Path
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("SENTINEL_DATA", ROOT / "data"))   # overridable so tests can run against a scratch copy
SETTINGS_FILE = DATA / "settings.json"
LAYOUTS = ("1x1", "2x2", "3x2", "3x3", "4x3", "4x4", "1+5", "1+7", "2+8")

_lock = threading.Lock()


class Connection(BaseModel):
    host: str = ""
    rtsp_port: int = Field(554, ge=1, le=65535)
    http_port: int = Field(80, ge=1, le=65535)   # only used to read camera names (Hikvision ISAPI)
    username: str = "admin"
    password: str = ""
    encrypted: bool = False
    key: str = ""

    @field_validator("host")
    @classmethod
    def _host(cls, v):
        v = v.strip()
        if v and not re.fullmatch(r"[A-Za-z0-9._-]+", v):
            raise ValueError("Host must be an IP address or hostname (no scheme, port or path)")
        return v

    @field_validator("key")
    @classmethod
    def _key(cls, v):
        if len(v.encode()) > 16:
            raise ValueError("The verification code is at most 16 characters")
        return v


def _fps(v):
    if v in (None, "", "auto"):
        return "auto"
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError("FPS must be a number or 'auto'")
    if not 0.5 <= f <= 120:
        raise ValueError("FPS must be between 0.5 and 120")
    return f


class Channel(BaseModel):
    id: str = Field(default_factory=lambda: "c" + secrets.token_hex(3))
    channel: int = Field(1, ge=1, le=999)
    name: str = ""
    enabled: bool = True
    sub_fps: Union[float, Literal["auto"]] = "auto"
    main_fps: Union[float, Literal["auto"]] = "auto"
    aspect: Literal["auto", "16:9", "4:3", "native"] = "auto"   # picture shape; auto = 16:9 when the SD frame is squeezed 2:1
    sub_path: str = ""   # optional RTSP path override (non-Hikvision sources)
    main_path: str = ""

    @field_validator("id")
    @classmethod
    def _id(cls, v):
        if not re.fullmatch(r"[A-Za-z0-9]{1,16}", v):
            raise ValueError("Bad channel id")
        return v

    @field_validator("sub_fps", "main_fps", mode="before")
    @classmethod
    def _f(cls, v):
        return _fps(v)

    @field_validator("sub_path", "main_path")
    @classmethod
    def _p(cls, v):
        v = v.strip()
        if v and not v.startswith("/"):
            raise ValueError("A stream path starts with /")
        return v


class Display(BaseModel):
    layout: Literal["1x1", "2x2", "3x2", "3x3", "4x3", "4x4", "1+5", "1+7", "2+8"] = "3x3"
    quality: Literal["sub", "main", "auto"] = "auto"
    main_codec: Literal["passthrough", "h264"] = "h264"   # h264 = convert H.265 on the server (smooth everywhere); passthrough = play H.265 directly
    fit: Literal["contain", "cover"] = "contain"
    rotate_seconds: int = Field(0, ge=0, le=600)
    theme: Literal["auto", "dark", "light"] = "auto"
    order: list[str] = []
    # Overlay transport controls (Playback, Live focus) fade out after this many idle seconds while
    # playing — was a hardcoded 2.6s (web/js/playback.js/live.js), now a real preference.
    controls_autohide_sec: float = Field(2.6, ge=1.0, le=10.0)
    # JPEG quality for snapshot downloads (tile.js/live.js) — was hardcoded at 0.92.
    snapshot_quality: float = Field(0.92, ge=0.5, le=1.0)
    # Starting L0 live-enhancement preset for a newly-opened tile/pane (enhance.js PRESETS keys) — was
    # always "off"; every operator had to re-pick a preset by hand on every tile, every session.
    enhance_default_preset: Literal["off", "night", "haze", "sharpen", "wdr", "retinex", "rainsnow"] = "off"
    # Starting mode/fidelity for the AI frame enhancer popup (docs/playback-spec.md section 7.8) — were hardcoded
    # "auto"/0.5; 0.5 is still the recommended fidelity default (spec 2d), now just changeable.
    enhance_default_mode: Literal["auto", "face", "plate", "general"] = "auto"
    enhance_default_fidelity: float = Field(0.5, ge=0.0, le=1.0)


class Settings(BaseModel):
    connection: Connection = Connection()
    channels: list[Channel] = []
    display: Display = Display()

    @field_validator("channels")
    @classmethod
    def _unique(cls, v):
        ids = [c.id for c in v]
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate channel id")
        return v


def _migrate_env() -> Settings:
    """First run: seed from .env (DVR_HOST/USER/PASS/KEY) if present, with 8 default channels."""
    env = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    conn = Connection(host=env.get("DVR_HOST", ""), username=env.get("DVR_USER", "admin"),
                      password=env.get("DVR_PASS", ""), encrypted=bool(env.get("DVR_KEY")),
                      key=env.get("DVR_KEY", ""))
    chans = [Channel(id=f"c{i}", channel=i, name=f"Camera {i}") for i in range(1, 9)]
    return Settings(connection=conn, channels=chans, display=Display(order=[c.id for c in chans]))


def load() -> Settings:
    with _lock:
        if SETTINGS_FILE.exists():
            return Settings.model_validate_json(SETTINGS_FILE.read_text())
    s = _migrate_env()
    save(s)
    return s


def save(s: Settings) -> None:
    with _lock:
        DATA.mkdir(exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(s.model_dump_json(indent=2))
        os.replace(tmp, SETTINGS_FILE)


def normalise_order(s: Settings) -> None:
    """Keep display.order consistent with the channel list (drop unknown ids, append new ones)."""
    ids = [c.id for c in s.channels]
    order = [i for i in s.display.order if i in ids]
    order += [i for i in ids if i not in order]
    s.display.order = order


def public(s: Settings) -> dict:
    """Settings as the browser sees them: secrets are never sent, only whether they are set."""
    d = s.model_dump()
    d["connection"]["has_password"] = bool(s.connection.password)
    d["connection"]["has_key"] = bool(s.connection.key)
    d["connection"]["password"] = ""
    d["connection"]["key"] = ""
    return d


def merge_secrets(new: Settings, old: Settings) -> Settings:
    """A blank password/key in a submitted form means 'keep the stored one'."""
    if not new.connection.password:
        new.connection.password = old.connection.password
    if not new.connection.key:
        new.connection.key = old.connection.key
    if not new.connection.encrypted:
        new.connection.key = new.connection.key  # kept so toggling back on doesn't lose it
    return new
