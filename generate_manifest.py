# -*- coding: utf-8 -*-
"""
generate_manifest.py
====================
GitHub Pages 배포 전 실행하는 스크립트.
data/tiles/ 와 data/cosmx_tiles/ 폴더를 스캔해서
docs/slides.json 을 생성합니다.

Flask API 없이 GitHub Pages에서 정적으로 슬라이드 목록을 읽을 수 있게 해줍니다.

사용법:
    cd E:\\Pathology_Demo
    python generate_manifest.py
"""

import json
import os
from pathlib import Path

# ── 경로 설정 ─────────────────────────────────────────────────────────────
DEMO_DIR         = Path(__file__).parent
TILES_DIR        = DEMO_DIR / "data" / "tiles"
COSMX_TILES_DIR  = DEMO_DIR / "data" / "cosmx_tiles"
DOCS_DIR         = DEMO_DIR / "docs"
OUTPUT_JSON      = DOCS_DIR / "slides.json"

# GitHub Pages에서 접근할 때의 base path
# 레포 이름이 Pathology_Demo 이면 "/Pathology_Demo"
REPO_BASE        = "/Pathology_Demo"
#REPO_BASE        = ""

# ── 슬라이드 스캔 ─────────────────────────────────────────────────────────

def find_slides():
    slides = []

    if not TILES_DIR.exists():
        print(f"[WARN] tiles 폴더 없음: {TILES_DIR}")
        return slides

    for slide_dir in sorted(TILES_DIR.iterdir()):
        if not slide_dir.is_dir():
            continue
        slide_id = slide_dir.name
        dzi_file = slide_dir / f"{slide_id}.dzi"
        if not dzi_file.exists():
            print(f"  [SKIP] DZI 없음: {slide_id}")
            continue

        # CosMx 확인
        cx_dir   = COSMX_TILES_DIR / slide_id
        cx_dzis = list(cx_dir.glob("*_registered.dzi")) if cx_dir.exists() else []
        if not cx_dzis:
            cx_dzis = list(cx_dir.glob("*.dzi")) if cx_dir.exists() else []
        has_cosmx = len(cx_dzis) > 0
        cx_dzi_name = cx_dzis[0].name if cx_dzis else None

        # transform_registered.json 확인
        tf_reg = cx_dir / "transform_registered.json" if cx_dir.exists() else None
        registered = tf_reg.exists() if tf_reg else False

        # transform 읽기
        transform = {"transform": "identity"}
        if registered and tf_reg:
            try:
                raw = json.loads(tf_reg.read_text(encoding="utf-8"))
                t = raw.get("transform", raw)
                transform = t.get("transform", t) if isinstance(t, dict) else t
            except Exception:
                pass

        slide = {
            "id":      slide_id,
            "dzi_url": f"{REPO_BASE}/data/tiles/{slide_id}/{slide_id}.dzi",
        }

        if has_cosmx:
            cx_dzi_stem = cx_dzis[0].stem
            slide["cosmx"] = {
                "has_cosmx":  True,
                "dzi_url":    f"{REPO_BASE}/data/cosmx_tiles/{slide_id}/{cx_dzi_name}",
                "registered": registered,
                "transform":  transform,
            }
        else:
            slide["cosmx"] = {"has_cosmx": False}

        slides.append(slide)
        cx_str = f"CosMx={'✓' if has_cosmx else '✗'}"
        print(f"  ✅ {slide_id}  ({cx_str})")

    return slides


def main():
    print("=" * 60)
    print("  generate_manifest.py")
    print("=" * 60)
    print(f"  tiles      : {TILES_DIR}")
    print(f"  cosmx_tiles: {COSMX_TILES_DIR}")
    print(f"  출력        : {OUTPUT_JSON}")
    print(f"  repo base  : {REPO_BASE}")
    print()

    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    slides = find_slides()

    if not slides:
        print("\n[ERROR] 슬라이드를 찾을 수 없습니다.")
        print("  data/tiles/<slide_id>/<slide_id>.dzi 구조인지 확인하세요.")
        return

    OUTPUT_JSON.write_text(
        json.dumps(slides, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    print(f"\n  총 {len(slides)}개 슬라이드 → {OUTPUT_JSON}")
    print("  완료! 이제 git add docs/slides.json 후 push 하세요.")


if __name__ == "__main__":
    main()
