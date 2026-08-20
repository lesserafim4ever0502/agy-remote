import { buildCascadeConfig, buildMetadata } from './metadata.js';
import { entriesLike, fileUriToPath, normalizeStatus } from './utils.js';
import { projectSteps } from './projector.js';

function normalizeSummary(id, summary = {}) {
  const workspaces = summary.workspaces || [];
  const workspace = workspaces[0]?.workspaceFolderAbsoluteUri
    || workspaces[0]?.workspaceUri
    || workspaces[0]?.workspace_uri
    || '';
  return {
    id,
    title: summary.annotations?.title || summary.summary || 'Untitled conversation',
    summary: summary.summary || '',
    stepCount: Number(summary.stepCount ?? summary.step_count ?? 0),
    status: normalizeStatus(summary.status),
    workspace,
    trajectoryId: summary.trajectoryId || summary.trajectory_id,
    createdTime: summary.createdTime || summary.created_time,
    lastModifiedTime: summary.lastModifiedTime || summary.last_modified_time,
    hasActiveChildren: !!(summary.hasActiveChildren ?? summary.has_active_children),
    killed: !!summary.killed,
  };
}

export class ConversationService {
  constructor({ transport, router, logger = console, models }) {
    this.transport = transport;
    this.router = router;
    this.logger = logger;
    this.models = models;
    this.listPromise = null;
    this.cachedList = [];
    this.listMeta = { stale: false, partial: false, failedInstances: 0, instanceCount: 0 };
  }

  async list() {
    if (this.listPromise) return this.listPromise;
    this.listPromise = this.#list();
    try {
      return await this.listPromise;
    } finally {
      this.listPromise = null;
    }
  }

  getListMeta() {
    return { ...this.listMeta };
  }

  async #list() {
    await this.router.ensure();
    const merged = new Map();
    let succeeded = 0;
    let failed = 0;
    await Promise.all(this.router.instances.map(async (instance) => {
      try {
        const response = await this.transport.unary(instance, 'GetAllCascadeTrajectories', { excludeSubtrajectories: false });
        succeeded += 1;
        const raw = response.trajectorySummaries ?? response.trajectory_summaries ?? response.summaries;
        for (const [id, summary] of entriesLike(raw)) {
          if (!id) continue;
          const normalized = normalizeSummary(id, summary);
          const existing = merged.get(id);
          if (!existing || normalized.stepCount >= existing.stepCount) merged.set(id, normalized);
          this.router.pinConversation(id, instance);
        }
      } catch (error) {
        failed += 1;
        this.logger.warn?.(`[conversations] list failed on ${instance.port}: ${error.message}`);
      }
    }));
    const conversations = [...merged.values()].sort((a, b) => String(b.lastModifiedTime || '').localeCompare(String(a.lastModifiedTime || '')));
    const instanceCount = this.router.instances.length;

    if (succeeded === 0) {
      this.router?.refresh?.().catch(() => {});
      if (this.cachedList.length) {
        this.listMeta = { stale: true, partial: true, unavailable: true, failedInstances: failed, instanceCount };
        return this.cachedList;
      }
    }

    this.listMeta = {
      stale: false,
      partial: failed > 0,
      unavailable: succeeded === 0,
      failedInstances: failed,
      instanceCount,
    };
    if (succeeded > 0) this.cachedList = conversations;
    return conversations;
  }

  async snapshot(cascadeId) {
    const instance = await this.router.forConversation(cascadeId);
    try { await this.transport.unary(instance, 'LoadTrajectory', { cascadeId }); } catch {}
    const [trajectoryResponse, stepsResponse] = await Promise.all([
      this.transport.unary(instance, 'GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI' }),
      this.transport.unary(instance, 'GetCascadeTrajectorySteps', { cascadeId, stepOffset: 0, trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI' }),
    ]);
    const trajectory = trajectoryResponse.trajectory || {};
    const steps = stepsResponse.steps || trajectory.steps || [];
    const trajectoryId = trajectory.trajectoryId || trajectory.trajectory_id;
    return {
      conversationId: cascadeId,
      trajectoryId,
      status: normalizeStatus(trajectoryResponse.status),
      totalSteps: Number(trajectoryResponse.numTotalSteps ?? trajectoryResponse.num_total_steps ?? steps.length),
      events: projectSteps(steps, { conversationId: cascadeId, trajectoryId }),
    };
  }

  async create({ workspaceUri, model, agenticMode = true, title } = {}) {
    const instance = await this.router.forWorkspace(workspaceUri);
    if (workspaceUri) {
      try {
        await this.transport.unary(instance, 'AddTrackedWorkspace', {
          workspace: fileUriToPath(workspaceUri),
          doNotWatchFiles: false,
          isPassiveWorkspace: false,
        });
      } catch (error) {
        this.logger.debug?.(`[conversations] AddTrackedWorkspace: ${error.message}`);
      }
    }
    const resolvedModel = model || (await this.models?.defaultModel?.());
    const modelEnum = (typeof resolvedModel === 'string' && resolvedModel.startsWith('MODEL_'))
      ? resolvedModel
      : undefined;
    const response = await this.transport.unary(instance, 'StartCascade', {
      metadata: buildMetadata(instance),
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
      trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
      workspaceUris: workspaceUri ? [workspaceUri] : [],
      ...(modelEnum ? { requestedModel: modelEnum } : {}),
    });
    const cascadeId = response.cascadeId || response.cascade_id;
    if (!cascadeId) throw new Error('StartCascade returned no cascadeId');
    this.router.pinConversation(cascadeId, instance);
    try {
      await this.transport.unary(instance, 'UpdateConversationAnnotations', {
        cascadeId,
        annotations: {
          lastUserViewTime: new Date().toISOString(),
          ...(title ? { title } : {}),
        },
        mergeAnnotations: true,
      });
    } catch (error) {
      this.logger.debug?.(`[conversations] annotations: ${error.message}`);
    }
    return { cascadeId, config: buildCascadeConfig({ model: resolvedModel, agenticMode }) };
  }

  async send(cascadeId, { text = '', model, agenticMode = true, items, media } = {}) {
    const instance = await this.router.forConversation(cascadeId, { write: true });
    const messageItems = Array.isArray(items) ? [...items] : [];
    if (text) messageItems.push({ text });
    if (!messageItems.length && !(media?.length)) throw new Error('Message is empty');
    const resolvedModel = model || (await this.models?.defaultModel?.());
    await this.transport.unary(instance, 'SendUserCascadeMessage', {
      metadata: buildMetadata(instance),
      cascadeId,
      items: messageItems,
      ...(media?.length ? { media } : {}),
      cascadeConfig: buildCascadeConfig({ model: resolvedModel, agenticMode }),
      messageOrigin: 'AGENT_MESSAGE_ORIGIN_IDE',
    }, { timeoutMs: 10000 });
    return { ok: true };
  }

  async approveArtifact(cascadeId, { artifactUri, approved = true, comment = '', model } = {}) {
    if (!artifactUri) throw new Error('artifactUri is required');
    const instance = await this.router.forConversation(cascadeId, { write: true });
    const approvalStatus = approved
      ? 'ARTIFACT_APPROVAL_STATUS_APPROVED'
      : 'ARTIFACT_APPROVAL_STATUS_REJECTED';
    await this.transport.unary(instance, 'SendUserCascadeMessage', {
      metadata: buildMetadata(instance),
      cascadeId,
      cascadeConfig: buildCascadeConfig({ model }),
      artifactComments: [{
        artifactUri,
        fullFile: {},
        approvalStatus,
        ...(comment ? { comment } : {}),
      }],
    });
    return { ok: true };
  }

  async stop(cascadeId) {
    const instance = await this.router.forConversation(cascadeId, { write: true });
    await this.transport.unary(instance, 'CancelCascadeInvocation', {
      cascadeId,
      killBackgroundTasks: true,
      notifyParent: true,
    });
    return { ok: true };
  }

  async revert(cascadeId, stepIndex, { model } = {}) {
    const instance = await this.router.forConversation(cascadeId, { write: true });
    return this.transport.unary(instance, 'RevertToCascadeStep', {
      metadata: buildMetadata(instance),
      cascadeId,
      stepIndex: Number(stepIndex),
      overrideConfig: buildCascadeConfig({ model }),
    });
  }

  async delete(cascadeId) {
    const instance = await this.router.forConversation(cascadeId, { write: true });
    await this.transport.unary(instance, 'DeleteCascadeTrajectory', { cascadeId });
    return { ok: true };
  }
}
