import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { advanceFeatureDesign } from "./feature-design.mjs";

// CLI composes the host renderer; this module owns the business ordering.
export async function runHostRoute(rootDir, input, classify) {
  await initRuntime(rootDir);
  await advanceFeatureDesign(rootDir, input);
  return classify(rootDir, input);
}

export async function runHostHook(rootDir, input, renderHook) {
  const project = typeof input.cwd === "string" ? input.cwd : rootDir;
  await initRuntime(project);
  const event = input.hook_event_name || input.event || input.name;
  if (["UserPromptSubmit", "user_prompt_submit"].includes(event) && input.prompt) {
    await advanceFeatureDesign(project, { text: input.prompt, sessionId: input.session_id || input.sessionId || "session" });
  }
  return renderHook(rootDir, input);
}
