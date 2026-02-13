# 자동 업데이트 릴리즈 가이드

이 문서는 CornerBrand의 Tauri Updater 배포 절차를 정리합니다. 현재 업데이트 메타데이터 엔드포인트는 아래 주소를 사용합니다.

- `https://github.com/RepentanceHeaven/CornerBrand/releases/latest/download/latest.json`

서명 키 백업/로테이션 절차는 `docs/signing-keys.md`를 참고하세요.

`src-tauri/tauri.conf.json`의 updater 설정(`plugins.updater.endpoints`)과 동일해야 하며, 릴리즈 자동화 워크플로(`.github/workflows/release.yml`)도 이 구조를 기준으로 동작합니다.

## 1) 서명 키 준비

Updater 아티팩트(`latest.json`, `.sig`) 생성을 위해 서명 키가 필요합니다.

- 개인 키 파일 예시 경로: `%USERPROFILE%\\.tauri\\cornerbrand.key`
- GitHub Secrets 필수 항목:
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (키 생성 시 비밀번호를 설정한 경우에만)

권장 방식:
- 개인 키 파일 내용을 `TAURI_SIGNING_PRIVATE_KEY`에 그대로 저장
- 비밀번호가 있으면 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`에 저장

## 2) 버전/태그 릴리즈 절차

자동 배포는 태그 기반으로 동작합니다.

1. 버전 올리기
   - `package.json`의 `version`
   - `src-tauri/tauri.conf.json`의 `version`
2. 변경사항 커밋 후 원격 저장소에 푸시
3. 릴리즈 태그 생성/푸시 (`vX.Y.Z` 형식)
   - 예: `v0.2.0`
4. GitHub Actions가 Windows 빌드를 수행하고 Public Release를 자동 공개

## 3) 워크플로 결과물

태그 푸시 후 `.github/workflows/release.yml`이 생성하는 주요 산출물:

- Windows 설치 파일 (`.exe`, `.msi`)
- Updater 메타데이터 (`latest.json`)
- Updater 서명 파일 (`.sig`)

즉, `vX.Y.Z` 태그만 푸시하면 GitHub Actions가 공개 릴리즈를 자동으로 만들고, 설치 파일(`.exe`, `.msi`)과 `latest.json`, `.sig`까지 함께 게시됩니다.
앱의 자동 업데이트는 공개된 릴리즈의 `latest.json`을 기준으로 배포됩니다.
