/**
 * The model APIs the app can chat with directly (bring your own key), and the provider for each.
 * Two wire formats cover them: Anthropic's Messages API and OpenAI's Chat Completions, which most
 * other services, local servers and company gateways speak.
 */
import type { Provider } from '../types.ts';
import { AnthropicProvider, ANTHROPIC_MODELS, type Effort } from './anthropic.ts';
import { OpenAICompatProvider } from './openai.ts';

export type ApiServiceId = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'local' | 'openai-compatible' | 'anthropic-compatible';

export interface ApiService {
  id: ApiServiceId;
  name: string;
  format: 'anthropic' | 'openai';
  /** Default address ('' = the user gives it). */
  baseURL: string;
  /** What a key looks like ('' = none needed). */
  keyHint: string;
  /** Where to get a key. */
  keysUrl?: string;
  /** Model ids to offer before (or instead of) the API's own list. */
  models: string[];
  /** One line of advice shown with the service. */
  note?: string;
}

export const API_SERVICES: ApiService[] = [
  { id: 'anthropic', name: 'Anthropic', format: 'anthropic', baseURL: 'https://api.anthropic.com', keyHint: 'sk-ant-…', keysUrl: 'https://console.anthropic.com/', models: ANTHROPIC_MODELS.map((m) => m.id) },
  { id: 'openai', name: 'OpenAI', format: 'openai', baseURL: 'https://api.openai.com/v1', keyHint: 'sk-…', keysUrl: 'https://platform.openai.com/api-keys', models: [] },
  { id: 'openrouter', name: 'OpenRouter', format: 'openai', baseURL: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…', keysUrl: 'https://openrouter.ai/keys', models: [], note: 'Many models with one key, e.g. anthropic/…, openai/…, google/….' },
  { id: 'gemini', name: 'Google Gemini', format: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHint: 'AIza…', keysUrl: 'https://aistudio.google.com/apikey', models: [] },
  {
    id: 'local',
    name: 'Local model (Ollama, LM Studio)',
    format: 'openai',
    baseURL: 'http://localhost:11434/v1',
    keyHint: '',
    models: [],
    note: 'Ollama: start it with OLLAMA_ORIGINS set to this app’s address. LM Studio: http://localhost:1234/v1 with CORS enabled. Pick a model that supports tool calls.',
  },
  {
    id: 'openai-compatible',
    name: 'Other, OpenAI-compatible',
    format: 'openai',
    baseURL: '',
    keyHint: 'key or token',
    models: [],
    note: 'Any Chat Completions API: Azure OpenAI (https://<resource>.openai.azure.com/openai/v1), LiteLLM, vLLM, a company gateway. It must allow requests from a browser (CORS).',
  },
  {
    id: 'anthropic-compatible',
    name: 'Other, Anthropic-compatible',
    format: 'anthropic',
    baseURL: '',
    keyHint: 'key or token',
    models: ANTHROPIC_MODELS.map((m) => m.id),
    note: 'A gateway or proxy that speaks the Anthropic Messages API (the address without /v1/messages). It must allow requests from a browser (CORS).',
  },
];

export function apiService(id: string): ApiService {
  return API_SERVICES.find((s) => s.id === id) ?? API_SERVICES[0]!;
}

export interface ApiChoice {
  service: ApiServiceId;
  /** '' = the service's default address. */
  baseURL: string;
  apiKey: string;
  model: string;
  effort?: Effort;
}

/** What is still missing before the chat can use this API (null = nothing). */
export function apiProblem(c: ApiChoice): 'no key' | 'no address' | 'no model' | null {
  const s = apiService(c.service);
  if (!(c.baseURL || s.baseURL)) return 'no address';
  if (!c.apiKey && s.keyHint && s.id !== 'openai-compatible' && s.id !== 'anthropic-compatible') return 'no key';
  if (!c.model) return 'no model';
  return null;
}

export function apiProvider(c: ApiChoice): Provider {
  const s = apiService(c.service);
  const baseURL = c.baseURL || s.baseURL;
  if (s.format === 'anthropic') {
    return new AnthropicProvider({ apiKey: c.apiKey, model: c.model, ...(c.effort ? { effort: c.effort } : {}), ...(baseURL !== API_SERVICES[0]!.baseURL ? { baseURL } : {}) });
  }
  return new OpenAICompatProvider({ baseURL, apiKey: c.apiKey, model: c.model });
}
