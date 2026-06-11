import path from "node:path";
import { fileURLToPath } from "url";
import { env, pipeline } from "@huggingface/transformers";
import elizaLogger from "../utils/logger.ts";

/** Dense vector size for Xenova/bge-m3 (Transformers.js ONNX). */
const BGE_M3_DIMENSIONS = 1024;
const LOCAL_BGE_M3_MODEL = "Xenova/bge-m3";

/**
 * Expected minimum size (bytes) for model.onnx_data.
 * The full fp32 file is ~2.27 GB (2 266 820 608 bytes).
 * We use a slightly lower threshold to tolerate minor version differences.
 */
const ONNX_DATA_EXPECTED_MIN_BYTES = 500_000_000;

/** BGE-M3 feature-extraction pipeline (avoid complex pipeline<> union in d.ts). */
type BgeM3Extractor = (
    text: string,
    options?: { pooling?: string; normalize?: boolean }
) => Promise<unknown>;

/** Narrow `pipeline` for d.ts generation (TS2590 on default overload union). */
const loadFeatureExtractionPipeline = pipeline as unknown as (
    task: "feature-extraction",
    model: string,
    options?: {
        progress_callback?: (progress: Record<string, unknown>) => void;
        dtype?: string;
        session_options?: {
            intraOpNumThreads?: number;
            interOpNumThreads?: number;
            executionMode?: "sequential" | "parallel";
            graphOptimizationLevel?:
                | "disabled"
                | "basic"
                | "extended"
                | "all";
        };
    }
) => Promise<BgeM3Extractor>;

/**
 * Cap onnxruntime-node threads. BGE-M3 cold-start otherwise pins both vCPUs
 * for ~60 s on a 2-vCPU container, starving concurrent request handling.
 * Read from EMBEDDING_ORT_THREADS (default 1) so it can be tuned per env.
 */
const ORT_THREADS = (() => {
    const raw = process.env.EMBEDDING_ORT_THREADS;
    const n = raw ? Number.parseInt(raw, 10) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
})();

class LocalEmbeddingModelManager {
    private static instance: LocalEmbeddingModelManager | null;
    private extractor: BgeM3Extractor | null = null;
    private _initPromise: Promise<void> | null = null;
    private _warmupPromise: Promise<void> | null = null;

    private constructor() {}

    public static getInstance(): LocalEmbeddingModelManager {
        if (!LocalEmbeddingModelManager.instance) {
            LocalEmbeddingModelManager.instance =
                new LocalEmbeddingModelManager();
        }
        return LocalEmbeddingModelManager.instance;
    }

    private getCacheDir(): string {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const normalizedDir = path.normalize(__dirname);
        const distSuffix = `${path.sep}dist`;
        const srcSegment = `${path.sep}src${path.sep}`;

        if (normalizedDir.endsWith(distSuffix)) {
            return path.join(path.dirname(normalizedDir), "cache");
        }

        const srcIndex = normalizedDir.lastIndexOf(srcSegment);
        if (srcIndex !== -1) {
            return path.join(normalizedDir.slice(0, srcIndex), "cache");
        }

        return path.join(path.resolve(__dirname, ".."), "cache");
    }

    public async initialize(): Promise<void> {
        if (this.extractor) {
            return;
        }
        if (!this._initPromise) {
            this._initPromise = this.initializeModel().catch((e: Error) => {
                this._initPromise = null;
                throw e;
            });
        }
        return this._initPromise;
    }

    /**
     * Force a real forward pass so the ORT session is created, q8→fp32 weights
     * are pre-packed into the arena, and the kernel cache is primed. Without
     * this, `pipeline()` only parses model files lazily — the ~4 GB native
     * commit + ~60 s CPU burn is deferred to the first user-driven embed call.
     */
    public async warmup(): Promise<void> {
        if (this._warmupPromise) {
            return this._warmupPromise;
        }
        this._warmupPromise = (async () => {
            await this.initialize();
            if (!this.extractor) {
                throw new Error("Failed to initialize model before warmup");
            }
            const start = Date.now();
            try {
                await this.extractor("warmup", {
                    pooling: "cls",
                    normalize: true,
                });
                elizaLogger.info(
                    `BGE-M3 warmup inference complete in ${Date.now() - start}ms (ortThreads=${ORT_THREADS})`
                );
            } catch (error) {
                this._warmupPromise = null;
                elizaLogger.error("BGE-M3 warmup inference failed:", error);
                throw error;
            }
        })();
        return this._warmupPromise;
    }

    private async initializeModel(): Promise<void> {
        const isNode =
            typeof process !== "undefined" &&
            process.versions != null &&
            process.versions.node != null;

        if (!isNode) {
            throw new Error("Local embedding not supported in browser");
        }

        try {
            const fs = await import("fs");
            const cacheDir = this.getCacheDir();

            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            env.cacheDir = cacheDir;

            // Validate cached model file integrity before loading
            await this.validateModelCache(fs, cacheDir);

            elizaLogger.debug("Initializing BGE-M3 embedding model...");

            /** Only INFO-log percent progress for larger assets; small JSON/tokenizer shards stay DEBUG. */
            const progressStepPct = 25;
            const progressInfoMinBytes = 512 * 1024;
            let lastProgressFile: string | undefined;
            let lastProgressBucket = -1;

            this.extractor = await loadFeatureExtractionPipeline(
                "feature-extraction",
                LOCAL_BGE_M3_MODEL,
                {
                    dtype: "q8" as const,
                    session_options: {
                        intraOpNumThreads: ORT_THREADS,
                        interOpNumThreads: ORT_THREADS,
                        executionMode: "sequential",
                    },
                    progress_callback: (progress) => {
                        const p = progress as {
                            status?: string;
                            file?: string;
                            name?: string;
                            progress?: number;
                            loaded?: number;
                            total?: number;
                        };
                        const file = p.file ?? p.name;
                        const status = p.status;

                        if (status && status !== "progress") {
                            if (status === "ready") {
                                elizaLogger.info(
                                    "BGE-M3 local embedding ready (Xenova/bge-m3)"
                                );
                            } else {
                                elizaLogger.debug("BGE-M3 model file", {
                                    status,
                                    file,
                                });
                            }
                            if (status === "done" || status === "ready") {
                                lastProgressFile = undefined;
                                lastProgressBucket = -1;
                            }
                            return;
                        }

                        const totalBytes = p.total;
                        const logProgressAtInfo =
                            totalBytes == null ||
                            totalBytes >= progressInfoMinBytes;

                        if (file !== lastProgressFile) {
                            lastProgressFile = file;
                            lastProgressBucket = -1;
                        }

                        const progressNum =
                            typeof p.progress === "number" ? p.progress : 0;
                        const bucket = Math.floor(
                            Math.min(100, progressNum) / progressStepPct
                        );
                        if (bucket <= lastProgressBucket) {
                            return;
                        }
                        lastProgressBucket = bucket;

                        const pctStr = `${progressNum.toFixed(1)}%`;
                        const bytesStr =
                            p.loaded != null && p.total != null
                                ? `${p.loaded}/${p.total} bytes`
                                : undefined;
                        const payload = {
                            status: "progress" as const,
                            file,
                            progress: pctStr,
                            bytes: bytesStr,
                        };
                        if (logProgressAtInfo) {
                            elizaLogger.info("BGE-M3 model", payload);
                        } else {
                            elizaLogger.debug("BGE-M3 model file", payload);
                        }
                    },
                }
            );

            elizaLogger.debug("BGE-M3 model initialized successfully");
        } catch (error) {
            elizaLogger.error("Failed to initialize BGE-M3 model:", error);
            throw error;
        }
    }

    /**
     * Check if the cached model.onnx_data file exists and is complete.
     * If the file is missing or truncated (e.g. previous download interrupted),
     * delete it so that @huggingface/transformers re-downloads it.
     */
    private async validateModelCache(
        fs: typeof import("fs"),
        cacheDir: string
    ): Promise<void> {
        const modelDir = path.join(
            cacheDir,
            LOCAL_BGE_M3_MODEL,
            "onnx"
        );
        const onnxDataPath = path.join(modelDir, "model_quantized.onnx");

        if (!fs.existsSync(onnxDataPath)) {
            return; // Not cached yet — will be downloaded
        }

        const stat = fs.statSync(onnxDataPath);
        if (stat.size >= ONNX_DATA_EXPECTED_MIN_BYTES) {
            elizaLogger.debug(
                `BGE-M3 model cache valid (${(stat.size / 1e9).toFixed(2)} GB)`
            );
            return;
        }

        // File is incomplete — remove the entire model directory to force re-download
        elizaLogger.warn(
            `BGE-M3 model_quantized.onnx is incomplete ` +
                `(${(stat.size / 1e9).toFixed(2)} GB / ` +
                `${(ONNX_DATA_EXPECTED_MIN_BYTES / 1e9).toFixed(2)} GB expected). ` +
                `Deleting cache to re-download...`
        );
        fs.rmSync(path.join(cacheDir, LOCAL_BGE_M3_MODEL), {
            recursive: true,
            force: true,
        });
    }

    public async generateEmbedding(input: string): Promise<number[]> {
        if (!this.extractor) {
            await this.initialize();
        }

        if (!this.extractor) {
            throw new Error("Failed to initialize model");
        }

        try {
            const raw = await this.extractor(input, {
                pooling: "cls",
                normalize: true,
            });
            return this.tensorToEmbedding(raw);
        } catch (error) {
            elizaLogger.error("Embedding generation failed:", error);
            throw error;
        }
    }

    private tensorToEmbedding(raw: unknown): number[] {
        if (
            raw &&
            typeof raw === "object" &&
            "tolist" in raw &&
            typeof (raw as { tolist: () => unknown }).tolist === "function"
        ) {
            const list = (raw as { tolist: () => unknown }).tolist();
            return this.normalizeEmbeddingList(list);
        }

        if (
            ArrayBuffer.isView(raw) &&
            (raw as Float32Array).constructor === Float32Array
        ) {
            const arr = Array.from(raw as Float32Array).map(Number);
            this.warnIfDimensionMismatch(arr.length);
            return arr;
        }

        throw new Error(`Unexpected embedding format: ${typeof raw}`);
    }

    private normalizeEmbeddingList(list: unknown): number[] {
        if (!Array.isArray(list) || list.length === 0) {
            throw new Error("Empty embedding list");
        }
        let row: unknown[];
        if (typeof list[0] === "number") {
            row = list as unknown[];
        } else if (Array.isArray(list[0])) {
            row = list[0] as unknown[];
        } else {
            throw new Error("Unexpected embedding list shape");
        }

        const finalEmbedding = row.map((n) => Number(n));
        if (finalEmbedding[0] === undefined) {
            throw new Error(
                "Invalid embedding format: must be an array starting with a number"
            );
        }
        this.warnIfDimensionMismatch(finalEmbedding.length);
        return finalEmbedding;
    }

    private warnIfDimensionMismatch(length: number): void {
        if (length !== BGE_M3_DIMENSIONS) {
            elizaLogger.warn(
                `Unexpected embedding dimension: ${length} (expected ${BGE_M3_DIMENSIONS})`
            );
        }
    }

    public async reset(): Promise<void> {
        if (this.extractor) {
            this.extractor = null;
        }
        this._initPromise = null;
        this._warmupPromise = null;
    }

    public static resetInstance(): void {
        if (LocalEmbeddingModelManager.instance) {
            LocalEmbeddingModelManager.instance.reset();
            LocalEmbeddingModelManager.instance = null;
        }
    }
}

export default LocalEmbeddingModelManager;
