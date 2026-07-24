import { packProject } from "../deps/pack.js";
import {
  collectNativePublishArtifacts,
  formatNativePublishChecklist,
} from "../deps/native-publish.js";
import { loadCredentials } from "../config.js";
import { loadProject, ProjectError } from "../project.js";
import { RegistryError } from "../registry/client.js";
import { publishPackageVersion } from "../registry/packages.js";

export async function runPublish(): Promise<number> {
  try {
    if (!loadCredentials()) {
      console.error("error: not logged in (run `sn login`)");
      return 1;
    }

    const project = loadProject();
    const {
      name,
      version,
      description,
      license,
      repository,
      documentation,
      keywords,
    } = project.package;

    const { targets, metadata } = collectNativePublishArtifacts(project);

    console.log(`Publishing ${name}@${version}`);
    console.log("");
    for (const line of formatNativePublishChecklist(targets)) {
      console.log(line);
    }
    console.log("");

    console.log(`packing ${name}@${version}`);
    const packed = await packProject(project);
    try {
      console.log("Publishing...");
      const publishOpts: {
        name: string;
        version: string;
        description?: string;
        license?: string;
        repository?: string;
        documentation?: string;
        keywords?: readonly string[];
        metadata?: Record<string, unknown>;
        archivePath: string;
        archiveBytes: Uint8Array;
      } = {
        name,
        version,
        archivePath: packed.archivePath,
        archiveBytes: packed.bytes,
      };
      if (description) {
        publishOpts.description = description;
      }
      if (license) {
        publishOpts.license = license;
      }
      if (repository) {
        publishOpts.repository = repository;
      }
      if (documentation) {
        publishOpts.documentation = documentation;
      }
      if (keywords && keywords.length > 0) {
        publishOpts.keywords = keywords;
      }
      if (metadata) {
        publishOpts.metadata = metadata as unknown as Record<string, unknown>;
      }
      const result = await publishPackageVersion(publishOpts);
      console.log(
        `Published successfully (${result.name}@${result.version}, ${result.sizeBytes} bytes).`,
      );
      return 0;
    } finally {
      packed.cleanup();
    }
  } catch (error) {
    const message =
      error instanceof ProjectError || error instanceof RegistryError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}
