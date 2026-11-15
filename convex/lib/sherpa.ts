"use node";
// Node-only (imported by voiceprint.ts). Loads sherpa-onnx's native speaker-embedding addon and the
// WeSpeaker model at runtime instead of shipping them in the Convex bundle: the addon (~33 MB) and
// model (~26 MB) would push the deployment past Convex's module-size limit. Both are pinned by hash,
// downloaded once, cached in Convex file storage, and unpacked to /tmp on each cold start.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const SHERPA_VERSION = "1.13.8";
const NATIVE: Record<string, { sha512: string }> = {
  "linux-x64": {
    sha512: "6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==",
  },
  // Convex's Node runtime (AWS Lambda arm64).
  "linux-arm64": {
    sha512: "Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==",
  },
  "darwin-arm64": {
    sha512: "FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==",
  },
};
export const MODEL = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx",
  sha256: "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94",
};

export function nativeKey() {
  const key = `${platform()}-${arch()}`;
  if (!NATIVE[key]) throw new Error(`no sherpa-onnx build pinned for ${key}`);
  return key;
}

export function nativeUrl() {
  const pkg = `sherpa-onnx-${nativeKey()}`;
  return `https://registry.npmjs.org/${pkg}/-/${pkg}-${SHERPA_VERSION}.tgz`;
}

export function verifyNative(bytes: ArrayBuffer) {
  const got = createHash("sha512").update(Buffer.from(bytes)).digest("base64");
  if (got !== NATIVE[nativeKey()].sha512) throw new Error("sherpa-onnx package hash mismatch");
}

export function verifyModel(bytes: ArrayBuffer) {
  const got = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  if (got !== MODEL.sha256) throw new Error("speaker model hash mismatch");
}

/** Bytes of the files to fetch: from Convex storage if cached, else the network (then cached). */
export type Fetcher = (kind: "native" | "model") => Promise<ArrayBuffer>;

const ROOT = `/tmp/wali-sherpa-${SHERPA_VERSION}`;

/** Extract the regular files of an npm tarball's package/ dir into `dir` (flat). */
function untgz(tgz: ArrayBuffer, dir: string) {
  const tar = gunzipSync(Buffer.from(tgz));
  mkdirSync(dir, { recursive: true });
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a: number, b: number) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const name = (str(345, 500) ? `${str(345, 500)}/` : "") + str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = off + 512;
    if (type === "0" && name.startsWith("package/")) {
      const rel = name.slice("package/".length);
      if (rel && !rel.includes("/") && !rel.includes("..")) {
        writeFileSync(join(dir, rel), tar.subarray(body, body + size), { mode: 0o755 });
      }
    }
    off = body + Math.ceil(size / 512) * 512;
  }
}

type Addon = {
  createSpeakerEmbeddingExtractor(config: { model: string; numThreads: number; debug: number }): unknown;
  speakerEmbeddingExtractorDim(h: unknown): number;
  speakerEmbeddingExtractorCreateStream(h: unknown): unknown;
  acceptWaveformOnline(stream: unknown, w: { samples: Float32Array; sampleRate: number }): void;
  speakerEmbeddingExtractorComputeEmbedding(h: unknown, stream: unknown, external: boolean): Float32Array;
};

export type Extractor = { dim: number; embed(samples: Float32Array, sampleRate: number): Float32Array };

let cached: Extractor | null = null;

export async function loadExtractor(fetchBytes: Fetcher): Promise<Extractor> {
  if (cached) return cached;
  const nativeDir = join(ROOT, nativeKey());
  const addonPath = join(nativeDir, "sherpa-onnx.node");
  if (!existsSync(addonPath)) {
    const tgz = await fetchBytes("native");
    verifyNative(tgz);
    const tmp = `${nativeDir}.${process.pid}.tmp`;
    untgz(tgz, tmp);
    if (!existsSync(join(tmp, "sherpa-onnx.node"))) throw new Error("sherpa-onnx.node missing from package");
    try {
      renameSync(tmp, nativeDir);
    } catch {
      // another invocation in this container won the race
    }
  }
  const modelPath = join(ROOT, "wespeaker_en_voxceleb_resnet34.onnx");
  if (!existsSync(modelPath)) {
    const bytes = await fetchBytes("model");
    verifyModel(bytes);
    const tmp = `${modelPath}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.from(bytes));
    renameSync(tmp, modelPath);
  }
  // The addon's RUNPATH is $ORIGIN, so libonnxruntime.so is found next to it.
  const addon = createRequire(import.meta.url)(addonPath) as Addon;
  const handle = addon.createSpeakerEmbeddingExtractor({ model: modelPath, numThreads: 2, debug: 0 });
  const dim = addon.speakerEmbeddingExtractorDim(handle);
  cached = {
    dim,
    embed(samples, sampleRate) {
      const stream = addon.speakerEmbeddingExtractorCreateStream(handle);
      addon.acceptWaveformOnline(stream, { samples, sampleRate });
      return addon.speakerEmbeddingExtractorComputeEmbedding(handle, stream, false);
    },
  };
  return cached;
}
