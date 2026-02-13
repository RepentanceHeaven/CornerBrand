# Windows 패키징/릴리즈 가이드

이 문서는 CornerBrand의 Windows 배포 파일을 만들고, GitHub에 업로드할 때의 기준을 정리합니다.

자동 업데이트(Updater) 전용 설정/배포 절차는 `docs/auto-update.md`를 함께 참고하세요.
태그 릴리즈 직후 검증 절차는 `docs/release-qa.md`를 참고하세요.

## 1) 사전 준비

- Node.js LTS, npm
- Rust (MSVC 툴체인)
- Microsoft C++ Build Tools (`Desktop development with C++`)
- (권장) PowerShell 또는 Git Bash 최신 버전

## 2) 빌드/패키징 명령

프로젝트 루트에서 아래 순서로 실행합니다.

```bash
npm install
npm run build
cd src-tauri
cargo test
cd ..
npm run tauri build
```

참고:
- `npm run build`: 프론트엔드 번들 생성
- `cargo test`: Rust 로직 테스트 검증
- `npm run tauri build`: Windows 설치 파일 생성 (현재 `bundle.targets: "all"`)

## 3) 산출물 위치

주요 Windows 설치 산출물은 아래 경로에서 확인합니다.

- NSIS 설치 파일: `src-tauri/target/release/bundle/nsis/*.exe`
- WiX MSI 설치 파일: `src-tauri/target/release/bundle/msi/*.msi`

환경/설정에 따라 추가 산출물이 생성될 수 있으나, GitHub 릴리즈 업로드 기준 파일은 위 2종을 기본으로 사용합니다.

## 4) 릴리즈 체크리스트 (간단)

- `npm run build` 성공
- `src-tauri`에서 `cargo test` 성공
- 기본/보조 스탬프 로고 확인: `assets/logo.png`(기본), `assets/logo.webp`(보조)
- 프론트 헤더 아이콘 확인: `public/icon.png`
- 리소스 번들 매핑 확인: `src-tauri/tauri.conf.json`의 `bundle.resources`
- Windows 설치 언어 설정 확인 (WiX `ko-KR`)
- 설치 파일 실행 테스트(최소 1회): 설치/실행/제거

## 5) GitHub 업로드 기준

릴리즈 태그 기준으로 아래 규칙을 적용합니다.

- 업로드 필수: `*.exe`(NSIS), `*.msi`(WiX)
- 파일명에 버전이 포함된 기본 산출물 우선 사용 (수동 rename 지양)
- 디버그/중간 산출물(`target` 내부 임시 파일, 로그 등) 업로드 금지
- 체크섬(예: SHA256)과 간단한 변경 요약을 릴리즈 본문에 함께 기재

예시 릴리즈 본문 항목:
- 버전: `v0.1.0`
- 포함 파일: NSIS EXE 1개, MSI 1개
- 검증: `npm run build`, `cargo test` 통과
