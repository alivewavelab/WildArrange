/** @deprecated Compatibility export surface; new internal code must import the five-zone implementation directly. */
export {
  DEFAULT_HELIX_CONFIG,
  DEFAULT_CLI_COMMAND,
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
  DEFAULT_PACKAGE_NAME,
  DEFAULT_PROMPT_PACK_DIR,
  DEFAULT_REVIEW_AGENTS,
  DEFAULT_RUNTIME_NAME,
  HELIX_CONFIG_FILE,
  HELIX_DIR,
  PRODUCT_NAME,
  STATE_VERSION,
  TASK_STATUSES,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  hashContent,
  initRuntime,
  installPromptPack,
  listPromptPack,
  loadPromptPackEntries,
  loadHelixConfig,
  nowIso,
  readJson,
  renderPromptPackEntry,
  resolveHelixPath,
  verifyLedger,
  withTaskStateLock,
  writeDefaultHelixConfig,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
export {
  listRuntimeStateBackups,
  restoreRuntimeStateBackup,
  verifyConfigBaseline,
  verifyRuntimeState,
  writeConfigBaseline,
  writeRuntimeStateBackup,
} from "./helix-security.mjs";
export { runDoctor } from "./interface/doctor.mjs";
export { installAdapter, restoreAdapterBackup, uninstallAdapter } from "./interface/adapters.mjs";
export { recordReviewBlocker, resolveChangeRequest, reviewChangeRequest, steerWorkflow } from "./helix-change.mjs";
export { buildFailureSummary } from "./helix-failure.mjs";
export { buildAcceptanceProof, writeAcceptanceProof } from "./helix-acceptance-proof.mjs";
export { buildMemoryDigest, writeMemoryDigest } from "./helix-memory-digest.mjs";
export { loadRoutesConfig, resolveRouteDecision, routeRequest, semanticRouteShadow } from "./helix-routing.mjs";
export {
  buildArchivistPacket,
  listArchivistRouteSuggestions,
  recordArchivistEvent,
  resolveArchivistRouteSuggestion,
  runArchivistRouter,
} from "./helix-archivist-router.mjs";
export { scanProjectRules } from "./helix-rules.mjs";
export { runRepositoryGovernanceAudit } from "./capabilities/repository-governance.mjs";
export { runReviewGate, runWorker } from "./helix-review.mjs";
export { callOpenAICompatible, resolveAgentProvider, runLlmReview } from "./helix-llm.mjs";
export { buildReviewFindingBundle, validateReviewFinding } from "./helix-review-findings.mjs";
export {
  hashLine,
  runAstStructureGate,
  runCommentCheckerGate,
  runHashlineAnchorsGate,
  runLspDiagnosticsGate,
  runQualityGates,
} from "./helix-code-intel.mjs";
export { buildAgentContext, continuationDirective, recordRuntimeSession, resumeReport, writeContextSnapshot } from "./ai/context.mjs";
export { preToolUseGuard, runInjectionHook } from "./ai/hooks.mjs";
export { detectToolResultFindings, evaluateHookResultGate } from "./helix-hook-result-gate.mjs";
export { resolveInjectionPoint } from "./helix-injection.mjs";
export { matchSkills, resolvePromptVariant } from "./helix-skill-matcher.mjs";
export { attentionReport, dashboardData, statusReport, writeWorkflowSummary } from "./helix-status.mjs";
export { copyPlanTemplate, createSamplePlan, runWorkflow } from "./helix-workflow.mjs";
export {
  runNextTask,
  runWorkflowNode,
  executeTaskNode,
  verifyTaskNode,
  scopeTaskNode,
  reviewTaskNode,
  checkpointTaskNode,
  retryTaskNode,
} from "./helix-node-runtime.mjs";
export {
  approvePlan,
  enrichPlanWithRoutes,
  enrichTaskWithRouteDecision,
  importPlan,
  isPossibleNoopTask,
  isTrivialCommand,
  loadPlanApproval,
  loadTaskState,
  normalizePlan,
  normalizeStringArray,
  normalizeSuccessCriteria,
  normalizeTask,
  validatePlanGraph,
  validateStatus,
  writeTasksMarkdown,
} from "./helix-plan.mjs";
export {
  applyVerifierEvidenceToCriteria,
  claimTeamTask,
  createTeamTask,
  criteriaStatus,
  findRunnableTask,
  getTeamTask,
  listTeamMessages,
  listTeamTasks,
  normalizeAgentName,
  persistTaskState,
  recordTaskEvidence,
  sendTeamMessage,
  writeOutbox,
} from "./helix-team.mjs";
export {
  admitParallelAgentResult,
  cleanupParallelAgentRun,
  closeParallelAgentRun,
  listParallelAgentRuns,
  parallelAgentStatus,
  runParallelAgents,
} from "./helix-parallel-agents.mjs";
export { renderSpawnCommand, resolveAgentSpawn } from "./helix-agent-spawn.mjs";
export { applyAgentPatch, captureWorkspaceSnapshot, collectAgentWorktreePatch, extractPatchPaths, prepareAgentWorktree } from "./helix-git-worktree.mjs";
export {
  appendWisdom,
  changedPathsIntroducedByTask,
  classifyManifestPathChanges,
  collectGitChangedPaths,
  collectGitDiff,
  listChangeRequests,
  pathAllowed,
  pathMatchesPattern,
  runCommand,
  runVerifier,
  scopeGuard,
  writeChangeRequest,
  writeCheckpoint,
  writeFailureReport,
  writeReviewReport,
} from "./helix-gates.mjs";
export { compileCommandSafetyPatterns, evaluateCommandSafety } from "./helix-command-safety.mjs";
