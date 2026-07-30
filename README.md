# BearHomeBot

BearHomeBot은 승인된 Telegram 사용자의 요청을 Codex CLI와 검증된
`k-skill` 실행으로 연결하는 Ubuntu 기반 홈 자동화 서비스입니다.

현재 Telegram과 Codex CLI의 다중 세션 대화, 그리고 fail-closed
`k-skill` 공급망 updater가 구현되어 있습니다. 사용자별 서비스 계정과
credentialed capability는 아직 연결하지 않았으며, 모든 런타임 설정과
상태는 저장소 밖의 전용 경로를 사용합니다.

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

## Telegram-Codex 실행

먼저 이 PC의 Codex CLI 로그인을 완료하고 상태를 확인합니다.

```bash
codex login
codex login status
```

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

승인된 사용자의 일반 텍스트는 현재 Codex 세션으로 전달됩니다. 선택된
세션이 없다면 `새 대화 YYYY-MM-DD HH:mm` 이름의 세션을 자동으로 만들며,
이 세션도 `/sessions`에 보존됩니다.

지원하는 명령은 다음과 같습니다.

```text
/newsession [이름]       새 Codex 대화를 만들고 선택
/sessions                내 대화 목록과 전환 버튼 표시
/renamesession <이름>    현재 대화 이름 변경
/endsession              현재 대화에서 나오기
/cancel                  진행 중인 Codex 응답 취소
/health                  Telegram gateway 상태 확인
/whoami                  내 Telegram 숫자 사용자 ID 확인
```

`/sessions`에서 `●`가 붙은 항목이 현재 세션입니다. 세션에서 나와도
대화는 삭제되지 않으며 목록에서 다시 선택할 수 있습니다. 그룹, 채널,
사진, 파일은 처리하지 않습니다.

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

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`이 설정된 환경에서는
각 XDG base 아래의 `bearhomebot/`을 사용합니다. 운영 서비스에서는
`BEARHOMEBOT_CONFIG_DIR`, `BEARHOMEBOT_DATA_DIR`,
`BEARHOMEBOT_CACHE_DIR`를 절대 경로로 고정해 실행 환경에 따른 차이를
없앱니다.

SQLite에는 Telegram 사용자, 세션 소유권, Codex thread ID, 표시 이름,
시각, turn 결과 metadata만 저장합니다. 사용자 prompt와 Codex 답변
원문은 복제해 저장하지 않습니다. Codex thread의 대화 문맥과 자동
compaction은 Codex가 관리합니다.

개발용 임시 상태는 Git에서 제외된 `.runtime/`만 사용할 수 있습니다.
실제 사용자 비밀정보는 아직 지원하지 않으며, Secret Broker가 구현되기
전에는 이 프로젝트에 입력하지 않습니다.

Telegram bot token은 별도의 `0600` 로컬 파일에 보관하며 Codex
프로세스나 Git checkout에 전달되지 않습니다.

## k-skill

`k-skill`은 BearHomeBot 저장소에 포함하지 않습니다. updater가 고정된
업스트림의 `main`을 bare mirror로 가져온 뒤 정확한 commit SHA를 정적
게이트, rootless Podman의 networkless CI, ephemeral Codex 보안 검토에
통과시킵니다. 하나라도 실패하거나 불확실하면 기존 active release를
그대로 유지합니다.

`install.sh`가 validator 이미지를 빌드한 뒤 다음 명령을 사용할 수
있습니다.

```bash
./scripts/k-skill-updater.sh check
./scripts/k-skill-updater.sh update
./scripts/k-skill-updater.sh status
./scripts/k-skill-updater.sh rollback
./scripts/k-skill-updater.sh rollback <검증된 commit SHA>
```

`check`는 fetch와 계산 가능한 정적 검사만 수행하며 후보 코드를 실행하지
않습니다. `update`는 격리된 dependency 획득과 networkless CI, Codex
검토, 불변 release 생성, SQLite active pointer 교체까지 수행합니다.
동시에 두 updater가 실행되지 않도록 `flock`을 사용합니다.

전체 구현 순서는 [Ubuntu 구현 계획](docs/implementation-plan.md)을
참고합니다. updater의 경계와 운영 절차는
[k-skill updater 운영 문서](docs/k-skill-updater.md)에 정리되어 있습니다.
