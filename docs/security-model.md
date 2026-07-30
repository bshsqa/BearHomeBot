# BearHomeBot 보안 모델

## 신뢰하는 것

- 버전 관리와 review를 거친 BearHomeBot 코드와 정책
- Telegram Bot API가 제공한 private chat의 숫자 `user_id`
- 로컬 관리자가 등록한 allowlist
- 설치 시 빌드하고 실행 시 image ID를 기록한 validator image
- 모든 gate를 통과해 content digest가 고정된 active `k-skill` release

## 신뢰하지 않는 것

- Telegram 메시지 내용과 username
- Codex가 생성한 자연어, 명령, 사용자 ID, credential 이름
- 새 `k-skill` commit의 코드, 문서, test, package metadata
- dependency registry 응답과 runtime network 응답
- validation 중 후보가 생성하거나 수정한 파일

## 주요 경계

Telegram gateway는 숫자 `user_id`로 principal을 확정하고 이후 계층에
구조화된 값으로 전달한다. Codex text가 principal이나 권한을 바꿀 수
없다.

Codex 대화 runner는 Telegram token과 서비스 credential이 없는 allowlist
environment, 전용 workspace, read-only permission profile로 실행된다.
SQLite는 thread ID와 turn metadata만 저장하며 prompt와 답변 원문을
복제하지 않는다.

`k-skill` candidate는 secret 없는 rootless container에서만 test한다.
candidate가 작성한 validation tree는 폐기하며, active release는 검증된
동일 Git SHA에서 새로 만든다. 모든 오류와 불확실성은 fail-closed다.

서비스 credential은 normal state와 분리된 encrypted vault에 저장한다.
각 값은 AES-256-GCM으로 principal과 credential/version metadata에
인증 결합되며, WSL2 host의 master key는 Windows DPAPI `CurrentUser`로
감싼 값만 vault 밖의 owner-only keyring에 저장한다. Secret Broker socket은
metadata만 반환하고 secret value를 반환하는 API가 없다. Phase 6의
credentialed operation에서도 Codex가 secret 평문을 보거나 복호화하지
않고, broker 내부의 allowlisted handler가 pinned helper에만 잠시 주입한다.

## 방어 범위

현재 구현은 저장소 오염, 사용자 간 session 혼합, 단순 prompt replay,
candidate path escape, submodule과 symlink, 비정상 history, 과도한 tree,
임의 dependency source, candidate test의 network 접근, 실패한 release의
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
