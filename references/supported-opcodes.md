# e-plc-runtime 지원 IL 명령어 (확정판)

> **출처**: `Program/e-plc-runtime/README.md:103-118`, `Program/e-plc-runtime/src/il_executor.cpp`, `Program/e-plc-runtime/src/il_parser.cpp`
> **이 범위를 벗어나는 명령을 생성하면 `upload` 시 `{"type":"error","msg":"파싱 오류: 알 수 없는 명령어 XXX"}`로 거부된다.**

## 지원 opcode 12종

| opcode | 역할 | 예 | 비고 |
|---|---|---|---|
| `LD`   | a접점 로드 | `LD X0` | 새 회로 시작 |
| `LDI`  | b접점 로드(반전) | `LDI X3` | 새 회로 시작, 반전 |
| `AND`  | 직렬 a접점 | `AND X1` | |
| `ANI`  | 직렬 b접점 | `ANI M0` | |
| `OR`   | 병렬 a접점 | `OR X2` | |
| `ORI`  | 병렬 b접점 | `ORI M1` | |
| `ORB`  | OR 블록 (스택) | `ORB` | 직렬조합끼리 병렬할 때 |
| `ANB`  | AND 블록 (스택) | `ANB` | 병렬조합끼리 직렬할 때 |
| `OUT`  | 코일 출력 | `OUT Y0` | |
| `SET`  | 세트(자기유지 ON) | `SET M10` | |
| `RST`  | 리셋(자기유지 OFF, 또는 T/C CV 0) | `RST T0` | |
| `END`  | 프로그램 끝 | `END` | 매 프로그램 마지막 1회 필수 |

## 타이머/카운터 FUNCTION

래더 에디터의 `FUNCTION` 요소는 MELSEC IL 상 **`OUT T<n> K<pv>`** / **`OUT C<n> K<pv>`** 로 컴파일된다 (`lib/compiler/melsec-generator.ts:32-40`).

### TMR (타이머)
- **시간축**: K1 = **100 ms** (README.md:128 확정). `OUT T0 K10` → 1초 후 T0 접점 ON
- **비유지형**: 코일 OFF 시 CV 즉시 0 리셋 (`plc_memory.cpp::updateTimers` 기준)
- **적산 타이머 ST는 미지원** (`plc-simulation-plan.md` Phase 1 예정)
- **RST T0**: CV 0 + 접점 OFF

### CNT (카운터)
- **상승 에지 카운트**: 코일이 OFF→ON 전환될 때마다 CV++
- `OUT C0 K10` → 10회 상승 에지 후 C0 접점 ON
- **RST C0**: CV 0 + 접점 OFF (CV만 직접 초기화)
- **감산·고속 카운터 미지원**

## 디바이스 맵

| 디바이스 | 범위 | 타입 | 용도 |
|---|---|---|---|
| `X` | 0-255 | BOOL | 입력(EtherCAT/sim force) |
| `Y` | 0-255 | BOOL | 출력 |
| `M` | 0-4095 | BOOL | 내부 릴레이 |
| `D` | 0-8191 | int16 | 데이터 레지스터 (현재 IL에서 직접 사용 불가 — MOV 미지원) |
| `T` | 0-255 | BOOL+CV | 타이머 접점 |
| `C` | 0-255 | BOOL+CV | 카운터 접점 |

> **주의**: X/Y 디바이스는 e-plc 웹 에디터 쪽 validator(`lib/model/device.ts:11-12`)에서 **8진수**로 해석한다 (`X7` 다음은 `X10`). 런타임은 10진 파싱이지만 **에디터 호환을 위해 항상 8진으로 기입**할 것.

## 명시적 미지원 목록 (사용하면 안 됨)

다음은 현재 런타임에 **없다** (`plc-simulation-plan.md` §1.1 소스 직접 확인):

- 에지 명령: `LDP`, `LDF`, `ANDP`, `ANDF`, `ORP`, `ORF`
- 펄스 코일: `PLS`, `PLF`
- 결과 스택: `MPS`, `MRD`, `MPP`
- 마스터 컨트롤: `MC`, `MCR`
- 흐름 제어: `CJ`, `JMP`, `CALL`, `SRET`, `FEND`, `FOR`, `NEXT`
- 데이터: `MOV`, `BMOV`, `FMOV`, `XCH`, `DMOV`
- 비교: `CMP`, `ZCP`, `LD=`, `LD<`, `LD>`, ...
- 사칙: `+`, `-`, `*`, `/`, `INC`, `DEC`
- 적산 타이머 `ST<n>`, 래치 릴레이 `L<n>`, 특수 릴레이 `SM<n>`/`SD<n>`

**writer가 이 중 하나라도 생성하면 `upload` 단계에서 반드시 실패한다.** 요구사항이 이들을 요구하면 writer는 "현재 런타임에서 미지원입니다"라고 명시하고 대체 구현(자기유지·TMR 조합으로 에지 모사 등)을 제안할 것.

## 에지 없이 자기유지 구현 패턴

현재 런타임은 에지 명령이 없으므로 버튼 펄스 흉내는 "SET + RST" 패턴으로:

```
LD X0           ; 기동버튼
OR M0           ; 자기유지 접점
ANI X1          ; 정지버튼 (NC)
OUT M0          ; 자기유지 코일
LD M0
OUT Y0          ; 출력
END
```

버튼을 떼면 자동으로 끊어져야 할 조건이 있다면 NC 접점으로 감싸되, 사용자에게 "버튼을 누르는 동안만 유지되는 동작입니다"라고 고지할 것.
