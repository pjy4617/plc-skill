# 래더 그리드 배치 규칙 (11열)

> **출처**: `Program/e-plc/lib/model/types.ts:52-58`, `Program/e-plc/CLAUDE.md:34-40`, `lib/validator/ladder-validator.ts:139-148`

## 열 구성 (COLS = 11)

```
col 0  1  2  3  4  5  6  7  8  9  10
    [접점 영역 0~7]   [FUNCTION 8~9]  [COIL 10]
    ├──────────────┤  ├────────────┤  ├──────┤
```

| 열 범위 | 허용 요소 | 비고 |
|---|---|---|
| 0 ~ 7 | `NO_CONTACT`, `NC_CONTACT` | 접점 전용 |
| 8 ~ 9 | `FUNCTION` (2칸 점유, 배치 좌표는 8) | TMR/CNT 등. col=8에 하나 배치하면 8·9 둘 다 점유 |
| 10 | `COIL`, `SET_COIL`, `RST_COIL` | 우측 모선 직결 |

## 코일 배치 규칙

- `COIL`/`SET_COIL`/`RST_COIL`은 **반드시 `col = 10`**
- `validateLadder`가 `col < 8`인 코일을 감지하면 `COIL_POSITION` 경고(`lib/validator/ladder-validator.ts:141`)
- **코일 우측에 다른 요소가 있으면** `OUTPUT_IN_MIDDLE` 에러(`:275`)
- FUNCTION이 출력 역할을 하는 경우(TMR/CNT) 별도 COIL 불필요 — FUNCTION 자체가 출력

## 병렬 회로(row ≥ 1) 규칙

- Rung의 기본 `rows = 1` (row 0만 존재). 병렬 추가 시 `add_element`가 row=1 이상을 주면 `rows`가 자동 확장
- **왼쪽 모선은 자동 연결** — 명시적 add_connection 불필요
- **오른쪽(병렬이 끝나는 지점)만 `add_connection` 1회 호출**
- 수직선의 `fromCol`/`toCol`은 **병렬 접점의 col보다 1 이상 커야** 한다. path-tracer는 VERTICAL 연결 중 최소 fromCol을 `mergeCol`로 잡고, `col < mergeCol`인 접점만 병렬로 분류(`path-tracer.ts:62-76`).

### 예 1 — 기본 병렬 (X0 // X1) → Y0

접점 col=0, 수직선 col=1 (병렬 끝나는 지점).

```
row 0: [X0 col=0] ─────────────────── [Y0 col=10]
                  │
row 1: [X1 col=0] ─
                  (col=1 수직선)
```

tool_call 순서:
```
insert_rung
add_element    rung 0, NO_CONTACT, X0, row=0, col=0
add_element    rung 0, NO_CONTACT, X1, row=1, col=0
add_connection rung 0, from=(0,1) to=(1,1)   ← 오른쪽 묶음 1개만
add_element    rung 0, COIL, Y0, row=0, col=10
```
→ IL: `LD X0 / LD X1 / ORB / OUT Y0 / END`

### 예 2 — 자기유지 (X0 OR Y0) AND (NOT X1) → Y0

병렬 (X0, Y0)는 col=0, 수직선은 col=1. 그 뒤 직렬 NC(X1)은 col=2.

```
row 0: [X0 col=0] ─ [/X1 col=2] ────── [Y0 col=10]
                  │
row 1: [Y0 col=0] ─
                  (col=1 수직선)
```

tool_call 순서:
```
insert_rung
add_element    rung 0, NO_CONTACT, X0, row=0, col=0
add_element    rung 0, NO_CONTACT, Y0, row=1, col=0
add_connection rung 0, (0,1) → (1,1)         ← 오른쪽 1개만
add_element    rung 0, NC_CONTACT, X1, row=0, col=2
add_element    rung 0, COIL, Y0, row=0, col=10
```
→ IL: `LD X0 / LD Y0 / ORB / ANI X1 / OUT Y0 / END` (MELSEC 정석 자기유지)

> 핵심: 수직선의 col은 **병렬이 끝나는 지점**. 접점 col보다 1 이상 크게, 그 다음 직렬 접점 col보다 작거나 같게 둔다. 수직선이 접점 col과 같거나 작으면 해당 접점이 seriesAfter로 분류되어 병렬이 깨진다.

## 검증기가 잡는 배치 오류 (simulator가 정적 검증으로도 감지)

| 코드 | 조건 | 심각도 |
|---|---|---|
| `EMPTY_RUNG` | 요소 0개 | warning |
| `NO_OUTPUT` | 출력(코일/FUNCTION) 없음 | error |
| `NO_CONTACT` | 접점 없이 출력만 | warning (항상 ON) |
| `EMPTY_DEVICE` | `device`가 빈 문자열 | error |
| `UNKNOWN_DEVICE_TYPE` | 접두사가 X/Y/M/T/C/D/SM/SD 아님 | error |
| `DEVICE_OUT_OF_RANGE` | 인덱스 범위 초과 | error |
| `X_AS_OUTPUT` | X를 코일로 사용 | error |
| `D_AS_BIT` | D를 접점으로 사용 | warning |
| `COIL_POSITION` | 비-FUNCTION 출력이 col<8 | warning |
| `DOUBLE_COIL` | 같은 디바이스에 OUT 중복 | warning |
| `UNDEFINED_TIMER_COUNTER_CONTACT` | T/C 접점 사용 but TMR/CNT 정의 없음 | error |
| `TIMER_COUNTER_DEVICE_MISMATCH` | TMR이 T 아님 / CNT가 C 아님 | error |
| `TIMER_COUNTER_PRESET_MISSING` | K값 없음 | warning |
| `DUPLICATE_TIMER_COUNTER_COIL` | 같은 T/C를 여러 Rung에서 정의 | error |
| `COIL_AND_SETRST_CONFLICT` | OUT과 SET/RST 혼용 | warning |
| `OUTPUT_IN_MIDDLE` | 코일 우측에 다른 요소 | error |
| `UNBALANCED_VERTICAL_CONNECTION` | 수직선이 병렬 경로 미완성 | error |

writer는 이 규칙들을 **미리 만족하도록** 작성하고, simulator는 IL 컴파일 전에 `validateLadder`를 돌려 error가 있으면 런타임 시뮬 없이 reviewer로 넘긴다.

## 디바이스 접두사 규칙 요약

| 접두사 | 진법 | 비트/워드 | 사용 가능 위치 |
|---|---|---|---|
| X | **8진** | 비트 | 접점(입력) — 코일 불가 |
| Y | **8진** | 비트 | 접점/코일 |
| M | 10진 | 비트 | 접점/코일 |
| T | 10진 | 비트+CV | 접점/FUNCTION(TMR) |
| C | 10진 | 비트+CV | 접점/FUNCTION(CNT) |
| D | 10진 | 워드 | 현재 IL에서 직접 접점 사용 불가(MOV 미지원) |

X/Y를 10진으로 썼을 때 에디터는 `"잘못된 주소"` 에러. 예: `X8` 대신 `X10`.
