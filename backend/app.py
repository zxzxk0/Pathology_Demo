# app.py  — Pathology Demo (GitHub Pages / Static Demo 버전)
# -*- coding: utf-8 -*-
"""
Pathogene Demo Backend

원본 app.py에서 파이프라인(SVS 처리, Registration) 제거.
이미 처리된 타일 데이터를 서빙하는 경량 Flask 서버.

구조:
Pathology_Demo/
├─ backend/
│  └─ app.py          ← 이 파일
├─ frontend/
│  ├─ index.html
│  └─ viewer.js
└─ data/
   ├─ tiles/          ← H&E DZI 타일 (trim_tiles.py로 용량 감소 후)
   ├─ cosmx_tiles/    ← CosMx DZI 타일
   ├─ annotations/
   └─ qc_results/

실행:
    cd backend
    pip install flask flask-cors
    python app.py

접속:
    http://localhost:8000/
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

# =============================================================================
# PATH CONFIG
# =============================================================================

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent

FRONTEND_DIR    = PROJECT_DIR / "frontend"
DATA_DIR        = PROJECT_DIR / "data"
TILES_DIR       = DATA_DIR / "tiles"
COSMX_TILES_DIR = DATA_DIR / "cosmx_tiles"
ANNOTATIONS_DIR = DATA_DIR / "annotations"
QC_DIR          = DATA_DIR / "qc_results"

for d in [DATA_DIR, TILES_DIR, COSMX_TILES_DIR, ANNOTATIONS_DIR, QC_DIR]:
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
CORS(app)

# =============================================================================
# UTILS
# =============================================================================

def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _get_slides() -> list[dict]:
    """tiles/ 폴더에서 DZI 슬라이드 목록 반환."""
    slides = []
    if not TILES_DIR.exists():
        return slides
    for slide_dir in sorted(TILES_DIR.iterdir()):
        if not slide_dir.is_dir():
            continue
        dzi_file = slide_dir / f"{slide_dir.name}.dzi"
        if not dzi_file.exists():
            continue
        slides.append({
            "id":      slide_dir.name,
            "dzi_url": f"/data/tiles/{slide_dir.name}/{slide_dir.name}.dzi",
        })
    return slides


def _get_cosmx_info(slide_id: str) -> dict:
    """CosMx 타일 정보 반환."""
    cx_dir  = COSMX_TILES_DIR / slide_id
    dzi_file = cx_dir / f"{slide_id}.dzi"
    if not dzi_file.exists():
        return {"has_cosmx": False}

    tf_file = cx_dir / "transform_registered.json"
    registered = tf_file.exists()

    return {
        "has_cosmx":  True,
        "dzi_url":    f"/data/cosmx_tiles/{slide_id}/{slide_id}.dzi",
        "registered": registered,
    }


def _get_cosmx_transform(slide_id: str) -> dict:
    """등록된 CosMx transform JSON 반환."""
    tf_file = COSMX_TILES_DIR / slide_id / "transform_registered.json"
    if tf_file.exists():
        return json.loads(tf_file.read_text(encoding="utf-8"))
    return {"transform": "identity"}


# =============================================================================
# STATIC FILES
# =============================================================================

@app.route("/")
def index():
    return send_from_directory(str(FRONTEND_DIR), "index.html")


@app.route("/data/tiles/<path:filename>")
def serve_he_tiles(filename):
    return send_from_directory(str(TILES_DIR), filename)


@app.route("/data/cosmx_tiles/<path:filename>")
def serve_cosmx_tiles(filename):
    return send_from_directory(str(COSMX_TILES_DIR), filename)


# =============================================================================
# SLIDE API
# =============================================================================

@app.route("/api/slides", methods=["GET"])
def get_slides():
    return jsonify(_get_slides())


@app.route("/api/slides/<slide_id>/info", methods=["GET"])
def get_slide_info(slide_id):
    slides = {s["id"]: s for s in _get_slides()}
    if slide_id not in slides:
        return _json_error(f"Slide not found: {slide_id}", 404)
    return jsonify(slides[slide_id])


@app.route("/api/cosmx/<slide_id>/info", methods=["GET"])
def get_cosmx_info(slide_id):
    return jsonify(_get_cosmx_info(slide_id))


@app.route("/api/cosmx/<slide_id>/transform", methods=["GET"])
def get_cosmx_transform(slide_id):
    return jsonify(_get_cosmx_transform(slide_id))


# =============================================================================
# ANNOTATION API
# =============================================================================

@app.route("/api/annotations/<slide_id>", methods=["GET"])
def get_annotations(slide_id):
    f = ANNOTATIONS_DIR / f"{slide_id}.json"
    if not f.exists():
        return jsonify({"type": "FeatureCollection", "features": []})
    return jsonify(json.loads(f.read_text(encoding="utf-8")))


@app.route("/api/annotations/<slide_id>", methods=["POST"])
def save_annotations(slide_id):
    f    = ANNOTATIONS_DIR / f"{slide_id}.json"
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        return _json_error("Invalid GeoJSON format", 400)
    f.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return jsonify({"status": "success", "saved": len(data.get("features", []))})


@app.route("/api/annotations/<slide_id>", methods=["DELETE"])
def delete_annotations(slide_id):
    f = ANNOTATIONS_DIR / f"{slide_id}.json"
    if f.exists():
        f.unlink()
        return jsonify({"status": "deleted"})
    return jsonify({"status": "not_found"}), 404


# =============================================================================
# QC API
# =============================================================================

@app.route("/api/qc/<slide_id>", methods=["GET"])
def get_qc_status(slide_id):
    f = QC_DIR / f"{slide_id}.json"
    if f.exists():
        return jsonify(json.loads(f.read_text(encoding="utf-8")))
    return jsonify({"status": "unreviewed"})


@app.route("/api/qc/<slide_id>", methods=["POST"])
def save_qc_status(slide_id):
    f    = QC_DIR / f"{slide_id}.json"
    data = request.get_json(force=True, silent=True) or {}
    qc   = {
        "slide_id":  slide_id,
        "status":    data.get("status"),
        "timestamp": datetime.now().isoformat(),
        "reviewer":  data.get("reviewer", "demo"),
    }
    f.write_text(json.dumps(qc, indent=2), encoding="utf-8")
    return jsonify({"status": "success", "qc_status": qc["status"]})


# =============================================================================
# HEALTH
# =============================================================================

@app.route("/health", methods=["GET"])
def health():
    slides = _get_slides()
    return jsonify({
        "status":      "healthy",
        "service":     "Pathogene Demo",
        "slides":      len(slides),
        "slide_ids":   [s["id"] for s in slides],
    })


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify({
        "mode":         "demo",
        "project_dir":  str(PROJECT_DIR),
        "tiles_dir":    str(TILES_DIR),
        "cosmx_tiles":  str(COSMX_TILES_DIR),
    })


# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":
    slides = _get_slides()
    print("=" * 60)
    print("  Pathogene Demo Backend")
    print("=" * 60)
    print(f"  PROJECT_DIR : {PROJECT_DIR}")
    print(f"  TILES_DIR   : {TILES_DIR}")
    print(f"  슬라이드 수  : {len(slides)}")
    for s in slides:
        cx = _get_cosmx_info(s["id"])
        print(f"    - {s['id']}  CosMx={'✓' if cx['has_cosmx'] else '✗'}")
    print("=" * 60)
    print("  Open: http://localhost:8000/")
    print("=" * 60)
    app.run(debug=False, host="0.0.0.0", port=8000, threaded=True)
