import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { registryFetch, registryJson, RegistryError } from "./client.js";

export interface PackageOwner {
  readonly id: string;
  readonly username: string;
  readonly avatarUrl: string;
}

export interface PackageMaintainer extends PackageOwner {
  readonly role: "owner" | "maintainer";
}

export interface PackageSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly owner: PackageOwner;
  readonly license?: string | null;
  readonly repository?: string | null;
  readonly documentation?: string | null;
  readonly keywords?: readonly string[];
  readonly downloadCount?: number;
  readonly deprecated?: boolean;
  readonly deprecationReason?: string | null;
  readonly replacement?: string | null;
}

export interface PackageVersionInfo {
  readonly version: string;
  readonly metadata: Record<string, unknown>;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly downloadCount?: number;
  readonly deprecated?: boolean;
  readonly deprecationReason?: string | null;
  readonly replacement?: string | null;
}

export interface PackageDetails extends PackageSummary {
  readonly latestVersion: PackageVersionInfo | null;
  readonly maintainers?: readonly PackageMaintainer[];
}

export interface VersionDetails {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly publishedBy: PackageOwner;
  readonly downloadCount?: number;
  readonly deprecated?: boolean;
  readonly deprecationReason?: string | null;
  readonly replacement?: string | null;
}

export interface Advisory {
  readonly id: string;
  readonly advisoryId: string;
  readonly packageName: string;
  readonly affectedVersions: string;
  readonly severity: "low" | "moderate" | "high" | "critical";
  readonly title: string;
  readonly description: string;
  readonly fixedIn: string | null;
  readonly createdAt: string;
}

export async function searchPackages(
  query: string | undefined,
  limit = 20,
): Promise<{
  packages: PackageSummary[];
  pagination: { limit: number; offset: number; total: number };
}> {
  const params = new URLSearchParams();
  if (query) {
    params.set("q", query);
  }
  params.set("limit", String(limit));
  const qs = params.toString();
  return registryJson(`/packages?${qs}`);
}

export async function getPackage(name: string): Promise<PackageDetails> {
  return registryJson(`/packages/${encodeURIComponent(name)}`);
}

export async function listVersions(name: string): Promise<{
  name: string;
  versions: Array<VersionDetails & { publishedBy: PackageOwner }>;
}> {
  return registryJson(`/packages/${encodeURIComponent(name)}/versions`);
}

export async function getVersion(
  name: string,
  version: string,
): Promise<VersionDetails> {
  return registryJson(
    `/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  );
}

export interface DownloadResult {
  readonly checksumSha256: string;
  readonly sizeBytes: number;
}

/**
 * Download a package version archive to `destPath`, verifying X-Checksum-SHA256 when present.
 */
export async function downloadPackageVersion(
  name: string,
  version: string,
  destPath: string,
): Promise<DownloadResult> {
  const response = await registryFetch(
    `/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/download`,
  );
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      code = body.error;
      throw new RegistryError(
        body.message ?? body.error ?? `HTTP ${response.status}`,
        response.status,
        code,
      );
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      throw new RegistryError(`HTTP ${response.status}`, response.status);
    }
  }

  const expected =
    response.headers.get("X-Checksum-SHA256") ??
    response.headers.get("x-checksum-sha256") ??
    undefined;

  mkdirSync(dirname(destPath), { recursive: true });
  if (!response.body) {
    throw new RegistryError("empty download body", 502, "download_failed");
  }

  const hash = createHash("sha256");
  const nodeStream = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );
  nodeStream.on("data", (chunk: Buffer | string) => {
    hash.update(chunk);
  });

  await pipeline(nodeStream, createWriteStream(destPath));
  const checksumSha256 = hash.digest("hex");

  if (expected && expected.toLowerCase() !== checksumSha256.toLowerCase()) {
    throw new RegistryError(
      `checksum mismatch for ${name}@${version}`,
      502,
      "checksum_mismatch",
    );
  }

  return {
    checksumSha256,
    sizeBytes: Number(response.headers.get("content-length") ?? 0),
  };
}

export interface PublishResult {
  readonly name: string;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly owner: PackageOwner;
}

export async function publishPackageVersion(options: {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly repository?: string;
  readonly documentation?: string;
  readonly keywords?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly archivePath: string;
  readonly archiveBytes: Uint8Array;
}): Promise<PublishResult> {
  const form = new FormData();
  form.append("version", options.version);
  if (options.description !== undefined) {
    form.append("description", options.description);
  }
  if (options.license !== undefined) {
    form.append("license", options.license);
  }
  if (options.repository !== undefined) {
    form.append("repository", options.repository);
  }
  if (options.documentation !== undefined) {
    form.append("documentation", options.documentation);
  }
  if (options.keywords !== undefined) {
    form.append("keywords", JSON.stringify(options.keywords));
  }
  if (options.metadata !== undefined) {
    form.append("metadata", JSON.stringify(options.metadata));
  }
  const fileName = `${options.name}-${options.version}.tar.gz`;
  form.append(
    "file",
    new Blob([Buffer.from(options.archiveBytes)], { type: "application/gzip" }),
    fileName,
  );

  return registryJson(
    `/packages/${encodeURIComponent(options.name)}/versions`,
    {
      method: "POST",
      auth: true,
      body: form,
    },
  );
}

export async function listMaintainers(name: string): Promise<{
  name: string;
  maintainers: PackageMaintainer[];
}> {
  return registryJson(
    `/packages/${encodeURIComponent(name)}/maintainers`,
  );
}

export async function addMaintainer(
  name: string,
  username: string,
  role: "maintainer" = "maintainer",
): Promise<unknown> {
  return registryJson(`/packages/${encodeURIComponent(name)}/maintainers`, {
    method: "POST",
    auth: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, role }),
  });
}

export async function removeMaintainer(
  name: string,
  username: string,
): Promise<unknown> {
  return registryJson(
    `/packages/${encodeURIComponent(name)}/maintainers/${encodeURIComponent(username)}`,
    { method: "DELETE", auth: true },
  );
}

export async function transferOwnership(
  name: string,
  username: string,
): Promise<unknown> {
  return registryJson(`/packages/${encodeURIComponent(name)}/transfer`, {
    method: "POST",
    auth: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
  });
}

export async function deprecatePackage(
  name: string,
  reason: string,
  replacement?: string,
): Promise<unknown> {
  const body: { reason: string; replacement?: string } = { reason };
  if (replacement !== undefined) {
    body.replacement = replacement;
  }
  return registryJson(`/packages/${encodeURIComponent(name)}/deprecate`, {
    method: "POST",
    auth: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deprecatePackageVersion(
  name: string,
  version: string,
  reason: string,
  replacement?: string,
): Promise<unknown> {
  const body: { reason: string; replacement?: string } = { reason };
  if (replacement !== undefined) {
    body.replacement = replacement;
  }
  return registryJson(
    `/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/deprecate`,
    {
      method: "POST",
      auth: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function reportPackage(
  name: string,
  reason: string,
): Promise<unknown> {
  return registryJson(`/packages/${encodeURIComponent(name)}/report`, {
    method: "POST",
    authOptional: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export async function auditPackages(
  packages: ReadonlyArray<{ name: string; version: string }>,
): Promise<{ advisories: Advisory[] }> {
  const result = await registryJson<{
    packages: Array<{
      name: string;
      version: string;
      advisories: Advisory[];
    }>;
  }>(`/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packages }),
  });
  const advisories: Advisory[] = [];
  for (const entry of result.packages ?? []) {
    for (const adv of entry.advisories ?? []) {
      advisories.push(adv);
    }
  }
  return { advisories };
}

export async function listAdvisories(options?: {
  package?: string;
  version?: string;
}): Promise<{ advisories: Advisory[] }> {
  const params = new URLSearchParams();
  if (options?.package) {
    params.set("package", options.package);
  }
  if (options?.version) {
    params.set("version", options.version);
  }
  const qs = params.toString();
  return registryJson(`/advisories${qs ? `?${qs}` : ""}`);
}

/** Format a deprecation warning for CLI display. */
export function formatDeprecationWarning(
  name: string,
  version: string | undefined,
  reason: string | null | undefined,
  replacement: string | null | undefined,
): string {
  const label = version ? `${name}@${version}` : name;
  const lines = [`Warning: package \`${label}\` is deprecated.`];
  if (reason) {
    lines.push("", "Reason:", reason);
  }
  if (replacement) {
    lines.push("", `Replacement: ${replacement}`);
  }
  return lines.join("\n");
}
