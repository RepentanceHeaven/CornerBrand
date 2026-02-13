# CornerBrand (코너브랜드)

회개와천국복음선교회에서 사용하는 **이미지/PDF 코너 로고 자동 삽입** Windows 데스크톱 앱입니다.

## 개발 환경 준비(Windows)

Tauri 개발/빌드를 위해 아래가 필요합니다.

- Rust (MSVC 툴체인)
- Microsoft C++ Build Tools ("Desktop development with C++")

공식 안내: `https://v2.tauri.app/start/prerequisites/`

## 실행 방법

```bash
npm install
npm run tauri dev
```

## 로고 파일

- 기본 스탬프 로고: `assets/logo.png` (기본)
- 보조 스탬프 로고: `assets/logo.webp` (fallback/호환용)
- 프론트 헤더 아이콘: `public/icon.png`
- 번들 포함 리소스 매핑: `src-tauri/tauri.conf.json`의 `bundle.resources`

## Git 무시 항목(.gitignore)

릴리즈 산출물/의존성 캐시는 저장소에 올리지 않도록 아래 항목을 유지하세요.

- `node_modules/`
- `dist/`
- `src-tauri/target/`
