#!/usr/bin/env bun
/**
 * A local MCP fixture for inspecting a harness's image output without image
 * generation, credentials, networking, or access to user files. It serves one
 * synthetic PNG; calling it directly spends no model tokens.
 *
 * Configure a stdio server with command `bun` and args
 * ["<absolute path to this script>", "--stdio"], then ask the harness to call
 * sample_image once. Capture the harness's structured output separately.
 * `--write-sample <path>` writes the same PNG for a Markdown-image comparison.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isRecord } from "../../src/validate";

// Generated from scratch: 240 x 100 pixels, blue/green/yellow vertical stripes.
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAABkCAIAAAA3wCqQAAABsElEQVR4nO3SAQmEAABFMeMYzIgmuSRGEK7EB99gEXac16/lvlKe+0w5" +
  "9sOEFlpooYUWWujvE/rj5sOEFlpooYUWWuiC+TChhRZaaKGFFrpgPkxooYUWWmihhS6YDxNaaKGFFlpooQvmw4QWWmihhRZa6IL5" +
  "MKGFFlpooYUWumA+TGihhRZaaKGFLpgPE1pooYUWWmihC+bDhBZaaKGFFlrogvkwoYUWWmihhRa6YD5MaKGFFlpooYUumA8TWmih" +
  "hRZaaKEL5sOEFlpooYUWWuiC+TChhRZaaKGFFrpgPkxooYUWWmihhS6YDxNaaKGFFlpooQvmw4QWWmihhRZa6IL5MKGFFlpooYUW" +
  "umA+TGihhRZaaKGFLpgPE1pooYUWWmihC+bDhBZaaKGFFlrogvkwoYUWWmihhRa6YD5MaKGFFlpooYUumA8TWmihhRZaaKEL5sOEFlpo" +
  "oYUWWuiC+TChhRZaaKGFFrpgPkxooYUWWmihhS6YDxNaaKGFFlpooQvmw4QWWmihhRZa6IL5MKGFFlpooYUWumA+TGihhRZaaKGFLpg" +
  "PE1pooYUWWui/F8Dv+Ig9sc2vAAAAAElFTkSuQmCC";

export function samplePng(): Buffer<ArrayBuffer> {
  return Buffer.from(SAMPLE_PNG_BASE64, "base64");
}

type RequestId = string | number | null;

function rpcError(id: RequestId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** One JSONL request in, one JSONL response out; notifications have no reply. */
export function imageProbeReply(line: string): string | null {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return JSON.stringify(rpcError(null, -32700, "Parse error"));
  }
  if (!isRecord(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return JSON.stringify(rpcError(null, -32600, "Invalid request"));
  }
  if (!Object.hasOwn(request, "id")) return null;
  if (typeof request.id !== "number" && typeof request.id !== "string" && request.id !== null) {
    return JSON.stringify(rpcError(null, -32600, "Invalid request id"));
  }
  const id = request.id;
  const params = isRecord(request.params) ? request.params : {};
  let result: unknown;
  switch (request.method) {
    case "initialize":
      if (typeof params.protocolVersion !== "string") {
        return JSON.stringify(rpcError(id, -32602, "Expected protocolVersion"));
      }
      result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "image-output-probe", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = { tools: [{
        name: "sample_image",
        description: "Return a synthetic PNG with blue, green, and yellow stripes for an output rendering test.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      }] };
      break;
    case "tools/call":
      if (params.name !== "sample_image" || (params.arguments !== undefined &&
          (!isRecord(params.arguments) || Object.keys(params.arguments).length > 0))) {
        return JSON.stringify(rpcError(id, -32602, "Expected sample_image with no arguments"));
      }
      result = { content: [
        { type: "text", text: "Synthetic sample image: blue, green, yellow stripes." },
        { type: "image", mimeType: "image/png", data: SAMPLE_PNG_BASE64 },
      ] };
      break;
    case "ping": result = {}; break;
    case "resources/list": result = { resources: [] }; break;
    case "resources/templates/list": result = { resourceTemplates: [] }; break;
    case "prompts/list": result = { prompts: [] }; break;
    default: return JSON.stringify(rpcError(id, -32601, "Method not found"));
  }
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--stdio") {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const reply = imageProbeReply(line);
      if (reply !== null) console.log(reply);
    }
    return;
  }
  if (args.length === 2 && args[0] === "--write-sample") {
    writeFileSync(args[1], samplePng(), { flag: "wx" });
    console.log(`wrote ${args[1]}`);
    return;
  }
  console.log("Usage: bun wispd/scripts/harness/image-output-probe.ts --stdio | --write-sample <new path>");
  if (args.length > 0 && args[0] !== "--help") process.exitCode = 2;
}

if (import.meta.main) await main(process.argv.slice(2));
