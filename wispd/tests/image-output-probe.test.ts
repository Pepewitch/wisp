import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { imageProbeReply, samplePng } from "../scripts/harness/image-output-probe";

function request(method: string, params?: unknown, id: string | number = 1) {
  return JSON.parse(imageProbeReply(JSON.stringify({ jsonrpc: "2.0", id, method, params }))!);
}

test("MCP handshake, tool discovery, and image delivery need no harness or external files", () => {
  const init = request("initialize", { protocolVersion: "2025-03-26" }, "hello");
  expect(init).toMatchObject({ jsonrpc: "2.0", id: "hello", result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} },
  } });
  const tools = request("tools/list").result.tools;
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ name: "sample_image", annotations: { readOnlyHint: true } });
  const image = request("tools/call", { name: tools[0].name, arguments: {} }).result.content[1];
  expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
  expect(Buffer.from(image.data, "base64")).toEqual(samplePng());
});

test("the sample is a decodable PNG with the advertised dimensions and stripe colors", () => {
  const png = samplePng();
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(240);
  expect(png.readUInt32BE(20)).toBe(100);
  const imageData: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      imageData.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(imageData));
  expect(pixels.length).toBe(100 * (1 + 240 * 3));
  expect([...pixels.subarray(1, 4)]).toEqual([40, 100, 210]);
  expect([...pixels.subarray(1 + 80 * 3, 4 + 80 * 3)]).toEqual([40, 180, 100]);
  expect([...pixels.subarray(1 + 160 * 3, 4 + 160 * 3)]).toEqual([240, 180, 40]);
});

test("notifications produce no response and malformed requests produce JSON-RPC errors", () => {
  expect(imageProbeReply('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull();
  expect(JSON.parse(imageProbeReply("{")!)).toMatchObject({ id: null, error: { code: -32700 } });
  expect(JSON.parse(imageProbeReply("[]")!)).toMatchObject({ id: null, error: { code: -32600 } });
  expect(request("unknown", {}, 7)).toMatchObject({ id: 7, error: { code: -32601 } });
});

test("tool calls cannot select files or other tools", () => {
  expect(request("tools/call", { name: "read_file" }).error.code).toBe(-32602);
  expect(request("tools/call", { name: "sample_image", arguments: { path: "/work/private.png" } }).error.code).toBe(-32602);
  expect(request("tools/call", { name: "sample_image", arguments: [] }).error.code).toBe(-32602);
});
