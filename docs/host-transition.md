# BearHomeBot PC와 호스트 전환

## 원칙

동일한 Telegram bot token은 한 번에 한 PC에서만 long polling한다. 새
PC를 활성화하기 전에 기존 PC의 gateway를 먼저 종료한다.

Git으로 이동하는 항목:

- BearHomeBot 소스와 문서

각 PC에서 따로 준비하는 항목:

- Codex CLI 설치와 로그인
- Telegram bot token과 allowlist
- BearHomeBot SQLite와 Codex session
- 프로젝트 내부의 `k-skill/` checkout
- `~/.config/k-skill/secrets.env`

## 개발 PC에서 이어서 작업

기존 PC:

```bash
npm run ci
git status
git add <의도한 파일>
git commit -m "<변경 내용>"
git push origin main
```

새 PC:

```bash
git clone https://github.com/bshsqa/BearHomeBot.git
cd BearHomeBot

# 이미 clone했다면
git pull --ff-only origin main

./scripts/doctor.sh
./scripts/install.sh
codex login
codex login status
```

`install.sh`가 `k-skill/`을 준비한다. 필요하면 별도로 갱신한다.

```bash
./scripts/sync-k-skill.sh
```

## Telegram 호스트 전환

기존 호스트에서:

```text
/shutdown
```

소유자 계정으로 종료 버튼을 누른다. Telegram을 사용할 수 없는 경우에만
기존 호스트의 터미널에서 다음 명령을 실행한다.

```bash
./scripts/stop.sh
pgrep -af '[d]ist/telegram-main.js'
```

두 번째 명령에 출력이 없어야 한다.

새 호스트에서:

```bash
git pull --ff-only origin main
./scripts/install.sh
codex login status

./scripts/configure-telegram.sh
./scripts/allow-telegram-user.sh <Telegram 숫자 ID>
./scripts/start-telegram.sh
```

첫 번째로 등록한 허용 사용자가 새 호스트의 소유자가 된다. 기존 호스트와
새 호스트의 로컬 설정은 서로 복사하지 않으므로, 새 호스트에서도 같은
사용자 ID를 먼저 등록한다.

휴대폰에서 확인한다.

```text
/health
/whoami
/features
/shutdown을 열고 취소 버튼 확인
/newsession 전환 테스트
k-skill에는 어떤 기능들이 있어?
/sessions
```

`/health`의 호스트 이름이 새 PC인지 확인한다.

## 같은 PC 재시작

같은 PC에서는 설정을 다시 만들지 않는다.

```bash
cd BearHomeBot
git pull --ff-only origin main
./scripts/sync-k-skill.sh
npm run build
codex login status
./scripts/start-telegram.sh
```

기존 Telegram allowlist, SQLite session과 로컬 Codex thread가 남아 있어
다음 메시지에서 기존 대화를 resume할 수 있다.

## 데이터 이전

기본 절차는 session과 credential을 PC 사이에서 복사하지 않는다. 새
PC에서는 새 Codex login과 새 session을 만들고, 필요한 서비스 credential은
`~/.config/k-skill/secrets.env`에 다시 설정한다.

소스 작업은 Git commit으로만 넘긴다. `.runtime`, `k-skill/`, SQLite,
Telegram token, secrets 파일 또는 `~/.codex`를 Git에 추가하지 않는다.
