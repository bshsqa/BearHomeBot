# BearHomeBot

BearHomeBot은 Telegram 메시지를 이 컴퓨터의 Codex CLI로 전달하고 최종
답변을 다시 Telegram으로 보내는 가벼운 Ubuntu 서비스다.

Codex는 BearHomeBot 프로젝트 루트에서 실행된다. 프로젝트 안의
`k-skill/` checkout을 직접 탐색하고, 요청에 맞는 `SKILL.md`와 helper가
있으면 사용한다. 해당 기능이 없으면 평소 Codex처럼 조사하거나 답변한다.
별도의 스킬 catalog, 사전 분류기, allowlist 또는 전용 실행 broker는 없다.

## 동작 구조

```text
허용된 Telegram 사용자
        |
        v
Telegram long polling
        |
        v
사용자별 queue와 Codex session
        |
        v
codex exec / codex exec resume
working directory: BearHomeBot/
permissions: unrestricted, no interactive approval
        |
        +---- k-skill/<skill>/SKILL.md
        +---- k-skill/scripts/*
        +---- ~/.config/k-skill/secrets.env
        |
        v
Telegram 최종 답변
```

일반 Telegram 메시지는 추가 지시문이나 catalog를 붙이지 않고 그대로
Codex stdin으로 전달된다. `AGENTS.md`가 프로젝트 내 `k-skill` 사용법을
Codex의 표준 프로젝트 지침으로 제공한다.

## 요구 환경

- Ubuntu 24.04 이상
- Node.js 24
- Python 3.10 이상
- Git
- 로그인된 Codex CLI
- `Asia/Seoul` 시간대

## 최초 설치

```bash
git clone https://github.com/bshsqa/BearHomeBot.git
cd BearHomeBot

./scripts/doctor.sh
./scripts/install.sh

codex login
./scripts/configure-telegram.sh
./scripts/start-telegram.sh
```

휴대폰에서 `/whoami`로 숫자 사용자 ID를 확인한 다음 gateway를 멈추고
사용자를 등록한다.

```bash
./scripts/allow-telegram-user.sh <Telegram 숫자 ID>
./scripts/start-telegram.sh
```

`install.sh`는 BearHomeBot 의존성을 설치하고 `k-skill/`이 없으면
`NomaDamas/k-skill`을 clone한다. 이미 있으면 fast-forward pull만 한다.

## k-skill

`k-skill/`은 BearHomeBot Git에는 포함하지 않지만 Codex 작업공간 안에
일반 checkout으로 둔다.

```bash
./scripts/sync-k-skill.sh
```

이 명령은 복잡한 검토나 승격 절차 없이 `main`을 직접 clone 또는
`git pull --ff-only` 한다. checkout에 로컬 변경이 있으면 덮어쓰지 않고
중단한다.

Codex는 요청을 받으면 필요에 따라 다음 순서로 동작한다.

1. `k-skill/`에서 관련 스킬을 찾는다.
2. 관련 `SKILL.md`를 읽는다.
3. `k-skill/`을 작업 디렉터리로 helper를 실행한다.
4. 필요한 패키지가 없으면 설치하거나 로컬 실행환경을 만든다.
5. 스킬을 사용할 수 없으면 일반 Codex 방식으로 답한다.

인증 정보가 필요한 스킬은 k-skill의 기본 경로를 그대로 사용한다.

```text
~/.config/k-skill/secrets.env
```

예를 들어 KTX 스킬은 파일의 `KSKILL_KTX_ID`와
`KSKILL_KTX_PASSWORD`를 helper 실행 직전에 환경변수로 불러올 수 있다.
인증 값을 Telegram 메시지나 BearHomeBot 저장소에 넣지 않는다.

## Telegram 명령

```text
/newsession [이름]       새 Codex 대화를 만들고 선택
/sessions                내 대화 목록과 전환 버튼 표시
/renamesession <이름>    현재 대화 이름 변경
/endsession              현재 대화에서 나오기
/cancel                  진행 중인 Codex 작업 취소
/features                기능 카테고리와 세부 기능 보기
/health                  gateway와 실행 호스트 확인
/whoami                  Telegram 숫자 사용자 ID 확인
```

`/features`는 여섯 개 카테고리 버튼을 보여준다. 카테고리를 누르면 관련
스킬 이름, 용도와 주요 제약이 나오고 다시 카테고리 목록으로 돌아갈 수
있다. 이 메뉴는 기능 안내만 담당하며, 실제 요청은 일반 메시지로 Codex에
전달된다.

선택된 세션이 없으면 첫 일반 메시지에서 새 세션을 자동 생성한다. 대화
문맥과 compaction은 Codex thread가 관리하고, SQLite에는 사용자 소유권,
thread ID, 표시 이름, turn 상태만 저장한다.

## 실행 권한

BearHomeBot은 허용된 Telegram 사용자의 요청을 다음 옵션으로 실행한다.

```text
codex exec --dangerously-bypass-approvals-and-sandbox
```

따라서 허용된 사용자는 Codex를 통해 이 컴퓨터의 파일, 명령, 네트워크와
로그인된 서비스에 접근할 수 있다. Telegram allowlist에는 이 컴퓨터의
셸 권한을 맡겨도 되는 사람만 등록한다. Telegram bot token 자체는 Codex
child 환경에서 제거한다.

## 업데이트와 재시작

```bash
git pull --ff-only origin main
./scripts/sync-k-skill.sh
./scripts/install.sh
./scripts/start-telegram.sh
```

같은 PC에서는 Telegram 설정, SQLite, Codex login과 session이 유지된다.
다른 PC로 옮기는 절차는 [호스트 전환 문서](docs/host-transition.md)를
따른다.

## 개발

```bash
npm run lint
npm test
npm run build
npm run format:check
npm run ci
```

로컬 상태는 Git 밖에 둔다.

```text
~/.config/bearhomebot/telegram.env
~/.local/share/bearhomebot/state.sqlite
~/.codex/
~/.config/k-skill/secrets.env
BearHomeBot/k-skill/
BearHomeBot/.runtime/
```
