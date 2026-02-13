# 릴리즈 QA 체크리스트

CornerBrand 태그 릴리즈(`vX.Y.Z`) 직후, 아래 항목만 빠르게 확인합니다.

## 1) GitHub Actions

- 릴리즈 태그 워크플로우가 `success` 상태인지 확인

## 2) 릴리즈 자산 확인

- 릴리즈에 아래 파일이 모두 있는지 확인
  - `.exe`
  - `.msi`
  - `.sig`
  - `latest.json`
  - `checksums.txt`

## 3) Updater 엔드포인트 확인

- `releases/latest/download/latest.json` URL이 정상 응답하는지 확인

## 4) Updater 스모크 테스트 (Windows)

- 설치된 앱에서 업데이트 확인 실행
- 업데이트 설치 시작 시 앱이 종료되고 설치가 진행되는지 확인
- 설치 완료 후 앱 재실행 확인

## 5) 앱 기능 스모크 테스트

- 샘플 파일(이미지/PDF) 선택
- 스탬프 실행
- 결과 파일이 정상 생성되는지 확인
