"""FastAPI Backend Service for Cymbal Auto Group — Trade-In Appraisal & Valuation."""

from __future__ import annotations

import contextlib
import datetime as dt
import logging
import os
import pathlib
from typing import Any, Dict, Optional

import qrcode
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.agents.valuation_bot import ValuationBotAgent
from backend.agents.vehicle_inspector import VehicleInspectorAgent
from backend.models import (
    MarkSoldRequest,
    SalespersonCreate,
    SearchVehiclesRequest,
    VehicleRecord,
)
from backend.storage import LOCAL_VIDEO_DIR, VehicleStorageManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("vehicle_id.main")

BASE_DIR = pathlib.Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

storage_manager = VehicleStorageManager()
inspector_agent = VehicleInspectorAgent()
valuation_agent = ValuationBotAgent()


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    """Initializes database tables and video storage on startup."""
    logger.info("Initializing Cymbal Auto Group Trade-In resources...")
    storage_manager.initialize_cloud_resources()
    yield


app = FastAPI(
    title="Cymbal Auto Group — Vehicle Trade-In & Valuation",
    description="Dealership Vehicle Walkaround Inspector, Official DVLA Lookup, and Valuation Guide.",
    version="1.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
@app.get("/status")
async def healthz() -> Dict[str, Any]:
    """System health check endpoint returning HTTP 200 and component readiness."""
    return {
        "status": "ok",
        "service": "cymbal-vehicle-id",
        "timestamp": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "components": {
            "database": {"connected": storage_manager.bq_connected},
            "video_storage": {"connected": storage_manager.gcs_connected},
            "vehicle_inspector": {
                "status": "ready",
                "registered_skills": len(inspector_agent.list_skills()),
            },
            "valuation_bot": {
                "status": "ready",
                "matching_tolerance": "±10% age & mileage",
            },
        },
    }


@app.get("/api/agent/skills")
@app.get("/api/agents/skills")
async def list_agent_skills() -> Dict[str, Any]:
    """Returns the extensible skill registry for the Vehicle Inspector & Valuation Bot."""
    skills = inspector_agent.list_skills()
    return {
        "skills": skills,
        "vehicle_inspector_agent": {
            "name": "Vehicle Inspector",
            "priority_rule": "Official DVLA registration data overrides video analysis where available; video analysis supplies variants/special editions, condition scores, modifications, and filtered voice comments.",
            "skills": skills,
        },
        "valuation_bot_agent": {
            "name": "Valuation Bot",
            "matching_rules": [
                "Exact Make and Model match",
                "Registration year within ±10% of vehicle age",
                "Odometer mileage within ±10% of vehicle mileage",
                "Includes 'For Sale' and 'Recently Sold' public UK examples",
            ],
        },
    }


@app.get("/api/salespeople")
async def list_salespeople_endpoint() -> Dict[str, Any]:
    """Returns all salespeople stored in the database."""
    users = storage_manager.list_salespeople()
    return {"salespeople": users, "count": len(users)}


@app.post("/api/salespeople")
async def add_salesperson_endpoint(req: SalespersonCreate) -> Dict[str, Any]:
    """Adds a new salesperson to the database."""
    if not req.name or not req.name.strip():
        raise HTTPException(status_code=400, detail="Salesperson name is required.")
    created = storage_manager.add_salesperson(req)
    return {
        "status": "created",
        "message": f"Salesperson '{created['name']}' added.",
        "salesperson": created,
    }


CHUNK_UPLOAD_DIR = pathlib.Path("/tmp/chunk_uploads")
CHUNK_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.post("/api/upload-chunk")
async def upload_video_chunk(
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
    file_name: str = Form(default="walkaround.mp4"),
    mime_type: str = Form(default="video/mp4"),
    salesperson: str = Form(default=""),
    registration_hint: str = Form(default=""),
    chunk: UploadFile = File(...),
) -> Dict[str, Any]:
    """Receives 4–8MB video chunks to bypass Cloud Run's 32MB request body limit."""
    upload_dir = CHUNK_UPLOAD_DIR / upload_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = upload_dir / f"chunk_{chunk_index:04d}"

    chunk_bytes = await chunk.read()
    chunk_path.write_bytes(chunk_bytes)

    existing_chunks = sorted(list(upload_dir.glob("chunk_*")))
    if len(existing_chunks) == total_chunks:
        from backend.agents.vehicle_inspector import normalize_reg
        temp_reg = normalize_reg(registration_hint) or "PENDING"
        ext = "mp4" if "mp4" in mime_type.lower() else "webm"
        timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        assembled_filename = f"{temp_reg}_{timestamp}.{ext}"
        assembled_path = LOCAL_VIDEO_DIR / assembled_filename

        with open(assembled_path, "wb") as outfile:
            for cp in existing_chunks:
                with open(cp, "rb") as infile:
                    outfile.write(infile.read())

        import shutil
        shutil.rmtree(upload_dir, ignore_errors=True)

        assembled_bytes = assembled_path.read_bytes()
        gcs_uri, video_url = storage_manager.upload_video(
            registration_number=temp_reg,
            video_bytes=assembled_bytes,
            mime_type=mime_type,
            salesperson=salesperson,
        )
        logger.info("Assembled chunked upload %s (%s bytes) -> GCS: %s", upload_id, len(assembled_bytes), gcs_uri)
        return {
            "status": "complete",
            "upload_id": upload_id,
            "gcs_uri": gcs_uri,
            "video_url": video_url,
            "file_name": assembled_filename,
            "total_bytes": len(assembled_bytes),
        }

    return {
        "status": "in_progress",
        "upload_id": upload_id,
        "chunks_received": len(existing_chunks),
        "total_chunks": total_chunks,
    }


@app.post("/api/inspect")
async def inspect_and_value_vehicle(
    video: Optional[UploadFile] = File(default=None),
    gcs_uri: Optional[str] = Form(default=None),
    video_url: Optional[str] = Form(default=None),
    mime_type_override: Optional[str] = Form(default=None),
    registration_hint: str = Form(default=""),
    spoken_transcript: str = Form(default=""),
    salesperson: str = Form(default=""),
    auto_save: bool = Form(default=False),
    skip_valuation: bool = Form(default=False),
) -> Dict[str, Any]:
    """Saves the walkaround video, runs the Vehicle Inspector, and runs the Valuation Bot."""
    try:
        if not isinstance(spoken_transcript, str):
            spoken_transcript = ""
        if not isinstance(registration_hint, str):
            registration_hint = ""
        if not isinstance(salesperson, str):
            salesperson = ""
        if not isinstance(gcs_uri, str):
            gcs_uri = None
        if not isinstance(video_url, str):
            video_url = None
        if not isinstance(mime_type_override, str):
            mime_type_override = None
        if not isinstance(skip_valuation, bool):
            skip_valuation = False

        video_bytes: Optional[bytes] = None
        mime_type = mime_type_override or "video/webm"

        if video is not None and hasattr(video, "read"):
            video_bytes = await video.read()
            if hasattr(video, "content_type") and video.content_type:
                mime_type = video.content_type

        logger.info(
            "Inspection request received: gcs_uri=%s, video_bytes=%s, mime=%s, reg_hint=%s, salesperson=%s, skip_valuation=%s",
            gcs_uri,
            len(video_bytes) if video_bytes else 0,
            mime_type,
            registration_hint,
            salesperson,
            skip_valuation,
        )

        # 1. Store video in Cloud Storage if not already uploaded via chunked uploader
        if not gcs_uri and video_bytes and len(video_bytes) > 0:
            from backend.agents.vehicle_inspector import format_uk_reg, normalize_reg
            temp_reg = normalize_reg(registration_hint) or "PENDING"
            gcs_uri, video_url = storage_manager.upload_video(
                registration_number=temp_reg,
                video_bytes=video_bytes,
                mime_type=mime_type,
                salesperson=salesperson,
            )
            logger.info("Video saved to GCS: %s (local: %s)", gcs_uri, video_url)

        # 2. Run Vehicle Inspector Agent with GCS URI
        inspector_result = await inspector_agent.inspect_vehicle(
            gcs_uri=gcs_uri,
            video_bytes=video_bytes,
            mime_type=mime_type,
            registration_hint=registration_hint,
            spoken_transcript_hint=spoken_transcript,
        )
        insp = inspector_result["inspection"]
        from backend.agents.vehicle_inspector import format_uk_reg
        reg_number = (
            insp.get("registration_number")
            or (format_uk_reg(registration_hint) if registration_hint.strip() else "")
            or "UNREGISTERED"
        )

        # 3. Ensure make and model have realistic values for Valuation Bot
        detected_make = insp.get("make") or "Vehicle"
        detected_model = insp.get("model") or "Standard"
        detected_year = int(insp.get("year") or 2021)
        detected_mileage = int(insp.get("mileage") or 35000)

        # 4. Run Valuation Bot Agent (if not deferred for progressive loading)
        valuation = None
        if not skip_valuation:
            valuation = await valuation_agent.value_vehicle(
                make=str(detected_make),
                model=str(detected_model),
                variant=str(insp.get("variant") or ""),
                year=detected_year,
                mileage=detected_mileage,
                colour=str(insp.get("colour") or ""),
                condition_inside=int(insp.get("condition_inside") or 8),
                condition_outside=int(insp.get("condition_outside") or 8),
                modifications=str(insp.get("modifications") or "None (Standard)"),
            )

        now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        purchase_val = float(valuation["suggested_trade_in_gbp"]) if valuation else 0.0
        retail_val = float(valuation["suggested_retail_gbp"]) if valuation else 0.0

        vehicle_payload = {
            "registration_number": reg_number,
            "vin": insp.get("vin") or "",
            "make": insp.get("make") or "",
            "model": insp.get("model") or "",
            "variant": insp.get("variant") or "",
            "year": int(insp.get("year") or 2021),
            "colour": insp.get("colour") or "",
            "condition_inside": int(insp.get("condition_inside") or 8),
            "condition_inside_issues": insp.get("condition_inside_issues") or "",
            "condition_outside": int(insp.get("condition_outside") or 8),
            "condition_outside_issues": insp.get("condition_outside_issues") or "",
            "modifications": insp.get("modifications") or "None (Standard)",
            "mot_status": insp.get("mot_status") or "",
            "mileage": int(insp.get("mileage") or 0),
            "purchase_value": purchase_val,
            "retail_value": retail_val,
            "comments": insp.get("comments") or "",
            "salesperson": salesperson,
            "recorded_at": now_iso,
            "video_gcs_uri": gcs_uri,
            "video_url": video_url,
            "sold": False,
            "field_sources": inspector_result["field_sources"],
            "inspector_skills_used": inspector_result["skills_executed"],
            "valuation_report": valuation,
        }

        if auto_save and valuation:
            record_obj = VehicleRecord(**vehicle_payload)
            vehicle_payload = storage_manager.save_vehicle(record_obj)

        return {
            "status": "success",
            "vehicle": vehicle_payload,
            "inspection": vehicle_payload,
            "inspector_agent": {
                "skills_executed": inspector_result["skills_executed"],
                "field_sources": inspector_result["field_sources"],
                "dvla_official_metadata": inspector_result.get("dvla_official_metadata", {}),
            },
            "valuation": valuation,
            "valuation_bot": valuation,
            "video_storage": {
                "gcs_uri": gcs_uri,
                "video_url": video_url,
            },
        }
    except Exception as exc:
        logger.exception("Error during vehicle inspection workflow")
        raise HTTPException(
            status_code=500,
            detail=f"Vehicle inspection could not be completed: {str(exc)}",
        ) from exc


@app.post("/api/valuation")
@app.post("/api/valuate")
async def recalculate_valuation(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Re-runs the Valuation Bot when the salesperson adjusts mileage, year, or condition."""
    valuation = await valuation_agent.value_vehicle(
        make=str(payload.get("make") or "Vehicle"),
        model=str(payload.get("model") or "Model"),
        variant=str(payload.get("variant") or ""),
        year=int(payload.get("year") or 2021),
        mileage=int(payload.get("mileage") or 30000),
        colour=str(payload.get("colour") or ""),
        condition_inside=int(payload.get("condition_inside") or 8),
        condition_outside=int(payload.get("condition_outside") or 8),
        modifications=str(payload.get("modifications") or "None"),
    )
    return {
        "status": "success",
        "valuation": valuation,
        "valuation_bot": valuation,
    }


@app.post("/api/dvla-lookup")
async def dvla_lookup_endpoint(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Looks up official DVLA vehicle register data by registration plate and updates vehicle attributes."""
    reg = payload.get("registration_number") or payload.get("registration_hint") or ""
    from backend.agents.vehicle_inspector import DvlaOfficialLookupSkill, format_uk_reg, normalize_reg
    formatted = format_uk_reg(reg)
    norm = normalize_reg(formatted)
    if not norm:
        raise HTTPException(status_code=400, detail="Please enter a valid UK registration number.")

    dvla_skill = DvlaOfficialLookupSkill()
    context = {"inspection": {"registration_number": formatted}, "field_sources": {}}
    context = await dvla_skill.execute(context)
    insp = context.get("inspection", {})
    return {
        "status": "success",
        "registration_number": formatted,
        "make": insp.get("make") or "",
        "model": insp.get("model") or "",
        "colour": insp.get("colour") or "",
        "year": insp.get("year") or 2021,
        "mot_status": insp.get("mot_status") or "Valid",
        "field_sources": context.get("field_sources", {}),
    }


@app.post("/api/vehicles")
async def save_vehicle_endpoint(record: VehicleRecord) -> Dict[str, Any]:
    """Saves or updates a trade-in vehicle record keyed by registration_number."""
    saved = storage_manager.save_vehicle(record)
    return {
        "status": "saved",
        "message": f"Vehicle {saved['registration_number']} saved to trade-in stock.",
        "vehicle": saved,
    }


@app.get("/api/vehicles")
async def list_vehicles() -> Dict[str, Any]:
    """Lists all trade-in vehicles with default search parameters."""
    return storage_manager.search_vehicles(SearchVehiclesRequest())


@app.post("/api/vehicles/search")
async def search_vehicles_endpoint(req: SearchVehiclesRequest) -> Dict[str, Any]:
    """Searches trade-in vehicles across selected fields and price/mileage filters."""
    return storage_manager.search_vehicles(req)


@app.patch("/api/vehicles/{registration_number}/sold")
async def mark_vehicle_sold_endpoint(
    registration_number: str, req: MarkSoldRequest
) -> Dict[str, Any]:
    """Marks a vehicle record as Sold (or Available)."""
    updated = storage_manager.mark_vehicle_sold(registration_number, sold=req.sold)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Vehicle '{registration_number}' not found.")
    return {
        "status": "updated",
        "registration_number": updated["registration_number"],
        "sold": updated["sold"],
        "vehicle": updated,
    }


@app.get("/api/videos/file/{filename}")
async def serve_uploaded_video(filename: str):
    """Streams an uploaded walkaround video."""
    safe_name = pathlib.Path(filename).name
    file_path = LOCAL_VIDEO_DIR / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found.")
    media_type = "video/mp4" if safe_name.endswith(".mp4") else "video/webm"
    return FileResponse(file_path, media_type=media_type)


def generate_qr_png_bytes(target_url: str) -> bytes:
    """Generates a high-contrast Google-blue QR code PNG for scanning with phone cameras."""
    import io
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(target_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#1a73e8", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@app.get("/api/qr-code.png")
async def get_qr_code_image(request: Request, url: Optional[str] = None) -> Response:
    """Returns a direct PNG QR code image for scanning with an Android phone."""
    target_url = (
        url
        or os.environ.get("SERVICE_URL")
        or str(request.base_url).rstrip("/")
    )
    png_bytes = generate_qr_png_bytes(target_url)
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/qr-code")
async def get_qr_code_json(request: Request, url: Optional[str] = None) -> Dict[str, Any]:
    """Returns QR code base64 data URI and target URL for dynamic display."""
    import base64
    target_url = (
        url
        or os.environ.get("SERVICE_URL")
        or str(request.base_url).rstrip("/")
    )
    png_bytes = generate_qr_png_bytes(target_url)
    b64 = base64.b64encode(png_bytes).decode("utf-8")
    return {
        "status": "ok",
        "target_url": target_url,
        "qr_code_data_uri": f"data:image/png;base64,{b64}",
    }


@app.get("/sw.js")
async def serve_service_worker() -> Response:
    """Serves minimal Service Worker for Android Chrome WebAPK installability."""
    sw_code = """// Cymbal Auto Group Vehicle ID Service Worker
const CACHE_NAME = 'vehicle-id-v1';
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
self.addEventListener('fetch', (event) => {
  // Pass-through with network-first fallback
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
"""
    return Response(
        content=sw_code,
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/manifest.json")
async def serve_manifest() -> JSONResponse:
    """Serves Web App Manifest for Android Chrome home screen installation."""
    return JSONResponse(
        {
            "name": "Cymbal Auto Group — Trade-In Appraiser",
            "short_name": "Vehicle ID",
            "description": "Multi-site dealership trade-in vehicle appraisal, DVLA lookup, and AI valuation bot.",
            "start_url": "/",
            "display": "standalone",
            "background_color": "#f8f9fa",
            "theme_color": "#1a73e8",
            "orientation": "portrait-primary",
            "icons": [
                {
                    "src": "/api/qr-code.png",
                    "sizes": "260x260",
                    "type": "image/png",
                    "purpose": "any maskable",
                }
            ],
        }
    )


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def serve_index() -> HTMLResponse:
    """Serves the responsive mobile & desktop Vehicle ID frontend."""
    index_file = FRONTEND_DIR / "index.html"
    if not index_file.exists():
        return HTMLResponse("<h1>Loading...</h1>", status_code=200)
    return HTMLResponse(index_file.read_text(encoding="utf-8"))
