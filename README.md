# BearHomeBot

BearHomeBot은 승인된 Telegram 사용자의 요청을 Codex CLI와 검증된
`k-skill` 실행으로 연결하는 Ubuntu 기반 홈 자동화 서비스입니다.

현재 단계에서는 Telegram이나 실제 사용자 비밀정보를 다루지 않습니다.
프로젝트 실행 환경을 진단하고, 이후 기능이 저장소 밖의 안전한 런타임
경로를 사용하도록 하는 기반만 제공합니다.

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

## k-skill

`k-skill`은 BearHomeBot 저장소에 포함하지 않습니다. 이후 updater가
지정된 업스트림 커밋을 별도 런타임 경로에 내려받아 검증하고, 통과한
불변 release만 활성화합니다.

전체 구현 순서는 [Ubuntu 구현 계획](docs/implementation-plan.md)을
참고합니다.
