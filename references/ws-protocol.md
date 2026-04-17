# e-plc-runtime WebSocket 프로토콜

> **출처**: `Program/e-plc-runtime/README.md:49-101`, `src/ws_server.cpp`
> 포트 기본 8765. JSON 한 줄당 한 메시지(프레임 단위).

## 런타임 실행

```bash
# 빌드(이미 되어있으면 생략)
cd Program/e-plc-runtime && mkdir -p build && cd build && cmake .. && make -j4

# 실행 (sim HAL)
./eplc_runtime --port 8765 --cycle 10 --hal sim
```

실행되면 stdout에 `WebSocket server listening on port 8765` 비슷한 문구 출력 (실제 문구는 `ws_server.cpp` 참조).

## 클라이언트 → 런타임 (command)

| cmd | payload | 반환 |
|---|---|---|
| `upload` | `{ "cmd":"upload", "il":"<IL 텍스트>" }` | `{"type":"ok","msg":"프로그램 업로드 완료 (N instructions)"}` 또는 `{"type":"error","msg":"파싱 오류: ..."}` |
| `start` | `{ "cmd":"start", "cycle_ms":10 }` | `{"type":"ok"}` — 스캔 루프 시작, state 브로드캐스트 개시 |
| `stop` | `{ "cmd":"stop" }` | `{"type":"ok"}` — 스캔 루프 정지 |
| `force` | `{ "cmd":"force", "device":"X0", "value":1 }` | `{"type":"ok"}` — sim HAL에서 입력 강제 설정 |
| `read_all` | `{ "cmd":"read_all" }` | `{"type":"state", ...}` 1회 즉시 응답 |

## 런타임 → 클라이언트 (events)

### 주기 브로드캐스트 (state, 100ms 간격)
```json
{
  "type": "state",
  "running": true,
  "cycle_ms": 10,
  "cycle_us": 9850,
  "devices": {"X0":0,"X1":1,"Y0":1,"M0":0,"T0":0,"C0":0, ...}
}
```

- `devices`에는 비트 디바이스가 0/1로 등장. 현재 프로젝트에서 참조된 디바이스만 포함(범위 전체 X).
- 타이머/카운터 CV/PV가 README에 명시적 채널로 없지만 `README.md:87-91`에 따르면 timers/counters가 state에 추가 필드로 포함될 수 있다(`doc/plc-simulation-plan.md` Phase 2 확장 예정 — **검증 시점에 실제 필드 유무 확인 필수**, 근거 없으면 `devices`만 사용).

### 단일 응답
```json
{"type":"ok","msg":"..."}
{"type":"error","msg":"..."}
```

## 시뮬레이션 테스트 기본 시퀀스

```
1. ws.connect("ws://localhost:8765")
2. send {"cmd":"upload","il":"<생성된 IL>"}
   └─ 응답이 error면 → 파싱 실패. reviewer에게 IL과 에러 함께 전달
3. send {"cmd":"start","cycle_ms":10}
4. 시나리오 루프:
   for step in scenario.steps:
     for (device, value) in step.inputs.items():
       send {"cmd":"force","device":device,"value":value}
     await (step.wait_ms)
     send {"cmd":"read_all"} 또는 가장 최근 state 사용
     실제 devices 상태와 step.expected 비교 → pass/fail 기록
5. send {"cmd":"stop"}
6. ws.close()
```

## 주의사항

- **cycle_ms** : 기본 10ms. TMR K1=100ms이므로 K10(1초) 검증 시 최소 1100ms는 대기해야 여유 있게 관찰 가능(스캔 한두 번 분 여유).
- **force 타이밍**: force는 스캔 사이클 경계에 적용된다. 연속 force 사이 1~2 cycle(20ms)은 대기하자.
- **타이머 리셋**: force로 X0=0 만든 뒤 T0 접점이 OFF 되기까지도 최소 한 스캔 필요.
- **포트 충돌**: 런타임이 이미 떠 있으면 EADDRINUSE. simulator는 시작 전에 `lsof -i :8765` 확인 및 정리.
- **sim HAL만 사용**: 본 스킬은 `--hal sim`만 지원. ethercat HAL은 실하드웨어 필요.

## 운영 체크리스트 (simulator용)

1. 이전 `eplc_runtime` 프로세스가 남아있는지 `pgrep eplc_runtime` 확인 → 있으면 `kill`
2. 필요 시 빌드: `build/eplc_runtime` 없거나 mtime이 src보다 오래됐으면 재빌드
3. 런타임 백그라운드 기동(`run_in_background`) → stdout에 listening 메시지 뜰 때까지 짧게 polling
4. 시나리오 실행 후 반드시 `stop`으로 종료하고, 시나리오 종료 시 런타임도 `kill`
