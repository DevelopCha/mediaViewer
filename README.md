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

### 5. 프로덕션 빌드

웹 프론트엔드 빌드:

```bash
npm run build
```

Tauri 데스크톱 빌드:

```bash
npm run build:desktop
```

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
