# BearHomeBot 보안 모델

## 신뢰하는 것

- 버전 관리와 review를 거친 BearHomeBot 코드와 정책
- Telegram Bot API가 제공한 private chat의 숫자 `user_id`
- 로컬 관리자가 등록한 allowlist
- 로딩 안전 조건과 스킬별 동작 검토를 통과해 content digest가 고정된
  active `k-skill` release의 `enabledSkills`

## 신뢰하지 않는 것

- Telegram 메시지 내용과 username
- Codex가 생성한 자연어, 명령, 사용자 ID, credential 이름
- 새 `k-skill` commit의 코드, 문서, test, package metadata
- 스킬 문서가 설명하는 외부 서비스와 runtime network 응답

## 주요 경계

Telegram gateway는 숫자 `user_id`로 principal을 확정하고 이후 계층에
구조화된 값으로 전달한다. Codex text가 principal이나 권한을 바꿀 수
없다.

Codex 대화 runner는 Telegram token과 서비스 credential이 없는 allowlist
environment, 전용 workspace, read-only permission profile로 실행된다.
SQLite는 thread ID와 turn metadata만 저장하며 prompt와 답변 원문을
복제하지 않는다.

`k-skill` updater는 후보 코드와 test를 실행하지 않는다. exact Git SHA의
path, mode, symlink, submodule, 크기만 계산 가능한 로딩 조건으로 확인하고,
스킬별 SKILL.md와 연결된 구현 파일은 secret 없는 ephemeral Codex가
read-only로 읽어 개인정보 접근·외부 전송·credential 요구·명령 실행
동작을 검토한다. 모든 오류와 불확실성은 fail-closed다.

스킬 동작 검토 결과는 `skill ID + content digest + review policy version`으로
저장한다. 첫 baseline에서는 전체 스킬을 검토하고, 이후에는 새 스킬 또는
동작 범위의 내용 해시가 바뀐 스킬만 다시 검토한다. 변경되지 않은 승인
결과와 거부 결과를 모두 재사용하므로 같은 후보를 nightly update가 반복해도
LLM 검토를 반복하지 않는다.

검토가 완결되고 승인된 스킬이 하나 이상이면 release를 만들 수 있다.
`approved`만 `enabledSkills`에 등록하며 `uncertain`과 `rejected`는
`excludedSkills`로 남긴다. Capability Broker는 active release의
`enabledSkills`에 없는 스킬을 선택하거나 실행하지 않는다. 검토 중단처럼
전체 결과가 불완전하거나 승인된 스킬이 하나도 없는 후보는 승격하지 않는다.

Telegram의 기능 목록 응답도 같은 `enabledSkills`만 사용한다. active
release의 각 `SKILL.md`에서 크기가 제한된 frontmatter 설명만 읽고,
거부·보류된 스킬과 release 밖의 파일은 목록에 포함하지 않는다. 이 경로는
Codex를 호출하지 않으므로 자연어 모델이 존재하지 않는 스킬을 추가하거나
승인 목록을 누락하는 것을 방지한다.

특정 기능 질문을 Codex에 전달할 때도 전체 catalog를 넣지 않는다. 질문
문자열과 일치하는 승인 항목을 최대 5개로 제한하고, frontmatter 설명은
실행 지시가 아닌 비신뢰 데이터로 구분한다. 이 문맥은 기능 설명용일 뿐
스킬 실행 권한이나 credential 접근 권한을 부여하지 않는다.

서비스 credential은 normal state와 분리된 encrypted vault에 저장한다.
각 값은 AES-256-GCM으로 principal과 credential/version metadata에
인증 결합되며, WSL2 host의 master key는 Windows DPAPI `CurrentUser`로
감싼 값만 vault 밖의 owner-only keyring에 저장한다. Secret Broker socket은
metadata만 반환하고 secret value를 반환하는 API가 없다. Phase 6의 공통
Capability Broker에서도 Codex가 secret 평문을 보거나 복호화하지 않는다.
Broker는 Telegram principal, 승인 스킬 allowlist, provider credential
field mapping과 action policy를 검증한 뒤 필요한 값만 pinned helper에
잠시 주입한다. helper 결과는 구조화하고 중앙 redaction을 거친 뒤 Codex와
Telegram에 전달한다.

## 방어 범위

현재 구현은 저장소 오염, 사용자 간 session 혼합, 단순 prompt replay,
candidate path escape, submodule과 symlink, 비정상 history, 과도한 tree,
개인정보·credential의 숨은 외부 전송, 후보 코드 실행, 실패한 release의
승격을 방어한다.

다음 항목은 운영 host 단계에서 추가로 필요하다.

- Windows Device Encryption/BitLocker 또는 Linux LUKS full-disk encryption
  적용을 권장한다. 적용하지 않은 host에서도 credential vault의 평문 저장은
  허용하지 않으며 승인된 key provider가 없으면 credential 기능을 잠근다.
- gateway, Codex, updater, Secret Broker의 Unix account 분리
- WSL2에서는 Windows DPAPI, native Ubuntu에서는 TPM 또는 root-owned
  systemd credential처럼 host에 맞는 provider로 vault master key를 보관
- provider별 egress allowlist
- encrypted backup과 restore drill
- systemd hardening과 보안 update

로컬 Unix account나 실행 중인 운영체제 전체가 이미 침해된 상황은
애플리케이션 암호화만으로 완전히 방어할 수 없다. disk encryption,
process ownership, 최소 권한, credential 분리가 함께 적용되어야 한다.

현재 WSL2 host는 C 드라이브 암호화를 사용하지 않는다. 따라서 vault
database만 복사된 경우에는 application encryption이 보호하지만, 로그인된
Windows 계정 전체나 실행 중인 WSL user가 침해된 상황은 방어하지 못한다.
DPAPI `CurrentUser` keyring은 같은 Windows 사용자와 같은 PC에서만 정상
해제되는 운영 편의 선택이며, 다른 PC로 복사해 복호화하는 backup key가
아니다.
