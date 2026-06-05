import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // 백엔드(/api/*)로 프록시 → 브라우저는 same-origin으로 토큰을 받는다 (CORS 단순화).
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
