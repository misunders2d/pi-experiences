export const LOCAL_EMBEDDING_PROVIDER = "local-experience-onnx";
export const LOCAL_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2@2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const LOCAL_EMBEDDING_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const LOCAL_EMBEDDING_ASSET_VERSION = "multilingual-minilm-l12-int8-v1";
export const LOCAL_EMBEDDING_DIMENSIONS = 384;
export const LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP = 4000;
export const LOCAL_EMBEDDING_STRONG_THRESHOLD_BP = 7000;
export const LOCAL_EMBEDDING_TIMEOUT_MS = 120_000;
export const LOCAL_EMBEDDING_MAX_TOKENS = 128;
export const LOCAL_EMBEDDING_IDLE_MS = 30_000;
export const LOCAL_EMBEDDING_MAX_BATCH = 64;

export interface LocalEmbeddingAssetDefinition {
	name: "model_int8.onnx" | "tokenizer.json" | "tokenizer_config.json" | "config.json" | "ort-wasm-simd-threaded.wasm";
	url: string;
	bytes: number;
	sha256: string;
}

const MODEL_BASE = `https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/${LOCAL_EMBEDDING_REVISION}`;

export const LOCAL_EMBEDDING_ASSETS: readonly LocalEmbeddingAssetDefinition[] = Object.freeze([
	{ name: "model_int8.onnx", url: `${MODEL_BASE}/onnx/model_int8.onnx?download=true`, bytes: 118_054_609, sha256: "d6ea442ff6a891daefed7c83b2f596fc5dc66bf697e4d006236f64f34bbcf4c8" },
	{ name: "tokenizer.json", url: `${MODEL_BASE}/tokenizer.json?download=true`, bytes: 17_082_913, sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441" },
	{ name: "tokenizer_config.json", url: `${MODEL_BASE}/tokenizer_config.json?download=true`, bytes: 496, sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2" },
	{ name: "config.json", url: `${MODEL_BASE}/config.json?download=true`, bytes: 673, sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7" },
	{ name: "ort-wasm-simd-threaded.wasm", url: "https://unpkg.com/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.wasm", bytes: 13_479_978, sha256: "d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6" },
]);

export const LOCAL_EMBEDDING_DOWNLOAD_BYTES = LOCAL_EMBEDDING_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);
export const LOCAL_EMBEDDING_MAX_MANAGED_BYTES = 300_000_000;

if (LOCAL_EMBEDDING_DOWNLOAD_BYTES > LOCAL_EMBEDDING_MAX_MANAGED_BYTES) throw new Error("Local embedding asset manifest exceeds managed footprint cap");
