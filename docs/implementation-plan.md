# BearHomeBot Implementation Plan

## 1. 목표

BearHomeBot은 집의 Ubuntu PC에서 Codex CLI를 실행하고, 가족이 Telegram을
통해 같은 Codex 기능을 사용할 수 있게 한다.

핵심 경험은 단순하다.

```text
Telegram으로 자연어 요청
  -> 현재 사용자 Codex session
  -> 프로젝트 안에서 일반 Codex 실행
  -> 관련 k-skill이 있으면 Codex가 직접 발견하고 사용
  -> 없으면 일반 Codex 방식으로 처리
  -> 최종 답변을 Telegram으로 전송
```

스킬 이름을 미리 분류하거나, 기능 catalog를 prompt에 삽입하거나, 별도
broker가 작업을 대행하지 않는다. Codex가 로컬 CLI에서 하던 탐색과 실행을
Telegram에서도 그대로 수행하는 것이 기준이다.

## 2. 범위

현재 지원 범위:

- Ubuntu 24.04 이상
- 최대 5명의 허용된 Telegram 사용자
- 사용자별 여러 Codex session
- `/features` 카테고리와 세부 기능 안내 메뉴
- 같은 사용자 요청의 순차 처리
- 서로 다른 사용자 요청의 제한된 병렬 처리
- 프로젝트 내부 `k-skill/` checkout 탐색과 helper 실행
- `~/.config/k-skill/secrets.env`를 사용하는 인증 스킬
- Codex가 지원하는 일반 조사, 파일 작업, 명령 실행과 네트워크 사용

현재 범위 밖:

- 여러 PC에서 동일 Telegram bot의 동시 운영
- Telegram 사용자별 Linux 계정 또는 파일 권한 분리
- 스킬 승인 allowlist, 사전 코드 검토, release 승격
- 별도 encrypted credential vault
- 사용자 요청을 스킬별로 분류하는 router
- 자동 결제 또는 스킬이 금지한 irreversible action

## 3. 구조

```text
Telegram Bot API
       |
       v
Telegram Gateway
       |
       +---- numeric user ID allowlist
       +---- update deduplication
       |
       v
Per-user Queue
       |
       v
Session Manager
       |
       +---- new: codex exec
       +---- existing: codex exec resume <thread ID>
       |
       v
BearHomeBot project root
       |
       +---- AGENTS.md
       +---- k-skill/<skill>/SKILL.md
       +---- k-skill/scripts/*
       +---- ordinary Codex tools
```

Codex child는 Telegram 원문을 stdin으로 받고
`--dangerously-bypass-approvals-and-sandbox`로 실행된다. 별도 빈 workspace,
read-only profile, catalog prompt 또는 고정 모델 설정을 사용하지 않는다.

## 4. k-skill 운영

`k-skill/`은 BearHomeBot 작업공간 안에 있지만 BearHomeBot Git에서는
제외한다. fresh clone에서는 다음 명령으로 준비한다.

```bash
./scripts/sync-k-skill.sh
```

동작:

- checkout이 없으면 upstream `main` clone
- checkout이 있으면 `git pull --ff-only origin main`
- 로컬 변경이 있으면 중단
- 검토, 재패키징, allowlist 생성 없이 checkout을 그대로 사용

Codex의 표준 프로젝트 지침인 `AGENTS.md`가 관련 스킬 탐색, `SKILL.md`
읽기, k-skill root에서 helper 실행, dependency 준비와 credential
resolution을 안내한다. 개별 Telegram 메시지에는 이 정보를 덧붙이지 않는다.

## 5. credential

인증 스킬은 k-skill이 정한 기본 fallback을 사용한다.

```text
~/.config/k-skill/secrets.env
```

파일은 host-local이며 mode `0600`으로 둔다. Codex는 관련 스킬이 필요할
때 직접 읽어 helper 환경변수로 사용할 수 있다. BearHomeBot은 값을 별도
DB로 복사하거나 암호화·복호화하지 않는다.

## 6. session

- 사용자는 `/newsession [이름]`으로 새 thread를 시작한다.
- `/sessions`에서 자신의 session만 보고 선택한다.
- `/renamesession`은 표시 이름만 바꾼다.
- `/endsession`은 active association만 해제한다.
- `/cancel`은 현재 실행 중인 Codex child를 종료한다.
- active session이 없으면 첫 일반 메시지로 session을 자동 생성한다.
- SQLite에는 thread ID와 metadata만 저장한다.
- 대화 원문, 답변 원문과 compaction은 Codex가 관리한다.

## 7. 구현 단계

### Phase 1: Telegram gateway

상태: 완료

- private chat과 숫자 user ID allowlist
- long polling과 update deduplication
- Telegram message 분할과 callback 처리
- `/features`, `/health`, `/whoami`

### Phase 2: Codex session

상태: 완료

- `codex exec`와 `codex exec resume`
- 사용자별 session 소유권
- session 생성, 목록, 선택, 이름 변경, 종료
- 사용자별 순차 queue와 전역 병렬 제한
- timeout과 `/cancel`

### Phase 3: 직접 k-skill workspace

상태: 완료

- Codex working directory를 BearHomeBot root로 고정
- Telegram 메시지를 wrapper 없이 그대로 전달
- `k-skill/` clone/pull 스크립트
- 프로젝트 지침을 통한 스킬 자동 탐색
- host environment와 secrets fallback 사용
- 불필요한 스킬 catalog와 중간 실행 계층 없이 helper 직접 실행

### Phase 4: 운영 서비스

상태: 다음 단계

- systemd user service 설치 스크립트
- 로그인 또는 재부팅 후 자동 시작
- 정상 종료와 restart policy
- host label, 시작 시각과 현재 버전을 포함한 상태 확인
- journald 로그 확인 명령

### Phase 5: 가족 운영

상태: 예정

- 최대 5명 동시 사용 부하 테스트
- 사용자별 queue 상태와 timeout 안내 개선
- 장시간 작업의 진행 상태 응답
- 별도 개발 bot과 운영 bot 전환 절차
- 선택적 일일 `k-skill` fast-forward sync timer

## 8. 완료 기준

- Telegram에서 “k-skill에 뭐가 있어?”라고 물으면 Codex가 실제
  `k-skill/` checkout을 탐색해 답한다.
- `/features`에서는 여섯 카테고리와 61개 주요 기능을 버튼으로 탐색한다.
- 특정 스킬을 참고해 작업해 달라고 하면 관련 `SKILL.md`와 helper를
  사용한다.
- KTX처럼 credential이 준비된 스킬은 secrets fallback을 이용해 조회와
  스킬이 허용한 예약 단계까지 수행한다.
- 관련 스킬이 없으면 일반 Codex 답변이나 도구 사용으로 처리한다.
- session 전환과 재시작 후 resume가 기존과 동일하게 동작한다.
- fresh clone에서 문서의 명령만으로 같은 구조를 재현할 수 있다.

## 9. 바로 다음 작업

다음 구현은 Phase 4의 최소 systemd 운영 서비스다.

1. `install-service.sh`와 `uninstall-service.sh`를 만든다.
2. gateway가 프로젝트의 Node 24와 Codex PATH를 안정적으로 찾게 한다.
3. 재부팅 후 자동 시작과 실패 시 제한된 restart를 검증한다.
4. `/health`에 host label, service 시작 시각과 commit을 표시한다.
5. 운영·중지·로그 확인 절차를 README에 추가한다.
