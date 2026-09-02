import React, { useEffect, useState } from 'react';
import { MdAdd, MdEdit } from 'react-icons/md';
import { IoMdCloseCircleOutline } from 'react-icons/io';
import SubPageHeader from './SubPageHeader';
import { BoxedList, Tips } from './primitives';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { type TTSProviderConfig } from '@/services/tts/providers/openaiConfigStore';
import {
  TTS_PRESETS,
  TTS_PRESET_ORDER,
  getPreset,
  type TTSPresetId,
} from '@/services/tts/providers/presets';
import { resolveApiRoot } from '@/services/tts/providers/openai';
import { useTTSProviderStore } from '@/store/useTTSProviderStore';

interface CustomTTSProvidersProps {
  onBack: () => void;
}

const isValidBaseUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const PRESET_OPTIONS = TTS_PRESET_ORDER.map((id) => ({
  id,
  label: TTS_PRESETS[id]!.label,
}));

/** Derive a display name from a base URL host (e.g. api.openai.com → OpenAI). */
const defaultNameFromUrl = (url: string): string => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    // Prefer the registrable-ish label (second-to-last for *.com) but keep
    // it short; fall back to the raw host.
    const label = parts.length >= 2 ? parts[parts.length - 2]! : parts[0];
    return label ? label[0]!.toUpperCase() + label.slice(1) : host;
  } catch {
    return '';
  }
};

// Probe the configured endpoint the same way the provider engine does:
// resolves the API root per the preset's URL style, filters the models list by
// output modality when the preset requires it, and (for OpenRouter-style
// presets) captures the selected model's supported voices. Presets that have
// no model list to probe (Sarvam, Azure) just validate the key/base URL.
const testConnection = async (
  config: Pick<TTSProviderConfig, 'baseUrl' | 'apiKey' | 'preset' | 'model'>,
): Promise<{ ok: boolean; message: string; models: string[]; voices: string[] }> => {
  const preset = getPreset(config.preset);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Timeout')), 8000);
  try {
    if (preset.modelsDisabled) {
      // No /models endpoint to probe (Azure OpenAI, Sarvam). Validate shape.
      if (!isValidBaseUrl(config.baseUrl)) {
        return { ok: false, message: 'Invalid base URL', models: [], voices: [] };
      }
      return {
        ok: true,
        message: 'OK - configuration looks valid (no model list to probe).',
        models: [],
        voices: [],
      };
    }
    const apiRoot = resolveApiRoot(config.baseUrl, preset.urlStyle);
    const modelsUrl =
      preset.modelsFilter === 'speech'
        ? `${apiRoot}/models?output_modalities=speech`
        : `${apiRoot}/models`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
    const response = await fetch(modelsUrl, { headers, signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        message: `HTTP ${response.status} ${response.statusText}`,
        models: [],
        voices: [],
      };
    }
    const data = (await response.json()) as {
      data?: { id: string; supported_voices?: string[] | null }[];
    };
    const models = data.data?.map((m) => m.id) ?? [];
    // For supported-voices presets (OpenRouter), find the configured model's
    // own voice set so the UI can show whether the model has enumerable
    // voices.
    let voices: string[] = [];
    const selected = config.model || models[0];
    if (preset.voiceSource === 'supported-voices' && selected) {
      const model = data.data?.find((m) => m.id === selected);
      if (Array.isArray(model?.supported_voices)) {
        voices = model!.supported_voices!;
      }
    }
    return {
      ok: true,
      message: models.length > 0 ? `OK (${models.length} TTS models)` : 'OK',
      models,
      voices,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      models: [],
      voices: [],
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

interface ProviderModalState {
  editingId: string | null;
  preset: TTSPresetId;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  // Optional explicit voice/speaker (needed for voice-cloning models with no
  // enumerable voice list, and pre-selected for static-speaker presets).
  voice: string;
  // Sarvam requires an explicit BCP-47 language on every request.
  languageCode: string;
  testing: boolean;
  testResult: string | null;
  // Model options from the last successful connection test (OpenAI engine).
  models: string[];
  // Voices the last test found for the configured model (OpenRouter).
  voices: string[];
}

const emptyModal = (preset: TTSPresetId = 'custom'): ProviderModalState => {
  const p = getPreset(preset);
  return {
    editingId: null,
    preset,
    name: p.defaultName ?? '',
    baseUrl: p.defaultBaseUrl,
    apiKey: '',
    model: p.defaultModel ?? '',
    voice: '',
    languageCode: 'hi-IN',
    testing: false,
    testResult: null,
    models: [],
    voices: [],
  };
};

const CustomTTSProviders: React.FC<CustomTTSProvidersProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { getAvailableProviders, addProvider, updateProvider, removeProvider, loadTTSProviders } =
    useTTSProviderStore();
  const [providers, setProviders] = useState<TTSProviderConfig[]>([]);
  const [modal, setModal] = useState<ProviderModalState | null>(null);

  const refresh = () => setProviders(getAvailableProviders());

  useEffect(() => {
    void loadTTSProviders(envConfig);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => setModal(emptyModal());
  const openEdit = (provider: TTSProviderConfig) => {
    const preset = getPreset(provider.preset);
    setModal({
      editingId: provider.id,
      preset: preset.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey ?? '',
      model: provider.model ?? '',
      voice: provider.voice ?? '',
      languageCode: provider.languageCode ?? 'hi-IN',
      testing: false,
      testResult: null,
      models: [],
      voices: [],
    });
  };
  const closeModal = () => setModal(null);

  // Choosing a different preset pre-fills the defaults. Switching away from a
  // non-custom preset keeps the previously typed URL/name only if the user
  // actually edited them; for a fresh add it re-applies the preset defaults.
  const handlePresetChange = (preset: TTSPresetId) => {
    if (!modal) return;
    const next = emptyModal(preset);
    // Preserve any already-entered values when switching preset mid-edit.
    setModal({
      ...next,
      editingId: modal.editingId,
      name: modal.name || next.name,
      baseUrl: modal.baseUrl || next.baseUrl,
      apiKey: modal.apiKey,
      model: modal.model || next.model,
    });
  };

  const handleTest = async () => {
    if (!modal) return;
    const preset = getPreset(modal.preset);
    // Sarvam has no models/voices list to probe — synthesis is the only test,
    // and we don't spend a sentence on it. Show guidance instead.
    if (preset.engine === 'sarvam') {
      setModal((m) =>
        m
          ? {
              ...m,
              testResult: _(
                'OK - Sarvam has no model list to probe; save and pick a voice to test.',
              ),
            }
          : m,
      );
      return;
    }
    setModal((m) => (m ? { ...m, testing: true, testResult: null } : m));
    const result = await testConnection({
      baseUrl: modal.baseUrl,
      apiKey: modal.apiKey,
      preset: modal.preset,
      model: modal.model,
    });
    setModal((m) =>
      m
        ? {
            ...m,
            testing: false,
            testResult: result.message,
            models: result.models,
            voices: result.voices,
          }
        : m,
    );
  };

  const handleSave = () => {
    if (!modal) return;
    const preset = getPreset(modal.preset);
    const name = modal.name.trim();
    const baseUrl = modal.baseUrl.trim();
    if (!name || !isValidBaseUrl(baseUrl)) {
      eventDispatcher.dispatch('toast', {
        type: 'warning',
        message: _('Enter a name and a valid http(s):// base URL.'),
        timeout: 4000,
      });
      return;
    }
    if (preset.requiresKey && !modal.apiKey.trim()) {
      eventDispatcher.dispatch('toast', {
        type: 'warning',
        message: _('This provider requires an API key.'),
        timeout: 4000,
      });
      return;
    }
    const payload: Partial<TTSProviderConfig> = {
      name,
      baseUrl,
      preset: modal.preset === 'custom' ? undefined : modal.preset,
      apiKey: modal.apiKey.trim() || undefined,
      model: modal.model.trim() || undefined,
      voice: modal.voice.trim() || undefined,
      languageCode:
        preset.engine === 'sarvam' && modal.languageCode.trim()
          ? modal.languageCode.trim()
          : undefined,
    };
    if (modal.editingId) {
      updateProvider(modal.editingId, payload);
    } else {
      addProvider(payload as Omit<TTSProviderConfig, 'id' | 'contentId'>);
    }
    refresh();
    closeModal();
    eventDispatcher.dispatch('toast', {
      type: 'info',
      message: _('TTS provider saved. It appears in the reader voice picker.'),
      timeout: 3000,
    });
  };

  const handleRemove = (id: string) => {
    removeProvider(id);
    refresh();
  };

  return (
    <div className='w-full'>
      <SubPageHeader
        parentLabel={_('TTS')}
        currentLabel={_('Custom Providers')}
        onBack={onBack}
        rightSlot={
          <button
            type='button'
            onClick={openAdd}
            className='btn btn-ghost btn-sm text-base-content gap-2 px-3'
            title={_('Add Provider')}
          >
            <MdAdd className='h-5 w-5 min-[800px]:h-4 min-[800px]:w-4' />
            <span className='hidden min-[800px]:inline'>{_('Add')}</span>
          </button>
        }
      />

      <BoxedList
        title={_('Custom Providers')}
        description={_(
          'Pick a preset (OpenAI, OpenRouter, Azure, Kokoro, Sarvam) or enter any custom endpoint. Presets pre-fill the wire format, auth, model and voice handling.',
        )}
      >
        <div className='divide-base-200 divide-y'>
          {providers.length === 0 && (
            <div className='text-base-content/60 px-4 py-6 text-center text-sm'>
              {_('No custom TTS providers configured yet.')}
            </div>
          )}
          {providers.map((provider) => {
            const preset = getPreset(provider.preset);
            return (
              <div
                key={provider.id}
                className='flex items-center gap-2 px-3 py-2 transition-colors hover:bg-base-200/40'
              >
                <div className='min-w-0 flex-1'>
                  <div className='truncate font-medium'>
                    {provider.name}
                    {provider.preset &&
                      provider.preset !== 'custom' &&
                      preset.id === provider.preset && (
                        <span className='text-base-content/60 ms-2 text-xs font-normal'>
                          {_(preset.label)}
                        </span>
                      )}
                  </div>
                  <div className='text-base-content/60 line-clamp-1 text-xs'>
                    {provider.baseUrl}
                    {provider.model ? ` · ${provider.model}` : ''}
                  </div>
                </div>
                <button
                  type='button'
                  onClick={() => openEdit(provider)}
                  className='btn btn-ghost btn-sm shrink-0 px-1'
                  aria-label={_('Edit')}
                  title={_('Edit')}
                >
                  <MdEdit className='text-base-content/75 h-4 w-4' />
                </button>
                <button
                  type='button'
                  onClick={() => handleRemove(provider.id)}
                  className='btn btn-ghost btn-sm shrink-0 px-1'
                  aria-label={_('Delete')}
                  title={_('Delete')}
                >
                  <IoMdCloseCircleOutline className='text-base-content/75 h-5 w-5' />
                </button>
              </div>
            );
          })}
        </div>
      </BoxedList>

      <Tips className='mt-4'>
        <li>{_('API keys are stored locally on this device and are never uploaded.')}</li>
        <li>
          {_(
            'OpenAI-compatible engines (OpenAI, OpenRouter, Azure, Kokoro) have no word-level timings; highlighting falls back to sentence level.',
          )}
        </li>
        <li>
          {_(
            'Sarvam AI uses its own REST API (base64 audio, Indic languages) — no OpenAI SDK needed.',
          )}
        </li>
      </Tips>

      {modal && (
        <div className='modal modal-open' role='dialog'>
          <div className='modal-box w-11/12 max-w-md'>
            <h3 className='text-base font-semibold'>
              {modal.editingId ? _('Edit Provider') : _('Add Provider')}
            </h3>
            <div className='mt-4 space-y-3'>
              {(() => {
                const preset = getPreset(modal.preset);
                const isOpenAIEngine = preset.engine === 'openai';
                const isSarvam = preset.engine === 'sarvam';
                // Whether this preset has a /models list the Test button can probe.
                const canProbeModels = isOpenAIEngine && !preset.modelsDisabled;
                const authLabel = preset.id === 'sarvam' ? _('Subscription Key') : _('API Key');
                const authPlaceholder = preset.requiresKey
                  ? isSarvam
                    ? _('Sarvam subscription key')
                    : _('Required')
                  : _('Optional for local servers');
                return (
                  <>
                    {/* Preset dropdown */}
                    <label className='form-control w-full'>
                      <span className='label-text text-sm'>{_('Provider Preset')}</span>
                      <select
                        className='select select-bordered select-sm w-full'
                        value={modal.preset}
                        onChange={(e) => handlePresetChange(e.target.value as TTSPresetId)}
                      >
                        {PRESET_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {_(opt.label)}
                          </option>
                        ))}
                      </select>
                      {preset.description && (
                        <span className='label-text-alt text-base-content/60 mt-1 text-xs'>
                          {_(preset.description)}
                        </span>
                      )}
                    </label>

                    <label className='form-control w-full'>
                      <span className='label-text text-sm'>{_('Display Name')}</span>
                      <input
                        type='text'
                        className='input input-bordered input-sm w-full'
                        value={modal.name}
                        placeholder={
                          preset.defaultName
                            ? String(preset.defaultName)
                            : defaultNameFromUrl(modal.baseUrl) || _('e.g. My TTS')
                        }
                        onChange={(e) => setModal((m) => (m ? { ...m, name: e.target.value } : m))}
                      />
                    </label>

                    <label className='form-control w-full'>
                      <span className='label-text text-sm'>{_('Base URL')}</span>
                      <input
                        type='url'
                        className='input input-bordered input-sm w-full'
                        value={modal.baseUrl}
                        placeholder={
                          preset.defaultBaseUrl
                            ? String(preset.defaultBaseUrl)
                            : 'http://localhost:8880'
                        }
                        onChange={(e) =>
                          setModal((m) => (m ? { ...m, baseUrl: e.target.value } : m))
                        }
                      />
                      <span className='label-text-alt text-base-content/60 mt-1 text-xs'>
                        {preset.requiresKey && preset.getKeyUrl ? (
                          <a
                            href={preset.getKeyUrl}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='link'
                          >
                            {_('Get API key')}
                          </a>
                        ) : (
                          _('Free / local endpoint — no key needed.')
                        )}
                      </span>
                    </label>

                    <label className='form-control w-full'>
                      <span className='label-text text-sm'>{authLabel}</span>
                      <input
                        type='password'
                        className='input input-bordered input-sm w-full'
                        value={modal.apiKey}
                        placeholder={String(authPlaceholder)}
                        onChange={(e) =>
                          setModal((m) => (m ? { ...m, apiKey: e.target.value } : m))
                        }
                      />
                    </label>

                    {/* Model field differs per engine */}
                    {isSarvam ? (
                      <>
                        <label className='form-control w-full'>
                          <span className='label-text text-sm'>{_('Model')}</span>
                          <select
                            className='select select-bordered select-sm w-full'
                            value={modal.model}
                            onChange={(e) =>
                              setModal((m) => (m ? { ...m, model: e.target.value } : m))
                            }
                          >
                            <option value='bulbul:v3'>bulbul:v3</option>
                            <option value='bulbul:v2'>bulbul:v2</option>
                          </select>
                        </label>
                        <label className='form-control w-full'>
                          <span className='label-text text-sm'>{_('Language Code')}</span>
                          <select
                            className='select select-bordered select-sm w-full'
                            value={modal.languageCode}
                            onChange={(e) =>
                              setModal((m) => (m ? { ...m, languageCode: e.target.value } : m))
                            }
                          >
                            {[
                              'hi-IN',
                              'en-IN',
                              'bn-IN',
                              'gu-IN',
                              'kn-IN',
                              'ml-IN',
                              'mr-IN',
                              'od-IN',
                              'pa-IN',
                              'ta-IN',
                              'te-IN',
                            ].map((code) => (
                              <option key={code} value={code}>
                                {code}
                              </option>
                            ))}
                          </select>
                          <span className='label-text-alt text-base-content/60 mt-1 text-xs'>
                            {_(
                              'Sarvam requires an explicit language. The reader language is matched to the nearest supported Indic code.',
                            )}
                          </span>
                        </label>
                      </>
                    ) : (
                      <label className='form-control w-full'>
                        <span className='label-text text-sm'>{_('Model')}</span>
                        {modal.models.length > 0 ? (
                          <select
                            className='select select-bordered select-sm w-full'
                            value={modal.model}
                            onChange={(e) =>
                              setModal((m) => (m ? { ...m, model: e.target.value } : m))
                            }
                          >
                            <option value=''>{_('Default')}</option>
                            {modal.models.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type='text'
                            className='input input-bordered input-sm w-full'
                            value={modal.model}
                            placeholder={
                              preset.defaultModel
                                ? String(preset.defaultModel)
                                : _('Optional, e.g. kokoro')
                            }
                            onChange={(e) =>
                              setModal((m) => (m ? { ...m, model: e.target.value } : m))
                            }
                          />
                        )}
                        {modal.models.length === 0 &&
                          (canProbeModels ? (
                            <span className='label-text-alt text-base-content/60 mt-1 text-xs'>
                              {_('Run Test Connection to load the model list.')}
                            </span>
                          ) : preset.id === 'azure' ? (
                            <span className='label-text-alt text-base-content/60 mt-1 text-xs'>
                              {_(
                                'Enter your Azure deployment name here (e.g. tts-1, tts-1-hd, gpt-4o-mini-tts).',
                              )}
                            </span>
                          ) : null)}
                      </label>
                    )}

                    {/* Explicit voice for models with no enumerable voice list
                        (e.g. OpenRouter voice-cloning models) or for custom
                        endpoints that need an explicit voice id. */}
                    {isOpenAIEngine &&
                      modal.voices.length === 0 &&
                      preset.voiceSource === 'supported-voices' && (
                        <label className='form-control w-full'>
                          <span className='label-text text-sm'>{_('Voice ID')}</span>
                          <input
                            type='text'
                            className='input input-bordered input-sm w-full'
                            value={modal.voice}
                            placeholder={_('Optional — e.g. alloy, or a cloning voice')}
                            onChange={(e) =>
                              setModal((m) => (m ? { ...m, voice: e.target.value } : m))
                            }
                          />
                          <span className='label-text-alt text-base-content/60 mt-1 text-xs'>
                            {_(
                              'This model may not expose a voice list (voice cloning); enter a voice id manually if synthesis needs one.',
                            )}
                          </span>
                        </label>
                      )}

                    <div className='flex items-center gap-2'>
                      <button
                        type='button'
                        onClick={handleTest}
                        disabled={
                          modal.testing || !isValidBaseUrl(modal.baseUrl.trim()) || isSarvam
                        }
                        className='btn btn-ghost btn-sm eink-bordered'
                      >
                        {modal.testing ? _('Testing…') : _('Test Connection')}
                      </button>
                      {modal.testResult !== null && (
                        <span
                          className={
                            modal.testResult.startsWith('OK')
                              ? 'text-success text-xs'
                              : 'text-error text-xs'
                          }
                        >
                          {modal.testResult}
                        </span>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
            <div className='modal-action'>
              <button type='button' onClick={closeModal} className='btn btn-ghost btn-sm'>
                {_('Cancel')}
              </button>
              <button type='button' onClick={handleSave} className='btn btn-primary btn-sm'>
                {_('Save')}
              </button>
            </div>
          </div>
          <button
            type='button'
            aria-label={_('Close')}
            className='modal-backdrop'
            onClick={closeModal}
          />
        </div>
      )}
    </div>
  );
};

export default CustomTTSProviders;
