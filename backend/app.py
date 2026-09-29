# app.py — Pathogene lightweight Flask Demo
# -*- coding: utf-8 -*-
"""
Pathogene Demo Backend

This Demo intentionally removes the heavy SVS/CosMx registration and tiling pipeline.
It serves PRE-GENERATED H&E/CosMx DZI data and the current viewer UI.

Expected structure:
Pathology_Demo/
├─ backend/
│  └─ app.py
├─ frontend/
│  ├─ index.html
│  ├─ viewer.js
│  └─ logo.png
└─ data/
   ├─ tiles/
   │  └─ <slide_id>/
   │     ├─ <slide_id>.dzi
   │     ├─ <slide_id>_files/...
   │     └─ dzi_meta.json              # optional
   ├─ cosmx_tiles/
   │  └─ <slide_id>/
   │     ├─ <slide_id>.dzi
   │     ├─ <slide_id>_files/...
   │     └─ transform_registered.json  # preferred transform
   ├─ annotations/
   └─ qc_results/

Run:
    cd backend
    python app.py

Open:
    http://localhost:8000/
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS


# =============================================================================
# PATH CONFIG
# =============================================================================

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent

FRONTEND_DIR = PROJECT_DIR / "frontend"
DATA_DIR = PROJECT_DIR / "data"
TILES_DIR = DATA_DIR / "tiles"
COSMX_TILES_DIR = DATA_DIR / "cosmx_tiles"
ANNOTATIONS_DIR = DATA_DIR / "annotations"
QC_DIR = DATA_DIR / "qc_results"

for d in [DATA_DIR, TILES_DIR, COSMX_TILES_DIR, ANNOTATIONS_DIR, QC_DIR]:
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
CORS(app)


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


# =============================================================================
# FRONTEND / STATIC FILES
# =============================================================================

@app.route("/")
def index():
    return send_from_directory(str(FRONTEND_DIR), "index.html")


@app.route("/<path:filename>")
def frontend_file(filename):
    target = FRONTEND_DIR / filename
    if target.exists() and target.is_file():
        return send_from_directory(str(FRONTEND_DIR), filename)
    return _json_error(f"Not found: {filename}", 404)


@app.route("/tiles/<path:filepath>")
def serve_tiles(filepath):
    return send_from_directory(str(TILES_DIR), filepath)


@app.route("/cosmx_tiles/<path:filepath>")
def serve_cosmx_tiles(filepath):
    return send_from_directory(str(COSMX_TILES_DIR), filepath)


# Backward-compatible paths used by older Demo code.
@app.route("/data/tiles/<path:filepath>")
def serve_tiles_legacy(filepath):
    return send_from_directory(str(TILES_DIR), filepath)


@app.route("/data/cosmx_tiles/<path:filepath>")
def serve_cosmx_tiles_legacy(filepath):
    return send_from_directory(str(COSMX_TILES_DIR), filepath)


# =============================================================================
# SLIDES / COSMX
# =============================================================================

def _get_slides() -> list[dict]:
    slides = []
    if not TILES_DIR.exists():
        return slides

    for slide_dir in sorted(TILES_DIR.iterdir()):
        if not slide_dir.is_dir():
            continue

        slide_id = slide_dir.name
        dzi_file = slide_dir / f"{slide_id}.dzi"
        if not dzi_file.exists():
            continue

        slides.append({
            "id": slide_id,
            "name": slide_id,
            "dzi_url": f"/tiles/{slide_id}/{slide_id}.dzi",
        })

    return slides


@app.route("/api/slides", methods=["GET"])
def get_slides():
    return jsonify(_get_slides())


@app.route("/api/slides/<slide_id>/info", methods=["GET"])
def get_slide_info(slide_id):
    slides = {s["id"]: s for s in _get_slides()}
    if slide_id not in slides:
        return _json_error(f"Slide not found: {slide_id}", 404)
    return jsonify(slides[slide_id])


def _get_cosmx_dzi_payload(slide_id: str) -> dict:
    slide_dir = COSMX_TILES_DIR / slide_id

    original_dzi = slide_dir / f"{slide_id}.dzi"
    registered_dzi = slide_dir / f"{slide_id}_registered.dzi"

    # Current viewer behavior: prefer ORIGINAL CosMx DZI and apply
    # transform_registered.json in OpenSeadragon.
    if original_dzi.exists():
        return {
            "has_cosmx": True,
            "dzi_url": f"/cosmx_tiles/{slide_id}/{slide_id}.dzi",
            "slide_id": slide_id,
            "registered": False,
            "registered_dzi_exists": registered_dzi.exists(),
            "mode": "original_dzi_plus_transform",
        }

    # Compatibility fallback for older Demo datasets.
    if registered_dzi.exists():
        return {
            "has_cosmx": True,
            "dzi_url": f"/cosmx_tiles/{slide_id}/{slide_id}_registered.dzi",
            "slide_id": slide_id,
            "registered": True,
            "registered_dzi_exists": True,
            "mode": "registered_dzi_fallback",
        }

    return {"has_cosmx": False, "slide_id": slide_id}


@app.route("/api/cosmx/<slide_id>/dzi", methods=["GET"])
def get_cosmx_dzi(slide_id):
    return jsonify(_get_cosmx_dzi_payload(slide_id))


# Older viewer.js compatibility.
@app.route("/api/cosmx/<slide_id>/info", methods=["GET"])
def get_cosmx_info(slide_id):
    return jsonify(_get_cosmx_dzi_payload(slide_id))


@app.route("/api/cosmx/<slide_id>/transform", methods=["GET"])
def get_cosmx_transform(slide_id):
    slide_dir = COSMX_TILES_DIR / slide_id

    # Prefer final fine-registration transform.
    for fname in ("transform_registered.json", "transform.json"):
        f = slide_dir / fname
        if not f.exists():
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data["_transform_source_file"] = fname
                data["_is_fine_registered"] = (fname == "transform_registered.json")
            return jsonify(data)
        except Exception as e:
            return _json_error(f"Could not read {fname}: {e}", 500)

    return jsonify({
        "version": "1.0",
        "slide_id": slide_id,
        "transform": "identity",
        "notes": "No transform file found",
    })


# =============================================================================
# ANNOTATION STORAGE API
# =============================================================================

@app.route("/api/annotations/<slide_id>", methods=["GET"])
def get_annotations(slide_id):
    # Accept either .json or .geojson.
    for suffix in (".json", ".geojson"):
        f = ANNOTATIONS_DIR / f"{slide_id}{suffix}"
        if f.exists():
            try:
                return jsonify(json.loads(f.read_text(encoding="utf-8")))
            except Exception as e:
                return _json_error(f"Could not read annotations: {e}", 500)

    return jsonify({"type": "FeatureCollection", "features": []})


@app.route("/api/annotations/<slide_id>", methods=["POST"])
def save_annotations(slide_id):
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        return _json_error("Invalid GeoJSON FeatureCollection", 400)

    f = ANNOTATIONS_DIR / f"{slide_id}.geojson"
    f.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return jsonify({"status": "success", "saved": len(data.get("features", []))})


@app.route("/api/annotations/<slide_id>", methods=["DELETE"])
def delete_annotations(slide_id):
    deleted = False
    for suffix in (".json", ".geojson"):
        f = ANNOTATIONS_DIR / f"{slide_id}{suffix}"
        if f.exists():
            f.unlink()
            deleted = True
    return jsonify({"status": "deleted" if deleted else "not_found"}), (200 if deleted else 404)


# =============================================================================
# QC STORAGE API
# =============================================================================

@app.route("/api/qc/<slide_id>", methods=["GET"])
def get_qc_status(slide_id):
    f = QC_DIR / f"{slide_id}.json"
    if f.exists():
        try:
            return jsonify(json.loads(f.read_text(encoding="utf-8")))
        except Exception as e:
            return _json_error(f"Could not read QC status: {e}", 500)
    return jsonify({"status": "unreviewed"})


@app.route("/api/qc/<slide_id>", methods=["POST"])
def save_qc_status(slide_id):
    data = request.get_json(force=True, silent=True) or {}
    qc = {
        "slide_id": slide_id,
        "status": data.get("status"),
        "timestamp": datetime.now().isoformat(),
        "reviewer": data.get("reviewer", "demo"),
    }
    f = QC_DIR / f"{slide_id}.json"
    f.write_text(json.dumps(qc, indent=2), encoding="utf-8")
    return jsonify({"status": "success", "qc_status": qc["status"]})


# =============================================================================
# SEGMENTATION EVALUATION — GT Coverage + reference Dice / IoU
# =============================================================================

def _segmentation_class_name(feature: Dict[str, Any]) -> str:
    props = feature.get("properties") or {}
    classification = props.get("classification")

    if isinstance(classification, dict):
        raw = classification.get("name") or classification.get("label") or ""
    elif classification is not None:
        raw = classification
    else:
        raw = (
            props.get("className") or props.get("label") or props.get("name") or
            props.get("type") or props.get("objectType") or ""
        )

    return str(raw).strip().rstrip("*").replace("_", " ").lower()


def _segmentation_union(geojson_obj: Dict[str, Any], wanted_class: str):
    try:
        from shapely.geometry import shape
        from shapely.ops import unary_union
    except ImportError as e:
        raise RuntimeError(
            "Segmentation evaluation requires Shapely. Install with: pip install shapely"
        ) from e

    features = geojson_obj.get("features", []) if isinstance(geojson_obj, dict) else []
    geoms = []
    wanted = wanted_class.lower()

    for feat in features:
        if not isinstance(feat, dict) or _segmentation_class_name(feat) != wanted:
            continue

        geom_obj = feat.get("geometry")
        if not isinstance(geom_obj, dict) or geom_obj.get("type") not in ("Polygon", "MultiPolygon"):
            continue

        try:
            g = shape(geom_obj)
            if g.is_empty:
                continue
            if not g.is_valid:
                g = g.buffer(0)
            if not g.is_empty:
                geoms.append(g)
        except Exception:
            continue

    if not geoms:
        return None, 0

    merged = unary_union(geoms)
    if not merged.is_valid:
        merged = merged.buffer(0)

    return merged, len(geoms)


def _geometry_bounds_payload(geom):
    if geom is None or geom.is_empty:
        return None

    minx, miny, maxx, maxy = geom.bounds
    return [float(minx), float(miny), float(maxx), float(maxy)]


@app.route("/api/evaluate/segmentation", methods=["POST"])
def evaluate_segmentation():
    data = request.get_json(force=True, silent=True) or {}
    gt = data.get("ground_truth")
    pred = data.get("prediction")

    if not isinstance(gt, dict) or gt.get("type") != "FeatureCollection":
        return _json_error("ground_truth must be a GeoJSON FeatureCollection", 400)
    if not isinstance(pred, dict) or pred.get("type") != "FeatureCollection":
        return _json_error("prediction must be a GeoJSON FeatureCollection", 400)

    try:
        results: Dict[str, Any] = {}
        coverage_values = []
        dice_values = []
        iou_values = []
        warnings = []

        for class_name in ("tumor", "stroma"):
            gt_geom, gt_count = _segmentation_union(gt, class_name)
            pred_geom, pred_count = _segmentation_union(pred, class_name)

            class_result: Dict[str, Any] = {
                "gt_polygons": gt_count,
                "prediction_polygons": pred_count,
                "gt_bounds": _geometry_bounds_payload(gt_geom),
                "prediction_bounds": _geometry_bounds_payload(pred_geom),
            }

            if gt_geom is None:
                class_result.update({
                    "gt_coverage": None,
                    "dice": None,
                    "iou": None,
                    "error": "No GT polygons for this class",
                })
                results[class_name] = class_result
                continue

            if pred_geom is None:
                class_result.update({
                    "gt_coverage": 0.0,
                    "dice": 0.0,
                    "iou": 0.0,
                    "error": "No prediction polygons for this class",
                })
                coverage_values.append(0.0)
                dice_values.append(0.0)
                iou_values.append(0.0)
                results[class_name] = class_result
                continue

            gt_area = float(gt_geom.area)
            pred_area = float(pred_geom.area)
            intersection_area = float(gt_geom.intersection(pred_geom).area)
            union_area = float(gt_geom.union(pred_geom).area)

            gt_coverage = (intersection_area / gt_area) if gt_area > 0 else None
            dice_den = gt_area + pred_area
            dice = (2.0 * intersection_area / dice_den) if dice_den > 0 else None
            iou = (intersection_area / union_area) if union_area > 0 else None

            class_result.update({
                "gt_coverage": gt_coverage,
                "dice": dice,
                "iou": iou,
                "gt_area": gt_area,
                "prediction_area": pred_area,
                "intersection_area": intersection_area,
                "union_area": union_area,
            })

            if gt_coverage is not None:
                coverage_values.append(gt_coverage)
            if dice is not None:
                dice_values.append(dice)
            if iou is not None:
                iou_values.append(iou)

            results[class_name] = class_result

        gt_parts = []
        pred_parts = []
        for class_name in ("tumor", "stroma"):
            g, _ = _segmentation_union(gt, class_name)
            p, _ = _segmentation_union(pred, class_name)
            if g is not None and not g.is_empty:
                gt_parts.append(g)
            if p is not None and not p.is_empty:
                pred_parts.append(p)

        if gt_parts and pred_parts:
            from shapely.ops import unary_union

            gb = unary_union(gt_parts).bounds
            pb = unary_union(pred_parts).bounds

            gw, gh = max(gb[2] - gb[0], 1e-9), max(gb[3] - gb[1], 1e-9)
            pw, ph = max(pb[2] - pb[0], 1e-9), max(pb[3] - pb[1], 1e-9)

            ratio = max(gw / pw, pw / gw, gh / ph, ph / gh)
            if ratio > 8.0:
                warnings.append(
                    "GT and prediction coordinate extents differ greatly. "
                    "Confirm that both files use the same slide pixel coordinate system."
                )

        return jsonify({
            "status": "success",
            "classes_evaluated": ["tumor", "stroma"],
            "ignored_classes": {
                "ground_truth": ["region"],
                "prediction": ["in-situ", "other", "region"],
            },
            "results": results,
            "mean": {
                "gt_coverage": (
                    sum(coverage_values) / len(coverage_values)
                    if coverage_values else None
                ),
                "dice": (
                    sum(dice_values) / len(dice_values)
                    if dice_values else None
                ),
                "iou": (
                    sum(iou_values) / len(iou_values)
                    if iou_values else None
                ),
            },
            "warnings": warnings,
        })

    except Exception as e:
        return _json_error(f"Segmentation evaluation failed: {e}", 500)


# =============================================================================
# DEMO-DISABLED HEAVY PIPELINE
# =============================================================================

@app.route("/api/pipeline/<path:_rest>", methods=["GET", "POST", "DELETE", "OPTIONS"])
@app.route("/api/dialog/<path:_rest>", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/registration/<path:_rest>", methods=["GET", "POST", "DELETE", "OPTIONS"])
def demo_disabled(_rest):
    return _json_error(
        "This endpoint is disabled in the lightweight Demo. "
        "Use pre-generated DZI/registration results.",
        410,
    )


# =============================================================================
# HEALTH
# =============================================================================

@app.route("/health", methods=["GET"])
def health():
    slides = _get_slides()
    return jsonify({
        "status": "healthy",
        "service": "Pathogene Demo",
        "mode": "pre_generated_tiles",
        "slides": len(slides),
        "slide_ids": [s["id"] for s in slides],
    })


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify({
        "mode": "demo",
        "project_dir": str(PROJECT_DIR),
        "tiles_dir": str(TILES_DIR),
        "cosmx_tiles": str(COSMX_TILES_DIR),
        "registration_enabled": False,
    })


if __name__ == "__main__":
    slides = _get_slides()

    print("=" * 60)
    print("  Pathogene Lightweight Flask Demo")
    print("=" * 60)
    print(f"  PROJECT_DIR : {PROJECT_DIR}")
    print(f"  TILES_DIR   : {TILES_DIR}")
    print(f"  slides      : {len(slides)}")
    for s in slides:
        cx = _get_cosmx_dzi_payload(s["id"])
        print(f"    - {s['id']}  CosMx={'YES' if cx.get('has_cosmx') else 'NO'}")
    print("=" * 60)
    print("  Open: http://localhost:8000/")
    print("=" * 60)

    app.run(debug=False, host="0.0.0.0", port=8000, threaded=True)
