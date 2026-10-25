import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import semver from "semver";
import type { MetadataSnapshot, SnapshotPackage } from "./snapshot.ts";
import { satisfies } from "../versions.ts";

export interface SnapshotRegistry {
  url: string;
  close(): Promise<void>;
}

/**
 * Serves a metadata snapshot as an npm-compatible registry, as it looked at `now`: versions published
 * later are hidden, and so are advisories published later. npm, pnpm and the tool's own providers all
 * read from it, so their answers agree.
 */
export async function startSnapshotRegistry(
  snapshot: MetadataSnapshot,
  options: { now: Date; port?: number },
): Promise<SnapshotRegistry> {
  const server = createServer((req, res) => {
    handle(snapshot, options.now, req, res, baseUrl).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    url: `${baseUrl}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  snapshot: MetadataSnapshot,
  now: Date,
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", baseUrl);
  const path = decodeURIComponent(url.pathname);

  if (req.method === "POST" && path === "/-/npm/v1/security/advisories/bulk") {
    if (snapshot.failures?.advisories) return send(res, 503, { error: "advisory service unavailable" });
    const body = JSON.parse(await readBody(req)) as Record<string, string[]>;
    return send(res, 200, bulkAdvisories(snapshot, now, body));
  }
  if (req.method === "POST" && path.startsWith("/-/npm/v1/security/")) {
    return send(res, 404, { error: "only the bulk advisory endpoint is served" });
  }
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

  const tarball = /^\/((?:@[^/]+\/)?[^/@]+)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(path);
  if (tarball) {
    const pkg = snapshot.packages[tarball[1]!];
    const version = tarball[2]!;
    if (!pkg?.versions[version]) return send(res, 404, { error: "not found" });
    res.setHeader("content-type", "application/octet-stream");
    res.end(syntheticTarball(tarball[1]!, version));
    return;
  }

  const name = path.slice(1);
  if (snapshot.failures?.packages?.includes(name)) return send(res, 503, { error: "registry unavailable" });
  const pkg = snapshot.packages[name];
  if (pkg === undefined) return send(res, 404, { error: "not found" });
  return send(res, 200, packument(name, pkg, now, baseUrl));
}

function packument(name: string, pkg: SnapshotPackage, now: Date, baseUrl: string): unknown {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  const visible = Object.keys(pkg.versions).filter((v) => {
    const t = pkg.time[v];
    return t === undefined || Date.parse(t) <= now.getTime();
  });
  const file = name.startsWith("@") ? name.split("/")[1]! : name;
  for (const v of visible) {
    const meta = pkg.versions[v]!;
    const tgz = syntheticTarball(name, v);
    versions[v] = {
      name,
      version: v,
      ...(meta.dependencies ? { dependencies: meta.dependencies } : {}),
      ...(meta.optionalDependencies ? { optionalDependencies: meta.optionalDependencies } : {}),
      ...(meta.peerDependencies ? { peerDependencies: meta.peerDependencies } : {}),
      ...(meta.deprecated ? { deprecated: meta.deprecated } : {}),
      dist: {
        tarball: `${baseUrl}/${name}/-/${file}-${v}.tgz`,
        integrity: meta.dist?.integrity ?? `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
        shasum: meta.dist?.shasum ?? createHash("sha1").update(tgz).digest("hex"),
      },
    };
    if (pkg.time[v] !== undefined) time[v] = pkg.time[v]!;
  }
  const stable = visible.filter((v) => semver.valid(v) && semver.prerelease(v) === null).sort(semver.compare);
  const times = Object.values(time).sort();
  if (times.length > 0) {
    time.created = times[0]!;
    time.modified = times.at(-1)!;
  }
  const doc: Record<string, unknown> = {
    name,
    "dist-tags": stable.length > 0 ? { latest: stable.at(-1) } : {},
    versions,
    time,
  };
  if (pkg.repository) doc.repository = { type: "git", url: pkg.repository };
  return doc;
}

function bulkAdvisories(snapshot: MetadataSnapshot, now: Date, body: Record<string, string[]>): unknown {
  const out: Record<string, unknown[]> = {};
  snapshot.advisories.forEach((a, index) => {
    if (a.published !== undefined && Date.parse(a.published) > now.getTime()) return;
    const versions = body[a.package];
    if (versions === undefined) return;
    const range = a.ranges.join(" || ");
    if (!versions.some((v) => satisfies(v, range))) return;
    (out[a.package] ??= []).push({
      id: 1_000_000 + index,
      url: a.url ?? `https://github.com/advisories/${a.id}`,
      title: a.title ?? a.id,
      severity: a.severity ?? "high",
      vulnerable_versions: range,
      cwe: [],
      cvss: { score: 0, vectorString: null },
    });
  });
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  return req.headers["content-encoding"] === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const tarballCache = new Map<string, Buffer>();

/** A minimal, deterministic package tarball containing only package/package.json. */
export function syntheticTarball(name: string, version: string): Buffer {
  const key = `${name}@${version}`;
  const cached = tarballCache.get(key);
  if (cached) return cached;
  const content = Buffer.from(`${JSON.stringify({ name, version })}\n`);
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  const tar = Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
  const gz = gzipSync(tar, { level: 9 });
  // Zero the gzip header's mtime and OS bytes so the archive is byte-for-byte stable.
  gz.writeUInt32LE(0, 4);
  gz[9] = 0xff;
  tarballCache.set(key, gz);
  return gz;
}
