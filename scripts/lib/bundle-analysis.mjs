import fs from "node:fs";
import crypto from "node:crypto";

export const STAGES = [
  {
    id: "base-prompt-cache-patcher",
    label: "Base direct-M3 request patcher",
    requiredForCurrentPatcher: true,
    markers: [
      ["patchMiniMaxPromptCacheBody", "function patchMiniMaxPromptCacheBody(bodyText) {"],
      ["annotatePromptCacheTools", "function annotatePromptCacheTools(tools) {"],
      ["minimaxPromptCacheTarget", "function isMiniMaxPromptCacheTarget(input, init) {"]
    ]
  },
  {
    id: "prompt-surface-profiles",
    label: "Prompt surface profiles",
    requiredForCurrentPatcher: true,
    markers: [
      ["promptSurfaceLimits", "function promptSurfaceLimits() {"],
      ["compactDescription", "function compactDescription("]
    ]
  },
  {
    id: "direct-m3-output-cap",
    label: "Direct M3 output cap",
    appliedByCurrentPatcher: true,
    markers: [
      ["maxTokenCap8192", "var MINIMAX_DEFAULT_MAX_TOKENS = 8192"],
      ["maxTokenEnvOverride", "process.env.MAVIS_MINIMAX_MAX_TOKENS"]
    ]
  },
  {
    id: "request-diagnostics",
    label: "Request section/tool diagnostics",
    markers: [
      ["sectionBytes", "sectionBytes"],
      ["largestTools", "largestTools"],
      ["descriptionBytes", "descriptionBytes"],
      ["inputSchemaBytes", "inputSchemaBytes"]
    ]
  },
  {
    id: "tool-definition-trim",
    label: "Tool definition trim",
    appliedByCurrentPatcher: true,
    markers: [
      ["trimToolDefinitionForMax", "function trimToolDefinitionForMax(input, output) {"],
      ["trimSchemaDescriptionsForMax", "function trimSchemaDescriptionsForMax(value"],
      ["skillToolShortDescription", "output.description = SKILL_TOOL_DESCRIPTION"],
      ["toolDefinitionTrimCall", "trimToolDefinitionForMax(input, output);"]
    ]
  },
  {
    id: "final-tool-description-trim",
    label: "Final request-body tool description trim",
    appliedByCurrentPatcher: true,
    markers: [
      ["trimFinalToolDescriptionsForMax", "function trimFinalToolDescriptionsForMax(tools) {"],
      ["toolDescriptionsTrimmed", "toolDescriptionsTrimmed"],
      ["finalToolTrimCall", "const finalToolDescriptions = trimFinalToolDescriptionsForMax(parsed.tools);"]
    ]
  },
  {
    id: "request-patcher-test-export",
    label: "Request patcher test export",
    appliedByCurrentPatcher: true,
    markers: [
      ["patchMiniMaxPromptCacheBodyExport", "patchMiniMaxPromptCacheBody,"]
    ]
  },
  {
    id: "memory-caps",
    label: "Max-profile memory caps",
    appliedByCurrentPatcher: true,
    markers: [
      ["userProfileCap1200", 'profile === "max" ? 1200'],
      ["memoryTailCap4500", 'profile === "max" ? 4500'],
      ["memorySummaryCap1800", 'profile === "max" ? 1800']
    ]
  },
  {
    id: "static-prompt-compaction",
    label: "Max-profile static prompt compaction",
    appliedByCurrentPatcher: true,
    markers: [
      ["compactBaseInstructionsForMax", "function compactBaseInstructionsForMax(prompt) {"],
      ["compactSessionPromptForMax", "function compactSessionPromptForMax(prompt) {"],
      ["baseInstructionsCompactionCall", "prompt = compactBaseInstructionsForMax(prompt);"],
      ["sessionPromptCompactionCall", "compactSessionPromptForMax(sessionTypePrompt.trim())"]
    ]
  }
];

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

export function readBundle(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    source,
    sizeBytes: stats.size,
    modified: stats.mtime.toISOString(),
    sha256: sha256(source)
  };
}

export function markerPresent(source, marker) {
  return typeof marker === "string" ? source.includes(marker) : marker.test(source);
}

export function analyzeBundleSource(source) {
  const stages = STAGES.map((stage) => {
    const markers = stage.markers.map(([name, marker]) => ({
      name,
      present: markerPresent(source, marker)
    }));
    const presentCount = markers.filter((marker2) => marker2.present).length;
    const status = presentCount === 0 ? "missing" : presentCount === markers.length ? "present" : "partial";
    return {
      id: stage.id,
      label: stage.label,
      requiredForCurrentPatcher: Boolean(stage.requiredForCurrentPatcher),
      status,
      presentCount,
      totalCount: markers.length,
      markers
    };
  });

  const requiredStages = stages.filter((stage) => stage.requiredForCurrentPatcher);
  const missingRequiredStages = requiredStages.filter((stage) => stage.status !== "present").map((stage) => stage.id);
  const presentStages = stages.filter((stage) => stage.status === "present").length;
  const partialStages = stages.filter((stage) => stage.status === "partial").length;
  const currentPatchStages = stages.filter((stage) => STAGES.find((candidate) => candidate.id === stage.id)?.appliedByCurrentPatcher);
  const finalPatchPresent = currentPatchStages.every((stage) => stage.status === "present");
  let classification = "unsupported";
  if (missingRequiredStages.length === 0 && finalPatchPresent) {
    classification = "fully-patched";
  } else if (missingRequiredStages.length === 0 && (presentStages > requiredStages.length || partialStages > 0)) {
    classification = "partially-patched";
  } else if (missingRequiredStages.length === 0) {
    classification = "base-compatible";
  }

  return {
    classification,
    compatibleWithCurrentPatcher: missingRequiredStages.length === 0,
    finalPatchPresent,
    missingRequiredStages,
    stages
  };
}

export function analyzeBundleFile(filePath) {
  const bundle = readBundle(filePath);
  return {
    path: bundle.path,
    sizeBytes: bundle.sizeBytes,
    modified: bundle.modified,
    sha256: bundle.sha256,
    ...analyzeBundleSource(bundle.source)
  };
}
