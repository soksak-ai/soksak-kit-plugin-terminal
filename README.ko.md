# soksak-kit-plugin-terminal

`soksak-spec-plugin-terminal` 0.0.5를 구현하는 터미널 플러그인의 공통 브라우저 구현입니다.

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

## 검증

이 패키지는 `@soksak/soksak-contract-plugin-terminal`에 의존하므로 설치를 수행하는 모든 `make`
호출은 명령줄 `REGISTRY`를 요구하며, 패키지가 `https://registry.npmjs.org`에 publish된 뒤에도
같습니다. Makefile은 이 요구를 `package.json`에서 읽으며 `REGISTRY`가 없으면
`REGISTRY required: this package depends on @soksak/...`으로 거부합니다.

```sh
make verify REGISTRY=http://host:port/
```

## 릴리즈

`OUT`과 `REGISTRY`는 make 명령줄 인자로만 받습니다. 환경 변수로 들어온 값은 거부합니다.
`OUT`은 절대 경로 디렉터리, `REGISTRY`는 `http://` 또는 `https://`로 시작하는 절대 URL이어야
OUT과 REGISTRY는 make 명령줄에서만 받습니다. 환경에서 온 값은 이름을 들어 거부합니다. GNU make 자체의
환경 채널(`MAKEFLAGS`, `GNUMAKEFLAGS`, `MAKEFILES`, `-e`)은 Makefile이 통제할 수 없으므로 거부하지
않습니다. 그것을 설정하는 것은 호출자의 의도적 행위입니다.

```sh
make release OUT=/absolute/dir REGISTRY=http://host:port/
make publish OUT=/absolute/dir REGISTRY=http://host:port/
```

`release`는 `verify`를 실행한 뒤 pack하고 두 digest를 출력합니다.

```sh
pnpm pack --pack-destination "$(OUT)"
shasum -a 256 "<tarball>"
gunzip -c "<tarball>" | shasum -a 256
```

gzip 바이트는 zlib 빌드마다 다르므로 tarball의 재현성은 압축을 푼 tar 스트림의 digest로
판정합니다. tarball digest는 업로드한 정확한 파일을 식별합니다. 레지스트리에 있는 tarball
바이트가 소비자에게 릴리즈 식별자입니다.

`publish`는 `release`를 실행한 뒤 바로 그 tarball을 업로드합니다.

```sh
pnpm publish "<tarball>" --registry "$(REGISTRY)" --@soksak:registry="$(REGISTRY)" --@soksak-ai:registry="$(REGISTRY)" --no-git-checks
```

`prepare`는 `@soksak`과 `@soksak-ai` 두 scope를 `REGISTRY`에서 설치하며 release-age 지연을
끄므로 방금 그 레지스트리에 publish한 버전도 해석됩니다. 설치가 실패하면 pnpm의 종료 상태로
종료합니다. 설치가 성공한 뒤 `pnpm-workspace.yaml`은 변경되지 않아야 하며 변경되면 65로
종료합니다.

```sh
pnpm install --frozen-lockfile --@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0
```
