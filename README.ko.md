# soksak-kit-plugin-terminal

`soksak-spec-plugin-terminal` 0.0.17을 구현하는 터미널 플러그인의 공통 브라우저 구현입니다.

이 kit가 view 등록, PTY 및 복원 수명 주기, 크기 변경, 공개 상태와 터미널 계약의 모든
표준 명령을 소유합니다. 플러그인은 엔진별 렌더링, 입력, IME, focus와 snapshot 적용을
renderer adapter로 제공할 수 있지만 수명 주기나 표준 명령을 교체할 수 없습니다.
플러그인 고유 명령은 명시적인 확장 명령으로만 등록합니다. 상태는 현재 플러그인 호스트 CSS 픽셀, 성공한 PTY 요청
크기, PTY 관측 크기와 이벤트 순서, 복원 관측 크기와 이벤트 순서, 렌더된 frame 크기를
구분해 반환합니다. 아직 도달하지 않은 경계는 `null`입니다.

크기 변경 작업은 한 번에 하나만 실행하며 진행 중 요청은 다음 최신 작업 한 번으로
병합합니다. wait는 현재 확정 상태를 먼저 검사하고 충족되지 않을 때만 사건을
구독합니다. 표준 `wait` command는 lifecycle, text, size, focus, cursor와 함께 renderer에
표시된 `themeMode`·`effectiveBackground`, 정확/최소 history size, 정확한 viewport offset,
`follow|pinned` mode를 요구할 수 있습니다. Frame은 history와 viewport 상태를 먼저 commit한
뒤 render status event를 게시하므로 output marker가 상태 wait를 먼저 끝낼 수 없습니다.
Presenter를 주기적으로 조회하는 wait 경로는 없습니다.
Presenter text read는 sync 또는 async일 수 있습니다. 표준 `read` command는 결과를 await하고
`{text:string}`만 게시하므로 IPC Promise가 command status로 노출되지 않습니다.
Selection read도 같은 경계를 따릅니다. `selection`과 `copy`는 native presenter를 await하고 resolve된
문자열만 게시하거나 복사합니다. 거부된 engine selection을 stale 또는 빈 성공으로 바꾸지 않습니다.
레이아웃 변경은 `ResizeObserver`와 호스트의 commit 이후 `layout.reflow` 사건을 함께
소비합니다. 두 신호는 같은 직렬 resize worker로 들어가며 주기 조회나 retry 경로는
없습니다.

플러그인은 자신의 매니페스트, 엔진 식별자, renderer adapter와 추가 명령을 소유합니다.

이 Kit은 browser-side terminal theme 게시를 소유합니다. Host의 명시적인 `light|dark` mode와
contract token을 읽고 presenter 상태를 검증한 뒤 `themeMode`, `baseTheme`,
`terminalOverrides`, `effectiveTheme`을 status·DOM data·`soksak:terminal-colors`로 게시합니다.
`terminal-screen`에는 effective semantic color와 indexed color 256개를 CSS property로
설정합니다. Plugin은 private theme map을 두거나 effective color 비교로 override 존재를
추측하지 않습니다. Native presenter는 `themeStatus`와 `onPresentationChanged`로 engine
상태를 게시하고 host의 `data-theme-epoch` event에서 `setTheme`을 받습니다. Polling과 terminal
output 재parse는 사용하지 않습니다.

## Clipboard와 file drop

Selection, copy, paste, drop은 공통 Kit 동작입니다. Copy와 암시적 paste는 host clipboard
capability만 사용합니다. Paste는 활성 presenter가 해당 engine mode를 보고할 때만 bracketed-paste
marker로 text를 감쌉니다. File drop은 불투명한 host grant만 받습니다. Host는 grant를 허용된 raw path로
redeem하고, 이 Kit이 `app.environment`에서 읽은 login shell에 맞춰 quote합니다. Core는 shell 문법을
소유하지 않으며 command가 raw path를 grant처럼 주입할 수 없습니다. Inline mode는 presenter capability가
있을 때만 실행하며 path 입력으로 fallback하지 않습니다. Pane은 `terminal-drop-target`, clipboard
permission, selection, bracketed-paste mode, 마지막 accepted/refused drop을 status·DOM data·event로
노출합니다.

## pane 이 터미널을 잃었을 때

pane 은 셸이 도는 자리이고, 그것을 스스로 유지합니다.

- pane 을 닫으면 세션이 끝나고, 마운트만 해제하면 세션은 남아 다시 마운트할 때 그 세션에 붙습니다.
- 쓰기 실패와 엔진에 미러가 없는 프레임은 세션이 사라졌다는 뜻이며, pane 은 세션을 다시 엽니다. 첫
  시도는 즉시, 이후는 최대 30초까지 간격을 두므로 바깥을 기다리는 pane 이 응용 전체를 잡아먹지 않습니다.
- 세션이 끝난 pane 은 보관된 화면을 보여준 뒤 셸을 엽니다. 관측이 끊긴 구간이 있어 화면을 되살릴 수
  없으면, 그 공백에서 실패하는 대신 셸에 새로 붙습니다.
- pane 은 세션이 있을 때 live 입니다. 세션 없이 live 라고 말하면 이후의 모든 키 입력이 아무도 서비스하지
  않는 번호로 갑니다.
- 살아난 pane 은 복구한 실패 표시를 지웁니다. 복구하지 못한 실패 — 거부된 체크포인트 — 는 남습니다.
- live 가 아닌 pane 은 그 단계를 pane 안에 적습니다. 빈 화면만으로는 유휴 셸과 구분되지 않습니다.

## 그리지 않는 것

레이아웃이 숨긴 pane 과, 호스트가 보여주지 않는 뷰의 모든 pane 은 프레임을 요청하지 않습니다. 세션과
출력은 유지되고, 다시 보이면 그때 프레임을 요청합니다. 2026-08-26 실측: 숨은 pane 이 4초에 195 프레임에서
0으로, 창의 렌더링 프로세스가 코어의 92.7% 에서 32.3% 로 내려갔습니다.
가시성에는 이름이 다른 소유자 둘이 있습니다. Workbench는 자체 split/maximize layout의
`intrinsicVisible`을 소유하고 Core는 workspace, tab, overlay, focus presentation의 `hostVisible`과
`dim`을 소유합니다. `effectiveVisible`은 두 값의 논리곱이며 render 작업 여부만 결정합니다. Native
presenter는 `intrinsicVisible`만 `data-native-visible`에 쓰고 Core host presentation은 view-slot
조상에 게시되므로 pre-DOM compositor stage를 오래된 중복 host 값이 거부하지 않습니다. 네 사실은
`data-terminal-intrinsic-visible`, `data-terminal-host-visible`,
`data-terminal-effective-visible`, `data-terminal-dim`으로 공개합니다. DOM 위치나
`IntersectionObserver`로 가시성을 추측하지 않습니다. 다시 effective visible이 되면 frame renderer는
최신 프레임을 요청하고 byte renderer는 보유한 버퍼를 한 번 다시 그립니다.

## 스트림 순서 규칙

PTY 출력은 하나의 절대 source sequence로 정렬합니다. 스트림 연결의 `startSeq`가 확정되기
전에 도착한 바이트는 보관하며, 연결 응답 뒤 그 `startSeq`부터 도착 순서대로 정확히 한 번
전달하고 ACK합니다. sequence 후퇴, 상대 좌표 ACK, 재시도, provider별 별도 스트림 경로는
허용하지 않습니다.
공개 상태는 PTY 생성, 복원 mirror 적용, renderer 적용 완료를 같은 절대 출력 좌표로
노출합니다. byte renderer는 parser callback이 끝난 뒤에만 완료하며 frame renderer는 frame과
원자적으로 반환된 sequence만 사용합니다.
하나의 pane은 하나의 renderer generation만 소유합니다. unmount는 정확한 byte stream을 닫고
Core close receipt를 기다린 뒤 PTY generation을 명시적으로 detach합니다. 교체 mount는 이
transaction이 끝난 뒤에만 시작하며 중지된 비동기 mount는 이후 open/attach할 수 없습니다.
Frame presenter는 `TerminalPresenterOptions.requestViewport`로 viewport를 요청합니다. Pane
session이 범위를 제한하고 engine에 해당 offset frame을 요청합니다. Renderer private DOM
event가 terminal history 이동을 소유하거나 조용히 흡수하지 않습니다.

## 검증

Node version은 `.node-version`이 소유합니다. `package.json#engines.node`와
`package.json#devEngines.runtime`은 package consumer와 direct pnpm 진입점을 위한 일치된
projection입니다. 로컬 환경과 GitHub Actions가 그 version을 선택한 뒤 같은 Make target을
호출합니다. 잘못된 Node에서 direct pnpm을 호출하면 dependency 해석 전에 실패합니다. pnpm은
script 실행 전에 어긋난 dependency tree를 몰래 복구하지도 않습니다. Dependency를
materialize하는 유일한 진입점은 `make prepare`입니다.
소유한 dependency 선언을 바꿀 때는 `make lock`만 lockfile을 재생성합니다. 이 명령은 package를
materialize하지 않고 lock만 갱신하며, 그 뒤 `make prepare`가 정확한 frozen 상태를 설치합니다.

이 패키지는 `@soksak/soksak-contract-plugin-terminal`에 의존하므로 설치를 수행하는 모든 `make`
호출은 명령줄 `REGISTRY`를 요구하며, 패키지가 `https://registry.npmjs.org`에 publish된 뒤에도
같습니다. Makefile은 이 요구를 `package.json`에서 읽으며 `REGISTRY`가 없으면
`REGISTRY required: this package depends on @soksak/...`으로 거부합니다.

```sh
make lock REGISTRY=http://host:port/
make verify REGISTRY=http://host:port/
```

## 릴리즈

`OUT`과 `COMMIT`은 make 명령줄 인자로만 받습니다. `OUT`은 절대 경로 디렉터리,
`COMMIT`은 정확한 소문자 Git SHA여야 합니다. 이 kit은 publish 가능한 portable component이며
canonical SDK/spec builder가 immutable GitHub release asset을 만듭니다. terminal plugin이 version으로
resolve할 수 있도록 선언된 package registry에도 정확한 package byte를 publish합니다.

```sh
make release COMMIT=<exact-git-sha> OUT=/absolute/dir REGISTRY=http://host:port/
make publish OUT=/absolute/dir REGISTRY=http://host:port/
```

`release`는 `verify`를 실행한 뒤 exact SDK로 위임합니다.

```sh
soksak-sdk package --root <absolute-kit-root> --spec-root <absolute-spec-package> \
  --commit <exact-git-sha> --out <absolute-release-directory>
```

`prepare`는 실제 사용하는 `@soksak` scope를 `REGISTRY`에서 설치하며 release-age 지연을 끄므로
방금 그 레지스트리에 publish한 버전도 해석됩니다. 설치가 실패하면 pnpm의 종료 상태로
종료합니다. 설치가 성공한 뒤 `pnpm-workspace.yaml`은 변경되지 않아야 하며 변경되면 65로
종료합니다.

```sh
pnpm install --frozen-lockfile --@soksak:registry=$(REGISTRY) --config.minimum-release-age=0
```
