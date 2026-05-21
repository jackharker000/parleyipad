# Speaker-ID models

Parley's speaker-ID engine runs entirely on-device. Two model files belong here:

## 1. `ecapa-tdnn.onnx` (or compatible speaker embedder)

The embedder is loaded by `OnnxEcapaEmbedder` in `src/lib/audio/embedder.ts`.

Expected ONNX signature:

- **Input:** `float32[1, num_samples]` — mono waveform at 16 kHz
- **Output:** `float32[1, 192]` — speaker embedding (or any fixed dim; the
  matcher works regardless)

The default path is `/models/ecapa-tdnn.onnx` (this file, served as-is by
Vite from `public/`).

### Where to get one

A standard option is the SpeechBrain `spkrec-ecapa-voxceleb` ECAPA-TDNN model,
exported to ONNX with feature extraction baked in (so the runtime input is
raw 16 kHz waveform). Equivalent WeSpeaker / Pyannote exports also work.

Until you drop the file in, the spike route falls back to a deterministic
mock embedder so the rest of the pipeline (VAD → match → UI) is still
debuggable. The mock is **not** suitable for shipping — swap to the real
ECAPA before any accuracy claim.

## 2. Silero VAD assets

The `@ricky0123/vad-web` package ships its own AudioWorklet and Silero ONNX.
By default it fetches:

- `/vad.worklet.bundle.min.js`
- `/silero_vad.onnx` (or `silero_vad_legacy.onnx` depending on version)

After running `bun install`, copy these from `node_modules/@ricky0123/vad-web/dist/`
into `public/`:

```sh
cp node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js public/
cp node_modules/@ricky0123/vad-web/dist/silero_vad.onnx public/
# or, depending on the version pinned in package.json:
# cp node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx public/
```

A short script in `package.json` (e.g. `"postinstall": "node scripts/copy-vad-assets.mjs"`)
is the right home for this once we have one.
