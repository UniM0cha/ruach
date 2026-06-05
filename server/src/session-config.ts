import { loadPersona } from "./persona.js";

/**
 * client_secrets 발급에 실어 보낼 Realtime 세션 설정.
 * 스키마: POST /v1/realtime/client_secrets 의 `session` 객체.
 */
export interface RealtimeSessionConfig {
  type: "realtime";
  model: string;
  instructions: string;
  output_modalities: ["audio"];
  audio: {
    input: {
      format: { type: "audio/pcm"; rate: number };
      turn_detection: { type: "server_vad" };
    };
    output: { voice: string };
  };
}

/** SOUL.md 페르소나 + 음성/턴감지 설정을 묶어 세션 설정을 만든다. */
export async function buildSessionConfig(
  model: string,
): Promise<RealtimeSessionConfig> {
  const instructions = await loadPersona();
  const voice = process.env.RUACH_VOICE ?? "alloy";

  return {
    type: "realtime",
    model,
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        // 서버 VAD가 말의 시작·끝을 자동 감지 → 자연스러운 턴 전환·끼어들기.
        turn_detection: { type: "server_vad" },
      },
      output: { voice },
    },
  };
}
