# Ruach (루아흐)

> 창세기 1:2 — "하나님의 영(루아흐)이 수면 위에 운행하시니라"

히브리어 **רוּחַ** — 숨, 바람, 영(靈).
수면 위를 떠돌던 숨결이 목소리가 되고, 목소리가 살아 곁에 머무는 음성 에이전트.

---

## 무엇인가

ChatGPT 고급 음성 모드처럼 **사람과 실제로 대화하듯** 자연스럽게 말을 주고받고,
대화 속에서 **실제로 일을 수행하는(agent)** 음성 동반자.

기존 **Hermes 에이전트**(개인용 에이전트 프레임워크)의 두뇌(페르소나·툴·스킬·메모리·멀티채널)를
계승하되, **음성 코어를 STT→LLM→TTS 파이프라인에서 OpenAI Realtime 네이티브 speech-to-speech로 교체**한다.

| | Hermes (기존) | Ruach (목표) |
|---|---|---|
| 음성 입력 | push-to-talk 녹음 → 로컬 Whisper STT | Realtime 마이크 스트림 + 서버 VAD |
| 사고 | LLM (텍스트 턴) | `gpt-realtime-2` (음성 네이티브 추론) |
| 음성 출력 | edge/elevenlabs TTS | Realtime 네이티브 음성 (감정 톤) |
| 턴 전환 | 수동 키 / 침묵 감지 | 네이티브 turn-taking · 끼어들기(barge-in) |
| 지연 | 높음 (3단 파이프라인) | 낮음 (단일 speech-to-speech) |

---

## 설계 원칙

- **인터페이스 독립** — 음성 대화 코어와 전달 채널(웹/Discord/전화)을 분리. 채널이 바뀌어도 코어는 그대로.
- **모델 독립** — Realtime 계열을 쓰되, 음성 I/O 추상화 뒤에 둬서 모델 교체가 코어를 깨지 않게.
- **키 비노출** — OpenAI API 키는 백엔드에만. 브라우저는 단기 토큰만 받는다.

---

## 아키텍처

```
  ┌─────────────────┐   1. POST /api/session    ┌──────────────────────┐
  │   브라우저 (web)  │ ────────────────────────▶ │   Ruach 서버 (server) │
  │                 │ ◀──────────────────────── │   - 단기 토큰 발급      │
  │  @openai/agents │   2. ek_... (600s)         │   - SOUL.md → 페르소나  │
  │  WebRTC + 마이크  │                           │   - 서버측 툴 실행       │
  └───────┬─────────┘                           └──────────┬───────────┘
          │ 3. WebRTC 직결 (오디오 양방향)                    │
          ▼                                                 │ 5. 무거운 작업 위임(예정)
  ┌─────────────────┐                                       ▼
  │ OpenAI Realtime  │  4. tool_call ──▶ 서버 라우팅 ──▶  (Hermes / 네이티브 툴)
  │  gpt-realtime-2  │  ◀── tool_result
  └─────────────────┘
```

### Hermes 개념 → Ruach 매핑

| Hermes | Ruach | 비고 |
|---|---|---|
| `SOUL.md` | `SOUL.md` | 인격. 매 세션 새로 읽어 `instructions`로 주입 |
| `ToolRegistry` / `tools/*.py` | `packages/core` 툴 레지스트리 (TS) | OpenAI function schema 동일 |
| `skills/*/SKILL.md` | (M3) 스킬 인덱스 | 시스템 프롬프트에 인덱스로 주입 |
| `SessionDB` (SQLite+FTS5) | (M2) 세션 저장 | 대화 영속화 + 교차 세션 검색 |
| `MemoryProvider` | (M3) 메모리 | prefetch/sync 추상화 |
| `gateway/platforms/*` | (M4) 채널 어댑터 | 웹 → Discord/전화 확장 |

---

## 로드맵

- **M1 — 살아있는 목소리** ✅
  브라우저에서 Realtime speech-to-speech로 자연스럽게 대화. SOUL.md 페르소나 주입. 데모 툴 1개로 "대화 중 행동" 증명.
- **M2 — 두뇌 코어** ⬅ *다음*
  네이티브 TS 툴 레지스트리 + dispatch, 비동기 잡 엔진, 세션 영속화, 토큰 리프레시. 방향은 **하이브리드**로 확정(라이브=TS, 무거운 작업=Hermes에 async 위임). Hermes 방법론을 실시간에 이식하는 상세 설계: [docs/HERMES-PORT.md](docs/HERMES-PORT.md).
- **M3 — 스킬과 메모리**
  SKILL.md 인덱스 주입, 장기 메모리 prefetch/sync.
- **M4 — 채널 확장**
  웹 외 Discord 음성 / 전화(Twilio) 어댑터. 인터페이스 독립 코어 검증.

---

## 스택

- **server** — Node + TypeScript. 단기 토큰 발급, 페르소나 로딩, 서버측 툴 실행.
- **web** — Vite + TypeScript + `@openai/agents` (WebRTC). 마이크·음성 UI.

## 실행 (M1)

터미널 두 개가 필요하다.

```bash
cp .env.example .env     # OPENAI_API_KEY 채우기 (이미 채워져 있으면 생략)
npm install

# 터미널 1 — 백엔드 (토큰 발급, :8787)
npm run dev:server

# 터미널 2 — web (Vite, :5173, /api는 백엔드로 프록시)
npm run dev:web
```

그다음 http://localhost:5173 → **통화 시작** → 마이크 허용 → 말하면 된다.
대화 중 `get_current_time`(시간)·`remember`(→ `notes.jsonl` 저장) 두 툴이 동작한다.

## 상태

✅ **M1 완료** — 백엔드(토큰 발급·SOUL 페르소나·서버측 툴) + web Realtime 클라이언트.
백엔드는 실제 OpenAI `gpt-realtime-2`에 붙여 검증함(토큰 발급·세션 생성·`/api/remember`).
브라우저 음성 통화는 로컬에서 사용 가능. 다음은 M2(두뇌·기억).
