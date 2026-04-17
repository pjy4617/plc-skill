# e-plc Ladder Skill 사용 가이드

> **대상**: `/home/pjy4617/Repos/plc-skill/` 에 설치된 e-plc 래더 작성 스킬 + 3개 에이전트(`ladder-writer`, `ladder-simulator`, `ladder-reviewer`)의 사용자·개발자 문서.
>
> **전제**: `raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime` 바이너리가 존재해야 함. Node.js 22+ 필요.

---

## 1. 설치 상태 확인

### 1-1. 스킬 원본 위치
```
/home/pjy4617/Repos/plc-skill/
├── SKILL.md                    ← 오케스트레이터
├── agents/                     ← 3개 에이전트
├── scripts/                    ← 4개 Node.js 헬퍼
├── references/                 ← 4개 규칙 문서
├── evals/evals.json            ← 테스트 시나리오
├── package.json                ← ws 의존성
└── node_modules/ws/            ← 설치됨
```

### 1-2. 로컬 설치본 위치(raspberrypi-ec)
```
/home/pjy4617/Repos/raspberrypi-ec/.claude/
├── agents/
│   ├── ladder-writer.md
│   ├── ladder-simulator.md
│   └── ladder-reviewer.md
└── skills/e-plc-ladder/
    ├── SKILL.md
    ├── references/
    ├── scripts/
    ├── evals/
    └── package.json
```

### 1-3. 사전 점검 명령
```bash
# Node 버전
node --version      # v22.0 이상이어야 함

# 런타임 바이너리
ls /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime

# 포트 8765 비어있는지
ss -tln | grep 8765 || echo "free"

# ws 패키지
ls /home/pjy4617/Repos/plc-skill/node_modules/ws/package.json
```

런타임이 없으면:
```bash
cd /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime
mkdir -p build && cd build
cmake .. && make -j4 eplc_runtime
```

---

## 2. 기본 사용법 — 자연어로 요청

`raspberrypi-ec` 프로젝트에서 Claude Code를 열고 다음과 같은 요청을 입력하면 SKILL.md가 자동 트리거됩니다.

### 예시 요청
- "X0 누르면 모터 Y0 켜지고 X1 누르면 꺼지는 자기유지 회로 만들어줘"
- "X0가 3초 이상 유지되면 Y0 ON 되는 타이머 회로"
- "X0 OR X1 이면 Y0 켜지는 병렬 회로"
- "컨베이어 기동/정지 회로 작성하고 시뮬로 검증해줘"

### 자동 수행되는 워크플로
```
사용자 요청
    │
    ▼
SKILL.md 트리거 (키워드: "래더", "PLC", "자기유지", "타이머" 등)
    │
    ▼
ladder-writer (tool_call JSON 생성)
    │
    ▼
ladder-simulator (pipeline.mjs 실행)
    ├── apply_tools.mjs  → LadderProject
    ├── staticValidate   → 배치 검증
    ├── compile_il.mjs   → MELSEC IL
    └── run_sim.mjs      → e-plc-runtime 구동 + 시나리오 검증
    │
    ▼
 verdict == passed?
    ├─ Yes → 사용자에게 최종 산출물(IL + tool_calls + 적용 방법)
    └─ No  → ladder-reviewer (수정 지시) → writer로 회귀 (최대 5회)
```

---

## 3. 에이전트 개별 호출 (Task 도구 사용)

각 에이전트는 `Task` 서브에이전트 도구로 개별 호출할 수 있습니다.

### 3-1. `ladder-writer` 단독 호출

```
Task(subagent_type="ladder-writer",
     prompt="자기유지 회로: X0=기동, X1=정지, Y0=모터. 한 번 누르면 유지되어야 함.")
```

**기대 출력**: 마크다운 본문 + 마지막에 tool_calls JSON 블록.

### 3-2. `ladder-simulator` 단독 호출

writer 결과를 받아 시뮬만 실행:

```
Task(subagent_type="ladder-simulator",
     prompt="""
다음 tool_calls를 시뮬레이션해줘:
[{"name":"insert_rung",...}, ...]

시나리오:
- X0 ON → Y0 ON 기대
- X0 OFF → Y0 유지
- X1 ON → Y0 OFF
""")
```

### 3-3. `ladder-reviewer` 단독 호출

시뮬 실패 리포트를 주고 수정안 요청:

```
Task(subagent_type="ladder-reviewer",
     prompt="pipeline.mjs 출력 report.json을 보고 원인 진단 + writer 수정 지시를 만들어줘:
<report 내용 붙여넣기>")
```

---

## 4. 수동 CLI 사용 — 파이프라인 직접 실행

Claude 없이도 스크립트만 단독 사용 가능.

### 4-1. tool_calls JSON 준비

예: 자기유지 회로

```bash
cat > /tmp/tc.json <<'EOF'
[
  { "id":"t1", "name":"insert_rung", "input":{"comment":"자기유지","insertAfterIndex":-1} },
  { "id":"t2", "name":"add_element", "input":{"rungIndex":0,"elementType":"NO_CONTACT","device":"X0","row":0,"col":0} },
  { "id":"t3", "name":"add_element", "input":{"rungIndex":0,"elementType":"NO_CONTACT","device":"Y0","row":1,"col":0} },
  { "id":"t4", "name":"add_connection", "input":{"rungIndex":0,"fromRow":0,"fromCol":1,"toRow":1,"toCol":1} },
  { "id":"t5", "name":"add_element", "input":{"rungIndex":0,"elementType":"NC_CONTACT","device":"X1","row":0,"col":2} },
  { "id":"t6", "name":"add_element", "input":{"rungIndex":0,"elementType":"COIL","device":"Y0","row":0,"col":10} }
]
EOF
```

### 4-2. 시나리오 JSON 준비

```bash
cat > /tmp/sc.json <<'EOF'
{
  "name": "자기유지 동작 검증",
  "cycleMs": 10,
  "settleMs": 200,
  "steps": [
    { "inputs": {"X0":0,"X1":0}, "expect": {"Y0":0}, "waitMs": 200 },
    { "inputs": {"X0":1},        "expect": {"Y0":1}, "waitMs": 250 },
    { "inputs": {"X0":0},        "expect": {"Y0":1}, "waitMs": 250 },
    { "inputs": {"X1":1},        "expect": {"Y0":0}, "waitMs": 250 }
  ]
}
EOF
```

### 4-3. 파이프라인 실행

```bash
cd /home/pjy4617/Repos/plc-skill

node scripts/pipeline.mjs \
  --tools /tmp/tc.json \
  --scenario /tmp/sc.json \
  --runtime /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime \
  --out /tmp/report.json
```

종료 코드:
- **0**: `verdict == passed` 또는 `partial`
- **1**: `failed`/`blocked`

### 4-4. 리포트 해석

```bash
node -e '
const r = JSON.parse(require("fs").readFileSync("/tmp/report.json","utf8"));
console.log("verdict:", r.verdict, "| stage:", r.stage);
console.log("summary:", r.summary);
if (r.il) console.log("\nIL:\n" + r.il);
if (r.sim) {
  console.log("\n시나리오:", r.sim.passed, "/", r.sim.total);
  for (const s of r.sim.steps) {
    console.log("  step", s.index, s.pass?"✅":"❌",
      "in", JSON.stringify(s.inputs), "expect", JSON.stringify(s.expect));
  }
}'
```

### 4-5. 개별 스크립트 사용

```bash
# tool_calls만 LadderProject로 변환
node scripts/apply_tools.mjs /tmp/tc.json > /tmp/project.json

# LadderProject를 IL로 컴파일 (정적 검증 포함)
node scripts/compile_il.mjs /tmp/project.json > /tmp/program.il

# IL + 시나리오로 시뮬만 실행
node scripts/run_sim.mjs \
  --il /tmp/program.il \
  --scenario /tmp/sc.json \
  --runtime /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/build/eplc_runtime

# 시뮬 없이 IL만 확인
node scripts/pipeline.mjs --tools /tmp/tc.json --project-only
```

---

## 5. 실전 예시 3개

### 5-1. 자기유지 (Self-Hold)

**요구**: X0=기동, X1=정지(NC), Y0=모터. 한 번 기동 후 X0를 떼도 Y0 유지.

**tool_calls** (6개):
```json
[
  { "name":"insert_rung", "input":{"comment":"자기유지","insertAfterIndex":-1} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"NO_CONTACT","device":"X0","row":0,"col":0} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"NO_CONTACT","device":"Y0","row":1,"col":0} },
  { "name":"add_connection", "input":{"rungIndex":0,"fromRow":0,"fromCol":1,"toRow":1,"toCol":1} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"NC_CONTACT","device":"X1","row":0,"col":2} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"COIL","device":"Y0","row":0,"col":10} }
]
```

**생성 IL**:
```
LD  X0
LD  Y0
ORB
ANI X1
OUT Y0
END
```

**검증 결과**: 5/5 스텝 통과 (실측 완료)

### 5-2. 3초 지연 타이머

**요구**: X0를 3초 유지하면 Y0 ON. X0 떼면 즉시 해제. TMR T0.

**tool_calls**:
```json
[
  { "name":"insert_rung", "input":{"comment":"TMR T0: 3초 카운트"} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"NO_CONTACT","device":"X0","row":0,"col":0} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"FUNCTION","device":"TMR T0 K30","row":0,"col":8} },
  { "name":"insert_rung", "input":{"comment":"T0 접점 → Y0"} },
  { "name":"add_element", "input":{"rungIndex":1,"elementType":"NO_CONTACT","device":"T0","row":0,"col":0} },
  { "name":"add_element", "input":{"rungIndex":1,"elementType":"COIL","device":"Y0","row":0,"col":10} }
]
```

**생성 IL**:
```
LD X0
OUT T0 K30
LD T0
OUT Y0
END
```

**중요**: K30 = 3000ms (K1 = 100ms)

### 5-3. 병렬 OR

**요구**: X0 또는 X1 중 하나라도 ON이면 Y0 ON.

**tool_calls**:
```json
[
  { "name":"insert_rung", "input":{"comment":"X0 OR X1 → Y0"} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"NO_CONTACT","device":"X0","row":0,"col":0} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"NO_CONTACT","device":"X1","row":1,"col":0} },
  { "name":"add_connection", "input":{"rungIndex":0,"fromRow":0,"fromCol":1,"toRow":1,"toCol":1} },
  { "name":"add_element", "input":{"rungIndex":0,"elementType":"COIL","device":"Y0","row":0,"col":10} }
]
```

**생성 IL**:
```
LD  X0
LD  X1
ORB
OUT Y0
END
```

---

## 6. 래더 작성 규칙 요약 (writer가 반드시 지키는 것)

### 6-1. 지원 범위 (런타임 제약)
| 카테고리 | 지원 | 미지원 (사용 금지) |
|---|---|---|
| 비트 논리 | LD, LDI, AND, ANI, OR, ORI, ORB, ANB, OUT, SET, RST, END | MPS/MRD/MPP, MC/MCR |
| 에지 | — | LDP, LDF, PLS, PLF |
| 타이머 | TMR (비유지형, K1=100ms) | 적산 ST |
| 카운터 | CNT (상승 에지) | 감산·고속 |
| 데이터 | — | MOV, CMP, INC/DEC, 사칙 |
| 흐름 제어 | — | CJ, JMP, CALL, FOR/NEXT |

### 6-2. 그리드 배치
```
col 0 ... 7   8-9   10
    [접점]   [FUNC] [COIL]
```
- `NO_CONTACT`/`NC_CONTACT` → col 0~7
- `FUNCTION` (TMR/CNT) → **col=8** 고정 (2칸 점유)
- `COIL`/`SET_COIL`/`RST_COIL` → **col=10** 고정

### 6-3. 병렬 회로 규칙 (중요)
- 왼쪽 모선은 자동 연결. `add_connection`은 **오른쪽 1회만**
- 수직선 `fromCol`은 **병렬 접점의 col보다 커야** 함 (path-tracer의 mergeCol 규칙)
- 예: 접점 col=0에 두면 수직선은 col=1

### 6-4. 디바이스 진법
- X/Y: **8진수** (X7 → X10, X8/X9 없음)
- M/T/C/D: 10진수

---

## 7. 결과물을 e-plc 웹 에디터에 적용하는 법

writer가 tool_calls JSON을 만들어 주었지만, 이를 **실제 e-plc 프로젝트**로 로드하는 방법은 두 가지:

### 7-1. LadderProject JSON으로 변환 후 Import (권장)

```bash
node scripts/apply_tools.mjs /tmp/tc.json > /tmp/project.json
```

이 `project.json`을 e-plc 웹 UI의 **프로젝트 가져오기** 기능으로 로드.
- `lib/storage/project-file.ts`의 import 포맷과 호환(필드: `id`, `name`, `rungs`, `deviceComments`, `createdAt`, `updatedAt`)

### 7-2. AI 채팅창에서 tool_call 재현

`Program/e-plc` 에서 `npm run dev`로 에디터를 띄운 뒤 AI 채팅창에 자연어로 동일 요청을 하면, 웹 UI의 `app/api/ai-chat/route.ts`가 동일한 7개 툴을 호출하여 GUI에 반영.
- 장점: GUI에 바로 반영, undo/redo 지원
- 단점: writer가 만든 tool_calls를 그대로 붙여넣을 수 없어 사용자가 자연어로 바꿔 말해야 함

---

## 8. 시나리오 JSON 스펙

```json
{
  "name": "시나리오 이름",
  "cycleMs": 10,               // 런타임 스캔 주기(기본 10)
  "settleMs": 200,             // step.waitMs 미지정 시 기본 대기 시간
  "steps": [
    {
      "inputs": { "X0": 1, "X1": 0 },   // force 명령으로 설정할 입력들
      "expect": { "Y0": 1, "M0": 1 },   // read_all 후 검증할 디바이스 상태
      "waitMs": 250                      // 이 step의 대기 시간(옵션)
    }
  ]
}
```

### 시나리오 작성 팁
- **첫 step은 초기화**: 모든 입력 0으로 두고 출력이 0인지 확인
- **타이머 검증은 waitMs 여유있게**: K30(3초) 타이머는 `waitMs: 3200` 이상
- **자기유지 테스트 순서**: 기동 → 입력 제거해도 유지 → 정지 입력으로 해제
- **inputs에 없는 디바이스는 이전 값 유지** (force는 누적)

---

## 9. 트러블슈팅

### 9-1. `eplc_runtime` 바이너리 없음
```bash
cd /home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime
mkdir -p build && cd build
cmake .. && make -j4 eplc_runtime
```

### 9-2. 포트 8765 사용 중
```bash
pkill -x eplc_runtime       # ⚠️ `-f` 쓰지 말 것 — 본 셸도 매칭됨
ss -tln | grep 8765         # 비어있는지 재확인
```

### 9-3. WebSocket 연결 에러
Node 내장 WebSocket이 런타임의 WS 구현과 호환이 떨어지는 경우가 있음. `ws` npm 패키지 사용:
```bash
cd /home/pjy4617/Repos/plc-skill
npm install
```
`run_sim.mjs`가 자동으로 `ws` 먼저 시도, 실패 시 내장 WebSocket으로 폴백.

### 9-4. `verdict: failed, stage: apply`
tool_call JSON의 순서/파라미터 오류.
- 흔한 원인: `rungIndex`가 아직 존재하지 않는 Rung을 가리킴 → 선행 `insert_rung` 누락
- 점검: `node scripts/apply_tools.mjs /tmp/tc.json` 단독 실행하여 상세 메시지 확인

### 9-5. `verdict: failed, stage: static` — 배치 규칙 위반
`staticIssues` 배열의 code 확인:
- `OUTPUT_IN_MIDDLE`: 코일 우측에 요소 있음 → COIL은 반드시 col=10
- `UNBALANCED_VERTICAL_CONNECTION`: 수직선 주변 접점 부족 → 병렬 경로 재구성
- `X_AS_OUTPUT`: X를 COIL로 사용 → Y 또는 M으로 변경

전체 규칙 → `references/ladder-grid-rules.md`

### 9-6. `verdict: failed, stage: sim` — 로직 오류
`sim.steps`에서 `pass:false`인 step의 `observed` vs `expect` 비교.
- **자기유지가 안 됨**: OR 경로(row=1 Y0 접점 + add_connection col=1) 누락
- **타이머 작동 안 함**: Rung 순서(TMR 정의가 T0 접점 사용보다 뒤) or K값 단위 착각
- **병렬이 AND처럼 동작**: add_connection의 fromCol이 접점 col 이하

### 9-7. 시나리오 step 실행 속도가 너무 빠름
`waitMs`를 늘리거나 `settleMs`를 크게. 타이머 K값 × 100ms + 여유 2스캔(20ms) 최소 권장.

### 9-8. Node 버전 오류
```
ReferenceError: WebSocket is not defined
```
→ Node 22+로 업그레이드하거나, `cd plc-skill && npm install` 로 `ws` 설치 (폴백 활성)

---

## 10. 개발자용 — 스킬 확장

### 10-1. 런타임 opcode 확장 시
`Program/docs/plc-simulation-plan.md` Phase 1~4 로드맵 따라 C++ 런타임 확장 후:
1. `references/supported-opcodes.md`에 지원 항목 추가
2. `agents/ladder-writer.md`의 "미지원" 목록에서 제거
3. `scripts/compile_il.mjs::outputToLine`에 새 FUNCTION 지원 추가(필요 시)
4. 새 시나리오를 `evals/evals.json`에 추가하여 회귀 방지

### 10-2. 새 테스트 시나리오 추가
```bash
cat >> evals/evals.json <<'EOF'
# evals 배열에 새 객체 추가
{
  "id": 4,
  "name": "counter-10-pulse",
  "prompt": "X0를 10회 눌러야 Y0 ON. CNT C0 사용.",
  "scenario": { ... },
  "assertions": [ ... ]
}
EOF
```

그 후 `skill-creator`의 eval 러너로 기준값 검증.

### 10-3. 에이전트 프롬프트 수정
`agents/ladder-{writer,simulator,reviewer}.md` 수정 후 로컬 설치본에도 동기화:
```bash
cp agents/*.md /home/pjy4617/Repos/raspberrypi-ec/.claude/agents/
cp SKILL.md references/*.md scripts/*.mjs \
   /home/pjy4617/Repos/raspberrypi-ec/.claude/skills/e-plc-ladder/ -r
```

---

## 11. 참조 문서 (상세 규칙)

| 파일 | 내용 | 언제 읽는가 |
|---|---|---|
| `references/ladder-tools-api.md` | 7개 도구(insert_rung 등) 스펙 | tool_call 작성 시 |
| `references/supported-opcodes.md` | 런타임 12 opcode + TMR/CNT | IL 생성 가능 범위 판단 |
| `references/ws-protocol.md` | e-plc-runtime WS 메시지 포맷 | 시뮬 러너 디버깅 |
| `references/ladder-grid-rules.md` | 11열 배치 + 병렬 규칙 | 검증 에러 분석 |

---

## 12. 자주 하는 실수 Top 5

1. **병렬 회로의 add_connection 두 번** — 왼쪽 모선 연결은 자동. 오른쪽만 1회
2. **수직선 fromCol == 접점 col** — mergeCol이 접점 col보다 커야 함. 접점 col=0이면 수직선 col=1
3. **타이머 K값 단위 착각** — K1 = **100ms**. 3초는 K30(K3 아님)
4. **X를 COIL에 사용** — X는 입력 전용. 출력은 Y
5. **X8, X9 사용** — X/Y는 8진수. X7 다음은 X10

---

## 13. 테스트 (회귀 · 에이전트 품질)

이 스킬 자체의 품질을 검증하는 방법. **두 레이어로 구성**되어 있으며 목적·비용이 다름.

### 13-1. Layer 1 — 스크립트 회귀 (`run_evals.mjs`)

**용도**: 런타임·컴파일러·시뮬 러너가 바뀌었을 때 기능 회귀 감지.  
**비용**: 무료 (로컬 실행만, 네트워크 불필요).  
**소요**: 3개 시나리오 약 **10초**.

```bash
cd /home/pjy4617/Repos/plc-skill
node scripts/run_evals.mjs
# 또는 JSON 리포트와 함께
node scripts/run_evals.mjs --json /tmp/eval_report.json
# 특정 케이스만
node scripts/run_evals.mjs --filter self-hold
```

**동작 원리**:
1. `evals/evals.json` 로드
2. 각 eval의 `fixtureFile` (golden tool_calls) → `pipeline.mjs` 실행
3. `assertions` 평가 (`project_metric` / `il_contains` / `sim_pass_rate`)
4. 집계 테이블 출력, 종료 코드 0=전부 통과 / 1=실패 있음

**현재 기준선**: `self-hold-motor` · `timer-3s-delay` · `parallel-or` — 모두 **3/3 통과** (실측 완료)

**Fixture 파일**:
- `evals/fixtures/self-hold-motor.json`
- `evals/fixtures/timer-3s-delay.json`
- `evals/fixtures/parallel-or.json`

이 파일들이 "정답 tool_calls". writer 에이전트를 개선해도 이 fixture는 건들지 말 것 — 런타임/컴파일러 변화 감지용 고정 기준.

**새 테스트 추가 방법**:
1. `evals/fixtures/<name>.json` — 검증된 tool_calls 배열
2. `evals/evals.json` 에 항목 추가:
   ```json
   {
     "id": 4,
     "name": "my-new-case",
     "prompt": "자연어 요구사항 (Layer 2 에서 사용)",
     "fixtureFile": "fixtures/my-new-case.json",
     "scenario": { "steps": [...] },
     "assertions": [
       { "name": "rung 개수", "type": "project_metric", "path": "project.rungs.length", "op": "==", "value": 3 },
       { "name": "IL에 MOV 포함 아님", "type": "il_contains", "value": "MOV" }
     ]
   }
   ```
3. `node scripts/run_evals.mjs --filter my-new-case` 로 확인

### 13-2. Layer 2 — 에이전트 품질 회귀 (`run_agent_evals.mjs`)

**용도**: writer 에이전트 프롬프트 변경 시 실제 tool_call 생성 품질 측정.  
**비용**: Claude API 호출 (케이스당 대략 $0.05~0.20, 총 $0.15~0.60).  
**소요**: 케이스당 20~60초.  
**요구**: `claude` CLI (PATH) + `ANTHROPIC_API_KEY` + 네트워크.

```bash
cd /home/pjy4617/Repos/plc-skill
node scripts/run_agent_evals.mjs --out /tmp/layer2.json
# 특정 케이스만 / 모델 지정
node scripts/run_agent_evals.mjs --filter self-hold --model sonnet --max-budget-usd 1.00
```

**동작 원리**:
1. `agents/ladder-writer.md` 본문(프론트매터 제외)을 system prompt 로 사용
2. `claude -p <eval.prompt> --system-prompt <writer-body>` 호출
3. 응답 텍스트에서 첫 `json` 코드 펜스 블록 파싱 → tool_calls
4. 추출된 tool_calls + eval.scenario → `pipeline.mjs`
5. assertions 평가 (Layer 1과 동일)

**언제 돌리는가**:
- `agents/ladder-writer.md` 프롬프트를 고쳤을 때
- 모델 변경 시 (claude-sonnet-4-6 → claude-opus-4-7 등)
- 새 테스트 케이스가 writer 능력 밖으로 나갔는지 판단할 때

**Layer 1과의 차이**:
| 항목 | Layer 1 | Layer 2 |
|---|---|---|
| 검증 대상 | 스크립트·런타임·컴파일러 | writer 에이전트 품질 |
| tool_calls 출처 | fixture 파일(고정) | 에이전트가 실시간 생성 |
| 비용 | 무료 | Claude API 과금 |
| 소요 | 10초 | 1~5분 |
| CI 적합성 | 매 커밋 | 주간/릴리스 전 |
| 결정론 | 결정론적 | 비결정론(모델 확률성) |

### 13-3. Layer 3 — 시각 회귀 (수동)

writer 또는 fixture의 tool_calls를 e-plc 웹 UI에 로드해 육안 확인:
```bash
node scripts/apply_tools.mjs evals/fixtures/self-hold-motor.json > /tmp/project.json
# 그 후 Program/e-plc 에서 dev 서버 띄우고 project.json을 프로젝트 가져오기로 로드
```
규칙을 어기지 않아도 "사람이 보기 불편한" 배치를 잡을 때 사용.

### 13-4. 권장 실행 주기

| 상황 | Layer 1 | Layer 2 | Layer 3 |
|---|---|---|---|
| 매 커밋 (CI) | ✅ | — | — |
| writer 프롬프트 수정 | ✅ | ✅ | — |
| 런타임 opcode 확장 | ✅ | ✅ | — |
| 릴리스 직전 | ✅ | ✅ | ✅ |

**최소 권장**: Layer 1 만큼은 CI에 걸고, Layer 2는 writer 수정 PR에서 1회만 실행.

---

## 14. 연락/기여

- 스킬 소스: `/home/pjy4617/Repos/plc-skill/`
- 런타임: `/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc-runtime/`
- 웹 에디터: `/home/pjy4617/Repos/raspberrypi-ec/Program/e-plc/`

버그/개선 제안은 프로젝트 README의 이슈 트래커 사용.
