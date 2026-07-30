# BearHomeBot

BearHomeBot은 승인된 Telegram 사용자의 요청을 Codex CLI와 검증된
`k-skill` 실행으로 연결하는 Ubuntu 기반 홈 자동화 서비스입니다.

현재 단계에서는 Telegram과 Ubuntu PC 사이의 전송 경로만 테스트합니다.
Codex, `k-skill`, 사용자별 서비스 계정은 아직 연결하지 않았으며, 모든
런타임 설정은 저장소 밖의 전용 경로를 사용합니다.

## 기준 환경

- Ubuntu 24.04 LTS 이상
- Node.js 24 LTS
- Python 3.10 이상
- Codex CLI
- rootless Podman
- systemd
- `Asia/Seoul` 시간대

Node.js 24는 프로젝트 루트의 `.nvmrc`에 고정되어 있습니다.

## 시작하기

저장소를 clone한 직후에는 먼저 환경 진단을 실행합니다.

```bash
./scripts/doctor.sh
```

`doctor.sh`는 시스템을 변경하지 않습니다. Ubuntu 버전, 시간대, 필수
명령, 저장 공간, systemd, Git ignore 상태를 검사하고 `PASS`, `WARN`,
`FAIL`로 결과를 출력합니다.

모든 필수 검사가 통과한 환경에서는 다음 명령으로 의존성을 설치하고
프로젝트를 검증합니다.

```bash
./scripts/install.sh
```

현재 앱 골격의 health 출력을 확인하려면 다음을 실행합니다.

```bash
./scripts/start.sh --health
```

## Telegram 연결 테스트

현재 Telegram 기능은 Codex나 `k-skill`을 호출하지 않는 전송 경로
테스트입니다. private chat에서 사용자 ID와 health를 확인하고, 승인된
사용자의 일반 텍스트를 Ubuntu PC가 수신했음을 응답합니다.

1. Telegram의 공식 `@BotFather`에게 `/newbot`을 보내 봇을 만들고 토큰을
   발급받습니다.
2. 토큰을 채팅이나 저장소에 붙이지 말고 로컬 설정 명령에 입력합니다.

```bash
./scripts/configure-telegram.sh
npm run build
./scripts/start-telegram.sh
```

3. 휴대폰에서 만든 봇에게 `/whoami`를 보내 숫자 사용자 ID를 확인합니다.
4. 봇을 `Ctrl+C`로 멈추고 해당 ID를 로컬 allowlist에 추가합니다.

```bash
./scripts/allow-telegram-user.sh <숫자 사용자 ID>
./scripts/start-telegram.sh
```

승인된 뒤에는 `/health`와 일반 텍스트 메시지에 응답합니다. 그룹,
채널, 사진, 파일은 이 단계에서 처리하지 않습니다.

Telegram 토큰은 임시 bootstrap 저장소인
`~/.config/bearhomebot/telegram.env`에 mode `0600`으로 저장됩니다.
Secret Broker가 구현되면 암호화 vault로 이전할 예정입니다.

## 개발 명령

```bash
npm run doctor
npm run lint
npm test
npm run build
npm run ci
```

## 저장 위치

BearHomeBot은 실제 운영 상태를 Git checkout에 저장하지 않습니다.
환경변수로 재정의하지 않으면 다음 XDG 경로를 사용합니다.

```text
~/.config/bearhomebot
~/.local/share/bearhomebot
~/.cache/bearhomebot
```

개발용 임시 상태는 Git에서 제외된 `.runtime/`만 사용할 수 있습니다.
실제 사용자 비밀정보는 아직 지원하지 않으며, Secret Broker가 구현되기
전에는 이 프로젝트에 입력하지 않습니다.

Telegram 전송 테스트에 한해 봇 토큰을 별도의 `0600` 로컬 파일에
보관합니다. 이 토큰은 Codex 프로세스나 Git checkout에 전달되지
않습니다.

## k-skill

`k-skill`은 BearHomeBot 저장소에 포함하지 않습니다. 이후 updater가
지정된 업스트림 커밋을 별도 런타임 경로에 내려받아 검증하고, 통과한
불변 release만 활성화합니다.

전체 구현 순서는 [Ubuntu 구현 계획](docs/implementation-plan.md)을
참고합니다.
