#!/usr/bin/env node
/**
 * Copy the runtime assets that the Silero VAD library needs (its
 * AudioWorklet bundle, the Silero ONNX models, and onnxruntime-web's WASM
 * glue) into public/ so the library can fetch them from the site's own
 * origin. iPad Safari blocks cross-origin module loads even from
 * cdn.jsdelivr.net, so the library's default CDN paths don't work.
 *
 * Runs as a postinstall step; safe to re-run.
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const dst = path.join(repoRoot, "public");

async function copyMatching(srcDir, patterns) {
  let entries;
  try {
    entries = await readdir(srcDir);
  } catch (err) {
    console.warn(`[copy-vad-assets] ${srcDir} missing (${err.code ?? err}); skipping`);
    return 0;
  }
  await mkdir(dst, { recursive: true });

  let copied = 0;
  for (const entry of entries) {
    if (!patterns.some((re) => re.test(entry))) continue;
    const from = path.join(srcDir, entry);
    const to = path.join(dst, entry);
    const info = await stat(from);
    if (!info.isFile()) continue;
    await copyFile(from, to);
    console.log(`[copy-vad-assets] ${path.basename(srcDir)}/${entry} → public/${entry}`);
    copied++;
  }
  return copied;
}

const vadDir = path.join(repoRoot, "node_modules", "@ricky0123", "vad-web", "dist");
const ortDir = path.join(repoRoot, "node_modules", "onnxruntime-web", "dist");

const vadCount = await copyMatching(vadDir, [
  /^vad\.worklet\.bundle\.min\.js$/i,
  /^silero_vad.*\.onnx$/i,
]);

const ortCount = await copyMatching(ortDir, [
  // ORT's WASM glue. Threading is disabled at runtime (numThreads = 1) but
  // ORT still picks one of these binaries based on capability detection.
  /^ort-wasm-simd-threaded\.(mjs|wasm)$/i,
  /^ort-wasm-simd-threaded\.jsep\.(mjs|wasm)$/i,
]);

if (vadCount === 0 || ortCount === 0) {
  console.warn(
    `[copy-vad-assets] vad=${vadCount} ort=${ortCount} — expected both non-zero. Check node_modules.`,
  );
}
