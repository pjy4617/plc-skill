# 래더 편집 툴 API (7종)

> **출처**: `Program/e-plc/app/api/ai-chat/route.ts:61-174`, `Program/e-plc/lib/ai/ladder-tools.ts:27-176`
> **불변 규칙**: 이 7개 외 도구는 존재하지 않는다. 새 도구를 발명하지 말 것.

writer 에이전트는 래더 작성 결과를 **반드시 이 7개 툴 호출의 JSON 배열**로 반환해야 한다. simulator는 `apply_tools.mjs`로 이 배열을 LadderProject로 변환한 뒤 IL 컴파일 → 런타임 시뮬한다.

## 공통 스키마

```json
{ "id": "<임의의 유니크 문자열>", "name": "<도구이름>", "input": { ... } }
```

`id`는 Anthropic tool_use_id와 호환되는 문자열이면 충분(`toolu_01_auto_<n>` 권장).

## 1) `insert_rung` — 새 Rung(래더 행) 삽입

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `comment` | string | 아니오 | Rung 설명(한국어). 기본 "" |
| `insertAfterIndex` | number | 아니오 | 이 인덱스 뒤에 삽입. **-1이면 맨 뒤에 추가**(기본). 0이면 첫 Rung 뒤 |

**예**: 새 Rung을 맨 뒤에 추가하고 코멘트 부여
```json
{ "name": "insert_rung", "input": { "comment": "모터 기동 자기유지", "insertAfterIndex": -1 } }
```

## 2) `add_element` — 접점/코일/응용명령 1개를 특정 셀에 추가

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `rungIndex` | number | 예 | 0부터 시작 |
| `elementType` | enum | 예 | `NO_CONTACT` · `NC_CONTACT` · `COIL` · `SET_COIL` · `RST_COIL` · `FUNCTION` |
| `device` | string | 예 | 일반: `"X0"`, `"Y1"`, `"M100"`. **FUNCTION**: `"TMR T0 K30"` · `"CNT C0 K10"` 형식 |
| `row` | number | 아니오 | 병렬 회로용 행번호(0 기본). row ≥ 1이면 add_connection 필요 |
| `col` | number | 예 | 접점 0~7 / FUNCTION 8 / COIL 10 (**후술 표 참조**) |

**열 배치 규칙**(`ladder-grid-rules.md` 참조):
- `NO_CONTACT`/`NC_CONTACT` → `col ∈ [0, 7]` (8~9는 FUNCTION용)
- `FUNCTION` (TMR/CNT 등) → **반드시 `col = 8`** (2칸 점유: 8~9, 10의 우측레일 접속)
- `COIL`/`SET_COIL`/`RST_COIL` → **반드시 `col = 10`**

**기존 (row, col) 위치에 요소가 있으면 덮어쓴다**(`ladder-tools.ts:75-94`). 같은 셀에 다른 디바이스 두 번 쓰면 뒤의 호출이 이긴다.

**예**:
```json
{ "name": "add_element", "input": { "rungIndex": 0, "elementType": "NO_CONTACT", "device": "X0", "row": 0, "col": 0 } }
{ "name": "add_element", "input": { "rungIndex": 0, "elementType": "COIL", "device": "Y0", "row": 0, "col": 10 } }
{ "name": "add_element", "input": { "rungIndex": 1, "elementType": "FUNCTION", "device": "TMR T0 K30", "row": 0, "col": 8 } }
```

## 3) `add_connection` — 병렬 회로용 수직 연결선

`row ≥ 1`에 요소를 추가한 뒤 **반드시** 이 도구로 상위 row와 묶어야 병렬 회로로 인식된다. 누락 시 `validateLadder` 가 `UNBALANCED_VERTICAL_CONNECTION` 에러 발생(`lib/validator/ladder-validator.ts:300`).

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `rungIndex` | number | 예 | |
| `fromRow` | number | 예 | 상위 row (보통 0) |
| `fromCol` | number | 예 | 병렬이 **끝나고 합쳐지는 지점** (merge col). 병렬 접점들의 col보다 커야 함 |
| `toRow` | number | 예 | 하위 row (≥1) |
| `toCol` | number | 예 | 보통 fromCol과 동일 |

**중요 규칙**: 왼쪽 모선(좌측 bus bar)은 자동으로 모든 row를 공통 접지한다. 따라서 **`add_connection`은 병렬 경로가 합쳐지는 "오른쪽" 지점 하나만** 호출하면 된다. path-tracer의 `mergeCol`은 VERTICAL 연결 중 가장 작은 `fromCol`로 정해지고, 그 값보다 **col이 작은** 접점들만 병렬 경로로 분류된다(`Program/e-plc/lib/compiler/path-tracer.ts:62-76`).

**예** — X0 // X1 병렬 회로:
```json
{ "name": "add_element", "input": { "rungIndex": 0, "elementType": "NO_CONTACT", "device": "X0", "row": 0, "col": 0 } }
{ "name": "add_element", "input": { "rungIndex": 0, "elementType": "NO_CONTACT", "device": "X1", "row": 1, "col": 0 } }
{ "name": "add_connection", "input": { "rungIndex": 0, "fromRow": 0, "fromCol": 1, "toRow": 1, "toCol": 1 } }
{ "name": "add_element", "input": { "rungIndex": 0, "elementType": "COIL", "device": "Y0", "row": 0, "col": 10 } }
```

→ IL: `LD X0 / LD X1 / ORB / OUT Y0`. 수직선 col=1이 접점 col=0보다 커서 X0·X1이 병렬 경로로 인식됨.

## 4) `set_rung_comment` — Rung 설명

| 필드 | 타입 | 필수 |
|---|---|---|
| `rungIndex` | number | 예 |
| `comment` | string | 예 |

가독성 및 이중 코일 추적에 활용. writer는 **모든 Rung에 한국어 코멘트**를 달 것.

## 5) `set_device_comment` — 디바이스 심볼 주석

| 필드 | 타입 | 필수 |
|---|---|---|
| `device` | string | 예 | `"X0"`, `"M100"` 등
| `comment` | string | 예 | `"기동 버튼"` 등

## 6) `delete_rung`

`{ "rungIndex": number }`. 인덱스가 유효하지 않으면 `executeLadderTool`이 `{success:false}` 반환 → simulator가 감지.

## 7) `delete_element`

`{ "rungIndex": number, "row": number, "col": number }` — 해당 셀의 요소 1개 삭제.

## 실행 순서 관례

1. `insert_rung`
2. `add_element`(접점들) — 왼쪽부터 오른쪽으로
3. `add_element`(row ≥ 1 요소들)
4. `add_connection`(수직 연결)
5. `add_element`(COIL 또는 FUNCTION) — 출력
6. `set_rung_comment`
7. `set_device_comment`

이 순서를 따르지 않으면 `rows` 자동 확장이 꼬이거나 `executeLadderTool`이 "Rung {i} 가 존재하지 않습니다"를 반환한다.

## 실패 모드

`executeLadderTool`이 반환할 수 있는 실패 메시지:
- `"Rung {N} 가 존재하지 않습니다"` — `rungIndex`가 범위 밖
- `"알 수 없는 도구: {name}"` — 7종 외의 이름
- `"오류: {Error}"` — 내부 예외

simulator는 이 메시지를 그대로 reviewer에게 전달한다.
