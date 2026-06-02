# Pathology Demo

H&E 병리 슬라이드 + CosMx 공간 전사체 데이터를 웹에서 시각화하는 데모 앱입니다.

## 프로젝트 구조

```
Pathology_Demo/
├─ backend/
│  └─ app.py              # Flask 서버 (경량 데모 버전)
├─ frontend/
│  ├─ index.html          # 메인 UI
│  └─ viewer.js           # 뷰어 로직 (REST API 버전)
├─ data/
│  ├─ tiles/              # H&E DZI 타일 (직접 추가 필요)
│  ├─ cosmx_tiles/        # CosMx DZI 타일 (직접 추가 필요)
│  ├─ annotations/        # GeoJSON 어노테이션
│  └─ qc_results/         # QC 결과
├─ scripts/
│  └─ trim_tiles.py       # 타일 고해상도 레벨 제거 (용량 절감)
└─ requirements.txt
```

---

## 빠른 시작

### 1. 의존성 설치

```bash
pip install -r requirements.txt
```

### 2. 타일 데이터 배치

로컬에서 처리된 타일 폴더를 복사합니다:

```
data/tiles/<slide_id>/<slide_id>.dzi
data/tiles/<slide_id>/<slide_id>_files/...

data/cosmx_tiles/<slide_id>/<slide_id>.dzi
data/cosmx_tiles/<slide_id>/<slide_id>_files/...
data/cosmx_tiles/<slide_id>/transform_registered.json   ← registration 결과
```

### 3. 서버 실행

```bash
cd backend
python app.py
```

브라우저에서 http://localhost:8000 접속

---

## 용량 절감 (GitHub 업로드 전)

타일 데이터는 수 GB에 달할 수 있습니다.  
`trim_tiles.py`로 고해상도 레벨을 제거하면 용량을 대폭 줄일 수 있습니다.

```bash
# 현황 확인 (삭제 없음)
python scripts/trim_tiles.py --dry-run

# 최고 레벨 2개 미리보기
python scripts/trim_tiles.py --remove 2 --dry-run

# 실제 제거 (주의: 되돌릴 수 없음 — 백업 후 실행!)
python scripts/trim_tiles.py --remove 2
```

| 제거 레벨 수 | 예상 용량 | 최대 줌 |
|------------|---------|---------|
| 0 (원본)   | 100%    | 최대    |
| 1개 제거   | ~40%    | 50%     |
| 2개 제거   | ~15%    | 25%     |
| 3개 제거   | ~5%     | 12%     |

> 데모 목적으로는 **2개 제거**가 적당합니다.

---

## GitHub Pages 배포

타일 데이터를 포함한 정적 배포는 용량 제한으로 어렵습니다.  
대용량 타일은 외부 스토리지(Hugging Face, Cloudflare R2 등)에 업로드한 뒤  
`app.py`의 타일 서빙 경로를 외부 URL로 변경하세요.

현재는 **로컬 Flask 서버** 방식으로 데모를 실행합니다.

---

## API 엔드포인트

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/slides` | 슬라이드 목록 |
| GET | `/api/cosmx/<id>/info` | CosMx 정보 |
| GET | `/api/cosmx/<id>/transform` | Registration 변환 |
| GET | `/api/annotations/<id>` | 어노테이션 조회 |
| POST | `/api/annotations/<id>` | 어노테이션 저장 |
| GET | `/api/qc/<id>` | QC 상태 조회 |
| POST | `/api/qc/<id>` | QC 상태 저장 |
| GET | `/health` | 서버 상태 확인 |

---

## 주요 기능

- **H&E 슬라이드 뷰어** — OpenSeadragon 기반 DeepZoom 타일 뷰어
- **CosMx 오버레이** — 공간 전사체 데이터 H&E 위에 오버레이
- **패널 동기화** — H&E / CosMx 패널 동시 팬/줌
- **어노테이션** — GeoJSON import (Polygon, Point 지원)
- **QC 마킹** — Approved / Rejected 상태 저장
- **신뢰도 임계값** — AI 림프구 예측 결과 필터링
