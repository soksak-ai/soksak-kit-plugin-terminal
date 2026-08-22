# soksak-kit-plugin-terminal

`soksak-spec-plugin-terminal` 0.0.3을 구현하는 터미널 플러그인의 공통 브라우저 구현입니다.

이 kit가 view 등록, PTY 및 복원 수명 주기, 크기 변경, 공개 상태와 터미널 계약의 모든
표준 명령을 소유합니다. 플러그인은 엔진별 렌더링, 입력, IME, focus와 snapshot 적용을
renderer adapter로 제공할 수 있지만 수명 주기나 표준 명령을 교체할 수 없습니다.
플러그인 고유 명령은 명시적인 확장 명령으로만 등록합니다. 상태는 현재 플러그인 호스트 CSS 픽셀, 성공한 PTY 요청
크기, PTY 관측 크기와 이벤트 순서, 복원 관측 크기와 이벤트 순서, 렌더된 frame 크기를
구분해 반환합니다. 아직 도달하지 않은 경계는 `null`입니다.

크기 변경 작업은 한 번에 하나만 실행하며 진행 중 요청은 다음 최신 작업 한 번으로
병합합니다. wait는 현재 확정 상태를 먼저 검사하고 충족되지 않을 때만 사건을
구독합니다.
레이아웃 변경은 `ResizeObserver`와 호스트의 commit 이후 `layout.reflow` 사건을 함께
소비합니다. 두 신호는 같은 직렬 resize worker로 들어가며 주기 조회나 retry 경로는
없습니다.

플러그인은 자신의 매니페스트, 엔진 식별자, renderer adapter와 추가 명령을 소유합니다.
