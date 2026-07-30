# BearHomeBot

BearHomeBot은 승인된 Telegram 사용자의 요청을 Codex CLI와 검증된
`k-skill` 실행으로 연결하는 Ubuntu 기반 홈 자동화 서비스입니다.

현재 Telegram과 Codex CLI의 다중 세션 대화, 활성 `k-skill` 기능 목록,
증분 `k-skill` 동작 검토 updater, 사용자별 encrypted vault와 Secret
Broker 기반이 구현되어 있습니다. 다음 단계는 Telegram 자연어 요청에서
승인된 스킬을 실제로 실행하는 공통 Capability Broker입니다. 계정이 없는
스킬은 그대로 실행하고, 계정이 필요한 사이트는 사용자별 provider 계정을
한 번 등록해 같은 대화 방식으로 사용합니다. 모든 런타임 설정과 상태는
저장소 밖의 전용 경로를 사용합니다.

## 기준 환경

- Ubuntu 24.04 LTS 이상
- Node.js 24 LTS
- Python 3.10 이상
- Codex CLI
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

## PC와 호스트 전환

개발 PC를 바꾸거나 가족용 Telegram gateway를 다른 PC로 옮길 때는
[PC와 호스트 전환 문서](docs/host-transition.md)를 따릅니다.

핵심 원칙은 다음과 같습니다.

- 개발 작업은 commit과 push로 전달합니다.
- Codex login, thread, Telegram 설정, SQLite와 runtime은 대상 PC에서
  새로 만듭니다.
- 동일한 가족용 Telegram bot gateway는 한 번에 한 PC에서만 실행합니다.
- 기존 gateway 종료를 확인한 뒤 새 PC의 gateway를 시작합니다.
- 운영 미니 PC가 활성화되면 개발 PC에서는 별도 개발 bot을 사용합니다.

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

`start-telegram.sh`는 현재 BearHomeBot의 통합 실행 진입점입니다. 하나의
Node process가 Telegram long polling, allowlist 인증, SQLite, session과
queue, Codex CLI 실행, Telegram 답장 전송을 모두 관리합니다. Codex는
별도 daemon으로 실행하지 않고 메시지마다 child process로 호출합니다.
`start.sh`를 추가로 실행할 필요도 없습니다.

Phase 8의 systemd service가 구현되기 전까지 이 process는 foreground로
실행됩니다. terminal을 닫거나 `Ctrl+C`를 누르거나 PC를 재부팅하면
종료되며 자동으로 다시 시작되지 않습니다. 같은 PC를 재부팅한 경우에는
설정을 다시 만들지 않고 `codex login status` 확인 후
`start-telegram.sh`만 다시 실행하면 기존 local session을 사용합니다.

3. 휴대폰에서 만든 봇에게 `/whoami`를 보내 숫자 사용자 ID를 확인합니다.
4. 봇을 `Ctrl+C`로 멈추고 해당 ID를 로컬 allowlist에 추가합니다.

```bash
./scripts/allow-telegram-user.sh <숫자 사용자 ID>
./scripts/start-telegram.sh
```

승인된 사용자의 일반 텍스트는 현재 Codex 세션으로 전달됩니다. 선택된
세션이 없다면 `새 대화 YYYY-MM-DD HH:mm` 이름의 세션을 자동으로 만들며,
이 세션도 `/sessions`에 보존됩니다.

각 Codex turn의 제한 시간은 기본 30분입니다. 운영 환경에서
`BEARHOMEBOT_CODEX_TIMEOUT_SECONDS`를 사용하면 10~1800초 범위로 더 짧게
설정할 수 있습니다.

지원하는 명령은 다음과 같습니다.

```text
/newsession [이름]       새 Codex 대화를 만들고 선택
/sessions                내 대화 목록과 전환 버튼 표시
/renamesession <이름>    현재 대화 이름 변경
/endsession              현재 대화에서 나오기
/cancel                  진행 중인 Codex 응답 취소
/skills                  사용 가능한 k-skill 목록
/health                  Telegram gateway 상태 확인
/whoami                  내 Telegram 숫자 사용자 ID 확인
```

`/skills` 외에도 `너 가능한 kskill 뭐 있어?`, `k-skill 기능 리스트
알려줘`처럼 자연어로 물을 수 있습니다. 이 응답은 Codex의 추측이 아니라
현재 active release의 `enabledSkills`와 각 `SKILL.md` 설명으로 만듭니다.
거부·보류된 스킬은 목록에 포함하지 않습니다.

`KTX 스킬로 조회와 예약이 가능해?`처럼 특정 기능을 묻는 문장은 전체
목록 요청으로 처리하지 않습니다. 관련 승인 스킬만 찾아 그 설명을 Codex
문맥에 제공하므로, Codex는 스킬이 설명한 기능과 현재 실제 실행 연결
여부를 구분해 답합니다.

`/sessions`에서 `●`가 붙은 항목이 현재 세션입니다. 세션에서 나와도
대화는 삭제되지 않으며 목록에서 다시 선택할 수 있습니다. 그룹, 채널,
사진, 파일은 처리하지 않습니다.

Telegram 토큰은 임시 bootstrap 저장소인
`~/.config/bearhomebot/telegram.env`에 mode `0600`으로 저장됩니다.
Telegram gateway credential 분리는 운영 service 계정 구성 단계에서
진행합니다.

## 암호화 credential vault

현재 WSL2 host에서는 vault master key를 Windows DPAPI `CurrentUser`로
보호합니다. C 드라이브 암호화는 이 프로젝트의 필수 조건이 아니지만,
사이트 ID와 password 자체는 항상 별도 vault database에서
AES-256-GCM으로 인증 암호화합니다. DPAPI가 설정되지 않았거나 현재
Windows 사용자로 해제할 수 없으면 credential 기능만 fail-closed로
잠깁니다.

최초 한 번 vault를 초기화하고 상태를 확인합니다.

```bash
npm run build
./scripts/setup-vault.sh
node dist/vault-main.js status
```

Phase 6에서는 관리자가 로컬 terminal에서 사용자별·provider별 credential
profile을 한 번 등록합니다. 입력값은 화면에 표시되지 않고 명령행 인자,
Telegram 또는 Codex prompt로 전달되지 않습니다. 이후에는 KTX를 포함한
각 사이트를 위한 별도 대화 명령을 만들지 않고 Telegram 자연어 요청으로
사용합니다.

현재 구현된 KTX 등록 명령은 이 공통 profile의 첫 실환경 예시입니다.

```bash
./scripts/configure-ktx-credentials.sh <Telegram 숫자 사용자 ID>
node dist/vault-main.js list <Telegram 숫자 사용자 ID>
```

기존 mode `0600` k-skill 설정을 가져올 수도 있습니다. importer는
`KSKILL_KTX_ID`와 `KSKILL_KTX_PASSWORD`만 읽고 원본을 자동 삭제하지
않습니다.

```bash
./scripts/import-k-skill-credentials.sh <Telegram 숫자 사용자 ID> \
  ~/.config/k-skill/secrets.env
```

개발 단계에서 Secret Broker를 별도 foreground process로 확인하려면
다음을 사용합니다. 공통 Capability Broker와 systemd service 연결은
Phase 6과 Phase 8에서 진행합니다.

```bash
./scripts/start-secret-broker.sh
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
~/.config/bearhomebot-vault
~/.local/share/bearhomebot-vault
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
실제 사용자 credential은 위의 local admin 명령으로만 encrypted vault에
등록하며 Git checkout, Telegram 또는 Codex prompt에 입력하지 않습니다.

Telegram bot token은 별도의 `0600` 로컬 파일에 보관하며 Codex
프로세스나 Git checkout에 전달되지 않습니다.

## k-skill

`k-skill`은 BearHomeBot 저장소에 포함하지 않습니다. updater가 고정된
업스트림의 `main`을 bare mirror로 가져온 뒤 정확한 commit SHA를 안전하게
materialize하고, 각 스킬의 실제 동작과 개인정보 전송 위험을 ephemeral
Codex로 검토합니다. 검토가 끝난 release에서는 `approved` 스킬만
`enabledSkills`에 등록하고 `uncertain` 또는 `rejected` 스킬은 명시적으로
제외합니다. 검토가 불완전하거나 승인된 스킬이 하나도 없으면 기존 active
release를 그대로 유지합니다.

최초 update는 모든 top-level 스킬을 검토합니다. 이후에는 스킬 정의,
스킬 구현 파일, 명시적으로 참조한 공용 helper 또는 연결된 local package의
내용 해시가 바뀐 스킬과 새 스킬만 검토합니다. 승인·거부 결과는
`skill ID + 내용 해시 + 검토 정책 버전`으로 저장하므로 같은 내용에는
LLM token을 다시 사용하지 않습니다. upstream SHA가 active SHA와 같으면
Codex를 전혀 호출하지 않습니다.

```bash
./scripts/k-skill-updater.sh check
./scripts/k-skill-updater.sh update
./scripts/k-skill-updater.sh status
./scripts/k-skill-updater.sh rollback
./scripts/k-skill-updater.sh rollback <검증된 commit SHA>
```

`check`는 fetch와 path, symlink, submodule, mode, 크기 같은 로딩 안전
조건만 확인하며 후보 코드를 실행하지 않습니다. `update`는 필요한 스킬의
증분 동작 검토, 승인 스킬 allowlist가 포함된 불변 release 생성, SQLite
active pointer 교체까지 수행합니다. 후보 코드나 test는 updater가 실행하지
않습니다. 이후 Capability Broker는 release 안에 파일이 있다는 이유만으로
실행하지 않고 반드시 `enabledSkills`를 확인해야 합니다. 동시에 두
updater가 실행되지 않도록 `flock`을 사용합니다.

Telegram gateway는 active release에서 승인된 스킬 목록을 직접 읽어
분야별 기능 설명을 제공합니다. 기능 목록 조회는 Codex를 호출하거나
대화 session을 만들지 않습니다. 실제 스킬 helper 실행은 Capability
Broker 연결이 끝난 스킬부터 단계적으로 지원합니다.

전체 구현 순서는 [Ubuntu 구현 계획](docs/implementation-plan.md)을
참고합니다. updater의 경계와 운영 절차는
[k-skill updater 운영 문서](docs/k-skill-updater.md)에 정리되어 있습니다.
