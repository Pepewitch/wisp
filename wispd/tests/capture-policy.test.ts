import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { CaptureUrlError, isLoopbackHost, mayReach, parseCaptureUrl, privateAddressReason, sanitizeUrl } from "../src/capture/policy";
import { startCaptureProxy, type CaptureProxy } from "../src/capture/proxy";

describe("what a capture may open", () => {
  test("only http(s) on loopback, spelled any way the URL parser normalises", () => {
    for (const url of ["http://localhost:3000/", "http://app.localhost:5173/x", "http://127.0.0.1:8080", "http://127.1:8080", "http://0x7f.1/", "https://[::1]:4443/", "http://[::ffff:127.0.0.1]:9/"]) {
      expect(() => parseCaptureUrl(url)).not.toThrow();
    }
    const refused = (url: string, says: string) => expect(() => parseCaptureUrl(url)).toThrow(says);
    refused("file:///etc/passwd", "only http and https");
    refused("http://example.com/", "loopback");
    refused("http://10.0.0.5:3000/", "loopback");
    refused("http://0.0.0.0:3000/", "use 127.0.0.1");
    refused("http://user:pw@localhost:3000/", "user name or password");
    expect(() => parseCaptureUrl("nope")).toThrow(CaptureUrlError);
  });

  test("loopback hosts, and the addresses that are not public", () => {
    expect(isLoopbackHost("LOCALHOST.")).toBe(true);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
    expect(privateAddressReason("169.254.169.254")).toContain("metadata");
    expect(privateAddressReason("192.168.1.2")).toContain("private");
    expect(privateAddressReason("::ffff:10.0.0.1")).toContain("private");
    expect(privateAddressReason("fd00::1")).toContain("private");
    expect(privateAddressReason("8.8.8.8")).toBeNull();
  });

  test("the browser reaches its own ports and public hosts, never Wisp or another local service", () => {
    const policy = { loopbackPorts: new Set([3000]), daemonPort: 8710, publicAllowed: true };
    expect(mayReach(policy, "127.0.0.1", 3000)).toEqual({ allow: true });
    expect(mayReach(policy, "::1", 3000)).toEqual({ allow: true });
    expect(mayReach({ ...policy, loopbackPorts: new Set([8710]) }, "127.0.0.1", 8710)).toMatchObject({ allow: false, reason: "Wisp's own port" });
    expect(mayReach(policy, "127.0.0.1", 5432)).toMatchObject({ allow: false, reason: expect.stringContaining("--allow-port 5432") });
    expect(mayReach(policy, "93.184.216.34", 443)).toEqual({ allow: true });
    expect(mayReach({ ...policy, publicAllowed: false }, "93.184.216.34", 443)).toMatchObject({ allow: false });
    expect(mayReach(policy, "10.1.2.3", 443)).toMatchObject({ allow: false, reason: "a private network" });
  });

  test("a stored URL keeps its route but no secret", () => {
    expect(sanitizeUrl("http://localhost:3000/settings?tab=billing&token=abc#/gallery")).toBe("http://localhost:3000/settings?tab=*&token=*#/gallery");
    expect(sanitizeUrl("http://localhost:3000/cb#access_token=abc&state=1")).toBe("http://localhost:3000/cb#redacted");
    expect(sanitizeUrl("http://u:p@localhost/")).toBe("http://localhost/");
  });
});

describe("the capture proxy", () => {
  const servers: Server[] = [];
  let proxy: CaptureProxy | null = null;
  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    for (const server of servers.splice(0)) server.close();
  });

  /** A loopback listener that answers HTTP and counts connections. */
  async function listener(): Promise<{ port: number; connections: () => number }> {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.on("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    return { port: (server.address() as { port: number }).port, connections: () => connections };
  }

  /** Send one raw request through the proxy and read the whole reply. */
  function through(port: number, request: string): Promise<string> {
    return new Promise((done) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(request));
      let reply = "";
      socket.on("data", (chunk) => { reply += chunk.toString("latin1"); });
      socket.on("close", () => done(reply));
      socket.on("error", () => done(reply));
      setTimeout(() => socket.destroy(), 3_000);
    });
  }

  test("an allowed port gets the request in origin form; a refused one never sees a connection", async () => {
    const app = await listener();
    const other = await listener();
    proxy = await startCaptureProxy({ loopbackPorts: new Set([app.port]), daemonPort: 1, publicAllowed: false });
    expect(await through(proxy.port, `GET http://127.0.0.1:${app.port}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Connection: keep-alive\r\n\r\n`)).toContain("200 OK");
    expect(await through(proxy.port, `CONNECT localhost:${other.port} HTTP/1.1\r\nHost: localhost\r\n\r\n`)).toContain("403");
    expect(await through(proxy.port, `GET http://127.0.0.1:${other.port}/ HTTP/1.1\r\nHost: x\r\n\r\n`)).toContain("403");
    expect(app.connections()).toBe(1);
    expect(other.connections()).toBe(0);
    expect(proxy.refused).toEqual([`localhost:${other.port} (local port ${other.port} is not this capture's (add --allow-port ${other.port}))`, `127.0.0.1:${other.port} (local port ${other.port} is not this capture's (add --allow-port ${other.port}))`]);
  });

  test("a name is dialled at the address that was checked: one that resolves to the LAN is refused", async () => {
    proxy = await startCaptureProxy({ loopbackPorts: new Set(), daemonPort: 1, publicAllowed: true }, { resolve: async () => ["192.168.0.10"] });
    expect(await through(proxy.port, "CONNECT rebind.example:443 HTTP/1.1\r\n\r\n")).toContain("403");
    expect(proxy.refused[0]).toContain("a private network");
  });

  test("a CONNECT tunnel to an allowed port carries bytes both ways", async () => {
    const app = await listener();
    proxy = await startCaptureProxy({ loopbackPorts: new Set([app.port]), daemonPort: 1, publicAllowed: false });
    const reply = await through(proxy.port, `CONNECT 127.0.0.1:${app.port} HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\n\r\n`);
    expect(reply).toContain("200 Connection Established");
    expect(reply).toContain("ok");
  });
});
