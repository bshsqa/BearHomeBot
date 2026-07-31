# BearHomeBot 권한 모델

## 신뢰 경계

BearHomeBot의 핵심 신뢰 경계는 Telegram 숫자 user ID allowlist다.
allowlist에 등록된 사용자는 이 컴퓨터에서 실행되는 Codex와 사실상 같은
권한을 갖는다.

Codex는 다음 옵션으로 실행된다.

```text
--dangerously-bypass-approvals-and-sandbox
```

따라서 허용된 사용자의 요청은 파일 읽기와 쓰기, 프로그램 설치와 실행,
네트워크 요청, `k-skill` helper 실행, 로컬 credential 사용으로 이어질 수
있다. 이 모델은 서로를 신뢰하는 소수 가족과 개인용 PC를 전제로 한다.

## 유지하는 최소 경계

- private Telegram chat만 처리한다.
- 숫자 user ID가 allowlist에 있는 사용자만 Codex를 호출할 수 있다.
- 소유자 user ID만 `/shutdown` 확인 버튼으로 gateway를 종료할 수 있다.
- 종료 확인은 2분짜리 일회용 토큰이며 재사용할 수 없다.
- 각 사용자는 자신의 Codex session만 선택하고 resume할 수 있다.
- 같은 Telegram update는 SQLite checkpoint로 한 번만 처리한다.
- Telegram bot token은 Codex child environment에서 제거한다.
- Git은 `.env`, `secrets.env`, SQLite, `.runtime`, `k-skill/`과 Codex
  local state를 제외한다.

## credential

사이트 credential은 k-skill의 기본 파일에 평문 dotenv로 저장할 수 있다.

```text
~/.config/k-skill/secrets.env
```

권장 파일 mode는 `0600`이다. Codex는 사용자가 요청한 스킬을 실행할 때
이 파일을 직접 읽을 수 있다. BearHomeBot은 별도 vault, 암호화 DB 또는
Secret Broker를 제공하지 않는다.

Codex 프로젝트 지침은 credential 값을 답변이나 로그에 출력하지 않도록
요구하지만, 애플리케이션 차원의 강제 격리는 아니다.

## 운영 전제

- allowlist에는 이 PC의 셸 접근을 맡겨도 되는 사용자만 등록한다.
- 첫 번째 허용 사용자를 소유자로 기록하고 가족 사용자 추가 시 보존한다.
- Telegram 계정과 bot token을 안전하게 관리한다.
- 가족 사이에도 파일과 credential을 분리해야 한다면 이 구조를 사용하지
  않고 OS 계정 또는 별도 worker 격리를 먼저 설계한다.
- 동일 bot token의 gateway를 여러 PC에서 동시에 실행하지 않는다.
- 디스크 분실에 대비한 BitLocker, LUKS 같은 전체 디스크 암호화는 host
  수준에서 선택적으로 적용한다.
