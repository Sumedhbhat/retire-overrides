import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, gunzipSync, gzipSync } from "node:zlib";
import semver from "semver";
import type { MetadataSnapshot, SnapshotPackage, SnapshotVersion } from "./snapshot.ts";
import { normalizeName, PEP440 } from "../pep440.ts";
import { SEMVER } from "../schemes.ts";

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
    const ecosystem = url.searchParams.get("ecosystem") === "PyPI" ? "PyPI" : "npm";
    return send(res, 200, bulkAdvisories(snapshot, now, body, ecosystem));
  }
  if (req.method === "POST" && path.startsWith("/-/npm/v1/security/")) {
    return send(res, 404, { error: "only the bulk advisory endpoint is served" });
  }
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  if (snapshot.pypi && /^\/(pypi|simple|files)\//.test(path)) return handlePypi(snapshot, now, req, res, baseUrl, path);

  const tarball = /^\/((?:@[^/]+\/)?[^/@]+)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(path);
  if (tarball) {
    const pkg = snapshot.packages[tarball[1]!];
    const version = tarball[2]!;
    if (!pkg?.versions[version]) return send(res, 404, { error: "not found" });
    res.setHeader("content-type", "application/octet-stream");
    res.end(syntheticTarball(tarball[1]!, version, pkg.versions[version]));
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
    const tgz = syntheticTarball(name, v, meta);
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

function bulkAdvisories(snapshot: MetadataSnapshot, now: Date, body: Record<string, string[]>, ecosystem: "npm" | "PyPI"): unknown {
  const out: Record<string, unknown[]> = {};
  const scheme = ecosystem === "PyPI" ? PEP440 : SEMVER;
  snapshot.advisories.forEach((a, index) => {
    if ((a.ecosystem ?? "npm") !== ecosystem) return;
    if (a.published !== undefined && Date.parse(a.published) > now.getTime()) return;
    const versions = body[a.package];
    if (versions === undefined) return;
    // Branches travel joined by `||`, which the bulk provider splits again.
    const range = a.ranges.join(" || ");
    if (!versions.some((v) => a.ranges.some((r) => scheme.satisfies(v, r)))) return;
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

/**
 * A minimal, deterministic package tarball containing only package/package.json. The manifest carries
 * the snapshot's dependency fields, because some package managers (Yarn Classic) read dependencies
 * from the tarball rather than the packument.
 */
export function syntheticTarball(
  name: string,
  version: string,
  meta: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } = {},
): Buffer {
  const manifest = JSON.stringify({
    name,
    version,
    ...(meta.dependencies ? { dependencies: meta.dependencies } : {}),
    ...(meta.optionalDependencies ? { optionalDependencies: meta.optionalDependencies } : {}),
    ...(meta.peerDependencies ? { peerDependencies: meta.peerDependencies } : {}),
  });
  const cached = tarballCache.get(manifest);
  if (cached) return cached;
  const key = manifest;
  const content = Buffer.from(`${manifest}\n`);
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

/** The PyPI JSON API (for the tool) and the Simple API with PEP 658 metadata (for uv). */
function handlePypi(snapshot: MetadataSnapshot, now: Date, req: IncomingMessage, res: ServerResponse, baseUrl: string, path: string): void {
  const pypi = snapshot.pypi ?? {};
  const visible = (pkg: SnapshotPackage) =>
    Object.keys(pkg.versions).filter((v) => pkg.time[v] === undefined || Date.parse(pkg.time[v]!) <= now.getTime());

  const json = /^\/pypi\/([^/]+)\/(?:([^/]+)\/)?json$/.exec(path);
  if (json) {
    const name = normalizeName(json[1]!);
    if (snapshot.failures?.packages?.includes(name)) return send(res, 503, { error: "registry unavailable" });
    const pkg = pypi[name];
    if (!pkg) return send(res, 404, { message: "Not Found" });
    const versions = visible(pkg);
    if (json[2]) {
      const v = json[2];
      if (!versions.includes(v)) return send(res, 404, { message: "Not Found" });
      const meta = pkg.versions[v]!;
      return send(res, 200, { info: { name, version: v, requires_dist: requiresDist(meta) }, urls: [pypiFile(name, v, pkg, baseUrl)] });
    }
    const releases: Record<string, unknown[]> = {};
    for (const v of versions) releases[v] = [pypiFile(name, v, pkg, baseUrl)];
    return send(res, 200, { info: { name, requires_dist: null, project_urls: pkg.repository ? { Source: pkg.repository } : null }, releases });
  }

  const simple = /^\/simple\/([^/]+)\/?$/.exec(path);
  if (simple) {
    const name = normalizeName(simple[1]!);
    const pkg = pypi[name];
    if (!pkg) return send(res, 404, { message: "Not Found" });
    const files = visible(pkg).map((v) => {
      const f = pypiFile(name, v, pkg, baseUrl);
      return {
        filename: f.filename,
        url: f.url,
        hashes: { sha256: f.sha256 },
        "core-metadata": { sha256: f.metadataSha256 },
        "data-dist-info-metadata": { sha256: f.metadataSha256 },
        "upload-time": f.upload_time_iso_8601,
        yanked: pkg.versions[v]!.deprecated ? pkg.versions[v]!.deprecated : false,
      };
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/vnd.pypi.simple.v1+json");
    res.end(JSON.stringify({ meta: { "api-version": "1.1" }, name, versions: visible(pkg), files }));
    return;
  }

  const file = /^\/files\/([^/]+?)-([^-/]+)-py3-none-any\.whl(\.metadata)?$/.exec(path);
  if (file) {
    const name = normalizeName(file[1]!);
    const pkg = pypi[name];
    const v = file[2]!;
    if (!pkg?.versions[v]) return send(res, 404, { message: "Not Found" });
    res.statusCode = 200;
    res.setHeader("content-type", "application/octet-stream");
    res.end(file[3] ? coreMetadata(name, v, pkg.versions[v]!) : syntheticWheel(name, v, pkg.versions[v]!));
    return;
  }
  send(res, 404, { message: "Not Found" });
}

function requiresDist(meta: SnapshotVersion): string[] {
  return Object.entries(meta.dependencies ?? {}).map(([dep, spec]) => (spec ? `${dep}${spec}` : dep));
}

function coreMetadata(name: string, version: string, meta: SnapshotVersion): Buffer {
  const lines = ["Metadata-Version: 2.1", `Name: ${name}`, `Version: ${version}`, ...requiresDist(meta).map((r) => `Requires-Dist: ${r}`), ""];
  return Buffer.from(lines.join("\n"));
}

function wheelName(name: string, version: string): string {
  return `${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`;
}

function pypiFile(name: string, version: string, pkg: SnapshotPackage, baseUrl: string) {
  const meta = pkg.versions[version]!;
  const filename = wheelName(name, version);
  return {
    filename,
    url: `${baseUrl}/files/${filename}`,
    sha256: createHash("sha256").update(syntheticWheel(name, version, meta)).digest("hex"),
    metadataSha256: createHash("sha256").update(coreMetadata(name, version, meta)).digest("hex"),
    upload_time_iso_8601: pkg.time[version] ?? "1970-01-01T00:00:00Z",
    yanked: Boolean(meta.deprecated),
  };
}

/** A minimal, deterministic wheel: a stored (uncompressed) zip holding the dist-info files. */
function syntheticWheel(name: string, version: string, meta: SnapshotVersion): Buffer {
  const dist = `${name.replace(/-/g, "_")}-${version}.dist-info`;
  const entries: Array<[string, Buffer]> = [
    [`${dist}/METADATA`, coreMetadata(name, version, meta)],
    [`${dist}/WHEEL`, Buffer.from("Wheel-Version: 1.0\nGenerator: retire-overrides\nRoot-Is-Purelib: true\nTag: py3-none-any\n")],
    [`${dist}/RECORD`, Buffer.from("")],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const nameBuf = Buffer.from(path);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
