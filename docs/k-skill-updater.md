# k-skill 로딩과 증분 동작 검토

## 목적

BearHomeBot은 `k-skill`을 저장소 전체의 일반적인 소프트웨어 품질로
평가하지 않는다. 핵심 승인 기준은 각 스킬이 설명한 목적대로 동작하고,
사용자의 개인정보·credential·파일·메시지·환경정보를 숨기거나 불필요하게
외부로 전송하지 않는지다.

updater는 후보 코드, test, package script 또는 installer를 실행하지 않는다.
`npm audit`, dependency 다운로드, 후보 전체 CI, Podman validator는 이
로딩 경로에 포함하지 않는다.

## 실행 단계

1. 정책에 고정된 upstream `main`을 bare mirror에 fetch한다.
2. candidate commit과 tree를 정확한 SHA로 해석하고 Git object 연결성을
   확인한다.
3. active SHA가 있으면 candidate가 그 descendant인지 확인한다.
4. checkout 전에 path escape, reserved path, symlink, submodule, 비정상
   file mode, 파일 수와 크기 제한을 확인한다.
5. 후보를 임시 read-only 검토 대상으로 materialize하고 top-level
   `*/SKILL.md`를 스킬 목록으로 찾는다.
6. 각 스킬에 다음 파일을 묶어 content digest를 계산한다.
   - 해당 스킬 directory 전체
   - 같은 이름의 `packages/<skill-id>` local package
   - 그 package가 의존하는 다른 local workspace package
   - 스킬 구현이 명시적으로 참조한 repository 내부 helper와 top-level
     스킬을 연쇄적으로 추적한 범위
   - `SKILL.md`의 설명이나 문서 링크는 검토 범위에는 포함하되, 실행 코드가
     명시적으로 참조한 top-level 스킬만 필수 실행 의존성으로 기록
7. SQLite에서 같은 `skill ID + content digest + review policy version`의
   기존 결과를 찾는다.
8. cache가 없는 스킬만 정책의 batch 크기로 나누고 최대 3개의 ephemeral
   Codex에 병렬 전달한다.
9. 검토가 완결되면 `approved` 스킬은 `enabledSkills`에 넣고 `uncertain`
   또는 `rejected` 스킬은 `excludedSkills`에 넣는다. 제외된 스킬에
   의존하는 상위 스킬도 연쇄 제외한다.
10. 승인된 스킬이 하나 이상이면 동일 Git SHA에서 fresh release를 만들고
    두 목록을 metadata에 고정한 뒤 active pointer를 원자적으로 교체한다.
    검토가 불완전하거나 승인된 스킬이 하나도 없으면 승격하지 않는다.

## 최초 검토와 nightly 증분 검토

- active release와 review cache가 없는 최초 update는 전체 스킬을 검토한다.
- upstream SHA가 active SHA와 같으면 Codex를 호출하지 않는다.
- 새 commit이 있어도 스킬 content digest가 모두 같으면 Codex를 호출하지
  않고 기존 approved 결과를 재사용한다.
- 새 스킬 또는 content digest가 달라진 스킬만 다시 검토한다.
- 삭제된 스킬은 더 이상 실행 대상이 아니므로 LLM 검토 대상이 아니다.
- 한 스킬이 거부되더라도 그 전에 완료된 스킬별 결과는 cache에 남는다.
  다음 patch에서는 같은 내용을 다시 검토하지 않는다.
- rejected 또는 uncertain digest도 cache한다. 같은 내용을 매일 재검토하지
  않으며, 내용 수정 또는 `behaviorReview.policyVersion` 증가가 있어야 새
  검토가 수행된다.
- 한 candidate의 모든 스킬은 끝까지 분류한다. 일부 결과가 `rejected` 또는
  `uncertain`이어도 승인된 스킬은 등록하고 해당 스킬만 실행 대상에서
  제외한다.

검토 정책 자체가 바뀌어 전체 재검토가 필요하면
`config/k-skill-policy.json`의 `behaviorReview.policyVersion`을 올린다.

## LLM 동작 검토 기준

Codex는 각 스킬의 `SKILL.md`와 계산된 구현 범위만 읽고 다음을 구조화해
반환한다.

- 읽는 사용자·로컬 데이터
- 요구하는 credential
- 접속하는 외부 destination
- 외부로 보내는 데이터
- command, browser 또는 local helper 실행 동작

다음은 거부한다.

- 목적에 필요하지 않거나 숨겨진 개인정보·credential·cookie·token·파일
  전송
- 사용자나 모델에게 secret 노출을 요구하는 지시
- arbitrary remote code/download 실행
- 숨은 telemetry 또는 secret logging
- Secret Broker와 Capability Broker의 구조화 실행 경계 우회
- 설명한 목적과 실질적으로 다른 동작
- 파괴적이거나 되돌리기 어려운 숨은 action

명시한 서비스에 목적 수행에 필요한 최소 데이터만 보내는 정상적인 요청은
그 사실이 드러나 있고 비례적이면 승인할 수 있다. 증거가 부족하면
`uncertain`으로 처리하며 해당 스킬을 `excludedSkills`에 넣는다.

## 실행 allowlist

release directory에는 같은 upstream SHA의 전체 tree가 들어갈 수 있지만,
실행 권한은 release metadata의 `enabledSkills`로 결정한다. 향후
Capability Broker와 모든 runner는 스킬을 선택하거나 helper를 시작하기
전에 현재 active release의 SHA와 `enabledSkills`를 함께 확인해야 한다.
`excludedSkills` 또는 목록에 없는 스킬은 파일이 존재해도 실행하지 않는다.

## Codex 격리

검토 Codex는 다음 조건으로 실행한다.

```text
ephemeral one-shot
candidate read-only
dedicated review workspace
no candidate execution
no network/browser/app/plugin/hook/memory/multi-agent tools
no Telegram token or service credential
strict JSON output schema
bounded time and output
```

candidate 안의 `AGENTS.md`, `CLAUDE.md`, `SKILL.md`와 모든 자연어는
untrusted data다. 검토 prompt는 그 안의 지시를 따르지 않도록 명시한다.

## 남겨 두는 로딩 안전 조건

다음 검사는 스킬 품질 평가가 아니라 후보를 안전하게 읽고 불변 release로
만들기 위한 최소 조건이므로 유지한다.

- exact upstream URL, branch, commit SHA
- fast-forward history
- Git object connectivity
- path escape와 reserved metadata 차단
- symlink와 submodule 차단
- regular/executable file mode만 허용
- file count, single-file size, total tree size 제한
- release content digest와 read-only permission
- atomic active pointer와 rollback digest 확인

## 제거한 검사

다음은 k-skill 로딩 승인 기준에서 제거했으며 관련 validator 코드와 설치
요구사항도 함께 삭제했다.

- npm dependency acquisition
- `npm audit` vulnerability hard gate
- package-lock과 dependency source 정책 검사
- Python wheel 사전 다운로드
- 후보 전체 `npm run ci`
- rootless Podman validator image와 cache
- changed-path 개수에 따른 후보 거부

라이브러리 취약점이나 upstream test 품질은 필요할 때 별도의 진단 정보로
확인할 수 있지만, 스킬이 개인정보를 부당하게 옮기는지에 대한 동작 승인과
섞지 않는다.

## 명령

현재 upstream을 실행 없이 로딩 안전 조건만 확인한다.

```bash
./scripts/k-skill-updater.sh check
```

필요한 스킬 동작 검토를 수행하고 승인된 스킬 목록을 활성화한다.

```bash
./scripts/k-skill-updater.sh update
```

현재 active SHA와 candidate 이력을 확인하거나 rollback한다.

```bash
./scripts/k-skill-updater.sh status
./scripts/k-skill-updater.sh rollback
./scripts/k-skill-updater.sh rollback <commit-sha>
```

## 상태 경로

```text
~/.local/share/bearhomebot/state.sqlite
~/.local/share/bearhomebot/k-skill/mirror.git
~/.local/share/bearhomebot/k-skill/review-candidates/
~/.local/share/bearhomebot/k-skill/review-workspace/
~/.local/share/bearhomebot/k-skill/releases/<sha>
```

review candidate directory는 검토 후 폐기한다. 스킬별 review cache와 release
metadata는 SQLite에 남는다.

## 실패 처리

- fetch나 로딩 안전 조건 실패: candidate를 실행하거나 검토하지 않는다.
- Codex가 `rejected` 또는 `uncertain`을 반환: 해당 digest 결과를 저장하고
  해당 스킬만 `excludedSkills`에 넣는다.
- 모든 스킬 검토가 끝났지만 `approved`가 없음: candidate를 승격하지
  않는다.
- Codex timeout, malformed output 또는 CLI 오류: candidate를 승격하지
  않는다.
- release 생성, digest 검증 또는 promotion transaction 실패: 기존 active
  release를 유지한다.
- 동시 updater 실행: `flock --nonblock`이 두 번째 실행을 거부한다.

상세 stdout/stderr, prompt, candidate 파일 내용과 credential은 SQLite나
사용자 응답에 복제하지 않는다. SHA, skill digest, structured review,
token usage와 stable failure code만 남긴다.
