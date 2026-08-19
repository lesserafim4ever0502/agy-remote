import { entriesLike } from './utils.js';

export class ModelService {
  constructor({ transport, router }) {
    this.transport = transport;
    this.router = router;
  }

  async raw() {
    await this.router.ensure();
    return this.transport.unary(this.router.instances[0], 'GetCascadeModelConfigData', {});
  }

  async list() {
    const response = await this.raw();
    const configs = response.clientModelConfigs || response.client_model_configs || [];
    return configs.map((config) => ({
      label: config.label || config.tagTitle || config.tag_title || 'Model',
      model: config.modelOrAlias?.model || config.model_or_alias?.model || config.model || '',
      recommended: !!(config.isRecommended ?? config.is_recommended),
      tagTitle: config.tagTitle || config.tag_title,
      quota: normalizeQuota(config.quotaInfo || config.quota_info),
    }));
  }

  async defaultModel() {
    if (process.env.AGY_DEFAULT_MODEL) return process.env.AGY_DEFAULT_MODEL;
    if (this.cachedDefaultModel) return this.cachedDefaultModel;
    try {
      const response = await this.raw();
      const override = response.defaultOverrideModelConfig?.modelOrAlias?.model
        || response.default_override_model_config?.model_or_alias?.model;
      if (override) {
        this.cachedDefaultModel = override;
        return override;
      }
      const configs = response.clientModelConfigs || response.client_model_configs || [];
      const recommended = configs.find((c) => c.isRecommended ?? c.is_recommended);
      const model = recommended?.modelOrAlias?.model || recommended?.model || configs[0]?.modelOrAlias?.model || configs[0]?.model;
      if (model) {
        this.cachedDefaultModel = model;
        return model;
      }
    } catch {
      // Fallback
    }
    return 'MODEL_PLACEHOLDER_M71';
  }

  async quota() {
    const models = await this.list();
    return models.filter((model) => model.quota).map((model) => ({
      label: model.label,
      model: model.model,
      ...model.quota,
    }));
  }
}

function normalizeQuota(quota) {
  if (!quota) return null;
  const remainingFraction = quota.remainingFraction ?? quota.remaining_fraction;
  const resetTime = quota.resetTime ?? quota.reset_time;
  const out = {};
  if (remainingFraction !== undefined) out.remainingFraction = Number(remainingFraction);
  if (resetTime !== undefined) out.resetTime = resetTime;
  for (const [key, value] of entriesLike(quota)) {
    if (!(key in out) && typeof value !== 'object') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}
