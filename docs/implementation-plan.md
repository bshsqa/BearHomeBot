# BearHomeBot Ubuntu 구현 계획

## 1. 목표

BearHomeBot은 승인된 가족이 Telegram으로 요청하면 집의 Ubuntu PC에서
Codex CLI가 요청을 해석하고, 검증된 `k-skill`과 사용자별 계정을 이용해
작업하는 상시 실행 서비스다.

첫 번째 지원 환경과 운영 범위는 다음과 같다.

- Ubuntu만 지원한다. Windows와 WSL 지원은 Ubuntu 운영이 안정된 뒤 검토한다.
- Telegram 사용자는 최대 5명까지 등록한다.
- 일반 대화와 작업 요청은 고정된 봇 명령을 제외하고 Codex CLI로 전달한다.
- 사용자마다 독립된 여러 Codex thread를 가질 수 있으며, 그중 하나를
  active session으로 선택해 사용한다.
- Codex thread의 긴 context는 Codex의 자동 compaction에 맡기고,
  BearHomeBot이 시간이나 turn 수를 기준으로 session을 자동 삭제하거나
  교체하지 않는다.
- 같은 사용자의 요청은 순서대로 처리한다.
- 서로 다른 사용자는 전역 worker 제한 안에서 동시에 사용할 수 있다.
- `k-skill`은 BearHomeBot 저장소에 포함하지 않는다.
- 개발 PC와 운영 host 사이에는 source code만 Git commit으로 전달하고,
  login, session, database, secret과 runtime은 대상 PC에서 새로 만든다.
- 가족용 Telegram gateway는 한 번에 하나의 활성 host에서만 실행한다.
- 매일 00:00 `Asia/Seoul`에 새 `k-skill` 후보를 검증하고, 모든 필수 검사를
  통과한 경우에만 활성 release를 교체한다.
- 결제, 전자서명 등 되돌리기 어려운 작업은 별도 정책이 생기기 전까지
  자동 실행하지 않는다.

## 2. 절대 지켜야 할 경계

- Telegram 숫자 `user_id`만 사용자 신원으로 신뢰한다. username과
  자연어에 포함된 사용자 ID는 권한 근거로 사용하지 않는다.
- Telegram bot token, Codex 인증정보, Korail 계정 등 비밀정보는 Git,
  Telegram 메시지, Codex prompt, 명령행 인자, 로그에 넣지 않는다.
- Telegram gateway가 확인한 principal을 queue, runner, broker까지
  구조화된 내부 값으로 전달한다.
- Codex가 출력한 명령이나 자연어만으로 사용자, 권한, credential scope를
  변경하지 않는다.
- Codex는 credential을 복호화하거나 평문 값을 전달받지 않는다.
- credential이 필요한 작업은 BearHomeBot이 검증한 typed operation으로만
  Capability Broker에 요청한다.
- 검증되지 않은 `k-skill` 후보에는 secret을 제공하지 않는다.
- deterministic gate가 하나라도 실패하면 Codex 검토 결과와 관계없이
  후보를 활성화하지 않는다.
- shell 문자열 조합 대신 인자 배열을 사용해 child process를 직접 실행한다.
- 로그와 사용자 응답에는 중앙 redaction 정책을 적용한다.

## 3. 목표 아키텍처

```text
Telegram Bot API
       |
       v
Telegram Gateway
       |
       +---- trusted principal: Telegram numeric user_id
       |
       v
Per-user Queue and Session Manager
       |
       +---- multiple owned threads, one active session per user
       |
       v
Codex Runner
       |
       +---- codex exec / resume / JSONL parsing
       |
       v
Policy and Capability Broker
       |
       +---- public, read-only skill runner
       |
       +---- credentialed typed operation
                         |
                         v
                    Secret Broker
                         |
                         v
               encrypted per-user vault

Nightly Updater
       |
       v
k-skill candidate -> deterministic gates -> isolated tests -> Codex review
       |
       v
atomic promotion or active release unchanged
```

Telegram gateway, Codex runner, updater, capability runner, secret broker는
논리적으로 분리한다. 운영 단계에서는 서로 다른 Unix service account와
최소 권한으로 실행한다.

## 4. 기술 선택

- 제어 애플리케이션: TypeScript, Node.js 24 LTS
- 영속 상태: SQLite
- 서비스 관리: systemd
- 로그: journald와 애플리케이션 수준 redaction
- Telegram 연결: long polling
- 후보 코드 격리: rootless Podman 또는 동등한 rootless OCI runtime
- Codex 연동: `codex exec --json`과 명시적인 sandbox 설정
- 비밀정보 저장: 인증 암호화를 적용한 별도 vault
- 운영 시간대: `Asia/Seoul`

Telegram은 long polling을 사용하므로 외부에서 집 PC로 들어오는 포트를
열지 않는다.

## 5. 저장 위치

### 5.1 개발 환경

```text
BearHomeBot/                              Git checkout
BearHomeBot/.runtime/                     Git에서 제외된 개발용 임시 상태
~/.config/bearhomebot/telegram.env        bootstrap Telegram 설정, mode 0600
~/.local/share/bearhomebot/               개발용 영속 상태
~/.cache/bearhomebot/                     개발용 cache
```

현재 Telegram token은 bootstrap 단계에서만 `telegram.env`에 보관한다.
Codex child process에는 이 파일 경로나 token 환경변수를 전달하지 않는다.

### 5.2 운영 환경

```text
/opt/bearhomebot/                         설치된 애플리케이션
/etc/bearhomebot/config.toml              비밀정보가 없는 설정
/var/lib/bearhomebot/state.sqlite         사용자, 세션, 작업, release, 감사 기록
/var/lib/bearhomebot/k-skill/mirror.git   upstream Git mirror
/var/lib/bearhomebot/k-skill/releases/    commit SHA별 불변 release
/var/lib/bearhomebot-vault/vault.sqlite   암호화된 사용자 credential
/run/bearhomebot/secret-broker.sock       로컬 broker socket
```

Telegram bot token과 vault master key는 일반 설정 파일이 아니라
root가 관리하는 systemd credential 또는 동등한 전용 secret 경로에서
서비스에 주입한다.

## 6. 단계별 구현 순서

### Phase 0: 운영 결정과 위협 모델

상태: 현재 WSL2 host 기준 완료

작업:

- 목표 mini PC의 Ubuntu 버전, CPU architecture, timezone을 확인한다.
- TPM 2.0 지원 여부와 LUKS full-disk encryption 적용 여부를 확인한다.
- `k-skill` upstream을 `https://github.com/NomaDamas/k-skill.git`, 허용
  branch를 `main`으로 version-controlled 설정에 고정한다.
- 예약, 취소, 결제 등 명시적 사용자 확인이 필요한 action을 정의한다.
- PC가 00:00에 꺼져 있을 때 다음 부팅 후 누락된 update를 한 번 실행하도록
  정책을 정한다.
- log 보존 기간, backup 범위, 장애 알림 대상을 정한다.

현재 운영 결정:

- Windows/WSL2 host의 Device Encryption 또는 native Ubuntu의 LUKS는
  권장하지만 BearHomeBot의 비-credential 기능을 시작하기 위한 필수 조건은
  아니다. 현재 공유 WSL2 PC는 host disk encryption 없이 먼저 운영한다.
- host disk encryption이 없어도 credential 평문 저장은 허용하지 않는다.
  Phase 5의 승인된 key provider로 vault를 열기 전까지 credential 기능은
  fail-closed 상태로 유지한다.
- 공개 조회와 검색은 자동 실행할 수 있다. 예약 생성과 취소는 실행 직전
  Telegram 재확인이 필요하며 결제, 송금, 전자서명은 금지한다.
- `k-skill` updater는 매일 00:00 `Asia/Seoul`에 실행하고, PC가 꺼져
  누락된 경우 다음 시작 후 한 번 보충한다.
- application과 journald log는 30일 또는 합계 100 MiB 중 먼저 도달한
  한도를 적용한다. Codex prompt와 답변 원문, credential, Telegram token은
  log에서 제외한다.
- normal state database와 encrypted vault database를 매주 일요일 03:00에
  backup하고 8개를 보존한다. vault master key, Telegram bootstrap token,
  Codex local state는 같은 backup에 넣지 않는다. 외부 backup 목적지가
  설정되지 않으면 자동 backup을 시작하지 않고 admin에게 알린다.
- 실패 알림 대상은 Telegram admin이다.
- 이 결정은 `config/operations-policy.json`에 version-controlled policy로
  저장하고 loader test로 각 action이 정확히 한 분류만 갖도록 검증한다.

완료 조건:

- 결정 사항이 configuration 또는 ADR로 저장된다.
- 애플리케이션 timezone이 `Asia/Seoul`로 고정된다.
- 허용 action과 금지 action의 기본 정책이 테스트 가능한 형태로 정의된다.

### Phase 1: Ubuntu 프로젝트 기반

상태: bootstrap 완료

구현 내용:

- 기본 branch가 `main`인 BearHomeBot Git 저장소를 구성했다.
- `origin`은 `https://github.com/bshsqa/BearHomeBot.git`이다.
- `k-skill`, `.runtime`, database, log, secret, Codex local state를 Git에서
  제외했다.
- TypeScript 애플리케이션, test, type check, build, formatting 기반을
  추가했다.
- `install.sh`, `start.sh`, `stop.sh`, `doctor.sh`를 추가했다.
- 운영 상태를 Git checkout 밖의 XDG 경로에 두는 runtime path를 추가했다.

남은 운영 준비:

- clean Ubuntu 설치에서 Node.js 24 설치 경로를 확정한다.
- rootless Podman을 설치하고 doctor 검사를 통과시킨다.
- target mini PC에서 systemd, disk, timezone 검사를 다시 수행한다.

완료 조건:

- fresh clone에서 doctor와 install이 재현 가능하게 동작한다.
- 일반적인 `git add .`로 runtime이나 secret이 stage되지 않는다.

### Phase 2: Telegram 보안 전송 기반

상태: 완료

구현 내용:

- 외부 inbound port가 필요 없는 Telegram long polling client를 추가했다.
- private text chat만 처리하고 group, channel, media를 무시한다.
- `/whoami`로 숫자 user ID를 확인할 수 있다.
- allowlist에 등록되지 않은 사용자의 일반 요청을 차단한다.
- `/health`와 일반 text 수신 응답으로 실제 휴대폰 왕복을 검증했다.
- token 설정 파일의 owner와 mode `0600`을 시작 전에 검사한다.
- token이 API error, test output, Git에 노출되지 않도록 검사한다.
- 이 네트워크의 IPv6 blackhole을 피하도록 Telegram Node process에
  IPv4 우선 연결을 적용했다.

현재 bootstrap 명령:

```bash
./scripts/configure-telegram.sh
./scripts/allow-telegram-user.sh <numeric-user-id>
npm run build
./scripts/start-telegram.sh
```

유지되는 보안 경계:

- `/whoami`, `/health`, `/start` 같은 gateway command는 Codex를 호출하지
  않는다.
- 승인된 일반 text만 Codex queue로 전달한다.
- bot token은 Codex process environment에서 제거한다.
- Telegram `update_id` checkpoint를 SQLite에 저장하고 replay를 차단한다.
- bootstrap allowlist를 SQLite principal model로 import한다.

완료 조건:

- 미승인 사용자는 session이나 job을 생성할 수 없다.
- Telegram update 재전송으로 동일 action이 두 번 실행되지 않는다.
- bot token이 Codex와 worker에서 읽히지 않는다.

### Phase 3: Telegram-Codex 대화 연결

상태: 완료

목표:

승인된 사용자의 일반 Telegram 메시지를 Codex CLI에 전달하고, Codex의
최종 답변을 같은 private chat으로 돌려준다. 이 단계는 대화와 session
수명주기만 지원하며 `k-skill`과 사용자별 서비스 credential은 연결하지
않는다.

세션 모델:

- Codex thread가 실제 대화 문맥과 transcript를 소유한다.
- BearHomeBot SQLite는 전체 대화 원문을 복제하지 않는다.
- SQLite에는 thread ID, 사용자 소유권, 표시 이름, 상태, 생성·최근 사용
  시각, active association, turn 결과 metadata만 저장한다.
- 한 사용자는 여러 session을 보유할 수 있지만 한 번에 하나만 active다.
- Codex가 model 기본 임계값에 따라 자동 compaction을 수행하도록 두며,
  BearHomeBot은 routine operation에서 수동 compaction을 요청하지 않는다.
- session은 age, idle time, turn count를 기준으로 자동 만료하거나 삭제하지
  않는다.
- 사용자가 명시적으로 새 session을 만들고, 이전 session을 선택하고,
  현재 session을 종료한다.

구현 내용:

- `users`, `codex_sessions`, `turns`, `telegram_updates`, `audit_events`
  SQLite schema와 migration을 구현했다.
- 기존 bootstrap allowlist를 최초 admin과 이후 member principal로
  안전하게 import한다.
- 사용자별 여러 `codex_sessions`와 하나의 active session을 저장한다.
- active session에 thread ID가 없으면 첫 일반 메시지를
  `codex exec --json`으로 시작하고
  `thread.started.thread_id`를 저장한다.
- active session의 다음 메시지는 저장된 정확한 ID로
  `codex exec resume <session-id>`를 실행한다.
- `/newsession [이름]`으로 새 session을 만들고 active로 선택한다. 이름을
  생략하면 생성 시각을 이용한 기본 표시 이름을 사용한다.
- `/sessions`는 현재 사용자가 소유한 session을 최근 사용 순으로
  page 단위로 보여주고 active session을 구분한다.
- `/sessions` 결과에 Telegram inline button을 붙여 session을 선택하게 한다.
- Telegram polling이 `message`와 `callback_query` update를 받고, 각
  callback query에 즉시 응답하도록 client와 type을 확장한다.
- 지원 명령을 lowercase command 이름으로 Telegram bot menu에 등록한다.
- callback data에는 Codex thread ID가 아닌 짧은 BearHomeBot 내부 ID만
  넣는다.
- callback을 처리할 때 Telegram 숫자 user ID와 session owner를 다시
  검증한 뒤 active association을 원자적으로 변경한다.
- `/renamesession [이름]`으로 현재 session의 표시 이름을 바꾼다.
- `/endsession` 또는 `세션 종료해`는 현재 association만 비활성화하고
  session과 Codex thread는 보존한다.
- active session이 없는 상태에서 일반 메시지를 받으면 새 기본 session을
  만든 뒤 해당 메시지로 Codex thread를 시작한다.
- Codex process는 shell 없이 인자 배열로 spawn한다.
- 사용자 text는 command-line argument 대신 stdin으로 전달한다.
- 전용 Git workspace, 고정 working directory, 명시적 read-only sandbox,
  timeout, output byte limit, cancellation signal을 적용한다.
- 자동화용 고정 Codex configuration을 사용하고 개인 설정의 우발적 상속을
  막는다.
- child environment는 allowlist 방식으로 만들고 Telegram token과 모든
  서비스 credential을 제외한다.
- JSONL parser가 `thread.started`, final agent message, failure, usage만
  구조화해서 처리하게 한다.
- Codex 자동 compaction을 위한 model 기본값을 유지하고 BearHomeBot은
  transcript 원문을 별도로 복제하지 않는다.
- 첫 버전에서는 세부 tool log를 Telegram에 보내지 않고, 처리 시작 알림과
  최종 답변만 보낸다.
- Telegram 길이 제한에 맞춰 최종 답변을 안전하게 분할한다.
- 같은 사용자의 동시 turn을 막고, 전역 Codex 동시 실행 수를 2로 제한한다.
- `/cancel`로 실행 중인 Codex child를 종료하고 상태를 기록한다.
- Codex process 상세 오류는 Telegram에 노출하지 않고 안정된 failure
  code와 일반 사용자 메시지로 분리한다.

안전한 첫 수직 기능:

```text
approved Telegram text
        |
        v
authenticated user queue
        |
        v
Codex exec/resume in read-only workspace
        |
        v
allowlisted final response
        |
        v
same Telegram private chat
```

완료 조건:

- 휴대폰에서 보낸 일반 질문에 Ubuntu의 Codex CLI 답변이 돌아온다.
- 같은 사용자의 두 번째 메시지가 같은 Codex session 문맥을 이어간다.
- `/newsession`, `/sessions`, session 선택, `/renamesession`,
  `/endsession`, `/cancel`이 명확하게 동작한다.
- 새 session과 과거 session 사이를 오가며 각 thread의 문맥을 이어간다.
- 재시작 후에도 active session과 session 목록을 복구하고 저장된 thread ID를
  정확한 사용자에게만 resume한다.
- 두 사용자가 서로의 session을 목록에서 보거나 선택하거나 resume할 수 없다.
- BearHomeBot SQLite에 전체 사용자 prompt와 Codex 답변 원문이 저장되지
  않는다.
- session은 규칙으로 자동 삭제되지 않으며 긴 context는 Codex 자동
  compaction으로 처리된다.
- Codex process와 출력에서 Telegram token 및 서비스 credential을 찾을
  수 없다.
- timeout, malformed JSONL, process crash가 gateway 전체를 종료시키지 않는다.

### Phase 4: 안전한 k-skill 공급망

상태: 구현 완료, 대상 WSL2의 거부 경로 검증 완료, 승격 경로 재검증 대기

구현 내용:

- version-controlled policy에 정확한 upstream URL, branch, registry,
  resource limit, review policy를 고정했다.
- Git checkout 밖에 bare upstream mirror를 만들고 `origin/main`만 정확한
  commit SHA로 fetch한다.
- remote 변경, non-fast-forward history, submodule, symlink, path escape,
  예약 path, 비정상 mode, 파일 수와 크기 초과를 checkout 전에 거부한다.
- 모든 `package.json`, package-lock v3, Python requirements를 구조적으로
  검사하고 Git, 임의 URL, file, link, custom registry dependency를
  거부한다.
- active commit과 후보의 machine-readable manifest를 만들고 SQLite에
  candidate, validation, review, failure code, active pointer를 기록한다.
- rootless Podman acquisition stage에서 lifecycle script 없이 dependency를
  받고 high 이상 vulnerability를 실패 처리한다.
- secret 없는 validation stage에 network `none`, read-only cache,
  capability drop, no-new-privileges, CPU, memory, PID, timeout, output
  limit을 적용하고 `npm run ci`를 실행한다.
- Codex를 ephemeral one-shot, read-only filesystem, JSON schema,
  user config/rules와 외부 tool 비활성화 조건으로 실행한다.
- deterministic gate, container validation, Codex review가 실패하거나
  불확실하면 candidate를 거부한다.
- validation tree를 폐기하고 동일 Git SHA에서 fresh release를 다시
  materialize해 digest를 기록하고 read-only로 만든다.
- 검증된 release만 SQLite transaction으로 active 상태로 교체한다.
- release를 자동 삭제하지 않아 최소 3개 보존 조건을 지키며, 직전 또는
  지정 SHA로 rollback할 때 content digest를 다시 검증한다.
- `flock`으로 updater 동시 실행을 막고 `check`, `update`, `status`,
  `rollback` 운영 명령을 제공한다.
- 악성 fixture, 전체 updater, 실패 시 active 보존, migration, rollback을
  포함한 자동 test를 추가했다.
- 실제 upstream fetch와 deterministic gate, 실제 Codex structured
  security review를 smoke test했다.
- 대상 WSL2의 rootless Podman 4.9 image ID 형식을 지원하고 실제 upstream
  fetch와 dependency acquisition을 실행했다. 2026-07-31 기준 후보는 high
  npm audit finding 2건으로 거부했으며 active release는 비어 있는 상태를
  유지했다.

남은 실환경 검증:

- upstream의 high npm audit finding이 해결된 후보에서 networkless CI,
  Codex review, 불변 release 승격까지 같은 WSL2 host에서 확인한다.

완료 조건:

- updater가 어느 시점에 종료돼도 active release가 손상되지 않는다.
- 실패하거나 불확실한 검사는 active release를 변경하지 않는다.
- 결과에 candidate SHA, manifest, validation summary, structured review,
  stable failure code가 남는다.
- 실행 중인 job은 pinned release를 계속 사용하고 새 job만 새 release를
  사용한다.
- target Ubuntu PC에서 validator image를 build하고 실제 upstream
  acquisition, networkless CI, promotion 거부 또는 성공을 end-to-end로
  확인한다.

### Phase 5: Secret Broker와 사용자별 credential

상태: 구현 완료, 현재 WSL2의 Windows DPAPI 실환경 검증 완료

구현 내용:

- normal state와 분리된
  `~/.local/share/bearhomebot-vault/vault.sqlite`를 mode `0600`으로
  생성한다.
- secret value마다 AES-256-GCM authenticated encryption을 적용하고
  Telegram principal, credential scope/name, credential version, key
  version을 additional authenticated data로 묶는다.
- 32-byte master key를 repository와 vault database 밖에서 생성하고,
  WSL2에서는 Windows DPAPI `CurrentUser`로 감싼 versioned keyring만
  `~/.config/bearhomebot-vault/`에 mode `0600`으로 저장한다.
- key provider interface를 분리하고 provider가 없거나 DPAPI 해제가
  실패하면 credential 기능을 fail-closed로 거부한다. master key 평문
  file provider는 지원하지 않는다.
- credential rotation과 master key version rotation을 구현한다. rotation
  중 기존 key version도 보존해 중단 후 복호화가 가능하다.
- mode `0600` Unix domain socket에서 strict schema와 allowlisted
  metadata operation만 받는 Secret Broker를 구현한다. API에는 secret
  value를 반환하는 operation이 없다.
- gateway가 확인한 numeric Telegram principal만 구조화된 값으로 전달하고,
  normal state의 enabled user를 다시 확인한다. 자연어 또는 Codex 출력에서
  user ID를 추출하는 경로는 만들지 않는다.
- 사용자별 credential 이름, 존재 여부와 version metadata만 조회하며
  다른 사용자 행은 반환하지 않는다.
- hidden terminal 입력 등록 명령과
  `~/.config/k-skill/secrets.env` local importer를 구현했다. importer는
  source owner, regular file, mode `0600`, 크기와 allowlisted KTX 이름을
  확인하고 원본을 자동 삭제하지 않는다.
- literal, URL-encoded, base64, environment assignment, Telegram token과
  bearer token 형태에 중앙 redaction test를 추가했다.
- 운영 Unix service account와 socket group 분리는 Phase 8 service 설치와
  Phase 9 hardening에서 적용한다. 현재 개발 host에서는 owner-only path와
  Codex filesystem deny profile로 접근을 분리한다.

완료 조건:

- Codex worker account가 vault database, master key, decrypted value를 읽을
  수 없다.
- secret은 한 번의 승인된 operation을 위해 broker memory에서만 복호화된다.
- normal state database나 일반 backup만 복사해서는 credential이 노출되지
  않는다.
- User A는 User B의 credential을 사용하거나 존재 여부를 조회할 수 없다.

현재 검증:

- unit/integration test가 ciphertext와 tag 변조, 잘못된 AAD principal,
  사용자 간 metadata 분리, 잠긴/insecure keyring, credential/key rotation,
  importer source mode, socket mode와 응답 redaction을 검증한다.
- 현재 WSL2에서 Windows PowerShell 5.1 DPAPI `CurrentUser`로 빈 운영 vault를
  초기화하고 재해제했다. keyring과 database는 각각 mode `0600`, parent
  directory는 `0700`임을 확인했다.
- 실제 DPAPI로 해제한 vault를 사용하는 Unix socket broker를 시작해 등록된
  Telegram principal의 빈 metadata 응답을 받고 정상 종료와 socket 정리를
  확인했다.
- 실제 Codex CLI를 BearHomeBot의 filesystem deny profile로 실행해 vault
  database 읽기 probe가 `VAULT_DENIED`로 차단되는 것을 확인했다.
- 실제 KTX credential은 아직 등록하지 않으며 Phase 6 typed capability를
  연결할 때 local hidden-input 명령으로 등록한다.

### Phase 6: Capability Broker와 첫 KTX 기능

상태: Phase 5 완료 후 시작

첫 credentialed capability는 KTX로 한다. KTX는 로그인, 검색, 예약,
장기 monitoring, 알림, account lock을 함께 검증할 수 있다.

작업:

- pinned active release의 KTX skill만 읽는다.
- 로그인 확인, 열차 검색, 좌석 확인, 예약 목록, 예약 생성, 예약 취소를
  typed operation으로 정의한다.
- Codex는 operation을 제안하고 BearHomeBot이 principal, policy,
  confirmation을 검증한 뒤 실행한다.
- 예약과 취소에는 idempotency key와 명시적 confirmation policy를 적용한다.
- Secret Broker가 해당 사용자의 `KSKILL_KTX_ID`와
  `KSKILL_KTX_PASSWORD`만 KTX helper child에 주입한다.
- helper는 shell 없이 최소 environment와 pinned release로 실행한다.
- 같은 Korail account를 사용하는 작업은 직렬화한다.
- 결과를 structured job state에 저장하고 요청한 Telegram 사용자에게
  알린다.

완료 조건:

- Codex는 Korail ID와 password를 받지 않는다.
- 다른 사용자의 Korail account를 선택하거나 사용할 수 없다.
- 동일 예약 요청이 재시도돼도 중복 예약되지 않는다.
- 예약 결과에는 감사 가능한 stable operation ID가 남는다.

### Phase 7: 영속 job과 동시 사용자 처리

작업:

- 사용자별 FIFO queue를 구현한다.
- 전역 Codex worker limit을 기본 2로 설정한다.
- provider별, account별 lock을 구현한다.
- monitoring job, 중지 조건, 최대 실행 시간을 SQLite에 저장한다.
- 각 job에 active `k-skill` release SHA를 pin한다.
- restart 후 interrupted job을 보수적으로 복구한다.
- backoff, jitter, rate policy, deadline을 적용한다.
- 대화 turn과 장기 job의 worker pool을 분리한다.
- 완료 응답 앞에 `[세션 이름]`을 붙여 active session을 바꾼 뒤에도 결과가
  어느 session에 속하는지 명확하게 표시한다.

완료 조건:

- 최대 5명이 session, credential, 결과가 섞이지 않은 상태로 요청할 수 있다.
- 같은 사용자의 대화 순서가 보존된다.
- 장기 job 중에도 status와 cancellation command가 동작한다.
- restart recovery가 완료된 예약을 다시 실행하지 않는다.

### Phase 8: 자동 업데이트와 운영 서비스

작업:

- gateway, Codex worker, Secret Broker, updater의 systemd service를 만든다.
- 00:00 `Asia/Seoul`에 실행되는 systemd timer를 만든다.
- 누락된 daily update를 다음 startup에 한 번 보충한다.
- Telegram, Codex authentication, database migration, active release,
  disk space, broker availability health check를 추가한다.
- update, migration, credential operation, health check 실패를 admin에게
  알린다.
- update 결과와 active commit을 Telegram admin command로 조회하게 한다.
- backup, restore, rollback 절차를 문서화하고 연습한다.

완료 조건:

- reboot 후 interactive terminal 없이 서비스가 시작된다.
- nightly update 실패 시 이전 release가 계속 활성 상태다.
- active commit 확인과 rollback이 한 명령으로 가능하다.
- 서비스 장애 원인을 secret 노출 없이 진단할 수 있다.

### Phase 9: 보안 강화와 첫 운영 release

작업:

- gateway, Codex worker, updater, Secret Broker를 별도 Unix account로
  분리한다.
- `NoNewPrivileges`, `ProtectSystem`, `PrivateTmp` 등 restrictive systemd
  옵션과 최소 writable path를 적용한다.
- production mini PC에 LUKS full-disk encryption을 적용한다.
- hardware가 지원하면 vault master key를 TPM-backed systemd credential로
  이전한다.
- credentialed runner의 outbound network를 provider 목적지로 제한한다.
- secret rotation, encrypted recovery export, restore drill을 추가한다.
- clean Ubuntu installation test와 release checklist를 수행한다.

완료 조건:

- Telegram gateway 또는 Codex worker 하나가 침해돼도 vault 평문을 직접
  읽을 수 없다.
- Git repository, normal state database, 일반 backup에 평문 credential이
  없다.
- 두 번째 Ubuntu machine에서 문서화된 restore 절차가 재현된다.

## 7. 비밀정보 저장 원칙

### 7.1 현재 bootstrap 저장

`~/.config/bearhomebot/telegram.env`는 Telegram 전송 기능을 검증하기 위한
임시 저장소다. repository 밖에 있고 mode `0600`이며 BearHomeBot Telegram
process만 읽는다.

기존 `~/.config/k-skill/secrets.env`도 mode `0600`인 개인 수동 실행
환경에서는 사용할 수 있다. 다중 사용자와 unattended operation을 지원하는
BearHomeBot 운영 저장소로는 사용하지 않는다.

### 7.2 암호화의 역할

- LUKS full-disk encryption은 전원이 꺼진 PC나 분리된 disk의 도난을
  방어한다.
- application-level encryption은 vault database나 backup만 복사된 경우를
  방어한다.
- process와 Unix account 분리는 Codex와 일반 worker의 직접 접근을 막는다.
- just-in-time injection은 평문이 존재하는 시간과 위치를 줄인다.

암호화된 database와 key를 같은 owner, 같은 경로, 같은 권한으로 보관하면
효과가 제한된다. vault, key, worker의 소유권을 분리해야 한다.

### 7.3 credential 사용 흐름

```text
encrypted per-user vault
          |
          | trusted principal + validated operation
          v
Secret Broker decrypts in memory
          |
          | minimal child environment, direct exec
          v
pinned k-skill helper
          |
          v
redacted structured result
          |
          +---- Codex receives only non-secret result
          +---- Telegram receives user-facing result
```

Codex는 operation이 필요하다고 제안할 수 있지만 복호화하지 않는다.
BearHomeBot이 principal과 policy를 검증하고 Secret Broker가 credential을
사용하는 실행을 담당한다.

## 8. 구현 마일스톤

### Milestone 1: Telegram-Codex 대화

1. 승인 사용자가 Telegram으로 일반 text를 보낸다.
2. Ubuntu PC의 Codex CLI가 active session의 thread를 시작하거나 resume한다.
3. 최종 답변이 같은 Telegram private chat으로 돌아온다.
4. 사용자가 여러 session을 만들고 목록에서 선택해 문맥을 전환한다.
5. session 종료, 이름 변경, cancellation, restart resume가 동작한다.
6. 긴 thread는 Codex 자동 compaction을 사용하고 session을 자동 삭제하지
   않는다.
7. Telegram token과 서비스 credential은 Codex에 전달되지 않는다.

### Milestone 2: 검증된 k-skill release

1. upstream candidate commit을 정확한 SHA로 가져온다.
2. secret 없는 격리 환경에서 deterministic gate와 Codex review를 수행한다.
3. 성공한 후보만 원자적으로 promote한다.
4. active release 확인과 rollback이 가능하다.

### Milestone 3: 사용자별 KTX

1. 관리자가 사용자별 Korail credential을 encrypted vault에 import한다.
2. Telegram 요청이 typed KTX operation으로 변환된다.
3. Secret Broker가 Codex에 secret을 보여주지 않고 pinned helper를 실행한다.
4. 검색, 예약, monitoring, cancellation 결과가 올바른 사용자에게 돌아간다.

### Milestone 4: 상시 운영

1. 최대 5명의 요청을 queue와 lock으로 안전하게 처리한다.
2. reboot 후 systemd가 서비스를 자동 시작한다.
3. 매일 00:00 update와 missed-run catch-up이 동작한다.
4. backup, restore, rollback, 장애 알림이 검증된다.

## 9. 바로 다음 작업

다음 구현 batch는 Phase 6의 첫 typed KTX capability다.

1. active로 승격된 pinned `k-skill` release의 KTX helper interface를
   확정한다.
2. 공개 열차 검색과 credential이 필요한 로그인/예약 조회 operation을
   별도 typed schema로 정의한다.
3. 예약 생성과 취소에 single-use confirmation과 idempotency key를
   적용하고 결제 operation을 구조적으로 금지한다.
4. Secret Broker 내부 operation handler만 KTX ID와 password를 memory에서
   복호화하고, pinned helper child의 최소 environment에 잠시 주입한다.
5. helper output을 structured result로 검증하고 secret을 redaction한 뒤
   Codex와 Telegram에는 비밀값 없는 결과만 전달한다.

현재 upstream 후보가 high vulnerability로 거부되어 active `k-skill`
release가 비어 있으므로, Phase 6은 안전한 후보가 승격되기 전까지 실제
예약을 실행하지 않고 fixture 기반 통합 test로 먼저 진행한다.

## 10. 참고 자료

- k-skill security policy: `k-skill/docs/security-and-secrets.md`
- Codex non-interactive mode:
  `https://learn.chatgpt.com/docs/non-interactive-mode`
- Codex best practices and automatic compaction:
  `https://learn.chatgpt.com/guides/best-practices`
- Codex configuration reference:
  `https://learn.chatgpt.com/docs/config-file/config-reference`
- Codex sandbox:
  `https://learn.chatgpt.com/docs/sandboxing`
- Telegram bot commands:
  `https://core.telegram.org/bots/api#botcommand`
- Telegram inline keyboard:
  `https://core.telegram.org/bots/api#inlinekeyboardbutton`
- Ubuntu full-disk encryption:
  `https://documentation.ubuntu.com/security/security-features/storage/encryption-full-disk/`
- Windows DPAPI `CryptProtectData`:
  `https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata`
- Linux process environment:
  `https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html`
