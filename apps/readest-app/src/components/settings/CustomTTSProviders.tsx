import React, { useEffect, useState } from 'react';
import { MdAdd, MdEdit } from 'react-icons/md';
import { IoMdCloseCircleOutline } from 'react-icons/io';
import SubPageHeader from './SubPageHeader';
import { BoxedList, Tips } from './primitives';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { type OpenAITTSProviderConfig } from '@/services/tts/providers/openaiConfigStore';
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

// Probe `GET {baseUrl}/v1/models` the same way OpenAISpeechProvider.init does,
// so the Test button reports what the provider will actually see and populates
// the model dropdown.
const testConnection = async (
  config: Pick<OpenAITTSProviderConfig, 'baseUrl' | 'apiKey'>,
): Promise<{ ok: boolean; message: string; models: string[] }> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Timeout')), 5000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: {
        Accept: 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status} ${response.statusText}`, models: [] };
    }
    const data = (await response.json()) as { data?: { id: string }[] };
    const models = data.data?.map((m) => m.id) ?? [];
    return {
      ok: true,
      message: models.length > 0 ? `OK (${models.length} models)` : 'OK',
      models,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      models: [],
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

interface ProviderModalState {
  editingId: string | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  testing: boolean;
  testResult: string | null;
  // Model options from the last successful connection test.
  models: string[];
}

const emptyModal = (): ProviderModalState => ({
  editingId: null,
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  testing: false,
  testResult: null,
  models: [],
});

const CustomTTSProviders: React.FC<CustomTTSProvidersProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { getAvailableProviders, addProvider, updateProvider, removeProvider, loadTTSProviders } =
    useTTSProviderStore();
  const [providers, setProviders] = useState<OpenAITTSProviderConfig[]>([]);
  const [modal, setModal] = useState<ProviderModalState | null>(null);

  const refresh = () => setProviders(getAvailableProviders());

  useEffect(() => {
    void loadTTSProviders(envConfig);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => setModal(emptyModal());
  const openEdit = (provider: OpenAITTSProviderConfig) =>
    setModal({
      editingId: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey ?? '',
      model: provider.model ?? '',
      testing: false,
      testResult: null,
      models: [],
    });
  const closeModal = () => setModal(null);

  const handleTest = async () => {
    if (!modal) return;
    setModal({ ...modal, testing: true, testResult: null });
    const result = await testConnection({ baseUrl: modal.baseUrl, apiKey: modal.apiKey });
    setModal({
      ...modal,
      testing: false,
      testResult: result.message,
      models: result.models,
    });
  };

  const handleSave = () => {
    if (!modal) return;
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
    const payload = {
      name,
      baseUrl,
      apiKey: modal.apiKey.trim(),
      model: modal.model.trim() || undefined,
    };
    if (modal.editingId) {
      updateProvider(modal.editingId, payload);
    } else {
      addProvider(payload);
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
        title={_('OpenAI-Compatible Providers')}
        description={_(
          'Any endpoint speaking the OpenAI TTS wire format: GET /v1/models, GET /v1/audio/voices, POST /v1/audio/speech.',
        )}
      >
        <div className='divide-base-200 divide-y'>
          {providers.length === 0 && (
            <div className='text-base-content/60 px-4 py-6 text-center text-sm'>
              {_('No custom TTS providers configured yet.')}
            </div>
          )}
          {providers.map((provider) => (
            <div
              key={provider.id}
              className='flex items-center gap-2 px-3 py-2 transition-colors hover:bg-base-200/40'
            >
              <div className='min-w-0 flex-1'>
                <div className='truncate font-medium'>{provider.name}</div>
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
          ))}
        </div>
      </BoxedList>

      <Tips className='mt-4'>
        <li>{_('API keys are stored locally on this device and are never uploaded.')}</li>
        <li>
          {_(
            'Works with OpenAI, OpenRouter, Kokoro-FastAPI, and any /v1/audio/speech-compatible service.',
          )}
        </li>
        <li>
          {_(
            'OpenAI-compatible engines have no word-level timings; highlighting falls back to sentence level.',
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
              <label className='form-control w-full'>
                <span className='label-text text-sm'>{_('Display Name')}</span>
                <input
                  type='text'
                  className='input input-bordered input-sm w-full'
                  value={modal.name}
                  placeholder={_('e.g. Kokoro Local')}
                  onChange={(e) => setModal((m) => (m ? { ...m, name: e.target.value } : m))}
                />
              </label>
              <label className='form-control w-full'>
                <span className='label-text text-sm'>{_('Base URL')}</span>
                <input
                  type='url'
                  className='input input-bordered input-sm w-full'
                  value={modal.baseUrl}
                  placeholder='http://localhost:8880'
                  onChange={(e) => setModal((m) => (m ? { ...m, baseUrl: e.target.value } : m))}
                />
              </label>
              <label className='form-control w-full'>
                <span className='label-text text-sm'>{_('API Key')}</span>
                <input
                  type='password'
                  className='input input-bordered input-sm w-full'
                  value={modal.apiKey}
                  placeholder={_('Optional for local servers')}
                  onChange={(e) => setModal((m) => (m ? { ...m, apiKey: e.target.value } : m))}
                />
              </label>
              <label className='form-control w-full'>
                <span className='label-text text-sm'>{_('Model')}</span>
                {modal.models.length > 0 ? (
                  <select
                    className='select select-bordered select-sm w-full'
                    value={modal.model}
                    onChange={(e) => setModal((m) => (m ? { ...m, model: e.target.value } : m))}
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
                    placeholder={_('Optional, e.g. kokoro')}
                    onChange={(e) => setModal((m) => (m ? { ...m, model: e.target.value } : m))}
                  />
                )}
                {modal.models.length === 0 && (
                  <span className='label-text-alt text-base-content/60 mt-1 text-xs'>
                    {_('Run Test Connection to load the model list.')}
                  </span>
                )}
              </label>

              <div className='flex items-center gap-2'>
                <button
                  type='button'
                  onClick={handleTest}
                  disabled={modal.testing || !isValidBaseUrl(modal.baseUrl.trim())}
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
