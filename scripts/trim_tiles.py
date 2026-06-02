"""
trim_tiles.py  --  DeepZoom 타일 고해상도 레벨 제거 스크립트

용량을 줄이기 위해 DZI 타일 피라미드에서 최고해상도 레벨 N개를 삭제합니다.
GitHub Pages 데모 배포 전 실행하세요.

사용법:
    # 현황 확인만 (삭제 없음)
    python scripts/trim_tiles.py --dry-run

    # 최고 레벨 2개 제거 (H&E + CosMx 모두)
    python scripts/trim_tiles.py --remove 2

    # 특정 폴더만 지정
    python scripts/trim_tiles.py --remove 2 --tiles-dir data/tiles
    python scripts/trim_tiles.py --remove 2 --tiles-dir data/cosmx_tiles

예상 용량 절감:
    --remove 1  →  원본의 ~40%로 감소
    --remove 2  →  원본의 ~15%로 감소
    --remove 3  →  원본의 ~5%로 감소
"""

import argparse
import shutil
import sys
from pathlib import Path

# ── 색상 출력 (터미널) ─────────────────────────────────────────────────────
try:
    from colorama import Fore, Style, init as colorama_init
    colorama_init(autoreset=True)
    RED    = Fore.RED
    GREEN  = Fore.GREEN
    YELLOW = Fore.YELLOW
    CYAN   = Fore.CYAN
    RESET  = Style.RESET_ALL
except ImportError:
    RED = GREEN = YELLOW = CYAN = RESET = ""


def _fmt_size(size_bytes: int) -> str:
    """바이트를 읽기 쉬운 단위로 변환."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


def _dir_size(path: Path) -> int:
    """디렉토리 전체 크기 (바이트)."""
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _get_level_dirs(files_dir: Path) -> list[tuple[int, Path]]:
    """
    _files 디렉토리에서 숫자 이름의 레벨 폴더 목록을 반환.
    [(level_int, path), ...] 내림차순 정렬 (높은 레벨 먼저).
    """
    levels = []
    for d in files_dir.iterdir():
        if d.is_dir() and d.name.isdigit():
            levels.append((int(d.name), d))
    levels.sort(key=lambda x: x[0], reverse=True)
    return levels


def analyze_slide(slide_dir: Path) -> dict:
    """슬라이드 폴더의 레벨별 용량 분석."""
    files_dirs = list(slide_dir.glob("*_files"))
    if not files_dirs:
        return {}

    files_dir = files_dirs[0]
    levels = _get_level_dirs(files_dir)

    info = {
        "slide_id": slide_dir.name,
        "files_dir": files_dir,
        "levels": [],
        "total_bytes": 0,
    }

    for lv, lv_path in levels:
        size = _dir_size(lv_path)
        tile_count = sum(1 for _ in lv_path.glob("*.jpeg")) + \
                     sum(1 for _ in lv_path.glob("*.jpg"))  + \
                     sum(1 for _ in lv_path.glob("*.png"))
        info["levels"].append({
            "level": lv,
            "path": lv_path,
            "bytes": size,
            "tiles": tile_count,
        })
        info["total_bytes"] += size

    return info


def print_analysis(info: dict, remove: int = 0) -> None:
    """분석 결과를 보기 좋게 출력."""
    if not info:
        return

    print(f"\n{CYAN}{'─'*60}")
    print(f"  슬라이드: {info['slide_id']}")
    print(f"  경로: {info['files_dir']}")
    print(f"{'─'*60}{RESET}")

    total = info["total_bytes"]
    cumulative = 0
    will_remove_bytes = 0

    for i, lv_info in enumerate(info["levels"]):
        lv  = lv_info["level"]
        sz  = lv_info["bytes"]
        cumulative += sz
        pct = (sz / total * 100) if total > 0 else 0
        bar = "█" * int(pct / 2) + "░" * (50 - int(pct / 2))

        mark = ""
        if i < remove:
            mark = f"{RED} ← 삭제 예정{RESET}"
            will_remove_bytes += sz
        elif i == remove:
            mark = f"{GREEN} ← 새 최고 레벨{RESET}"

        print(f"  레벨 {lv:>3}: {_fmt_size(sz):>10}  ({pct:5.1f}%)  "
              f"tiles={lv_info['tiles']:>6}{mark}")

    kept = total - will_remove_bytes
    print(f"\n  {YELLOW}전체 크기     : {_fmt_size(total)}{RESET}")
    if remove > 0:
        print(f"  {RED}삭제 예정     : {_fmt_size(will_remove_bytes)} "
              f"(-{will_remove_bytes/total*100:.0f}%){RESET}")
        print(f"  {GREEN}삭제 후 크기  : {_fmt_size(kept)}{RESET}")


def trim_slide(info: dict, remove: int, dry_run: bool = False) -> tuple[int, int]:
    """
    info 슬라이드에서 상위 remove개 레벨 삭제.
    Returns: (삭제된 레벨 수, 삭제된 바이트)
    """
    if not info or not info.get("levels"):
        return 0, 0

    removed_levels = 0
    removed_bytes  = 0

    for i, lv_info in enumerate(info["levels"]):
        if i >= remove:
            break
        lv_path = lv_info["path"]
        sz      = lv_info["bytes"]
        lv      = lv_info["level"]

        if dry_run:
            print(f"  [DRY-RUN] 삭제 예정: 레벨 {lv}  ({_fmt_size(sz)})")
        else:
            print(f"  {RED}삭제 중: 레벨 {lv}  ({_fmt_size(sz)}){RESET}")
            shutil.rmtree(lv_path)
            print(f"  {GREEN}✓ 삭제 완료: 레벨 {lv}{RESET}")

        removed_levels += 1
        removed_bytes  += sz

    return removed_levels, removed_bytes


def process_tiles_dir(tiles_dir: Path, remove: int, dry_run: bool) -> tuple[int, int]:
    """tiles_dir 아래의 모든 슬라이드를 처리."""
    if not tiles_dir.exists():
        print(f"{YELLOW}[SKIP] 폴더 없음: {tiles_dir}{RESET}")
        return 0, 0

    slide_dirs = [d for d in tiles_dir.iterdir() if d.is_dir()]
    if not slide_dirs:
        print(f"{YELLOW}[SKIP] 슬라이드 없음: {tiles_dir}{RESET}")
        return 0, 0

    total_removed_levels = 0
    total_removed_bytes  = 0

    for slide_dir in sorted(slide_dirs):
        info = analyze_slide(slide_dir)
        if not info:
            print(f"  {YELLOW}[SKIP] DZI 구조 없음: {slide_dir.name}{RESET}")
            continue

        print_analysis(info, remove=remove)

        if remove > 0:
            lv, by = trim_slide(info, remove, dry_run=dry_run)
            total_removed_levels += lv
            total_removed_bytes  += by

    return total_removed_levels, total_removed_bytes


def main():
    parser = argparse.ArgumentParser(
        description="DeepZoom 타일 고해상도 레벨 제거 (용량 절감용)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--remove", type=int, default=0, metavar="N",
        help="제거할 최고해상도 레벨 수 (기본: 0 = 분석만)",
    )
    parser.add_argument(
        "--tiles-dir", type=str, default=None, metavar="PATH",
        help="처리할 특정 타일 폴더 (기본: data/tiles 와 data/cosmx_tiles 모두)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="실제 삭제 없이 미리보기만",
    )
    parser.add_argument(
        "--data-dir", type=str, default=None, metavar="PATH",
        help="데이터 루트 폴더 (기본: 스크립트 위치 기준 ../data)",
    )
    args = parser.parse_args()

    # 경로 결정
    script_dir = Path(__file__).resolve().parent
    data_dir   = Path(args.data_dir) if args.data_dir else Path(r"E:\병리\data")


    print(f"\n{'='*60}")
    print(f"  Pathology Demo - 타일 트리밍 스크립트")
    print(f"{'='*60}")
    print(f"  데이터 루트 : {data_dir}")
    print(f"  제거 레벨수 : {args.remove}")
    print(f"  DRY-RUN    : {args.dry_run}")

    if args.remove == 0:
        print(f"\n{YELLOW}  ※ --remove 옵션 없음: 현황 분석만 수행합니다.{RESET}")
    elif args.dry_run:
        print(f"\n{YELLOW}  ※ DRY-RUN 모드: 실제 파일은 삭제되지 않습니다.{RESET}")
    else:
        print(f"\n{RED}  ⚠  주의: 실제 파일이 삭제됩니다! 백업 후 실행하세요.{RESET}")
        confirm = input("  계속하시겠습니까? (yes/no): ").strip().lower()
        if confirm not in ("yes", "y"):
            print("  취소되었습니다.")
            sys.exit(0)

    total_removed_levels = 0
    total_removed_bytes  = 0

    if args.tiles_dir:
        # 특정 폴더만
        tl, by = process_tiles_dir(
            Path(args.tiles_dir), args.remove, args.dry_run
        )
        total_removed_levels += tl
        total_removed_bytes  += by
    else:
        # H&E + CosMx 모두
        for folder_name in ("tiles", "cosmx_tiles"):
            tiles_dir = data_dir / folder_name
            print(f"\n\n{'='*60}")
            print(f"  📂  {folder_name}/")
            print(f"{'='*60}")
            tl, by = process_tiles_dir(tiles_dir, args.remove, args.dry_run)
            total_removed_levels += tl
            total_removed_bytes  += by

    # 최종 요약
    print(f"\n\n{'='*60}")
    print(f"  {'[DRY-RUN] ' if args.dry_run else ''}완료 요약")
    print(f"{'='*60}")
    print(f"  제거된 레벨 폴더 수 : {total_removed_levels}")
    print(f"  절감된 용량         : {_fmt_size(total_removed_bytes)}")
    print(f"{'='*60}\n")

    if args.dry_run and args.remove > 0:
        print(f"{YELLOW}실제 적용하려면 --dry-run 없이 다시 실행하세요.{RESET}\n")


if __name__ == "__main__":
    main()
