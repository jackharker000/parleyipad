import type { CapacitorConfig } from "@capacitor/cli";

// Native iPad shell. The web bundle (SPA shell + assets, including the ONNX
// speaker-ID models) ships inside the app, so the cockpit, IndexedDB, and the
// audio pipeline all run on-device with zero network. Only the keyed server
// functions go out to the hosted deploy — see src/lib/native-bridge.ts, which
// rewrites those calls to https://parley.help (override with VITE_API_ORIGIN
// at build time).
const config: CapacitorConfig = {
  appId: "help.parley.app",
  appName: "Parley",
  webDir: "dist-ios",
  ios: {
    // The cockpit manages its own safe-area padding via CSS.
    contentInset: "never",
  },
};

export default config;
