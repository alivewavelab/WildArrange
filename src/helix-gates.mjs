/**
 * @deprecated Compatibility re-export shim. The real implementations moved
 * to src/capabilities/ (command-runner, verify, scope-guard, checkpoint,
 * task-reports) and to helix-change.mjs (ChangeRequest lifecycle), as part
 * of the five-zone decoupling refactor. This file exists only so every
 * pre-existing `import ... from "./helix-gates.mjs"` across the codebase
 * keeps working unchanged. New code should import directly from the real
 * location; this shim is scheduled for removal once all call sites have
 * been migrated (see doc/plans/2026-07-17-wildarrange-five-zone-refactor.html).
 */
export { runCommand } from "./infra/command-runner.mjs";
export { runVerifier } from "./capabilities/verify.mjs";
export {
  changedPathsIntroducedByTask,
  classifyManifestPathChanges,
  collectGitChangedPaths,
  collectGitDiff,
  pathAllowed,
  pathMatchesPattern,
  scopeGuard,
} from "./capabilities/scope-guard.mjs";
export { writeCheckpoint } from "./capabilities/checkpoint.mjs";
export { appendWisdom, writeFailureReport, writeReviewReport } from "./infra/task-reports.mjs";
export {
  listChangeRequests,
  renderChangeRequestMarkdown,
  writeChangeRequest,
  writeOpenChangesIndex,
} from "./orchestration/change-governance.mjs";
