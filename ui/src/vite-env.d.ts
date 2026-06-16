/// <reference types="vite/client" />

// Injected by vite.config.ts `define`: the dev API's WebSocket URL (e.g.
// "ws://localhost:4747/ws"). The client connects here directly in dev instead of
// through Vite's flaky `/ws` proxy. Replaced with a string literal at build time.
declare const __RUBATO_DEV_WS_URL__: string;
