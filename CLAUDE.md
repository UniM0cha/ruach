# CLAUDE.md — Ruach

Ruach(루아흐)는 OpenAI Realtime API로 만드는 **speech-to-speech 음성 에이전트**다.
ChatGPT 고급 음성 모드처럼 자연스럽게 대화하고, 대화 중 툴로 실제 행동까지 한다.
비전·로드맵 전체는 [README.md](README.md) 참고.

## 구조

- `server/` — Node + TypeScript 백엔드.
  - `src/index.ts` — `POST /api/session`(단기 토큰 발급), `POST /api/remember`, `GET /api/health`
  - `src/session-config.ts` — Realtime 세션 설정(모델·`server_vad`·오디오 포맷·voice)
  - `src/persona.ts` — `SOUL.md` 로더(주석/frontmatter strip)
- `web/` — Vite + TypeScript 브라우저 클라이언트. `@openai/agents`(WebRTC)로 마이크·음성·tool.
  - `src/main.ts` — `RealtimeAgent`/`RealtimeSession` 연결, 툴 정의, `history_updated`로 트랜스크립트 렌더
- `SOUL.md` — Ruach의 인격. 세션 `instructions`로 주입된다. 자유롭게 수정(재시작 불필요).
- `.env` — 시크릿. **절대 커밋 금지.** `.env.example` 참고.

## 개발 명령

```bash
npm install
npm run dev:server   # :8787 백엔드(토큰 발급)
npm run dev:web      # :5173 web (/api → 백엔드 프록시)
```

타입체크: `npx tsc --noEmit -p server/tsconfig.json`, `npx tsc --noEmit -p web/tsconfig.json`

## 아키텍처 핵심 (꼭 지킬 것)

- **API 키 비노출** — `OPENAI_API_KEY`는 백엔드에만. 브라우저엔 `ek_` 단기 토큰만 내려간다. 키가 클라이언트로 새는 코드 금지.
- **토큰 필드는 `value`** — `client_secrets` 응답의 토큰은 top-level `value` 필드다(`client_secret` 아님). 방어적 fallback 유지.
- **루트 `.env` 로딩** — npm 워크스페이스 스크립트는 cwd를 `server/`로 바꾼다. `dotenv`는 소스 기준 절대경로(`../../.env`)로 읽는다. `import "dotenv/config"`만 믿지 말 것.
- **인터페이스 독립** — 음성 코어와 전달 채널(웹/Discord/전화)을 분리. 채널 추가가 코어를 깨면 안 된다.
- **통화 턴은 가볍게** — Realtime은 단일 빠른 음성턴 + 빠른 툴 모델. 무거운 멀티스텝 작업을 통화 중 인라인으로 돌리지 말고 비동기로 위임한다.

## 비용 주의

- 기본 모델 `gpt-realtime-2`는 비싸다(오디오 출력 약 $64/1M). 개발·테스트는 `.env`의 `RUACH_REALTIME_MODEL`을 `gpt-realtime` 등 더 싼 모델로 낮춰서 한다.

## 커밋

- `.env`·`notes.jsonl`·`node_modules`는 `.gitignore`에 있다. `git add` 시 시크릿이 들어가지 않는지 확인.
- 커밋 메시지에 `Co-Authored-By` 라인을 넣지 않는다. 도메인 관점의 자연스러운 요약으로 작성.

## 로드맵

- **M1** ✅ 음성 통화 + SOUL 페르소나 + 데모 툴(`get_current_time`, `remember`)
- **M2** 두뇌 코어 — 툴 레지스트리/dispatch, 비동기 잡 엔진, 세션 영속화, 토큰 리프레시. **방향 확정: 하이브리드**(라이브=네이티브 TS, 무거운 작업=Hermes에 async 위임). Hermes 방법론 이식 상세 설계: [docs/HERMES-PORT.md](docs/HERMES-PORT.md).
- **M3** 스킬 인덱스 + 장기 메모리(prefetch/sync)
- **M4** 채널 확장(Discord 음성 / 전화)
