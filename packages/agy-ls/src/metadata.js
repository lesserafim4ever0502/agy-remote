import { DEFAULT_IDE_VERSION, DEFAULT_MODEL } from './constants.js';
import { boolEnv } from './utils.js';
import { readAntigravityApiKey } from './state-db.js';

let cachedApiKey;
let attempted = false;

export function getApiKey() {
  if (!attempted) {
    cachedApiKey = readAntigravityApiKey();
    attempted = true;
  }
  return cachedApiKey;
}

export function buildMetadata(target) {
  const ideVersion = (typeof target === 'string' ? target : target?.ideVersion) || DEFAULT_IDE_VERSION;
  return {
    ideName: 'antigravity',
    apiKey: getApiKey() || '',
    locale: process.env.LANG?.split('.')[0] || 'en',
    ideVersion,
    extensionName: 'antigravity',
  };
}

export function buildCascadeConfig({ model, agenticMode = true } = {}) {
  const eager = String(process.env.AGY_TERMINAL_POLICY || 'off').toLowerCase() === 'eager';
  const review = String(process.env.AGY_ARTIFACT_REVIEW_POLICY || 'always').toLowerCase();
  const allowGitignored = boolEnv('AGY_ALLOW_GITIGNORED', false);
  const artifactReviewMode = review === 'turbo'
    ? 'ARTIFACT_REVIEW_MODE_TURBO'
    : review === 'auto'
      ? 'ARTIFACT_REVIEW_MODE_AUTO'
      : 'ARTIFACT_REVIEW_MODE_ALWAYS';

  const plannerConfig = {
    conversational: {
      plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT',
      agenticMode,
    },
    toolConfig: {
      runCommand: {
        autoCommandConfig: {
          autoExecutionPolicy: eager
            ? 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER'
            : 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
        },
      },
      notifyUser: { artifactReviewMode },
      code: { allowEditGitignore: allowGitignored },
      viewFile: { allowViewGitignore: allowGitignored },
      grep: { allowAccessGitignore: allowGitignored },
    },
  };

  const resolvedModel = model || process.env.AGY_DEFAULT_MODEL || DEFAULT_MODEL;
  if (resolvedModel) plannerConfig.requestedModel = { model: resolvedModel };
  return { plannerConfig };
}
