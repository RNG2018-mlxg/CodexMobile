import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

MODEL_NAME = os.getenv("SENSEVOICE_MODEL", "iic/SenseVoiceSmall")
DEVICE = os.getenv("SENSEVOICE_DEVICE", "cpu")
DEFAULT_LANGUAGE = os.getenv("SENSEVOICE_LANGUAGE", "auto")
MAX_AUDIO_MB = int(os.getenv("SENSEVOICE_MAX_AUDIO_MB", "10"))
PRELOAD = os.getenv("SENSEVOICE_PRELOAD", "1").lower() not in {"0", "false", "no", "off"}
VAD_MODEL = os.getenv("SENSEVOICE_VAD_MODEL", "fsmn-vad").strip()

app = FastAPI(title="CodexMobile SenseVoice ASR")

_condition = threading.Condition()
_model = None
_loading = False
_load_error: Optional[str] = None
_loaded_at: Optional[float] = None


def _safe_suffix(filename: str, content_type: str) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix:
        return suffix[:12]
    if content_type == "audio/mp4":
        return ".m4a"
    if content_type == "audio/mpeg":
        return ".mp3"
    if content_type == "audio/webm":
        return ".webm"
    if content_type == "audio/wav":
        return ".wav"
    return ".audio"


def _normalize_language(language: Optional[str]) -> str:
    value = (language or DEFAULT_LANGUAGE or "auto").strip().lower()
    aliases = {
        "zh-cn": "zh",
        "zh-hans": "zh",
        "cn": "zh",
        "mandarin": "zh",
        "cantonese": "yue",
        "粤语": "yue",
        "中文": "zh",
    }
    return aliases.get(value, value or "auto")


def _extract_text(result) -> str:
    if isinstance(result, list) and result:
        first = result[0]
        if isinstance(first, dict):
            return str(first.get("text") or "").strip()
        return str(first or "").strip()
    if isinstance(result, dict):
        return str(result.get("text") or "").strip()
    return str(result or "").strip()


def _load_model():
    global _model, _loading, _load_error, _loaded_at

    with _condition:
        if _model is not None:
            return _model
        if _loading:
            while _loading:
                _condition.wait(timeout=1.0)
            if _model is not None:
                return _model
            raise RuntimeError(_load_error or "SenseVoice model failed to load")
        _loading = True
        _load_error = None

    try:
        from funasr import AutoModel

        kwargs = {
            "model": MODEL_NAME,
            "device": DEVICE,
            "trust_remote_code": True,
        }
        if VAD_MODEL:
            kwargs["vad_model"] = VAD_MODEL
            kwargs["vad_kwargs"] = {"max_single_segment_time": 30000}

        loaded = AutoModel(**kwargs)
        with _condition:
            _model = loaded
            _loaded_at = time.time()
            _loading = False
            _condition.notify_all()
            return _model
    except Exception as exc:
        with _condition:
            _load_error = str(exc)
            _loading = False
            _condition.notify_all()
        raise


def _preload_model():
    try:
        _load_model()
    except Exception:
        # Health exposes the failure without printing audio or secret data.
        pass


@app.on_event("startup")
def startup():
    if PRELOAD:
        threading.Thread(target=_preload_model, daemon=True).start()


@app.get("/health")
def health():
    with _condition:
        return {
            "ok": True,
            "ready": _model is not None,
            "loading": _loading,
            "model": MODEL_NAME,
            "device": DEVICE,
            "error": _load_error,
            "loadedAt": _loaded_at,
        }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    response_format: str = Form("json"),
):
    del model

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="No audio received")
    if len(data) > MAX_AUDIO_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Audio exceeds {MAX_AUDIO_MB}MB")

    suffix = _safe_suffix(file.filename or "", file.content_type or "")
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
            temp.write(data)
            temp_path = temp.name

        asr = _load_model()
        from funasr.utils.postprocess_utils import rich_transcription_postprocess

        result = asr.generate(
            input=temp_path,
            cache={},
            language=_normalize_language(language),
            use_itn=True,
            batch_size_s=60,
            merge_vad=True,
            merge_length_s=15,
        )
        text = rich_transcription_postprocess(_extract_text(result)).strip()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SenseVoice transcription failed: {exc}") from exc
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass

    if response_format == "text":
        return PlainTextResponse(text)
    return JSONResponse({"text": text})
