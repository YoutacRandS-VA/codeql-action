import * as fs from "fs";
import * as path from "path";

import * as core from "@actions/core";
import * as toolrunner from "@actions/exec/lib/toolrunner";
import * as yaml from "js-yaml";
import * as semver from "semver";

import {
  getActionVersion,
  getOptionalInput,
  isAnalyzingDefaultBranch,
} from "./actions-util";
import * as api from "./api-client";
import {
  CommandInvocationError,
  wrapCliConfigurationError,
} from "./cli-errors";
import type { Config } from "./config-utils";
import { EnvVar } from "./environment";
import {
  CODEQL_VERSION_FINE_GRAINED_PARALLELISM,
  CodeQLDefaultVersionInfo,
  Feature,
  FeatureEnablement,
} from "./feature-flags";
import { isTracedLanguage, Language } from "./languages";
import { Logger } from "./logging";
import * as setupCodeql from "./setup-codeql";
import { ToolsFeature, isSupportedToolsFeature } from "./tools-features";
import * as util from "./util";
import { wrapError } from "./util";

type Options = Array<string | number | boolean>;

/**
 * Extra command line options for the codeql commands.
 */
interface ExtraOptions {
  "*"?: Options;
  database?: {
    "*"?: Options;
    init?: Options;
    "trace-command"?: Options;
    analyze?: Options;
    finalize?: Options;
  };
  resolve?: {
    "*"?: Options;
    extractor?: Options;
    queries?: Options;
  };
}

export interface CodeQL {
  /**
   * Get the path of the CodeQL executable.
   */
  getPath(): string;
  /**
   * Get a string containing the semver version of the CodeQL executable.
   */
  getVersion(): Promise<VersionInfo>;
  /**
   * Print version information about CodeQL.
   */
  printVersion(): Promise<void>;
  /**
   * Returns whether the CodeQL executable supports the specified feature.
   */
  supportsFeature(feature: ToolsFeature): Promise<boolean>;
  /**
   * Run 'codeql database init --db-cluster'.
   */
  databaseInitCluster(
    config: Config,
    sourceRoot: string,
    processName: string | undefined,
    qlconfigFile: string | undefined,
    logger: Logger,
  ): Promise<void>;
  /**
   * Runs the autobuilder for the given language.
   */
  runAutobuild(language: Language): Promise<void>;
  /**
   * Extract code for a scanned language using 'codeql database trace-command'
   * and running the language extractor.
   */
  extractScannedLanguage(config: Config, language: Language): Promise<void>;
  /**
   * Extract code with 'codeql database trace-command --use-build-mode'. This can only be used when
   * the database specifies a build mode. This requires the `traceCommandUseBuildMode` tool feature.
   */
  extractUsingBuildMode(config: Config, language: Language): Promise<void>;
  /**
   * Finalize a database using 'codeql database finalize'.
   */
  finalizeDatabase(
    databasePath: string,
    threadsFlag: string,
    memoryFlag: string,
  ): Promise<void>;
  /**
   * Run 'codeql resolve languages'.
   */
  resolveLanguages(): Promise<ResolveLanguagesOutput>;
  /**
   * Run 'codeql resolve languages' with '--format=betterjson'.
   */
  betterResolveLanguages(): Promise<BetterResolveLanguagesOutput>;
  /**
   * Run 'codeql resolve queries'.
   */
  resolveQueries(
    queries: string[],
    extraSearchPath: string | undefined,
  ): Promise<ResolveQueriesOutput>;
  /**
   * Run 'codeql resolve build-environment'
   */
  resolveBuildEnvironment(
    workingDir: string | undefined,
    language: string,
  ): Promise<ResolveBuildEnvironmentOutput>;

  /**
   * Run 'codeql pack download'.
   */
  packDownload(
    packs: string[],
    qlconfigFile: string | undefined,
  ): Promise<PackDownloadOutput>;

  /**
   * Run 'codeql database cleanup'.
   */
  databaseCleanup(databasePath: string, cleanupLevel: string): Promise<void>;
  /**
   * Run 'codeql database bundle'.
   */
  databaseBundle(
    databasePath: string,
    outputFilePath: string,
    dbName: string,
  ): Promise<void>;
  /**
   * Run 'codeql database run-queries'.
   */
  databaseRunQueries(databasePath: string, flags: string[]): Promise<void>;
  /**
   * Run 'codeql database interpret-results'.
   */
  databaseInterpretResults(
    databasePath: string,
    querySuitePaths: string[] | undefined,
    sarifFile: string,
    addSnippetsFlag: string,
    threadsFlag: string,
    verbosityFlag: string | undefined,
    automationDetailsId: string | undefined,
    config: Config,
    features: FeatureEnablement,
    logger: Logger,
  ): Promise<string>;
  /**
   * Run 'codeql database print-baseline'.
   */
  databasePrintBaseline(databasePath: string): Promise<string>;
  /**
   * Run 'codeql database export-diagnostics'
   *
   * Note that the "--sarif-include-diagnostics" option is always used, as the command should
   * only be run if the ExportDiagnosticsEnabled feature flag is on.
   */
  databaseExportDiagnostics(
    databasePath: string,
    sarifFile: string,
    automationDetailsId: string | undefined,
    tempDir: string,
    logger: Logger,
  ): Promise<void>;
  /**
   * Run 'codeql diagnostics export'.
   */
  diagnosticsExport(
    sarifFile: string,
    automationDetailsId: string | undefined,
    config: Config,
  ): Promise<void>;
  /** Get the location of an extractor for the specified language. */
  resolveExtractor(language: Language): Promise<string>;
}

export interface VersionInfo {
  version: string;
  features?: { [name: string]: boolean };
}

export interface ResolveLanguagesOutput {
  [language: string]: [string];
}

export interface BetterResolveLanguagesOutput {
  aliases?: {
    [alias: string]: string;
  };
  extractors: {
    [language: string]: [
      {
        extractor_root: string;
        extractor_options?: any;
      },
    ];
  };
}

export interface ResolveQueriesOutput {
  byLanguage: {
    [language: string]: {
      [queryPath: string]: {};
    };
  };
  noDeclaredLanguage: {
    [queryPath: string]: {};
  };
  multipleDeclaredLanguages: {
    [queryPath: string]: {};
  };
}

export interface ResolveBuildEnvironmentOutput {
  configuration?: {
    [language: string]: {
      [key: string]: unknown;
    };
  };
}

export interface PackDownloadOutput {
  packs: PackDownloadItem[];
}

interface PackDownloadItem {
  name: string;
  version: string;
  packDir: string;
  installResult: string;
}

/**
 * Stores the CodeQL object, and is populated by `setupCodeQL` or `getCodeQL`.
 * Can be overridden in tests using `setCodeQL`.
 */
let cachedCodeQL: CodeQL | undefined = undefined;

/**
 * The oldest version of CodeQL that the Action will run with. This should be
 * at least three minor versions behind the current version and must include the
 * CLI versions shipped with each supported version of GHES.
 *
 * The version flags below can be used to conditionally enable certain features
 * on versions newer than this.
 */
const CODEQL_MINIMUM_VERSION = "2.11.6";

/**
 * This version will shortly become the oldest version of CodeQL that the Action will run with.
 */
const CODEQL_NEXT_MINIMUM_VERSION = "2.11.6";

/**
 * This is the version of GHES that was most recently deprecated.
 */
const GHES_VERSION_MOST_RECENTLY_DEPRECATED = "3.7";

/**
 * This is the deprecation date for the version of GHES that was most recently deprecated.
 */
const GHES_MOST_RECENT_DEPRECATION_DATE = "2023-11-08";

/*
 * Deprecated in favor of ToolsFeature.
 *
 * Versions of CodeQL that version-flag certain functionality in the Action.
 * For convenience, please keep these in descending order. Once a version
 * flag is older than the oldest supported version above, it may be removed.
 */

/**
 * Versions 2.12.1+ of the CodeQL Bundle include a `security-experimental` built-in query suite for
 * each language.
 */
export const CODEQL_VERSION_SECURITY_EXPERIMENTAL_SUITE = "2.12.1";

/**
 * Versions 2.12.3+ of the CodeQL CLI support exporting configuration information from a code
 * scanning config file to SARIF.
 */
export const CODEQL_VERSION_EXPORT_CODE_SCANNING_CONFIG = "2.12.3";

/**
 * Versions 2.12.4+ of the CodeQL CLI support the `--qlconfig-file` flag in calls to `database init`.
 */
export const CODEQL_VERSION_INIT_WITH_QLCONFIG = "2.12.4";

/**
 * Versions 2.13.1+ of the CodeQL CLI fix a bug where diagnostics export could produce invalid SARIF.
 */
export const CODEQL_VERSION_DIAGNOSTICS_EXPORT_FIXED = "2.13.1";

/**
 * Versions 2.13.4+ of the CodeQL CLI support the `resolve build-environment` command.
 */
export const CODEQL_VERSION_RESOLVE_ENVIRONMENT = "2.13.4";

/**
 * Versions 2.14.2+ of the CodeQL CLI support language-specific baseline configuration.
 */
export const CODEQL_VERSION_LANGUAGE_BASELINE_CONFIG = "2.14.2";

/**
 * Versions 2.14.4+ of the CodeQL CLI support language aliasing.
 */
export const CODEQL_VERSION_LANGUAGE_ALIASING = "2.14.4";

/**
 * Versions 2.15.0+ of the CodeQL CLI support new analysis summaries.
 */
export const CODEQL_VERSION_ANALYSIS_SUMMARY_V2 = "2.15.0";

/**
 * Versions 2.15.0+ of the CodeQL CLI support sub-language file coverage information.
 */
export const CODEQL_VERSION_SUBLANGUAGE_FILE_COVERAGE = "2.15.0";

/**
 * Versions 2.15.2+ of the CodeQL CLI support the `--sarif-include-query-help` option.
 */
const CODEQL_VERSION_INCLUDE_QUERY_HELP = "2.15.2";

/**
 * Set up CodeQL CLI access.
 *
 * @param toolsInput
 * @param apiDetails
 * @param tempDir
 * @param variant
 * @param defaultCliVersion
 * @param logger
 * @param checkVersion Whether to check that CodeQL CLI meets the minimum
 *        version requirement. Must be set to true outside tests.
 * @returns a { CodeQL, toolsVersion } object.
 */
export async function setupCodeQL(
  toolsInput: string | undefined,
  apiDetails: api.GitHubApiDetails,
  tempDir: string,
  variant: util.GitHubVariant,
  defaultCliVersion: CodeQLDefaultVersionInfo,
  logger: Logger,
  checkVersion: boolean,
): Promise<{
  codeql: CodeQL;
  toolsDownloadDurationMs?: number;
  toolsSource: setupCodeql.ToolsSource;
  toolsVersion: string;
}> {
  try {
    const { codeqlFolder, toolsDownloadDurationMs, toolsSource, toolsVersion } =
      await setupCodeql.setupCodeQLBundle(
        toolsInput,
        apiDetails,
        tempDir,
        variant,
        defaultCliVersion,
        logger,
      );
    let codeqlCmd = path.join(codeqlFolder, "codeql", "codeql");
    if (process.platform === "win32") {
      codeqlCmd += ".exe";
    } else if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new util.ConfigurationError(
        `Unsupported platform: ${process.platform}`,
      );
    }

    cachedCodeQL = await getCodeQLForCmd(codeqlCmd, checkVersion);
    return {
      codeql: cachedCodeQL,
      toolsDownloadDurationMs,
      toolsSource,
      toolsVersion,
    };
  } catch (e) {
    throw new Error(
      `Unable to download and extract CodeQL CLI: ${wrapError(e).message}`,
    );
  }
}

/**
 * Use the CodeQL executable located at the given path.
 */
export async function getCodeQL(cmd: string): Promise<CodeQL> {
  if (cachedCodeQL === undefined) {
    cachedCodeQL = await getCodeQLForCmd(cmd, true);
  }
  return cachedCodeQL;
}

function resolveFunction<T>(
  partialCodeql: Partial<CodeQL>,
  methodName: string,
  defaultImplementation?: T,
): T {
  if (typeof partialCodeql[methodName] !== "function") {
    if (defaultImplementation !== undefined) {
      return defaultImplementation;
    }
    const dummyMethod = () => {
      throw new Error(`CodeQL ${methodName} method not correctly defined`);
    };
    return dummyMethod as any;
  }
  return partialCodeql[methodName];
}

/**
 * Set the functionality for CodeQL methods. Only for use in tests.
 *
 * Accepts a partial object and any undefined methods will be implemented
 * to immediately throw an exception indicating which method is missing.
 */
export function setCodeQL(partialCodeql: Partial<CodeQL>): CodeQL {
  cachedCodeQL = {
    getPath: resolveFunction(partialCodeql, "getPath", () => "/tmp/dummy-path"),
    getVersion: resolveFunction(partialCodeql, "getVersion", async () => ({
      version: "1.0.0",
    })),
    printVersion: resolveFunction(partialCodeql, "printVersion"),
    supportsFeature: resolveFunction(
      partialCodeql,
      "supportsFeature",
      async (feature) =>
        !!partialCodeql.getVersion &&
        isSupportedToolsFeature(await partialCodeql.getVersion(), feature),
    ),
    databaseInitCluster: resolveFunction(partialCodeql, "databaseInitCluster"),
    runAutobuild: resolveFunction(partialCodeql, "runAutobuild"),
    extractScannedLanguage: resolveFunction(
      partialCodeql,
      "extractScannedLanguage",
    ),
    extractUsingBuildMode: resolveFunction(
      partialCodeql,
      "extractUsingBuildMode",
    ),
    finalizeDatabase: resolveFunction(partialCodeql, "finalizeDatabase"),
    resolveLanguages: resolveFunction(partialCodeql, "resolveLanguages"),
    betterResolveLanguages: resolveFunction(
      partialCodeql,
      "betterResolveLanguages",
    ),
    resolveQueries: resolveFunction(partialCodeql, "resolveQueries"),
    resolveBuildEnvironment: resolveFunction(
      partialCodeql,
      "resolveBuildEnvironment",
    ),
    packDownload: resolveFunction(partialCodeql, "packDownload"),
    databaseCleanup: resolveFunction(partialCodeql, "databaseCleanup"),
    databaseBundle: resolveFunction(partialCodeql, "databaseBundle"),
    databaseRunQueries: resolveFunction(partialCodeql, "databaseRunQueries"),
    databaseInterpretResults: resolveFunction(
      partialCodeql,
      "databaseInterpretResults",
    ),
    databasePrintBaseline: resolveFunction(
      partialCodeql,
      "databasePrintBaseline",
    ),
    databaseExportDiagnostics: resolveFunction(
      partialCodeql,
      "databaseExportDiagnostics",
    ),
    diagnosticsExport: resolveFunction(partialCodeql, "diagnosticsExport"),
    resolveExtractor: resolveFunction(partialCodeql, "resolveExtractor"),
  };
  return cachedCodeQL;
}

/**
 * Get the cached CodeQL object. Should only be used from tests.
 *
 * TODO: Work out a good way for tests to get this from the test context
 * instead of having to have this method.
 */
export function getCachedCodeQL(): CodeQL {
  if (cachedCodeQL === undefined) {
    // Should never happen as setCodeQL is called by testing-utils.setupTests
    throw new Error("cachedCodeQL undefined");
  }
  return cachedCodeQL;
}

/**
 * Get a real, newly created CodeQL instance for testing. The instance refers to
 * a non-existent placeholder codeql command, so tests that use this function
 * should also stub the toolrunner.ToolRunner constructor.
 */
export async function getCodeQLForTesting(
  cmd = "codeql-for-testing",
): Promise<CodeQL> {
  return getCodeQLForCmd(cmd, false);
}

/**
 * Return a CodeQL object for CodeQL CLI access.
 *
 * @param cmd Path to CodeQL CLI
 * @param checkVersion Whether to check that CodeQL CLI meets the minimum
 *        version requirement. Must be set to true outside tests.
 * @returns A new CodeQL object
 */
export async function getCodeQLForCmd(
  cmd: string,
  checkVersion: boolean,
): Promise<CodeQL> {
  const codeql: CodeQL = {
    getPath() {
      return cmd;
    },
    async getVersion() {
      let result = util.getCachedCodeQlVersion();
      if (result === undefined) {
        const output = await runTool(cmd, ["version", "--format=json"]);
        try {
          result = JSON.parse(output) as VersionInfo;
        } catch (err) {
          throw Error(
            `Invalid JSON output from \`version --format=json\`: ${output}`,
          );
        }
        util.cacheCodeQlVersion(result);
      }
      return result;
    },
    async printVersion() {
      await runTool(cmd, ["version", "--format=json"]);
    },
    async supportsFeature(feature: ToolsFeature) {
      return isSupportedToolsFeature(await this.getVersion(), feature);
    },
    async databaseInitCluster(
      config: Config,
      sourceRoot: string,
      processName: string | undefined,
      qlconfigFile: string | undefined,
      logger: Logger,
    ) {
      const extraArgs = config.languages.map(
        (language) => `--language=${language}`,
      );
      if (config.languages.filter((l) => isTracedLanguage(l)).length > 0) {
        extraArgs.push("--begin-tracing");
        extraArgs.push(...(await getTrapCachingExtractorConfigArgs(config)));
        extraArgs.push(`--trace-process-name=${processName}`);
      }

      const codeScanningConfigFile = await generateCodeScanningConfig(
        config,
        logger,
      );
      const externalRepositoryToken = getOptionalInput(
        "external-repository-token",
      );
      extraArgs.push(`--codescanning-config=${codeScanningConfigFile}`);
      if (externalRepositoryToken) {
        extraArgs.push("--external-repository-token-stdin");
      }

      if (
        config.buildMode !== undefined &&
        (await this.supportsFeature(ToolsFeature.BuildModeOption))
      ) {
        extraArgs.push(`--build-mode=${config.buildMode}`);
      }
      if (
        qlconfigFile !== undefined &&
        (await util.codeQlVersionAbove(this, CODEQL_VERSION_INIT_WITH_QLCONFIG))
      ) {
        extraArgs.push(`--qlconfig-file=${qlconfigFile}`);
      }

      if (
        await util.codeQlVersionAbove(
          this,
          CODEQL_VERSION_LANGUAGE_BASELINE_CONFIG,
        )
      ) {
        extraArgs.push("--calculate-language-specific-baseline");
      }

      if (await isSublanguageFileCoverageEnabled(config, this)) {
        extraArgs.push("--sublanguage-file-coverage");
      } else if (
        await util.codeQlVersionAbove(
          this,
          CODEQL_VERSION_SUBLANGUAGE_FILE_COVERAGE,
        )
      ) {
        extraArgs.push("--no-sublanguage-file-coverage");
      }

      try {
        await runTool(
          cmd,
          [
            "database",
            "init",
            "--db-cluster",
            config.dbLocation,
            `--source-root=${sourceRoot}`,
            ...(await getLanguageAliasingArguments(this)),
            ...extraArgs,
            ...getExtraOptionsFromEnv(["database", "init"]),
          ],
          { stdin: externalRepositoryToken },
        );
      } catch (e) {
        if (e instanceof Error) {
          throw wrapCliConfigurationError(e);
        }
        throw e;
      }
    },
    async runAutobuild(language: Language) {
      const autobuildCmd = path.join(
        await this.resolveExtractor(language),
        "tools",
        process.platform === "win32" ? "autobuild.cmd" : "autobuild.sh",
      );

      // Update JAVA_TOOL_OPTIONS to contain '-Dhttp.keepAlive=false'
      // This is because of an issue with Azure pipelines timing out connections after 4 minutes
      // and Maven not properly handling closed connections
      // Otherwise long build processes will timeout when pulling down Java packages
      // https://developercommunity.visualstudio.com/content/problem/292284/maven-hosted-agent-connection-timeout.html
      const javaToolOptions = process.env["JAVA_TOOL_OPTIONS"] || "";
      process.env["JAVA_TOOL_OPTIONS"] = [
        ...javaToolOptions.split(/\s+/),
        "-Dhttp.keepAlive=false",
        "-Dmaven.wagon.http.pool=false",
      ].join(" ");

      // On macOS, System Integrity Protection (SIP) typically interferes with
      // CodeQL build tracing of protected binaries.
      // The usual workaround is to prefix `$CODEQL_RUNNER` to build commands:
      // `$CODEQL_RUNNER` (not to be confused with the deprecated CodeQL Runner tool)
      // points to a simple wrapper binary included with the CLI, and the extra layer of
      // process indirection helps the tracer bypass SIP.

      // The above SIP workaround is *not* needed here.
      // At the `autobuild` step in the Actions workflow, we assume the `init` step
      // has successfully run, and will have exported `DYLD_INSERT_LIBRARIES`
      // into the environment of subsequent steps, to activate the tracer.
      // When `DYLD_INSERT_LIBRARIES` is set in the environment for a step,
      // the Actions runtime introduces its own workaround for SIP
      // (https://github.com/actions/runner/pull/416).
      try {
        await runTool(autobuildCmd);
      } catch (e) {
        if (e instanceof Error) {
          throw wrapCliConfigurationError(e);
        }
        throw e;
      }
    },
    async extractScannedLanguage(config: Config, language: Language) {
      await runTool(cmd, [
        "database",
        "trace-command",
        "--index-traceless-dbs",
        ...(await getTrapCachingExtractorConfigArgsForLang(config, language)),
        ...getExtraOptionsFromEnv(["database", "trace-command"]),
        util.getCodeQLDatabasePath(config, language),
      ]);
    },
    async extractUsingBuildMode(config: Config, language: Language) {
      await runTool(cmd, [
        "database",
        "trace-command",
        "--use-build-mode",
        ...(await getTrapCachingExtractorConfigArgsForLang(config, language)),
        ...getExtraOptionsFromEnv(["database", "trace-command"]),
        util.getCodeQLDatabasePath(config, language),
      ]);
    },
    async finalizeDatabase(
      databasePath: string,
      threadsFlag: string,
      memoryFlag: string,
    ) {
      const args = [
        "database",
        "finalize",
        "--finalize-dataset",
        threadsFlag,
        memoryFlag,
        ...getExtraOptionsFromEnv(["database", "finalize"]),
        databasePath,
      ];
      try {
        await runTool(cmd, args);
      } catch (e) {
        if (e instanceof Error) {
          throw wrapCliConfigurationError(e);
        }
        throw e;
      }
    },
    async resolveLanguages() {
      const codeqlArgs = [
        "resolve",
        "languages",
        "--format=json",
        ...getExtraOptionsFromEnv(["resolve", "languages"]),
      ];
      const output = await runTool(cmd, codeqlArgs);

      try {
        return JSON.parse(output);
      } catch (e) {
        throw new Error(
          `Unexpected output from codeql resolve languages: ${e}`,
        );
      }
    },
    async betterResolveLanguages() {
      const codeqlArgs = [
        "resolve",
        "languages",
        "--format=betterjson",
        "--extractor-options-verbosity=4",
        ...(await getLanguageAliasingArguments(this)),
        ...getExtraOptionsFromEnv(["resolve", "languages"]),
      ];
      const output = await runTool(cmd, codeqlArgs);

      try {
        return JSON.parse(output);
      } catch (e) {
        throw new Error(
          `Unexpected output from codeql resolve languages with --format=betterjson: ${e}`,
        );
      }
    },
    async resolveQueries(
      queries: string[],
      extraSearchPath: string | undefined,
    ) {
      const codeqlArgs = [
        "resolve",
        "queries",
        ...queries,
        "--format=bylanguage",
        ...getExtraOptionsFromEnv(["resolve", "queries"]),
      ];
      if (extraSearchPath !== undefined) {
        codeqlArgs.push("--additional-packs", extraSearchPath);
      }
      const output = await runTool(cmd, codeqlArgs);

      try {
        return JSON.parse(output);
      } catch (e) {
        throw new Error(`Unexpected output from codeql resolve queries: ${e}`);
      }
    },
    async resolveBuildEnvironment(
      workingDir: string | undefined,
      language: string,
    ) {
      const codeqlArgs = [
        "resolve",
        "build-environment",
        `--language=${language}`,
        ...(await getLanguageAliasingArguments(this)),
        ...getExtraOptionsFromEnv(["resolve", "build-environment"]),
      ];
      if (workingDir !== undefined) {
        codeqlArgs.push("--working-dir", workingDir);
      }
      const output = await runTool(cmd, codeqlArgs);

      try {
        return JSON.parse(output);
      } catch (e) {
        throw new Error(
          `Unexpected output from codeql resolve build-environment: ${e} in\n${output}`,
        );
      }
    },
    async databaseRunQueries(
      databasePath: string,
      flags: string[],
    ): Promise<void> {
      const codeqlArgs = [
        "database",
        "run-queries",
        ...flags,
        databasePath,
        "--min-disk-free=1024", // Try to leave at least 1GB free
        "-v",
        ...getExtraOptionsFromEnv(["database", "run-queries"]),
      ];
      if (await util.supportExpectDiscardedCache(this)) {
        codeqlArgs.push("--expect-discarded-cache");
      }
      if (
        await util.codeQlVersionAbove(
          this,
          CODEQL_VERSION_FINE_GRAINED_PARALLELISM,
        )
      ) {
        codeqlArgs.push("--intra-layer-parallelism");
      }
      await runTool(cmd, codeqlArgs);
    },
    async databaseInterpretResults(
      databasePath: string,
      querySuitePaths: string[] | undefined,
      sarifFile: string,
      addSnippetsFlag: string,
      threadsFlag: string,
      verbosityFlag: string,
      automationDetailsId: string | undefined,
      config: Config,
      features: FeatureEnablement,
      logger: Logger,
    ): Promise<string> {
      const shouldExportDiagnostics = await features.getValue(
        Feature.ExportDiagnosticsEnabled,
        this,
      );
      const shouldWorkaroundInvalidNotifications =
        shouldExportDiagnostics &&
        !(await isDiagnosticsExportInvalidSarifFixed(this));
      const codeqlOutputFile = shouldWorkaroundInvalidNotifications
        ? path.join(config.tempDir, "codeql-intermediate-results.sarif")
        : sarifFile;
      const codeqlArgs = [
        "database",
        "interpret-results",
        threadsFlag,
        "--format=sarif-latest",
        verbosityFlag,
        `--output=${codeqlOutputFile}`,
        addSnippetsFlag,
        "--print-diagnostics-summary",
        "--print-metrics-summary",
        "--sarif-add-baseline-file-info",
        ...(await getCodeScanningConfigExportArguments(config, this)),
        "--sarif-group-rules-by-pack",
        ...(await getCodeScanningQueryHelpArguments(this)),
        ...getExtraOptionsFromEnv(["database", "interpret-results"]),
      ];
      if (automationDetailsId !== undefined) {
        codeqlArgs.push("--sarif-category", automationDetailsId);
      }
      if (await isSublanguageFileCoverageEnabled(config, this)) {
        codeqlArgs.push("--sublanguage-file-coverage");
      } else if (
        await util.codeQlVersionAbove(
          this,
          CODEQL_VERSION_SUBLANGUAGE_FILE_COVERAGE,
        )
      ) {
        codeqlArgs.push("--no-sublanguage-file-coverage");
      }
      if (shouldExportDiagnostics) {
        codeqlArgs.push("--sarif-include-diagnostics");
      } else if (await util.codeQlVersionAbove(this, "2.12.4")) {
        codeqlArgs.push("--no-sarif-include-diagnostics");
      }
      if (
        // Analysis summary v2 links to the status page, so check the GHES version we're running on
        // supports the status page.
        (config.gitHubVersion.type !== util.GitHubVariant.GHES ||
          semver.gte(config.gitHubVersion.version, "3.9.0")) &&
        (await util.codeQlVersionAbove(
          this,
          CODEQL_VERSION_ANALYSIS_SUMMARY_V2,
        ))
      ) {
        codeqlArgs.push("--new-analysis-summary");
      } else if (
        await util.codeQlVersionAbove(this, CODEQL_VERSION_ANALYSIS_SUMMARY_V2)
      ) {
        codeqlArgs.push("--no-new-analysis-summary");
      }
      codeqlArgs.push(databasePath);
      if (querySuitePaths) {
        codeqlArgs.push(...querySuitePaths);
      }
      // Capture the stdout, which contains the analysis summary. Don't stream it to the Actions
      // logs to avoid printing it twice.
      const analysisSummary = await runTool(cmd, codeqlArgs, {
        noStreamStdout: true,
      });

      if (shouldWorkaroundInvalidNotifications) {
        util.fixInvalidNotificationsInFile(codeqlOutputFile, sarifFile, logger);
      }

      return analysisSummary;
    },
    async databasePrintBaseline(databasePath: string): Promise<string> {
      const codeqlArgs = [
        "database",
        "print-baseline",
        ...getExtraOptionsFromEnv(["database", "print-baseline"]),
        databasePath,
      ];
      return await runTool(cmd, codeqlArgs);
    },

    /**
     * Download specified packs into the package cache. If the specified
     * package and version already exists (e.g., from a previous analysis run),
     * then it is not downloaded again (unless the extra option `--force` is
     * specified).
     *
     * If no version is specified, then the latest version is
     * downloaded. The check to determine what the latest version is is done
     * each time this package is requested.
     *
     * Optionally, a `qlconfigFile` is included. If used, then this file
     * is used to determine which registry each pack is downloaded from.
     */
    async packDownload(
      packs: string[],
      qlconfigFile: string | undefined,
    ): Promise<PackDownloadOutput> {
      const qlconfigArg = qlconfigFile
        ? [`--qlconfig-file=${qlconfigFile}`]
        : ([] as string[]);

      const codeqlArgs = [
        "pack",
        "download",
        ...qlconfigArg,
        "--format=json",
        "--resolve-query-specs",
        ...getExtraOptionsFromEnv(["pack", "download"]),
        ...packs,
      ];

      const output = await runTool(cmd, codeqlArgs);

      try {
        const parsedOutput: PackDownloadOutput = JSON.parse(output);
        if (
          Array.isArray(parsedOutput.packs) &&
          // TODO PackDownloadOutput will not include the version if it is not specified
          // in the input. The version is always the latest version available.
          // It should be added to the output, but this requires a CLI change
          parsedOutput.packs.every((p) => p.name /* && p.version */)
        ) {
          return parsedOutput;
        } else {
          throw new Error("Unexpected output from pack download");
        }
      } catch (e) {
        throw new Error(
          `Attempted to download specified packs but got an error:\n${output}\n${e}`,
        );
      }
    },
    async databaseCleanup(
      databasePath: string,
      cleanupLevel: string,
    ): Promise<void> {
      const codeqlArgs = [
        "database",
        "cleanup",
        databasePath,
        `--mode=${cleanupLevel}`,
        ...getExtraOptionsFromEnv(["database", "cleanup"]),
      ];
      await runTool(cmd, codeqlArgs);
    },
    async databaseBundle(
      databasePath: string,
      outputFilePath: string,
      databaseName: string,
    ): Promise<void> {
      const args = [
        "database",
        "bundle",
        databasePath,
        `--output=${outputFilePath}`,
        `--name=${databaseName}`,
        ...getExtraOptionsFromEnv(["database", "bundle"]),
      ];
      await new toolrunner.ToolRunner(cmd, args).exec();
    },
    async databaseExportDiagnostics(
      databasePath: string,
      sarifFile: string,
      automationDetailsId: string | undefined,
      tempDir: string,
      logger: Logger,
    ): Promise<void> {
      const shouldWorkaroundInvalidNotifications =
        !(await isDiagnosticsExportInvalidSarifFixed(this));
      const codeqlOutputFile = shouldWorkaroundInvalidNotifications
        ? path.join(tempDir, "codeql-intermediate-results.sarif")
        : sarifFile;
      const args = [
        "database",
        "export-diagnostics",
        `${databasePath}`,
        "--db-cluster", // Database is always a cluster for CodeQL versions that support diagnostics.
        "--format=sarif-latest",
        `--output=${codeqlOutputFile}`,
        "--sarif-include-diagnostics", // ExportDiagnosticsEnabled is always true if this command is run.
        "-vvv",
        ...getExtraOptionsFromEnv(["diagnostics", "export"]),
      ];
      if (automationDetailsId !== undefined) {
        args.push("--sarif-category", automationDetailsId);
      }
      await new toolrunner.ToolRunner(cmd, args).exec();

      if (shouldWorkaroundInvalidNotifications) {
        // Fix invalid notifications in the SARIF file output by CodeQL.
        util.fixInvalidNotificationsInFile(codeqlOutputFile, sarifFile, logger);
      }
    },
    async diagnosticsExport(
      sarifFile: string,
      automationDetailsId: string | undefined,
      config: Config,
    ): Promise<void> {
      const args = [
        "diagnostics",
        "export",
        "--format=sarif-latest",
        `--output=${sarifFile}`,
        ...(await getCodeScanningConfigExportArguments(config, this)),
        ...getExtraOptionsFromEnv(["diagnostics", "export"]),
      ];
      if (automationDetailsId !== undefined) {
        args.push("--sarif-category", automationDetailsId);
      }
      await new toolrunner.ToolRunner(cmd, args).exec();
    },
    async resolveExtractor(language: Language): Promise<string> {
      // Request it using `format=json` so we don't need to strip the trailing new line generated by
      // the CLI.
      let extractorPath = "";
      await new toolrunner.ToolRunner(
        cmd,
        [
          "resolve",
          "extractor",
          "--format=json",
          `--language=${language}`,
          ...(await getLanguageAliasingArguments(this)),
          ...getExtraOptionsFromEnv(["resolve", "extractor"]),
        ],
        {
          silent: true,
          listeners: {
            stdout: (data) => {
              extractorPath += data.toString();
            },
            stderr: (data) => {
              process.stderr.write(data);
            },
          },
        },
      ).exec();
      return JSON.parse(extractorPath);
    },
  };
  // To ensure that status reports include the CodeQL CLI version wherever
  // possible, we want to call getVersion(), which populates the version value
  // used by status reporting, at the earliest opportunity. But invoking
  // getVersion() directly here breaks tests that only pretend to create a
  // CodeQL object. So instead we rely on the assumption that all non-test
  // callers would set checkVersion to true, and util.codeQlVersionAbove()
  // would call getVersion(), so the CLI version would be cached as soon as the
  // CodeQL object is created.
  if (
    checkVersion &&
    !(await util.codeQlVersionAbove(codeql, CODEQL_MINIMUM_VERSION))
  ) {
    throw new util.ConfigurationError(
      `Expected a CodeQL CLI with version at least ${CODEQL_MINIMUM_VERSION} but got version ${
        (await codeql.getVersion()).version
      }`,
    );
  } else if (
    checkVersion &&
    process.env[EnvVar.SUPPRESS_DEPRECATED_SOON_WARNING] !== "true" &&
    !(await util.codeQlVersionAbove(codeql, CODEQL_NEXT_MINIMUM_VERSION))
  ) {
    const result = await codeql.getVersion();
    core.warning(
      `CodeQL CLI version ${result.version} was discontinued on ` +
        `${GHES_MOST_RECENT_DEPRECATION_DATE} alongside GitHub Enterprise Server ` +
        `${GHES_VERSION_MOST_RECENTLY_DEPRECATED} and will not be supported by the next minor ` +
        `release of the CodeQL Action. Please update to CodeQL CLI version ` +
        `${CODEQL_NEXT_MINIMUM_VERSION} or later. For instance, if you have specified a custom ` +
        "version of the CLI using the 'tools' input to the 'init' Action, you can remove this " +
        "input to use the default version.\n\n" +
        "Alternatively, if you want to continue using CodeQL CLI version " +
        `${result.version}, you can replace 'github/codeql-action/*@v2' by ` +
        `'github/codeql-action/*@v${getActionVersion()}' in your code scanning workflow to ` +
        "continue using this version of the CodeQL Action.",
    );
    core.exportVariable(EnvVar.SUPPRESS_DEPRECATED_SOON_WARNING, "true");
  }
  return codeql;
}

/**
 * Gets the options for `path` of `options` as an array of extra option strings.
 */
function getExtraOptionsFromEnv(paths: string[]) {
  const options: ExtraOptions = util.getExtraOptionsEnvParam();
  return getExtraOptions(options, paths, []);
}

/**
 * Gets `options` as an array of extra option strings.
 *
 * - throws an exception mentioning `pathInfo` if this conversion is impossible.
 */
function asExtraOptions(options: any, pathInfo: string[]): string[] {
  if (options === undefined) {
    return [];
  }
  if (!Array.isArray(options)) {
    const msg = `The extra options for '${pathInfo.join(
      ".",
    )}' ('${JSON.stringify(options)}') are not in an array.`;
    throw new Error(msg);
  }
  return options.map((o) => {
    const t = typeof o;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      const msg = `The extra option for '${pathInfo.join(
        ".",
      )}' ('${JSON.stringify(o)}') is not a primitive value.`;
      throw new Error(msg);
    }
    return `${o}`;
  });
}

/**
 * Gets the options for `path` of `options` as an array of extra option strings.
 *
 * - the special terminal step name '*' in `options` matches all path steps
 * - throws an exception if this conversion is impossible.
 *
 * Exported for testing.
 */
export function getExtraOptions(
  options: any,
  paths: string[],
  pathInfo: string[],
): string[] {
  const all = asExtraOptions(options?.["*"], pathInfo.concat("*"));
  const specific =
    paths.length === 0
      ? asExtraOptions(options, pathInfo)
      : getExtraOptions(
          options?.[paths[0]],
          paths?.slice(1),
          pathInfo.concat(paths[0]),
        );
  return all.concat(specific);
}

/*
 * A constant defining the maximum number of characters we will keep from
 * the programs stderr for logging. This serves two purposes:
 * (1) It avoids an OOM if a program fails in a way that results it
 *     printing many log lines.
 * (2) It avoids us hitting the limit of how much data we can send in our
 *     status reports on GitHub.com.
 */
const maxErrorSize = 20_000;

async function runTool(
  cmd: string,
  args: string[] = [],
  opts: { stdin?: string; noStreamStdout?: boolean } = {},
) {
  let output = "";
  let error = "";
  process.stdout.write(`[command]${cmd} ${args.join(" ")}\n`);
  const exitCode = await new toolrunner.ToolRunner(cmd, args, {
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString("utf8");
        if (!opts.noStreamStdout) {
          process.stdout.write(data);
        }
      },
      stderr: (data: Buffer) => {
        let readStartIndex = 0;
        // If the error is too large, then we only take the last 20,000 characters
        if (data.length - maxErrorSize > 0) {
          // Eg: if we have 20,000 the start index should be 2.
          readStartIndex = data.length - maxErrorSize + 1;
        }
        error += data.toString("utf8", readStartIndex);
        // Mimic the standard behavior of the toolrunner by writing stderr to stdout
        process.stdout.write(data);
      },
    },
    silent: true,
    ...(opts.stdin ? { input: Buffer.from(opts.stdin || "") } : {}),
  }).exec();
  if (exitCode !== 0) {
    throw new CommandInvocationError(cmd, args, exitCode, error, output);
  }
  return output;
}

/**
 * Generates a code scanning configuration that is to be used for a scan.
 *
 * @param codeql The CodeQL object to use.
 * @param config The configuration to use.
 * @returns the path to the generated user configuration file.
 */
async function generateCodeScanningConfig(
  config: Config,
  logger: Logger,
): Promise<string> {
  const codeScanningConfigFile = getGeneratedCodeScanningConfigPath(config);

  // make a copy so we can modify it
  const augmentedConfig = cloneObject(config.originalUserInput);

  // Inject the queries from the input
  if (config.augmentationProperties.queriesInput) {
    if (config.augmentationProperties.queriesInputCombines) {
      augmentedConfig.queries = (augmentedConfig.queries || []).concat(
        config.augmentationProperties.queriesInput,
      );
    } else {
      augmentedConfig.queries = config.augmentationProperties.queriesInput;
    }
  }
  if (augmentedConfig.queries?.length === 0) {
    delete augmentedConfig.queries;
  }

  // Inject the packs from the input
  if (config.augmentationProperties.packsInput) {
    if (config.augmentationProperties.packsInputCombines) {
      // At this point, we already know that this is a single-language analysis
      if (Array.isArray(augmentedConfig.packs)) {
        augmentedConfig.packs = (augmentedConfig.packs || []).concat(
          config.augmentationProperties.packsInput,
        );
      } else if (!augmentedConfig.packs) {
        augmentedConfig.packs = config.augmentationProperties.packsInput;
      } else {
        // At this point, we know there is only one language.
        // If there were more than one language, an error would already have been thrown.
        const language = Object.keys(augmentedConfig.packs)[0];
        augmentedConfig.packs[language] = augmentedConfig.packs[
          language
        ].concat(config.augmentationProperties.packsInput);
      }
    } else {
      augmentedConfig.packs = config.augmentationProperties.packsInput;
    }
  }
  if (Array.isArray(augmentedConfig.packs) && !augmentedConfig.packs.length) {
    delete augmentedConfig.packs;
  }
  logger.info(
    `Writing augmented user configuration file to ${codeScanningConfigFile}`,
  );
  logger.startGroup("Augmented user configuration file contents");
  logger.info(yaml.dump(augmentedConfig));
  logger.endGroup();

  fs.writeFileSync(codeScanningConfigFile, yaml.dump(augmentedConfig));
  return codeScanningConfigFile;
}

function cloneObject<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Gets arguments for passing the code scanning configuration file to interpretation commands like
 * `codeql database interpret-results` and `codeql database export-diagnostics`.
 *
 * Returns an empty list if a code scanning configuration file was not generated by the CLI.
 */
async function getCodeScanningConfigExportArguments(
  config: Config,
  codeql: CodeQL,
): Promise<string[]> {
  const codeScanningConfigPath = getGeneratedCodeScanningConfigPath(config);
  if (
    fs.existsSync(codeScanningConfigPath) &&
    (await util.codeQlVersionAbove(
      codeql,
      CODEQL_VERSION_EXPORT_CODE_SCANNING_CONFIG,
    ))
  ) {
    return ["--sarif-codescanning-config", codeScanningConfigPath];
  }
  return [];
}

// This constant sets the size of each TRAP cache in megabytes.
const TRAP_CACHE_SIZE_MB = 1024;

export async function getTrapCachingExtractorConfigArgs(
  config: Config,
): Promise<string[]> {
  const result: string[][] = [];
  for (const language of config.languages)
    result.push(
      await getTrapCachingExtractorConfigArgsForLang(config, language),
    );
  return result.flat();
}

export async function getTrapCachingExtractorConfigArgsForLang(
  config: Config,
  language: Language,
): Promise<string[]> {
  const cacheDir = config.trapCaches[language];
  if (cacheDir === undefined) return [];
  const write = await isAnalyzingDefaultBranch();
  return [
    `-O=${language}.trap.cache.dir=${cacheDir}`,
    `-O=${language}.trap.cache.bound=${TRAP_CACHE_SIZE_MB}`,
    `-O=${language}.trap.cache.write=${write}`,
  ];
}

/**
 * Get the path to the code scanning configuration generated by the CLI.
 *
 * This will not exist if the configuration is being parsed in the Action.
 */
export function getGeneratedCodeScanningConfigPath(config: Config): string {
  return path.resolve(config.tempDir, "user-config.yaml");
}

async function isDiagnosticsExportInvalidSarifFixed(
  codeql: CodeQL,
): Promise<boolean> {
  return await util.codeQlVersionAbove(
    codeql,
    CODEQL_VERSION_DIAGNOSTICS_EXPORT_FIXED,
  );
}

async function getLanguageAliasingArguments(codeql: CodeQL): Promise<string[]> {
  if (await util.codeQlVersionAbove(codeql, CODEQL_VERSION_LANGUAGE_ALIASING)) {
    return ["--extractor-include-aliases"];
  }
  return [];
}

async function isSublanguageFileCoverageEnabled(
  config: Config,
  codeql: CodeQL,
) {
  return (
    // Sub-language file coverage is first supported in GHES 3.12.
    (config.gitHubVersion.type !== util.GitHubVariant.GHES ||
      semver.gte(config.gitHubVersion.version, "3.12.0")) &&
    (await util.codeQlVersionAbove(
      codeql,
      CODEQL_VERSION_SUBLANGUAGE_FILE_COVERAGE,
    ))
  );
}

async function getCodeScanningQueryHelpArguments(
  codeql: CodeQL,
): Promise<string[]> {
  if (
    await util.codeQlVersionAbove(codeql, CODEQL_VERSION_INCLUDE_QUERY_HELP)
  ) {
    return ["--sarif-include-query-help=always"];
  }
  return ["--sarif-add-query-help"];
}
