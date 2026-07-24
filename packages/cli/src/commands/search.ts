import {
  searchPackages,
  getPackage,
  listVersions,
  formatDeprecationWarning,
} from "../registry/packages.js";
import { RegistryError } from "../registry/client.js";

export async function runSearch(query: string | undefined): Promise<number> {
  try {
    const result = await searchPackages(query, 20);
    if (result.packages.length === 0) {
      console.log("no packages found");
      return 0;
    }
    for (const pkg of result.packages) {
      console.log(pkg.name);
      if (pkg.description) {
        console.log(pkg.description);
      }
      const bits: string[] = [];
      if (pkg.deprecated) {
        bits.push("DEPRECATED");
      }
      bits.push(`by ${pkg.owner.username}`);
      if (typeof pkg.downloadCount === "number") {
        bits.push(`Downloads: ${pkg.downloadCount.toLocaleString("en-US")}`);
      }
      console.log(bits.join(" · "));
      console.log("");
    }
    if (result.pagination.total > result.packages.length) {
      console.log(
        `(showing ${result.packages.length} of ${result.pagination.total})`,
      );
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof RegistryError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}

export async function runInfo(name: string): Promise<number> {
  try {
    const pkg = await getPackage(name);
    console.log(`name: ${pkg.name}`);
    console.log(`description: ${pkg.description || "(none)"}`);
    console.log(`owner: ${pkg.owner.username}`);
    if (pkg.maintainers && pkg.maintainers.length > 0) {
      console.log(
        `maintainers: ${pkg.maintainers.map((m) => `${m.username} (${m.role})`).join(", ")}`,
      );
    }
    if (pkg.license) {
      console.log(`license: ${pkg.license}`);
    }
    if (pkg.repository) {
      console.log(`repository: ${pkg.repository}`);
    }
    if (pkg.documentation) {
      console.log(`documentation: ${pkg.documentation}`);
    }
    if (pkg.keywords && pkg.keywords.length > 0) {
      console.log(`keywords: ${pkg.keywords.join(", ")}`);
    }
    if (typeof pkg.downloadCount === "number") {
      console.log(`downloads: ${pkg.downloadCount.toLocaleString("en-US")}`);
    }
    console.log(`created: ${pkg.createdAt}`);
    if (pkg.deprecated) {
      console.log("");
      console.log(
        formatDeprecationWarning(
          pkg.name,
          undefined,
          pkg.deprecationReason,
          pkg.replacement,
        ),
      );
      console.log("");
    }
    if (pkg.latestVersion) {
      console.log(`latest: ${pkg.latestVersion.version}`);
      console.log(`size: ${pkg.latestVersion.sizeBytes} bytes`);
      console.log(`checksum: ${pkg.latestVersion.checksumSha256}`);
      if (pkg.latestVersion.deprecated) {
        console.log(
          formatDeprecationWarning(
            pkg.name,
            pkg.latestVersion.version,
            pkg.latestVersion.deprecationReason,
            pkg.latestVersion.replacement,
          ),
        );
      }
    } else {
      console.log("latest: (no versions)");
    }

    const versions = await listVersions(name);
    if (versions.versions.length > 0) {
      console.log("versions:");
      for (const v of versions.versions) {
        const mark = v.deprecated ? " [deprecated]" : "";
        const downloads =
          typeof v.downloadCount === "number"
            ? ` downloads=${v.downloadCount}`
            : "";
        console.log(`  ${v.version} (${v.createdAt})${mark}${downloads}`);
      }
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof RegistryError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}
