# k-skill 공급망과 운영

## 목적

BearHomeBot은 `k-skill` 저장소를 신뢰된 실행물로 바로 사용하지 않는다.
고정된 upstream에서 후보 commit을 가져오고, 계산 가능한 검사와 격리
실행, Codex 의미 검토를 모두 통과한 commit만 SHA별 불변 release로
활성화한다.

버전 관리되는 정책은 `config/k-skill-policy.json`에 있다. upstream URL,
branch, 크기 제한, registry, Python wheel, validator resource limit,
Codex review 정책을 바꾸려면 BearHomeBot 코드 변경과 동일한 review를
거쳐야 한다.

## 실행 단계

1. 정책에 고정된 `origin/main`만 bare mirror에 fetch한다.
2. candidate commit과 tree를 정확한 SHA로 해석하고 Git object
   connectivity를 검사한다.
3. active SHA가 있으면 candidate가 그 descendant인지 확인한다.
4. checkout 전에 NUL-delimited Git tree를 읽어 경로, mode, submodule,
   symlink, 파일 수와 크기, review 가능한 변경 경로 수를 검사한다.
5. 모든 `package.json`, lockfile v3, Python requirement source를
   구조적으로 검사하고 임의 URL, Git, file, link dependency를 거부한다.
6. fresh validation directory를 만들고 rootless Podman에서 dependency를
   lifecycle script 없이 획득하며 `npm audit --audit-level=high`를
   실행한다.
7. 동일 컨테이너 이미지를 network `none`, cache read-only, candidate
   source writable 조건으로 다시 실행해 `npm run ci`를 수행한다.
8. Codex를 ephemeral one-shot, read-only filesystem, JSON output schema,
   user config/rules 비활성화 조건으로 실행해 의미 기반 보안 검토를 한다.
9. validation 작업공간을 폐기하고 Git object에서 새 release를 다시
   materialize한다.
10. release content digest와 검증 metadata를 기록하고 read-only로 만든
    뒤 SQLite transaction으로 active SHA를 교체한다.

Codex 검토는 deterministic gate를 우회하거나 성공으로 바꿀 수 없다.
`rejected`, `uncertain`, malformed output, timeout, CLI 오류는 모두
promotion 실패다. high 또는 critical finding이 있는데 Codex가
`approved`를 반환해도 BearHomeBot이 `rejected`로 바꾼다.

## 격리 경계

Dependency 획득 stage에는 registry network가 있지만 후보 script를
실행하지 않는다. npm lifecycle script는 비활성화되고 Python package는
정책에 고정된 이름과 버전만 binary wheel로 내려받는다. 전이 의존성도
정책에 직접 열거하며 sdist build와 자동 dependency resolution을
허용하지 않는다.

Validation stage는 다음 경계를 사용한다.

```text
rootless Podman
network=none
read-only root filesystem
all Linux capabilities dropped
no-new-privileges
bounded CPU, memory, PID, time, output
secret-free explicit environment
dependency cache read-only
```

후보 test가 source tree를 변경할 수 있으므로 validation directory 자체는
승격하지 않는다. 승격 대상은 동일 SHA의 Git object에서 새로 만든 별도
release이며 content digest를 다시 확인한다.

Codex review에는 Telegram token, 서비스 credential, candidate 실행 권한,
network tool, app, plugin, hook, browser, memory, multi-agent 기능을
제공하지 않는다. Codex 인증은 CLI 자체가 사용하지만 model tool의
filesystem profile에는 candidate read 권한과 전용 review workspace만
포함된다.

## 명령

먼저 환경과 validator image를 준비한다.

```bash
./scripts/doctor.sh
./scripts/install.sh
```

현재 upstream을 실행 없이 검사한다.

```bash
./scripts/k-skill-updater.sh check
```

모든 gate를 수행하고 통과한 candidate를 활성화한다.

```bash
./scripts/k-skill-updater.sh update
```

현재 active SHA와 candidate 이력을 확인한다.

```bash
./scripts/k-skill-updater.sh status
```

직전 active release 또는 지정한 검증 release로 되돌린다.

```bash
./scripts/k-skill-updater.sh rollback
./scripts/k-skill-updater.sh rollback <commit-sha>
```

rollback도 저장된 release의 content digest가 일치하지 않으면 실패한다.
release는 자동 삭제하지 않으므로 정책의 최소 3개 보존 조건보다 적게
남기지 않는다. 정리 정책은 disk quota와 실행 중 job의 pinned SHA를
함께 추적할 수 있을 때 추가한다.

## 상태 경로

기본 경로는 다음과 같다.

```text
~/.local/share/bearhomebot/state.sqlite
~/.local/share/bearhomebot/k-skill/mirror.git
~/.local/share/bearhomebot/k-skill/releases/<sha>
~/.local/share/bearhomebot/k-skill/validation/
~/.local/share/bearhomebot/k-skill/review-workspace/
~/.cache/bearhomebot/k-skill/<sha>/
```

`BEARHOMEBOT_DATA_DIR`, `BEARHOMEBOT_CACHE_DIR`,
`BEARHOMEBOT_CONFIG_DIR`는 절대 경로로 재정의할 수 있다. updater lock은
data directory 아래 `k-skill/update.lock`이다.

## 실패 처리

- fetch나 Git object 검증 실패: candidate를 실행하지 않는다.
- deterministic gate 실패: candidate를 `rejected`로 기록한다.
- image, acquisition, audit, networkless CI 실패: candidate를
  `rejected`로 기록한다.
- Codex가 거부하거나 확신하지 못함: review와 함께 `rejected`로 기록한다.
- release materialization 또는 digest 검증 실패: active pointer를
  변경하지 않는다.
- promotion transaction 실패: 기존 active release를 유지한다.
- 동시 updater 실행: `flock --nonblock`이 두 번째 실행을 거부한다.

실패 상세 stdout/stderr는 사용자 응답이나 SQLite에 복제하지 않는다.
SQLite에는 stable failure code, SHA, manifest, validation summary,
structured review만 저장한다.
