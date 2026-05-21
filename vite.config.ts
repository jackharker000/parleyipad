import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsConfigPaths(), tanstackStart(), viteReact(), tailwindcss()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web", "@ricky0123/vad-web"],
  },
});

// Note: enable Cross-Origin Isolation (COOP/COEP) once we start using
// SharedArrayBuffer for multi-threaded ONNX WASM or AudioWorklet → Worker
// shared buffers. Single-threaded WASM and WebGPU work without it.
