import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [tsConfigPaths(), tanstackStart(), nitro(), viteReact(), tailwindcss()],
  // Dexie hard-throws "Two different versions of Dexie loaded in the same
  // app" if two physical copies land in one bundle — which crashed SSR on
  // every route after the legacy-deps install left 4.4.2 + 4.4.3 both
  // resolvable (direct `dexie` vs the copy `dexie-react-hooks` pulled in).
  // dedupe collapses every `dexie` import to one module instance at bundle
  // time regardless of node_modules layout. react/react-dom deduped too as
  // standard singleton hygiene.
  resolve: {
    dedupe: ["dexie", "dexie-react-hooks", "react", "react-dom"],
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web", "@ricky0123/vad-web", "@huggingface/transformers"],
  },
});

// Vercel auto-detects the Nitro output and routes /api/* + SSR through serverless
// functions. Enable Cross-Origin Isolation later (COOP/COEP headers) once we want
// SharedArrayBuffer for multi-threaded ONNX WASM. Single-threaded WASM and WebGPU
// both work without it.
