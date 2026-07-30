# BearHomeBot PC와 호스트 전환

## 원칙

BearHomeBot에서 Git으로 이동하는 것은 source code, test, version-controlled
policy와 문서뿐이다. 다음 항목은 각 PC에서 새로 만든다.

- Codex CLI 로그인과 local thread
- Telegram bot token 설정
- Telegram allowlist bootstrap 설정
- BearHomeBot SQLite와 `/sessions`
- `k-skill` mirror, validation cache와 active release
- 향후 추가할 사용자별 service credential

가족이 사용하는 동일 Telegram bot token의 gateway는 한 번에 한 PC에서만
실행한다. 현재 구현에는 PC 사이의 distributed lock이나 leader election이
없다. 개발 PC에서 실제 봇을 시험해야 하면 운영 gateway를 먼저 끄거나,
별도의 개발용 Telegram bot을 사용한다.

## 역할

### 개발 PC

코드 작성, test, commit과 push를 담당한다. 실제 가족용 Telegram gateway는
기본적으로 실행하지 않는다. 여러 개발 PC는 Git commit을 통해서만 작업을
주고받는다.

### 활성 Telegram 호스트

가족용 bot token으로 long polling을 수행하는 유일한 PC다. 수동 개발
단계에서는 foreground process로 실행하고, Phase 8 이후에는 운영 미니
PC의 systemd service가 이 역할을 고정해서 맡는다.

### 운영 미니 PC

검증된 Git commit을 새로 clone하고 local credential과 runtime을
구성한다. 개발 PC의 database, Codex home, session 또는 login 파일을
복사하지 않는다.

## 개발 PC 전환

완료된 작업을 다른 PC에서 이어갈 때 source PC에서 실행한다.

```bash
cd BearHomeBot
npm run ci
git status
git add <의도한 파일>
git commit -m "<변경 내용>"
git push origin main
```

작업이 아직 완료되지 않아 `main`에 넣을 수 없다면 local stash에만
남기지 않는다. topic branch에 checkpoint commit을 만들고 push한다.

```bash
git switch -c work/<작업이름>
git add <의도한 파일>
git commit -m "WIP: <현재 상태>"
git push -u origin work/<작업이름>
```

대상 개발 PC에서는 다음과 같이 시작한다.

```bash
git clone https://github.com/bshsqa/BearHomeBot.git
cd BearHomeBot

# 이미 clone되어 있다면
git switch main
git pull --ff-only origin main

./scripts/doctor.sh
./scripts/install.sh
codex login
codex login status
```

topic branch를 이어갈 때는 clone 후 해당 branch를 checkout한다.

```bash
git fetch origin
git switch --track origin/work/<작업이름>
```

새 Codex thread에는 다음 시작 요청을 사용한다.

```text
BearHomeBot 저장소의 AGENTS.md와 거기서 지정한 문서, 최근 Git 이력을
읽어줘. 현재 checkout된 commit과 테스트 상태를 확인하고,
docs/implementation-plan.md의 바로 다음 작업부터 이어서 진행해줘.
```

Codex가 `AGENTS.md`를 자동으로 읽더라도 현재 branch, 최신 commit,
test 결과를 확인하도록 위 요청을 명시하는 것이 좋다.

## Telegram 호스트 전환

### 1. Source code 확정

source 개발 PC에서 변경을 검증하고 push한다. 대상 PC에서 사용할 commit
SHA를 기록한다.

```bash
npm run ci
git status
git rev-parse HEAD
git push origin main
```

dirty worktree나 push되지 않은 commit으로 운영 host를 전환하지 않는다.

### 2. 기존 gateway 종료

기존 gateway가 foreground terminal에서 실행 중이면 `Ctrl+C`로 종료한다.
systemd service가 설치된 이후에는 다음 명령을 사용한다.

```bash
./scripts/stop.sh
```

프로세스가 남아 있지 않은지 확인한다. 아무 출력도 없어야 한다.

```bash
pgrep -af '[d]ist/telegram-main.js'
```

기존 gateway 종료를 확인하기 전에는 대상 PC에서 같은 bot token으로
gateway를 시작하지 않는다.

### 3. 대상 PC fresh setup

대상 PC에서 repository와 필수 runtime을 준비한다.

```bash
git clone https://github.com/bshsqa/BearHomeBot.git
cd BearHomeBot

# 이미 clone되어 있다면
git switch main
git pull --ff-only origin main

./scripts/doctor.sh
./scripts/install.sh

codex login
codex login status

./scripts/configure-telegram.sh
./scripts/allow-telegram-user.sh <Telegram 숫자 user ID>
```

가족이 여러 명이면 각 숫자 user ID를 같은 명령으로 추가한다. token과
user ID 설정은 Git에 넣지 않는다.

`install.sh`는 rootless Podman validator image도 빌드한다. 환경 검증 후
현재 `k-skill` 후보를 실행 없이 검사할 수 있다.

```bash
./scripts/k-skill-updater.sh check
```

### 4. 새 gateway 활성화

기존 PC가 완전히 정지한 후 대상 PC에서 실행한다.

```bash
./scripts/start-telegram.sh
```

수동 단계에서는 이 terminal을 열어 둔다. 휴대폰에서 순서대로 확인한다.

```text
/health
/whoami
안녕 BearHomeBot
/sessions
```

fresh setup이므로 기존 PC의 `/sessions`와 Codex 문맥은 나타나지 않는다.
첫 일반 메시지 또는 `/newsession`으로 새 local Codex thread를 만든다.

### 5. 전환 실패 시 rollback

대상 PC의 gateway를 먼저 종료하고 프로세스가 없는지 확인한 다음, 이전
PC의 gateway를 다시 시작한다. 두 PC를 동시에 켜서 장애를 우회하지
않는다.

이전 PC의 local database와 Codex thread를 삭제하지 않았다면 그 PC의
기존 session은 그대로 남아 있다. 대상 PC에서 새로 만든 session과는
서로 독립적이다.

## 권장 이동 순서

프로젝트가 운영 미니 PC에 정착하기 전까지는 다음 흐름을 사용한다.

```text
현재 개발 PC
  -> commit과 push
집 메인 개발 PC
  -> pull, fresh Codex login/thread, 개발과 검증
  -> commit과 push
운영 미니 PC
  -> pull, fresh local setup
  -> 유일한 가족용 Telegram gateway 실행
```

운영 미니 PC가 활성화된 뒤에는 개발 PC에서 가족용 gateway를 실행하지
않는다. Telegram 왕복 test가 필요하면 별도 개발 bot token을 사용한다.
