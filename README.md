# Media Vault

`Media Vault`는 로컬 폴더 안의 이미지와 영상을 빠르게 탐색하고, 미리보기하고, 이름 변경 및 삭제까지 처리할 수 있는 Tauri 기반 데스크톱 앱입니다. 웹 브라우저가 아닌 데스크톱 런타임에서 동작하므로 로컬 파일 경로 접근이 필요한 미디어 관리 시나리오에 적합합니다.

## 주요 기능

- 루트 폴더 선택 후 하위 디렉터리까지 재귀적으로 미디어 스캔
- 이미지와 영상 통합 목록 조회
- 검색, 타입 필터, 정렬
- 중앙 미리보기 패널에서 선택 항목 즉시 확인
- 영상 썸네일 미리보기 및 재생, 음소거 토글
- 전체 화면 뷰어
- 이미지 전체 화면 줌 인/아웃, 휠 줌, 드래그 이동, 배율 초기화
- 파일 이름 변경
- 파일 삭제
- 대용량 목록 대응을 위한 가상 스크롤 렌더링

## 지원 확장자

- 이미지: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.svg`, `.avif`
- 영상: `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`, `.avi`, `.wmv`

## 기술 스택

- Frontend: React 19, TypeScript 5, Vite 7
- UI: Tailwind CSS 4
- Desktop Runtime: Tauri 2
- Backend: Rust 2021
- Native Folder Picker: `rfd`
- Filesystem Traversal: `walkdir`

## 개발 스펙

- 3단 레이아웃
- 좌측: 폴더 선택, 검색, 필터, 정렬, 미디어 목록
- 중앙: 선택 미디어 미리보기, 이전/다음 이동, 전체 화면 진입
- 우측: 파일 메타데이터, 이름 변경, 삭제
- 키보드 이동 지원: `Arrow` 키
- 전체 화면 단축키
- `Esc`: 전체 화면 닫기
- `+`, `-`, `0`: 이미지 확대, 축소, 초기화

## 프로젝트 구조

```text
.
├─ src/                # React 프론트엔드
│  ├─ App.tsx          # 메인 UI와 상호작용 로직
│  ├─ main.tsx         # 앱 엔트리
│  └─ styles.css       # Tailwind 진입점
├─ src-tauri/          # Tauri / Rust 백엔드
│  ├─ src/lib.rs       # 폴더 선택, 스캔, 이름 변경, 삭제 명령
│  ├─ src/main.rs      # 데스크톱 실행 엔트리
│  └─ tauri.conf.json  # 앱 메타데이터 및 빌드 설정
├─ public/             # 정적 에셋
└─ README.md
```

## 실행 방법

### 1. 사전 준비

- Node.js 20 이상 권장
- Rust / Cargo 설치
- Windows에서는 `cargo`가 PATH에 포함되어 있어야 `tauri dev`가 정상 동작합니다.

### 2. 의존성 설치

```bash
npm install
```

### 3. 웹 개발 서버 실행

```bash
npm run dev:web
```

브라우저 미리보기는 가능하지만, 로컬 파일 경로 접근 제약이 있어 실제 사용은 데스크톱 실행을 권장합니다.

### 4. 데스크톱 앱 실행

```bash
npm run dev:desktop
```

또는 배치 파일로 실행:

```bat
run-dev-desktop.bat
```

### 5. 프로덕션 빌드

웹 프론트엔드 빌드:

```bash
npm run build
```

Tauri 데스크톱 빌드:

```bash
npm run build:desktop
```

또는 배치 파일로 빌드:

```bat
build-release.bat
```

## EXE로 실행하려면

개발 모드가 아니라 배포용 실행 파일로 쓰고 싶다면 한 번만 릴리스 빌드를 만들면 됩니다.

```bat
build-release.bat
```

빌드가 끝나면 아래 EXE를 직접 실행할 수 있습니다.

```text
src-tauri\target\release\tauri-app.exe
```

더 편하게 실행하려면 아래 배치 파일을 사용하면 됩니다.

```bat
run-release.bat
```

정리하면:

- `run-dev-desktop.bat`: 개발 모드 실행, 소스 수정 자동 반영
- `build-release.bat`: 배포용 EXE / 설치 파일 생성
- `run-release.bat`: 이미 빌드된 EXE 실행

## 설치형으로 배포하려면

Tauri는 Windows에서 설치형 패키지를 함께 생성합니다. `npm run build:desktop` 또는 `build-release.bat` 실행 후 아래 폴더를 확인하면 됩니다.

```text
src-tauri\target\release\bundle\
```

일반적으로 이 안에 다음과 같은 결과물이 생성됩니다.

- `msi`: Windows 설치 파일
- `nsis`: 설치 마법사 형태의 실행 파일

즉, GitHub에 올릴 때는 보통 소스는 저장소에 올리고, 설치 파일은 릴리스 첨부 파일로 올립니다.

추천 방식:

1. 소스 코드는 현재 저장소 `main` 브랜치에 유지
2. `build-release.bat` 실행
3. `src-tauri\target\release\bundle\` 아래 생성된 설치 파일 확인
4. GitHub 저장소의 `Releases`에서 버전 태그를 만들고 `.msi` 또는 설치용 `.exe` 업로드

## GitHub에 간단히 올리는 방법

소스와 설치 파일은 분리하는 편이 가장 깔끔합니다.

- Git 저장소: 소스코드, README, 설정 파일
- GitHub Release: 최종 사용자용 설치 파일

이유:

- 설치 파일은 용량이 커서 Git 이력 관리에 불리함
- 버전별 배포 파일 관리가 쉬움
- 사용자는 소스 대신 설치 파일만 받아 바로 설치 가능

## Tauri 명령 구성

Rust 백엔드에서는 아래 기능을 Tauri command로 제공합니다.

- `pick_root_folder`: 루트 폴더 선택
- `scan_media_folder`: 미디어 스캔
- `rename_media_file`: 파일 이름 변경
- `delete_media_file`: 파일 삭제

## Git 업로드 전 참고

- `node_modules/`, `dist/`, 로그 파일은 Git 제외 대상입니다.
- `src-tauri/target/`은 `src-tauri/.gitignore`에서 제외됩니다.
- 저장소에 올릴 때는 `README.md`, `src/`, `src-tauri/`, 설정 파일 중심으로 관리하면 됩니다.

## 향후 확장 아이디어

- 즐겨찾기 또는 태그 기능
- 다중 선택 일괄 작업
- 썸네일 캐싱
- 휴지통 이동 기반 삭제 옵션
- EXIF / 메타데이터 상세 보기
