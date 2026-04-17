---
name: e-plc-ladder
description: e-plc 웹 에디터(OpenPLC + EtherCAT + CM5 기반, 미쯔비시 MELSEC 스타일)의 래더 프로그램을 자연어 요구사항으로부터 생성한다. 웹 AI 채팅 모드에서는 LLM이 7종 래더 편집 tool(insert_rung / add_element / add_connection / set_rung_comment / set_device_comment / delete_rung / delete_element)을 직접 호출해 래더를 구성하고, CLI(Claude Code) 모드에서는 writer→simulator→reviewer 3-agent 루프로 검증까지 수행한다. 두 환경 모두에서 MELSEC GX Works 스타일 니모닉을 이해하되, 실행은 e-plc-runtime이 지원하는 12 opcode(LD/LDI/AND/ANI/OR/ORI/ORB/ANB/OUT/SET/RST/END + TMR/CNT)로 한정한다. "래더 작성", "PLC 래더", "ladder program", "자기유지 회로", "타이머 지연", "모터 제어", "시퀀스 제어", "PLC 시뮬레이션", "래더 테스트" 등의 요청에 반드시 자동 적용한다.
---

# e-plc Ladder Program Skill

OpenPLC 기반 e-plc 웹 에디터 및 CLI 환경 양쪽에서 동작하는 래더 프로그램 작성 스킬이다. **실행 환경에 따라 동작이 근본적으로 달라지므로 가장 먼저 환경을 판정**한다.

---

## 🚨 0. 실행 환경 감지 (가장 먼저 수행)

이 스킬은 **두 환경**에서 로드될 수 있고, 각 환경에서 해야 할 일이 서로 다르다.

### 판정 규칙 (결정적)

현재 가용한 도구(tools) 목록에 **`insert_rung`** 이 있는지를 기준으로 판정한다.

| 조건 | 환경 | 동작 모드 |
|---|---|---|
| `insert_rung` 도구가 있음 | **웹 AI 채팅 모드** (e-plc Next.js `/ladder` 페이지의 AIChatPanel) | **§1 웹 모드 섹션만 따른다** |
| `Task` / `Bash` 도구가 있고 `insert_rung` 이 없음 | **CLI (Claude Code) 모드** | §2 CLI 모드 섹션을 따른다 |
| 둘 다 없음 | 알 수 없음 | 사용자에게 환경을 물어본다 |

### 대원칙

- **환경을 착각하면 스킬이 동작하지 않는다.** 웹 모드에서 `Task(...)`, `node scripts/pipeline.mjs`, `bash`, `eplc_runtime` 실행을 시도해도 **그런 도구는 존재하지 않으며 응답이 실패 없이 무시된다.** 사용자는 "AI가 계획만 쓰고 래더를 안 만든다"고 느낀다. (실제 2026-04-17 현장 재현: 이 파일 이전 버전이 `Task / pipeline.mjs` 경로를 제1절차로 명시했기 때문에 발생한 버그다.)
- **웹 모드에서는 LLM이 직접 tool_use 호출로 래더를 만든다.** 서브에이전트 호출·bash·Node 실행을 시도하지 않는다.
- **CLI 모드에서는** §2의 writer→simulator→reviewer 루프를 사용한다.

---

## 1. 웹 AI 채팅 모드 (e-plc 기본 환경)

> **전제**: 현재 사용 가능한 도구에 `insert_rung`, `add_element`, `add_connection`, `set_rung_comment`, `set_device_comment`, `delete_rung`, `delete_element` 7종이 포함돼 있다. 그 외 서브에이전트(`Task`), 쉘(`Bash`), 파일시스템(`Read`/`Write`) 도구는 **존재하지 않는다**고 간주하고 호출 시도조차 하지 말아야 한다.

### 1.1 해야 하는 일 (단일 책임)

**사용자 요구사항 → 이 7개 tool의 tool_use 호출 시퀀스**를 생성해 **같은 응답 안에서 직접 실행**한다. 계획/설계 마크다운만 출력하고 끝내는 것은 실패다.

### 1.2 하지 말아야 하는 일 (중요)

- ❌ `Task(subagent_type="ladder-writer", ...)` 같은 서브에이전트 호출 — 웹에는 Task 도구 없음
- ❌ `node scripts/pipeline.mjs`, `node scripts/apply_tools.mjs` 등 bash/Node 실행
- ❌ `eplc_runtime` 바이너리 구동·재빌드
- ❌ tool_calls JSON을 마크다운 코드펜스에만 써놓고 종료 — 반드시 **실제 tool_use 이벤트**로 호출해야 한다
- ❌ 사용자에게 "수동으로 다음 JSON을 import 하세요" 안내 (시뮬 검증은 웹에선 불가하지만 편집은 100% 자동이어야 함)
- ❌ ladder-simulator, ladder-reviewer 루프 시뮬레이션 — 웹에서는 실행 불가

### 1.3 사용 가능한 7개 도구 (웹 모드 전용)

| # | 도구 | 용도 | 필수 입력 |
|---|---|---|---|
| 1 | **`insert_rung`** | 새 Rung(래더 라인) 삽입 | (선택: `comment`, `insertAfterIndex`) |
| 2 | **`add_element`** | 접점·코일·FUNCTION 1개 추가 | `rungIndex`, `elementType`, `device`, `col` |
| 3 | **`add_connection`** | 병렬 회로 수직 연결선 | `rungIndex`, `fromRow`, `fromCol`, `toRow`, `toCol` |
| 4 | **`set_rung_comment`** | Rung 코멘트 설정 | `rungIndex`, `comment` |
| 5 | **`set_device_comment`** | 디바이스 심볼 주석 | `device`, `comment` |
| 6 | **`delete_rung`** | Rung 삭제 | `rungIndex` |
| 7 | **`delete_element`** | 요소 1개 삭제 | `rungIndex`, `row`, `col` |

자세한 스키마는 `references/ladder-tools-api.md`.

### 1.4 런타임 제약 (웹 모드에서도 반드시 준수)

- **지원 opcode 12종**: `LD, LDI, AND, ANI, OR, ORI, ORB, ANB, OUT, SET, RST, END`
- **TMR/CNT FUNCTION만 지원** (`OUT T<n> K<pv>` / `OUT C<n> K<pv>`로 컴파일)
  - K1 = 100ms (K10=1초, K30=3초)
- **미지원 (생성 금지)**: MOV/CMP/PLS/PLF/LDP/LDF/MC/MCR/MPS/MRD/MPP/CJ/JMP/CALL/SRET/FOR/NEXT/사칙연산/적산 타이머(ST)/래치(L)/특수릴레이(SM,SD)/비교접점(LD=, LD< 등)
- **디바이스 범위**: X/Y 0~255 **8진**(X8·X9 금지, X10이 8번째), M 0~4095, D 0~8191, T 0~255, C 0~255

미지원 기능 요청 시 → **생성 중단 후** 사용자에게 "런타임 미지원. 자기유지+TMR 조합으로 대체 가능한지 확인 부탁드립니다"라고 안내.

### 1.5 배치 규칙 (웹 모드 — 필수)

- 그리드: 11열(0~10).
- `NO_CONTACT` / `NC_CONTACT` → `col ∈ [0, 7]`
- `FUNCTION` (TMR/CNT) → **`col = 8` 고정** (2칸 점유: 8~9). 별도 COIL 불필요(FUNCTION이 출력 역할).
- `COIL` / `SET_COIL` / `RST_COIL` → **`col = 10` 고정**
- 병렬 회로: `row ≥ 1`에 요소 추가 후 **오른쪽 합류 지점에 `add_connection` 1회**. `fromCol`은 병렬 접점들의 `col`보다 커야 함(path-tracer가 mergeCol로 사용).

### 1.6 웹 모드 체크리스트 (응답 생성 순서)

반드시 이 순서로 작업한다. 단계를 건너뛰면 래더가 엉키거나 `Rung {i}가 존재하지 않습니다` 오류가 발생한다.
**특히 [5] Pseudo 시뮬레이션과 [6] Pseudo 리뷰는 건너뛰지 말 것** — 2026-04-17 현장 재현: "편집만 되고 시뮬/리뷰가 빠졌다"는 사용자 불만의 근본 원인이 이 두 단계 누락이다.

```
[1] 요구사항 재진술 (1~3줄, 한국어) — 애매하면 질문 후 진행
[2] I/O 할당표 — X/Y/M/T/C/D 매핑 (짧은 테이블)
[3] Rung 설계 — 각 Rung이 무엇을 하는지 한 줄씩
[4] ★ 도구 호출 시퀀스 실행 ★ — 이 단계를 반드시 같은 응답에서 수행
     Rung 당 순서:
        insert_rung
     → add_element(접점들, row=0, col 0→7)
     → add_element(병렬 접점들, row=1+, col 동일)
     → add_connection(오른쪽 합류점)
     → add_element(COIL col=10 또는 FUNCTION col=8)
     → set_rung_comment
     → set_device_comment(해당 Rung에 처음 등장한 디바이스들)
[5] Pseudo 시뮬레이션 (LLM in-context trace)  ★필수★  — §1.11 참조
[6] Pseudo 리뷰 (정적 체크리스트)               ★필수★  — §1.12 참조
[7] 완료 요약 + 실제 시뮬 안내 — §1.13 참조 (F4 / 시뮬레이션 탭)
```

**주의**: 실제 `eplc_runtime` 바이너리는 웹 AI 채팅 런타임에서 실행 불가. 따라서 [5]/[6]은 실제 실행이 아니라 **LLM이 생성한 IL을 머리로 트레이스**하는 "Pseudo" 검증이다. 라벨에 반드시 **"Pseudo 시뮬"**, **"Pseudo 리뷰"** 로 표기해 사용자가 실제 실행과 혼동하지 않도록 한다.

### 1.7 자체 검증 (tool_use 발행 직전)

- [ ] 7개 도구 외 이름을 쓰지 않았는가? (Task/bash 등 호출하지 않았는가?)
- [ ] 모든 COIL이 `col=10`인가?
- [ ] 모든 FUNCTION이 `col=8`인가?
- [ ] 접점이 `col 0~7` 범위인가?
- [ ] 병렬 회로마다 `add_connection`이 하나씩 있고 `fromCol` > 접점 col인가?
- [ ] 같은 T/C 번호가 여러 Rung에서 FUNCTION으로 중복 정의되지 않는가?
- [ ] X 디바이스를 COIL/SET_COIL/RST_COIL에 쓰지 않는가?
- [ ] 모든 Rung에 한국어 코멘트가 있는가?
- [ ] opcode가 12종 + TMR/CNT 범위 안인가?

### 1.8 웹 모드 표준 템플릿 (즉시 호출 가능)

#### A. 자기유지 (X0 기동 / X1 정지 / Y0 출력)

호출할 tool_use (순서대로):
1. `insert_rung` — `{ comment: "모터 기동/정지 자기유지", insertAfterIndex: -1 }`
2. `add_element` — `{ rungIndex:0, elementType:"NO_CONTACT", device:"X0", row:0, col:0 }`
3. `add_element` — `{ rungIndex:0, elementType:"NO_CONTACT", device:"Y0", row:1, col:0 }`
4. `add_connection` — `{ rungIndex:0, fromRow:0, fromCol:1, toRow:1, toCol:1 }`
5. `add_element` — `{ rungIndex:0, elementType:"NC_CONTACT", device:"X1", row:0, col:2 }`
6. `add_element` — `{ rungIndex:0, elementType:"COIL", device:"Y0", row:0, col:10 }`
7. `set_rung_comment` — `{ rungIndex:0, comment:"X0=기동, X1=정지 자기유지" }`
8. `set_device_comment` — `{ device:"X0", comment:"기동 버튼" }`
9. `set_device_comment` — `{ device:"X1", comment:"정지 버튼" }`
10. `set_device_comment` — `{ device:"Y0", comment:"모터 출력" }`

예상 IL: `LD X0 / LD Y0 / ORB / ANI X1 / OUT Y0 / END`

#### B. 타이머 3초 지연 (X0 ON 후 3초 → Y0 ON)

1. `insert_rung` — `{ comment:"X0 ON 후 3초 지연 타이머 T0" }`
2. `add_element` — `{ rungIndex:0, elementType:"NO_CONTACT", device:"X0", row:0, col:0 }`
3. `add_element` — `{ rungIndex:0, elementType:"FUNCTION", device:"TMR T0 K30", row:0, col:8 }`
4. `set_rung_comment` — `{ rungIndex:0, comment:"X0 ON → 3초 카운트" }`
5. `insert_rung` — `{ comment:"T0 만료 시 Y0 ON" }`
6. `add_element` — `{ rungIndex:1, elementType:"NO_CONTACT", device:"T0", row:0, col:0 }`
7. `add_element` — `{ rungIndex:1, elementType:"COIL", device:"Y0", row:0, col:10 }`
8. `set_rung_comment` — `{ rungIndex:1, comment:"타이머 만료 → 출력 Y0" }`
9. `set_device_comment` — `{ device:"X0", comment:"기동 입력" }`
10. `set_device_comment` — `{ device:"T0", comment:"3초 지연 타이머" }`
11. `set_device_comment` — `{ device:"Y0", comment:"지연 출력" }`

예상 IL: `LD X0 / OUT T0 K30 / LD T0 / OUT Y0 / END`

#### C. 1Hz 점멸 (X0 ON 동안 Y0가 1초마다 ON/OFF)

T0/T1 상호 리셋으로 0.5s/0.5s 플립플롭 구성 후 T0으로 Y0 구동:

1. `insert_rung` — `{ comment:"T1 OFF 구간에서 T0 카운트 (0.5s)" }`
2. `add_element` — `{ rungIndex:0, elementType:"NO_CONTACT", device:"X0", row:0, col:0 }`
3. `add_element` — `{ rungIndex:0, elementType:"NC_CONTACT", device:"T1", row:0, col:1 }`
4. `add_element` — `{ rungIndex:0, elementType:"FUNCTION", device:"TMR T0 K5", row:0, col:8 }`
5. `insert_rung` — `{ comment:"T0 ON되면 T1 카운트 (0.5s)" }`
6. `add_element` — `{ rungIndex:1, elementType:"NO_CONTACT", device:"T0", row:0, col:0 }`
7. `add_element` — `{ rungIndex:1, elementType:"FUNCTION", device:"TMR T1 K5", row:0, col:8 }`
8. `insert_rung` — `{ comment:"T0 ON 동안 Y0 ON → 1Hz 점멸" }`
9. `add_element` — `{ rungIndex:2, elementType:"NO_CONTACT", device:"T0", row:0, col:0 }`
10. `add_element` — `{ rungIndex:2, elementType:"COIL", device:"Y0", row:0, col:10 }`
11. `set_rung_comment` — `{ rungIndex:0, comment:"T1 OFF 구간 동안 0.5s 측정" }`
12. `set_rung_comment` — `{ rungIndex:1, comment:"T0 만료 시 T1 0.5s 측정 시작" }`
13. `set_rung_comment` — `{ rungIndex:2, comment:"T0 상태 → Y0 (1초 주기)" }`
14. `set_device_comment` — `{ device:"X0", comment:"점멸 기동" }`
15. `set_device_comment` — `{ device:"T0", comment:"0.5s 타이머 (OFF구간)" }`
16. `set_device_comment` — `{ device:"T1", comment:"0.5s 타이머 (ON구간 리셋용)" }`
17. `set_device_comment` — `{ device:"Y0", comment:"1Hz 점멸 출력" }`

예상 IL: `LD X0 / ANI T1 / OUT T0 K5 / LD T0 / OUT T1 K5 / LD T0 / OUT Y0 / END`

### 1.9 웹 모드 완료 후 사용자 안내 문구 (권장)

`§1.13 완료 요약 표준 문구` 참조. 간단 요약: "N개 Rung 편집 / tool_use M회 호출 / Pseudo 시뮬 passed·warn / 실제 검증은 F4 + 시뮬레이션 탭".

### 1.10 웹 모드 제약 및 한계

- **실제 시뮬레이션은 웹 클라이언트가 담당**: LLM이 수행하는 [5] Pseudo 시뮬은 머리로 하는 IL 트레이스이며, 실제 바이너리 실행이 아님. 최종 동작 검증은 e-plc UI 하단 "시뮬레이션" 탭에서 사용자가 X 입력을 토글해 수행.
- **재시도 시 주의**: 이미 Rung이 있는 상태에서 새로 편집할 때는 `insertAfterIndex`를 적절히 쓰거나 `delete_rung`으로 정리 후 추가. 덮어쓰기 실수를 피하기 위해 "현재 프로젝트 상태" 섹션(`projectContext`)을 먼저 읽는다.
- **병렬 회로 자기유지 필수 패턴**: Y0 COIL의 상태를 `add_element(rungIndex, "NO_CONTACT", "Y0", row:1, col:0)` + `add_connection`으로 피드백해야 자기유지가 성립한다.

---

### 1.11 ★ Pseudo 시뮬레이션 ([5] 단계 상세) ★

**목적**: tool_use로 래더를 편집한 직후, 실제 `eplc_runtime` 실행 없이 **LLM이 in-context로 IL을 트레이스**해 동작을 사용자에게 미리 보여준다. 실제 실행 아님을 **"Pseudo"** 라벨로 명시.

#### 1.11.1 입력 준비

1. **IL 유도**: §1.8 템플릿 또는 `references/supported-opcodes.md` 규칙대로 방금 만든 Rung들을 MELSEC IL로 변환. 각 Rung은 한 줄씩 `LD / LDI / AND / ANI / OR / ORI / ORB / ANB / OUT / SET / RST` 로 기술하고 마지막에 `END`.
2. **시나리오 결정**: 사용자가 명시한 입력 순서가 있으면 그대로. 없으면 요구사항에서 다음 우선순위로 자동 추론:
   - (a) 입력 디바이스(X) **초기 전부 OFF 상태(사이클 0)**
   - (b) 핵심 기동 입력 **ON 유지** 직후 전이(첫 타이머 만료 전후)
   - (c) 핵심 동작이 1주기 **반복되는 시점**(점멸/자기유지 해제 등)
3. **사이클 단위**: 스캔 타임 = 100ms 고정(런타임 기본 브로드캐스트 간격). K1=100ms = 1사이클.

#### 1.11.2 트레이스 규칙

- 각 사이클마다 **좌→우로 IL 순서대로** 스택 연산을 시뮬. 병렬(ORB/ANB)은 스택 2개 조합.
- **TMR `OUT Tn Km`**: 입력 조건 참이면 Tn 카운트 +1. 카운트가 m 이상이면 Tn 접점 ON. 입력 거짓이면 Tn 카운트 0 + 접점 OFF(비적산 타이머).
- **CNT `OUT Cn Km`**: 입력 상승 에지(직전 OFF → 현재 ON)일 때만 카운트 +1. 카운트가 m 이상이면 Cn 접점 ON. RST 신호로 0 복원.
- **OUT Y/M**: 해당 사이클 전류 통과 여부에 따라 값 확정.
- 동일 디바이스 중복 OUT: **나중에 나오는 OUT이 최종값** (DOUBLE_COIL 경고 대상).

#### 1.11.3 출력 형식 (표)

최소 **3행 필수**: (a) 초기 / (b) 첫 전이 / (c) 정상 동작 반복. 상태가 복잡하면 **≤ 8행**으로 축약.

```markdown
### [5] Pseudo 시뮬레이션 (in-context trace, 실제 실행 아님)

**시나리오**: X4 ON 유지 → 1Hz 점멸 관찰 (cycleMs=100, settleMs=200)

| 사이클 | t(ms) | X4 | T0 cnt | T1 cnt | T0 | T1 | Y1 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 0 | 0    | 0 | -  | -  | 0 | 0 | 0 | 초기 |
| 1 | 100  | 1 | 1  | -  | 0 | 0 | 0 | X4 ON → T0 카운트 시작 |
| 5 | 500  | 1 | 5  | -  | 1 | 0 | 1 | T0 만료(K5) → T0 접점 ON → Y1 ON, T1 카운트 시작 |
| 10| 1000 | 1 | 0  | 5  | 0 | 1 | 0 | T1 만료 → T0 입력측 NC(T1)이 OFF → T0 리셋 → Y1 OFF |
| 11| 1100 | 1 | 1  | 0  | 0 | 0 | 0 | T1 OFF되며 다음 주기 시작 |

**판정**: Y1이 500ms ON / 500ms OFF로 반복 → 1Hz 점멸 요구사항과 일치. **Pseudo verdict = passed**.
```

verdict 값:
- `passed`: 모든 기대 동작 재현 확인
- `warn`: 동작은 재현되지만 §1.12 리뷰 체크리스트에서 경고 항목 존재
- `uncertain`: 요구사항 모호 또는 트레이스 불확정 → 사용자 질문

#### 1.11.4 Pseudo 시뮬 실패 시

- 기대 동작이 재현 안 되면 원인 가설을 §1.12 리뷰와 연결해 즉시 명시
- **동일 응답 안에서** tool_use(`delete_element` / `add_element` 덮어쓰기 등)로 **수정을 시도**할 수 있다. 수정 후 Pseudo 시뮬 표를 다시 출력. 최대 2회까지만 시도하고, 초과 시 사용자에게 개입 요청.

---

### 1.12 ★ Pseudo 리뷰 체크리스트 ([6] 단계 상세) ★

[5] 트레이스 직후 **아래 6개 항목 각각 ✓ / ✗ / N/A** 로 출력. ✗ 하나라도 있으면 원인·수정안 명시.

```markdown
### [6] Pseudo 리뷰 체크리스트

1. **opcode 지원 범위** (✓/✗) — LD/LDI/AND/ANI/OR/ORI/ORB/ANB/OUT/SET/RST + TMR/CNT 내에서만 사용했는가?
   - ✗일 때 예: "MOV 사용 발견 → 런타임 미지원. 자기유지+타이머 조합으로 대체 필요"
2. **디바이스 중복 OUT** (✓/✗) — 동일 Y/M에 OUT이 2회 이상 나오지 않는가? (DOUBLE_COIL 방지)
   - ✗일 때 예: "Rung 2·Rung 4 둘 다 OUT Y0 → 뒤의 OUT이 이김. Rung 4 OUT을 SET/RST로 변경 고려"
3. **타이머/카운터 단위·값** (✓/✗) — K 값이 의도한 시간과 일치? (K1=100ms, 1초=K10, 3초=K30)
   - ✗일 때 예: "요구는 3초인데 K3(=300ms) 사용 → K30으로 수정"
4. **엣지/자기유지 구조** (✓/✗) — SET/RST 쌍 맞음, 자기유지 시 OR Y 피드백 접점과 add_connection 존재?
   - ✗일 때 예: "Rung 0 자기유지에 Y0 피드백 접점 누락 → X0 놓는 순간 Y0 OFF. `add_element(row=1, Y0)` + `add_connection` 필요"
5. **인터록/안전** (✓/✗/N/A) — 위험 기동 조건에 비상정지 NC 접점 혹은 인터록 포함? (없으면 warn, 사용자에게 고지)
   - N/A: 단순 데모/점멸 회로
   - ✗ 예: "모터 구동 Rung에 비상정지 미반영. 실제 적용 전 하드와이어 비상정지 이중화 필수 (ISO 13849, IEC 62061)"
6. **명명/코멘트** (✓/✗) — 모든 Rung에 한국어 코멘트, 새 디바이스에 `set_device_comment` 부여?
   - ✗일 때 예: "T1에 device 코멘트 없음 → set_device_comment 추가 권장"

**리뷰 verdict**: passed(모두 ✓) / warn(✗ ≥1 있지만 동작 가능) / failed(opcode 미지원 또는 재편집 필수)
```

리뷰 verdict가 `failed`이면 §1.11.4대로 **동일 응답 내 tool_use 재호출 루프** (최대 2회) 수행.

---

### 1.13 ★ 완료 요약 표준 문구 ([7] 단계 상세) ★

아래 템플릿을 그대로 채워 넣어 출력. 사용자가 실제 e-plc UI에서 검증하도록 **F4 컴파일 + 시뮬레이션 탭**을 반드시 안내.

```markdown
### [7] 완료 요약

- 편집된 Rung: N개 (rungIndex 0~N-1)
- 호출된 tool_use: 총 M회 (insert_rung a / add_element b / add_connection c / set_rung_comment d / set_device_comment e)
- Pseudo 시뮬 verdict: passed | warn | uncertain
- Pseudo 리뷰 verdict: passed | warn | failed
- 경고 항목 요약 (있는 경우): [3] 타이머 K값 재확인 권장, [5] 비상정지 미반영 등

### 실제 동작 검증 (사용자 수행)
1. **F4** 키를 눌러 컴파일하고 IL 패널에서 MELSEC 니모닉을 확인하세요.
2. 화면 **하단 "시뮬레이션" 탭**에서 입력 X를 토글하며 실제 동작을 검증하세요.
3. 좌측 "디바이스" 패널에서 Y/T/C 상태와 코멘트를 확인하세요.
4. 예상과 다른 동작이면 구체적 불일치(어느 사이클에 어느 디바이스가 기대와 다름)를 알려주시면 재편집 + Pseudo 시뮬 다시 수행하겠습니다.
```

---

## 2. CLI (Claude Code) 모드 — writer → simulator → reviewer 루프

> **전제**: 이 모드는 `Task` 서브에이전트 도구, `Bash`, `Read`/`Write`가 사용 가능한 Claude Code 터미널 환경이다. 웹에서는 **이 섹션의 어떤 절차도 실행하지 말 것**.

### 2.1 전제 환경 (CLI 전용)

- 실행 대상 런타임: `/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime`
- 에디터 프로젝트: `/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc/`
- 스킬 루트(로컬): `/home/pjy4617/Repos/plc-skill/` 또는 `temp/plc-skill/`
- Node.js 22+ (내장 WebSocket 사용)

### 2.2 스킬 디렉토리 구조 (CLI 전용)

```
plc-skill/
├── SKILL.md                       ← 본 파일
├── USAGE.md                       ← 사용자용 상세 가이드
├── agents/
│   ├── ladder-writer.md           ← (CLI) 요구사항 → tool_call JSON
│   ├── ladder-simulator.md        ← (CLI) tool_call → IL → 런타임 시뮬
│   └── ladder-reviewer.md         ← (CLI) 실패 진단 + 수정 지시
├── scripts/
│   ├── apply_tools.mjs            ← tool_call → LadderProject
│   ├── compile_il.mjs             ← LadderProject → MELSEC IL + 정적검증
│   ├── run_sim.mjs                ← IL + 시나리오 → WS 검증
│   ├── pipeline.mjs               ← 오케스트레이터 CLI
│   ├── run_evals.mjs              ← Layer 1 회귀
│   └── run_agent_evals.mjs        ← Layer 2 회귀
├── references/
│   ├── ladder-tools-api.md
│   ├── supported-opcodes.md
│   ├── ws-protocol.md
│   └── ladder-grid-rules.md
└── evals/
    ├── evals.json
    └── fixtures/
```

### 2.3 CLI 워크플로

```
┌─────────────┐     tool_calls    ┌──────────────┐
│ USER 요구    │─────────────────▶│ ladder-writer │
└─────────────┘                    └───────┬──────┘
                                           │ JSON
                                           ▼
                                  ┌──────────────────┐
                                  │ ladder-simulator │
                                  │ - apply_tools    │
                                  │ - validate       │
                                  │ - compile IL     │
                                  │ - run_sim (WS)   │
                                  └───────┬──────────┘
                                          │ report.json
                              ┌───────────┴──────────┐
                              ▼                      ▼
                           passed                 failed
                             │                      │
                             ▼                      ▼
                        USER에게 제출       ladder-reviewer
                                                   │ 수정 지시
                                                   ▼
                                              ladder-writer
```

- 최대 **5회** 반복. 동일 실패 2회 → 사용자 개입 요청.

### 2.4 CLI 서브에이전트 호출

Claude Code의 `Task` 도구로 서브에이전트를 호출:

```
Task(subagent_type="ladder-writer",   prompt="...")
Task(subagent_type="ladder-simulator", prompt="tool_calls=... scenario=...")
Task(subagent_type="ladder-reviewer",  prompt="report=...")
```

### 2.5 CLI 파이프라인 실행 (bash)

```bash
cd /home/pjy4617/Repos/plc-skill

node scripts/pipeline.mjs \
  --tools /tmp/tool_calls.json \
  --scenario /tmp/scenario.json \
  --runtime /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime \
  --out /tmp/report.json

echo "exit=$?"
```

IL만 (시뮬 없이):

```bash
node scripts/pipeline.mjs --tools /tmp/tool_calls.json --project-only
```

런타임 재빌드:

```bash
cd /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime
cd build && cmake .. && make -j4 eplc_runtime
```

### 2.6 CLI 산출물 설치 방법

1. Node 스크립트로 LadderProject JSON 생성 후 e-plc 웹 UI의 프로젝트 import:
   ```bash
   node scripts/apply_tools.mjs tool_calls.json > project.json
   ```
2. 혹은 web UI의 AI 채팅에서 **§1 웹 모드**를 사용(자연어로 다시 요청) — 이 경로가 더 직관적임.

### 2.7 CLI 실패 복구

| 증상 | 조치 |
|---|---|
| `eplc_runtime` 바이너리 없음 | `Program/e-plc-runtime` 빌드 |
| 포트 8765 충돌 | `pkill -f eplc_runtime; sleep 1` |
| WebSocket 미지원 | Node 22+ 확인 |
| `upload` 응답 error | 생성된 IL을 확인해 파싱 오류와 대조 |
| `observed.Y0=undefined` | 디바이스가 IL에 등장 안 함 → tool_calls 재확인 |

---

## 3. 공통 — 스킬 품질 기준 (두 모드 공유)

### 3.1 범위 밖 (둘 다 위임)

- e-plc 웹 UI 자체 코드 수정 → 일반 코딩 에이전트
- C++ 런타임 opcode 확장(MOV, CMP 등) → `plc-simulation-plan.md` 참조
- EtherCAT 슬레이브 실하드웨어 연동 → 본 스킬 범위 외
- 안전 SIL/PLr 인증 설계 → 전문 안전 엔지니어링 (소프트웨어만으론 불가)

### 3.2 참조 파일 로딩 가이드

상세 규칙이 필요할 때 아래 파일을 읽는다 (progressive disclosure).

- 도구 7종 스펙 → `references/ladder-tools-api.md`
- 지원 opcode/디바이스 → `references/supported-opcodes.md`
- WS 프로토콜 → `references/ws-protocol.md`
- 11열 배치 규칙 → `references/ladder-grid-rules.md`

### 3.3 언어 / 근거 규칙 (두 모드 공유)

- 모든 설명·코멘트 한국어
- 추측 금지. 확실하지 않으면 "근거 없음" 또는 사용자에게 질문
- 안전 관련 요구사항(비상정지/인터록)은 소프트웨어만으로는 안전 달성 불가 — 하드와이어 이중화 권장 문구 필수(ISO 13849, IEC 62061)

### 3.4 CLI 품질 검증 (2-레이어 테스트)

CLI 모드에만 해당:

- **Layer 1 (`scripts/run_evals.mjs`)** — 무료·10초. 골든 tool_calls → pipeline → assertion. CI 권장
- **Layer 2 (`scripts/run_agent_evals.mjs`)** — Claude API 과금. writer 프롬프트/모델 변경 시 수동 1회
- **Layer 3 (수동)** — `apply_tools.mjs`로 project.json 만들어 e-plc 웹 UI import 후 육안 검토

```bash
cd /home/pjy4617/Repos/plc-skill
node scripts/run_evals.mjs
```

---

## 4. 환경 판정 디버깅 체크리스트

이 스킬이 활성화됐는데도 래더가 편집되지 않는다면:

1. **웹 AI 채팅창에서 "현재 사용 가능한 도구를 알려달라"고 질의.** 응답에 `insert_rung`이 보이면 §1 모드를 따라야 하는데 LLM이 §2로 오인한 것이다. 이 SKILL.md의 §0을 다시 확인.
2. **Claude Code CLI에서 사용 중인가.** Task 도구가 있으면 §2로 진행. `pgrep eplc_runtime`·`which node` 먼저 검증.
3. **스크린샷에 "수동으로 import 하세요" / "Task(subagent_type=...)" 같은 문자열**이 보이면 §0 판정 실패. 사용자에게 "이 스킬은 웹 모드에서는 LLM이 직접 tool_use로 래더를 만들어야 합니다. 요청을 다시 보내주세요"라고 안내.
