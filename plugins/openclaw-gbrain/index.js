import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_GBRAIN_BIN = "gbrain";
const DEFAULT_OPENCLAW_BIN = "openclaw";
const DEFAULT_EXTRACTION_MODEL = "openai-codex/gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = 120_000;
const GBRAIN_ROUTE_PATH = "/plugins/gbrain/extract";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_TIMEOUT_MS = 300_000;

function readConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  return {
    gbrainBin: readConfigString(cfg.gbrainBin) ?? process.env.GBRAIN_BIN ?? DEFAULT_GBRAIN_BIN,
    openclawBin: readConfigString(cfg.openclawBin) ?? process.env.OPENCLAW_BIN ?? DEFAULT_OPENCLAW_BIN,
    workingDir: readConfigString(cfg.workingDir) ?? process.cwd(),
    extractionModel: readConfigString(cfg.extractionModel) ?? DEFAULT_EXTRACTION_MODEL,
    timeoutMs: readTimeoutMs(cfg.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

function readConfigString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTimeoutMs(value, fallback) {
  return clampTimeoutMs(Number(value), fallback);
}

function clampTimeoutMs(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function runCommand(command, args, config, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: config.workingDir,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxBytes = options.maxBytes ?? 256_000;
    let timedOut = false;
    const timeoutMs = clampTimeoutMs(options.timeoutMs, config.timeoutMs);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-maxBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maxBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr: timedOut ? `Command timed out after ${timeoutMs}ms.` : stderr,
        timedOut,
      });
    });
  });
}

function runGbrain(config, args, options = {}) {
  return runCommand(config.gbrainBin, args, config, options);
}

function runOpenClaw(config, args, options = {}) {
  return runCommand(config.openclawBin, args, config, options);
}

async function handleExtractionRoute(config, req, res) {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  let tempDir;
  try {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const request = readExtractionRequest(body);
    const kind = normalizeMediaKind(request.kind);
    const sourceRef = normalizeRequiredString(request.sourceRef, "sourceRef");
    const title = normalizeOptionalString(request.title);
    const text = normalizeOptionalString(request.text);
    const image = readImageInput(request);
    if (!text && !image) {
      throw new RequestError(400, "missing_content", "Provide text or file.base64.");
    }
    if (kind !== "image" && !text) {
      throw new RequestError(
        400,
        "missing_text",
        "Video, audio, and document MVP extraction requires text or transcript content.",
      );
    }

    const args = [
      "infer",
      "model",
      "run",
      "--gateway",
      "--model",
      resolveExtractionModel(request.model, config.extractionModel),
      "--prompt",
      buildExtractionPrompt({ kind, sourceRef, title, text, hasImage: Boolean(image) }),
      "--json",
    ];
    if (image) {
      tempDir = await mkdtemp(join(tmpdir(), "gbrain-extract-"));
      const imagePath = join(tempDir, image.name);
      await writeFile(imagePath, Buffer.from(image.base64, "base64"));
      args.push("--file", imagePath);
    }

    const result = await runOpenClaw(config, args, {
      maxBytes: 512_000,
      timeoutMs: readTimeoutMs(request.timeoutMs, config.timeoutMs),
    });
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "OpenClaw model run failed.");
    }
    const cliJson = parseJsonObject(result.stdout);
    if (cliJson.ok !== true) {
      throw new Error("OpenClaw model run returned an unsuccessful response.");
    }
    const modelText = readModelRunText(cliJson);
    const extraction = normalizeExtraction({
      parsed: parseJsonObject(modelText),
      kind,
      sourceRef,
      title,
    });
    writeJson(res, 200, {
      ok: true,
      protocol: "gbrain.media-extraction.v1",
      provider: "openai-codex",
      model: resolveExtractionModel(request.model, config.extractionModel),
      extraction,
    });
    return true;
  } catch (error) {
    if (error instanceof RequestError) {
      writeJson(res, error.statusCode, {
        ok: false,
        error: error.code,
        message: error.message,
      });
      return true;
    }
    writeJson(res, 502, {
      ok: false,
      error: "extraction_failed",
      message: "OpenClaw OAuth-backed extraction failed.",
    });
    return true;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function resolveExtractionModel(requested, fallback) {
  const model = normalizeOptionalString(requested) ?? fallback;
  return model.includes("/") ? model : `openai-codex/${model}`;
}

function buildExtractionPrompt(params) {
  const segmentKind =
    params.kind === "image"
      ? "frame"
      : params.kind === "video"
        ? "transcript_segment"
        : params.kind === "audio"
          ? "audio_segment"
          : "page";
  const parts = [
    "Return only JSON matching this TypeScript shape:",
    "{ schemaVersion:'gbrain.media-extraction.v1', kind:'image'|'pdf'|'video'|'audio', sourceRef:string, title?:string, summary?:string, tags?:string[], entities?:{text:string,type?:string}[], segments:{id:string, kind:'asset'|'page'|'frame'|'transcript_segment'|'audio_segment', label?:string, summary?:string, caption?:string, ocrText?:string, transcriptText?:string, tags?:string[], entities?:{text:string,type?:string}[]}[] }",
    "",
    `kind: ${params.kind}`,
    `sourceRef: ${params.sourceRef}`,
    `preferred segment kind: ${segmentKind}`,
  ];
  if (params.title) parts.push(`title: ${params.title}`);
  if (params.hasImage) {
    parts.push(
      "Analyze the attached image. Categorize it, summarize it, add searchable tags, extract visible text into ocrText, and list visible entities when identifiable.",
    );
  }
  if (params.text) parts.push("Text/transcript content:", params.text);
  return parts.join("\n");
}

function normalizeExtraction(params) {
  const candidate = isRecord(params.parsed.extraction) ? params.parsed.extraction : params.parsed;
  const summary = normalizeOptionalString(candidate.summary);
  const extraction = {
    schemaVersion: "gbrain.media-extraction.v1",
    kind: params.kind,
    sourceRef: params.sourceRef,
    ...(params.title ? { title: params.title } : {}),
    ...(summary ? { summary } : {}),
    tags: normalizeStringArray(candidate.tags),
    entities: normalizeEntities(candidate.entities),
    segments: normalizeSegments(candidate.segments, params.kind, summary),
  };
  const returnedTitle = normalizeOptionalString(candidate.title);
  if (returnedTitle && !extraction.title) extraction.title = returnedTitle;
  return extraction;
}

function normalizeSegments(value, kind, fallbackSummary) {
  const source = Array.isArray(value) ? value : [];
  const segments = source.filter(isRecord).map((segment, index) => {
    const segmentKind =
      normalizeSegmentKind(segment.kind) ??
      (kind === "image"
        ? "frame"
        : kind === "video"
          ? "transcript_segment"
          : kind === "audio"
            ? "audio_segment"
            : "page");
    const normalized = {
      id: normalizeOptionalString(segment.id) ?? `${segmentKind}-${index + 1}`,
      kind: segmentKind,
      tags: normalizeStringArray(segment.tags),
      entities: normalizeEntities(segment.entities),
    };
    for (const key of ["label", "summary", "caption", "ocrText", "transcriptText"]) {
      const stringValue = normalizeOptionalString(segment[key]);
      if (stringValue) normalized[key] = stringValue;
    }
    const ocr = normalizeOptionalString(segment.ocr);
    const transcript = normalizeOptionalString(segment.transcript);
    if (ocr && !normalized.ocrText) normalized.ocrText = ocr;
    if (transcript && !normalized.transcriptText) normalized.transcriptText = transcript;
    return normalized;
  });
  if (segments.length > 0) return segments;
  return [
    {
      id: "asset-1",
      kind:
        kind === "image"
          ? "frame"
          : kind === "video"
            ? "transcript_segment"
            : kind === "audio"
              ? "audio_segment"
              : "page",
      ...(fallbackSummary ? { summary: fallbackSummary } : {}),
      tags: [],
      entities: [],
    },
  ];
}

function normalizeEntities(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((entity) => {
    const text = normalizeOptionalString(entity.text ?? entity.name);
    if (!text) return [];
    const type = normalizeOptionalString(entity.type ?? entity.kind);
    return [{ text, ...(type ? { type } : {}) }];
  });
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean),
    ),
  ];
}

function normalizeSegmentKind(value) {
  const kind = normalizeOptionalString(value);
  return ["asset", "page", "frame", "transcript_segment", "audio_segment"].includes(kind)
    ? kind
    : undefined;
}

function readModelRunText(value) {
  const outputs = Array.isArray(value.outputs) ? value.outputs : [];
  const text = outputs
    .filter(isRecord)
    .map((output) => normalizeOptionalString(output.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!text) throw new Error("OpenClaw model run returned no text.");
  return text;
}

function readExtractionRequest(value) {
  if (!isRecord(value)) {
    throw new RequestError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return value;
}

function readImageInput(request) {
  const file = isRecord(request.file) ? request.file : undefined;
  const base64 = normalizeOptionalString(file?.base64);
  if (!base64) return undefined;
  return {
    base64,
    name: sanitizeFileName(normalizeOptionalString(file.name) ?? "image.png"),
  };
}

function sanitizeFileName(value) {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return clean || "image.png";
}

function normalizeMediaKind(value) {
  const kind = normalizeOptionalString(value) ?? "image";
  if (["image", "pdf", "video", "audio"].includes(kind)) return kind;
  throw new RequestError(400, "invalid_kind", "kind must be image, pdf, video, or audio.");
}

function normalizeRequiredString(value, field) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new RequestError(400, `missing_${field}`, `${field} is required.`);
  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text));
    if (isRecord(parsed)) return parsed;
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/u);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (isRecord(parsed)) return parsed;
    }
  }
  throw new Error("Expected a JSON object.");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeJson(res, statusCode, value) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new RequestError(413, "body_too_large", "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new RequestError(400, "invalid_json", "Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

class RequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export default definePluginEntry({
  id: "gbrain",
  name: "GBrain",
  description: "Eva Brain/GBrain search, query, and media extraction.",
  register(api) {
    const config = readConfig(api.pluginConfig);

    api.registerHttpRoute({
      path: GBRAIN_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      handler: (req, res) => handleExtractionRoute(config, req, res),
    });

    api.registerTool(
      {
        name: "gbrain_status",
        description: "Check the local Eva Brain/GBrain installation status.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const version = await runGbrain(config, ["--version"]);
          const sources = await runGbrain(config, ["sources", "list"], { maxBytes: 24_000 });
          return textResult(
            [
              version.ok ? version.stdout.trim() : `gbrain version failed: ${version.stderr.trim()}`,
              "",
              sources.ok ? sources.stdout.trim() : `gbrain sources failed: ${sources.stderr.trim()}`,
            ].join("\n"),
            { version, sources },
          );
        },
      },
      { name: "gbrain_status" },
    );

    api.registerTool(
      {
        name: "gbrain_search",
        description: "Search the local Eva Brain/GBrain index.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
        },
        execute: async (_toolCallId, params) => {
          const query = typeof params?.query === "string" ? params.query.trim() : "";
          const limit = Number.isFinite(params?.limit)
            ? Math.max(1, Math.min(20, Math.floor(params.limit)))
            : 5;
          if (!query) return textResult("Missing required query.", { ok: false });
          const result = await runGbrain(config, ["search", query, "--limit", String(limit)]);
          return textResult(result.ok ? result.stdout.trim() : result.stderr.trim(), result);
        },
      },
      { name: "gbrain_search" },
    );

    api.registerTool(
      {
        name: "gbrain_query",
        description: "Ask a question against the local Eva Brain/GBrain index.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            question: { type: "string" },
          },
        },
        execute: async (_toolCallId, params) => {
          const question = typeof params?.question === "string" ? params.question.trim() : "";
          if (!question) return textResult("Missing required question.", { ok: false });
          const result = await runGbrain(config, ["query", question]);
          return textResult(result.ok ? result.stdout.trim() : result.stderr.trim(), result);
        },
      },
      { name: "gbrain_query" },
    );

    api.registerCli(
      ({ program }) => {
        const gbrain = program.command("gbrain").description("Eva Brain/GBrain commands");
        gbrain
          .command("status")
          .description("Check the local GBrain installation")
          .action(async () => {
            const result = await runGbrain(config, ["--version"]);
            if (result.ok) {
              console.log(result.stdout.trim());
            } else {
              console.error(result.stderr.trim() || "gbrain status failed");
              process.exitCode = 1;
            }
          });
      },
      {
        descriptors: [
          {
            name: "gbrain",
            description: "Eva Brain/GBrain commands",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
