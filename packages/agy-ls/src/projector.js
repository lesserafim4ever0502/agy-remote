import { normalizeStatus } from './utils.js';

function stepStatus(step) {
  return normalizeStatus(step?.status || 'unknown');
}

function textItems(userInput = {}) {
  const items = userInput.items || [];
  const text = items.map((item) => item?.text).filter(Boolean).join('');
  return text || userInput.query || userInput.userResponse || '';
}

function commandOutput(run = {}) {
  return run.combinedOutput?.full
    || run.combinedOutput?.truncated
    || run.combinedOutputSnapshot?.full
    || run.stdoutOutput?.full
    || run.stdout
    || run.stderrOutput?.full
    || run.stderr
    || '';
}

function actionFile(codeAction = {}) {
  const spec = codeAction.actionSpec || {};
  return spec.createFile?.absoluteUri
    || spec.editFile?.absoluteUri
    || spec.deleteFile?.absoluteUri
    || codeAction.absoluteUri
    || '';
}

function interactionDescriptor(requested = {}) {
  const known = [
    'filePermission', 'runCommand', 'openBrowserUrl', 'runExtensionCode',
    'executeBrowserJavascript', 'captureBrowserScreenshot', 'clickBrowserPixel',
    'browserAction', 'openBrowserSetup', 'confirmBrowserSetup', 'sendCommandInput',
    'readUrlContent', 'mcp', 'elicitation', 'permission', 'askQuestion', 'approvalInteraction', 'deploy',
  ];
  const kind = known.find((key) => requested[key] !== undefined);
  if (!kind) return null;
  const spec = requested[kind] || {};
  const descriptor = { kind };
  if (kind === 'filePermission') {
    descriptor.path = spec.absolutePathUri;
    descriptor.isDirectory = !!spec.isDirectory;
    descriptor.reason = spec.blockReason;
  } else if (kind === 'permission') {
    descriptor.resource = spec.resource;
    descriptor.reason = spec.reason;
    descriptor.suggestedPersistPattern = spec.suggestedPersistPattern;
  } else if (kind === 'askQuestion') {
    descriptor.questions = spec.questions || [];
  } else if (kind === 'elicitation') {
    descriptor.serverName = spec.serverName;
    descriptor.message = spec.message;
    descriptor.mode = spec.mode;
  }
  return descriptor;
}

function browserStep(step, index) {
  const keys = [
    ['openBrowserUrl', 'open_url'],
    ['executeBrowserJavascript', 'javascript'],
    ['listBrowserPages', 'list_pages'],
    ['captureBrowserScreenshot', 'screenshot'],
    ['clickBrowserPixel', 'click_pixel'],
    ['captureBrowserConsoleLogs', 'console_logs'],
    ['readBrowserPage', 'read_page'],
    ['browserGetDom', 'dom'],
    ['browserInput', 'input'],
    ['browserMoveMouse', 'move_mouse'],
    ['browserSelectOption', 'select'],
    ['browserScrollUp', 'scroll_up'],
    ['browserScrollDown', 'scroll_down'],
    ['browserScroll', 'scroll'],
    ['browserClickElement', 'click_element'],
    ['browserListNetworkRequests', 'network_list'],
    ['browserGetNetworkRequest', 'network_request'],
    ['browserPressKey', 'press_key'],
    ['browserResizeWindow', 'resize'],
    ['browserDragPixelToPixel', 'drag'],
    ['browserMouseWheel', 'wheel'],
    ['browserMouseUp', 'mouse_up'],
    ['browserMouseDown', 'mouse_down'],
    ['browserRefreshPage', 'refresh'],
    ['browserSubagent', 'subagent'],
  ];
  for (const [field, action] of keys) {
    if (!step?.[field]) continue;
    const value = step[field] || {};
    const page = value.pageMetadata || {};
    return {
      type: 'browser.action',
      stepIndex: index,
      status: stepStatus(step),
      action,
      pageId: value.pageId || page.pageId || page.id,
      url: value.url || page.url,
      title: page.title,
      task: value.taskName || value.task,
      hasScreenshot: !!(value.screenshot || value.mediaScreenshot || value.screenshotEnd || value.screenshotWithClickFeedback),
    };
  }
  return null;
}

export function projectStep(step, stepIndex, context = {}) {
  if (!step) return [];
  const events = [];
  const base = { stepIndex, status: stepStatus(step) };

  if (step.userInput) {
    events.push({
      type: 'user.message', ...base,
      text: textItems(step.userInput),
      attachmentCount: (step.userInput.media || []).length + (step.userInput.images || []).length,
    });
  }

  if (step.plannerResponse) {
    // Deliberately omit plannerResponse.thinking and rawThinking.
    events.push({
      type: 'assistant.message', ...base,
      text: step.plannerResponse.modifiedResponse || step.plannerResponse.response || '',
      messageId: step.plannerResponse.messageId,
      streaming: String(step.status || '').includes('GENERATING'),
    });
  }

  if (step.taskBoundary) {
    events.push({
      type: 'task.update', ...base,
      name: step.taskBoundary.taskName,
      taskStatus: step.taskBoundary.taskStatus,
      summary: step.taskBoundary.taskSummary,
      mode: step.taskBoundary.mode,
    });
  }

  if (step.notifyUser) {
    events.push({
      type: 'agent.notice', ...base,
      text: step.notifyUser.notificationContent || '',
      blocking: !!step.notifyUser.isBlocking,
      autoProceed: !!step.notifyUser.shouldAutoProceed,
      reviewUris: step.notifyUser.reviewAbsoluteUris || step.notifyUser.pathsToReview || [],
    });
  }

  if (step.runCommand) {
    events.push({
      type: 'tool.command', ...base,
      command: step.runCommand.commandLine || step.runCommand.proposedCommandLine || step.runCommand.command || '',
      cwd: step.runCommand.cwd,
      commandId: step.runCommand.commandId,
      terminalId: step.runCommand.terminalId,
      exitCode: step.runCommand.exitCode,
      output: commandOutput(step.runCommand),
      rejected: !!step.runCommand.userRejected,
    });
  }

  if (step.sendCommandInput) {
    events.push({
      type: 'tool.command_input', ...base,
      commandId: step.sendCommandInput.commandId,
      terminate: !!step.sendCommandInput.terminate,
      inputLength: String(step.sendCommandInput.input || '').length,
    });
  }

  if (step.codeAction) {
    events.push({
      type: 'tool.file', ...base,
      action: 'edit',
      fileUri: actionFile(step.codeAction),
      description: step.codeAction.description,
    });
  }
  if (step.viewFile) {
    events.push({
      type: 'tool.file', ...base,
      action: 'view',
      fileUri: step.viewFile.absoluteUri || step.viewFile.filePath || step.viewFile.path,
      startLine: step.viewFile.startLine ?? step.viewFile.start_line,
      endLine: step.viewFile.endLine ?? step.viewFile.end_line,
    });
  }
  if (step.listDirectory) {
    events.push({
      type: 'tool.file', ...base,
      action: 'list',
      fileUri: step.listDirectory.path || step.listDirectory.absoluteUri || step.listDirectory.directoryPath,
    });
  }
  if (step.grepSearch) {
    events.push({
      type: 'tool.search', ...base,
      action: 'grep',
      query: step.grepSearch.query || step.grepSearch.searchPattern,
      path: step.grepSearch.searchPath || step.grepSearch.path,
    });
  }
  if (step.find) {
    events.push({
      type: 'tool.search', ...base,
      action: 'find',
      query: step.find.pattern,
      directory: step.find.searchDirectory,
    });
  }
  if (step.searchWeb) {
    events.push({
      type: 'tool.search', ...base,
      action: 'web',
      query: step.searchWeb.query,
    });
  }

  const browser = browserStep(step, stepIndex);
  if (browser) events.push(browser);

  if (step.invokeSubagent) {
    events.push({
      type: 'subagent.update', ...base,
      name: step.invokeSubagent.subagentName,
      prompt: step.invokeSubagent.prompt,
      conversationId: step.invokeSubagent.conversationId,
      taskMode: !!step.invokeSubagent.taskMode,
      subagents: (step.invokeSubagent.subagents || []).map((spec) => ({
        typeName: spec.typeName,
        role: spec.role,
        initialPrompt: spec.initialPrompt,
        model: spec.model,
        modelTier: spec.modelTier,
        runAsTask: spec.runAsTask,
        workspaceUri: spec.workspaceUri,
      })),
      results: (step.invokeSubagent.results || []).map((result) => ({
        conversationId: result.conversationId,
        logUri: result.logAbsoluteUri,
        workspaceUris: result.workspaceUris || [],
      })),
    });
  }

  if (step.askQuestion) {
    events.push({ type: 'agent.question', ...base, questions: step.askQuestion.questions || [] });
  }

  if (step.errorMessage || step.error) {
    const error = step.errorMessage?.error || step.error || step.errorMessage || {};
    events.push({
      type: 'error', ...base,
      message: error.message || error.errorMessage || 'Agent step failed',
    });
  }

  const interaction = interactionDescriptor(step.requestedInteraction || {});
  if (interaction) {
    events.push({
      type: 'approval.required', ...base,
      conversationId: context.conversationId,
      trajectoryId: context.trajectoryId,
      interaction,
    });
  }

  return events.filter((event) => {
    if (event.type === 'assistant.message' || event.type === 'user.message') return !!event.text || event.attachmentCount > 0;
    return true;
  });
}

export function projectSteps(steps, context = {}) {
  return (steps || []).flatMap((step, index) => projectStep(step, index, context));
}
