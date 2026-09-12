import type { APIRequestOptions } from './request_abort'
import { toast } from 'sonner'

import { PAGE_INSTANCE_HEADER, pageInstanceId, pageLifecycleSignal } from '~/page_lifecycle'
import { tokenAtom } from '~/store'
import { APIRequestTimeoutError, createAPIRequestAbortScope, DEFAULT_API_REQUEST_TIMEOUT_MS } from './request_abort'

export type APIQueryPrimitive = string | number | boolean
export type APIQueryValue = APIQueryPrimitive | null | undefined | APIQueryPrimitive[]

export interface APIClientInterface {
  get: <T>(path: string, query?: Record<string, APIQueryValue>, options?: APIRequestOptions) => Promise<T>
  post: <T>(
    path: string,
    body?: unknown,
    query?: Record<string, APIQueryValue>,
    options?: APIRequestOptions,
  ) => Promise<T>
  put: <T>(
    path: string,
    body?: unknown,
    query?: Record<string, APIQueryValue>,
    options?: APIRequestOptions,
  ) => Promise<T>
  patch: <T>(
    path: string,
    body?: unknown,
    query?: Record<string, APIQueryValue>,
    options?: APIRequestOptions,
  ) => Promise<T>
  delete: <T>(
    path: string,
    body?: unknown,
    query?: Record<string, APIQueryValue>,
    options?: APIRequestOptions,
  ) => Promise<T>
}

const leadingSlashesRE = /^\/+/
const trailingSlashesRE = /\/+$/
const trailingSlashRE = /\/$/
const documentSegmentRE = /\.html?$/i
const staticFileServerMethodHint = 'method should be GET or HEAD'
const apiSegment = 'api'
const apiResourceSegments = new Set([
  'auth',
  'configs',
  'dns',
  'events',
  'general',
  'groups',
  'logs',
  'nodes',
  'openapi.json',
  'profiles',
  'routings',
  'runtime',
  'subscriptions',
  'user',
])
const frontendRouteSegments = new Set(['setup'])

const httpMethod = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
} as const

export function buildAPIURL(endpointURL: string, path: string, query?: Record<string, APIQueryValue>) {
  const normalizedPath = path.replace(leadingSlashesRE, '')
  const url = new URL(normalizedPath, `${endpointURL}/`)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item))
        }
        continue
      }
      url.searchParams.set(key, String(value))
    }
  }

  return url
}

/**
 * 把「接口地址」里的路径归一化成 API 根路径。
 *
 * URL 里可能出现三类路径：真正的挂载前缀（WebUI 被反向代理挂在 /daed/ 下）、
 * API 资源段（/api/configs/1 这种贴多了的）、以及用户在输入框里多写的页面路径
 * （/settings、/index.html）。只有第一类才应该保留前缀。
 *
 * ⚠️ 这里曾经对所有「未知首段」一律拼成 `<前缀>/api`：用户把接口地址填成
 * `http://host:2023/settings` 时会被持久化成 `http://host:2023/settings/api`，
 * 之后所有请求都打到 WebUI 静态处理器（GET 被回落成 index.html，POST 被回
 * `{"error":"method should be GET or HEAD"}`），整个面板报废且无法自愈。
 * 现在用「当前文档路径」校验前缀是否真实存在，不匹配就回到 origin 根下的 /api
 * —— 顺带能治好浏览器里已经存坏的值。
 */
function currentAppPathname(): string {
  const loc =
    (typeof window !== 'undefined' && window.location) ||
    (typeof globalThis !== 'undefined' && (globalThis as { location?: Location }).location) ||
    null

  return loc?.pathname ?? '/'
}

export function canonicalizeEndpointPathname(pathname: string, appPathname: string = currentAppPathname()) {
  const trimmedPath = pathname.replace(trailingSlashesRE, '')

  if (trimmedPath === '' || trimmedPath === '/') {
    return '/api'
  }

  const segments = trimmedPath.split('/').filter(Boolean)
  const normalizedSegments = segments.map((segment) => segment.toLowerCase())
  const appSegments = (appPathname ?? '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
  const apiIndex = normalizedSegments.indexOf(apiSegment)
  const resourceIndex = normalizedSegments.findIndex(
    (segment) => apiResourceSegments.has(segment) || frontendRouteSegments.has(segment),
  )

  const keepPrefix = (prefixSegments: string[]) => {
    // 目录挂载点不会以 .html/.htm 结尾：面板本来就served在 /index.html 时，
    // 用户照着地址栏抄 `http://host:2023/index.html` 不该被当成挂载前缀。
    if (prefixSegments.some((segment) => documentSegmentRE.test(segment))) {
      return false
    }
    return prefixSegments.length === 0 || prefixSegments.every((segment, index) => appSegments[index] === segment)
  }

  if (resourceIndex >= 0 && (apiIndex === -1 || resourceIndex < apiIndex)) {
    return keepPrefix(normalizedSegments.slice(0, resourceIndex))
      ? `/${[...segments.slice(0, resourceIndex), apiSegment].join('/')}`
      : `/${apiSegment}`
  }

  if (apiIndex >= 0) {
    return keepPrefix(normalizedSegments.slice(0, apiIndex))
      ? `/${[...segments.slice(0, apiIndex), apiSegment].join('/')}`
      : `/${apiSegment}`
  }

  return keepPrefix(normalizedSegments) ? `/${[...segments, apiSegment].join('/')}` : `/${apiSegment}`
}

export function normalizeEndpointURL(raw: string, appPathname: string = currentAppPathname()): string {
  const url = new URL(raw)
  url.pathname = canonicalizeEndpointPathname(url.pathname, appPathname)
  url.search = ''
  url.hash = ''
  return url.toString().replace(trailingSlashRE, '')
}

function parseResponsePayload(text: string, contentType: string | null): unknown {
  if (!text) {
    return {}
  }
  if (contentType?.includes('application/json')) {
    return JSON.parse(text)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function staticHandlerErrorMessage(message: string): string {
  if (message.includes(staticFileServerMethodHint)) {
    return 'API request reached the WebUI static handler; check the endpoint URL and make sure it points to /api'
  }
  return message
}

function responseErrorMessage(response: Response, payload: unknown): string {
  if (typeof payload === 'object' && payload && 'error' in payload && typeof payload.error === 'string') {
    return staticHandlerErrorMessage(payload.error)
  }
  if (typeof payload === 'string' && payload.trim()) {
    return staticHandlerErrorMessage(payload.trim())
  }
  return `${response.status} ${response.statusText}`
}

export class APIResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'APIResponseError'
  }
}

function responseErrorMetadata(payload: unknown) {
  if (typeof payload !== 'object' || !payload) {
    return { errorCode: null, retryable: false }
  }
  const record = payload as Record<string, unknown>
  return {
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : null,
    retryable: record.retryable === true,
  }
}

export class APIClient implements APIClientInterface {
  constructor(
    private readonly endpointURL: string,
    private readonly token?: string,
    private readonly requestTimeoutMs = DEFAULT_API_REQUEST_TIMEOUT_MS,
  ) {}

  get<T>(path: string, query?: Record<string, APIQueryValue>, options?: APIRequestOptions) {
    return this.request<T>(httpMethod.get, path, undefined, query, options)
  }

  post<T>(path: string, body?: unknown, query?: Record<string, APIQueryValue>, options?: APIRequestOptions) {
    return this.request<T>(httpMethod.post, path, body, query, options)
  }

  put<T>(path: string, body?: unknown, query?: Record<string, APIQueryValue>, options?: APIRequestOptions) {
    return this.request<T>(httpMethod.put, path, body, query, options)
  }

  patch<T>(path: string, body?: unknown, query?: Record<string, APIQueryValue>, options?: APIRequestOptions) {
    return this.request<T>(httpMethod.patch, path, body, query, options)
  }

  delete<T>(path: string, body?: unknown, query?: Record<string, APIQueryValue>, options?: APIRequestOptions) {
    return this.request<T>(httpMethod.delete, path, body, query, options)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, APIQueryValue>,
    options?: APIRequestOptions,
  ): Promise<T> {
    const url = buildAPIURL(this.endpointURL, path, query)
    const abortScope = createAPIRequestAbortScope(
      {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? this.requestTimeoutMs,
      },
      [pageLifecycleSignal()],
    )

    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          [PAGE_INSTANCE_HEADER]: pageInstanceId(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abortScope.signal,
      })

      if (response.status === 401 && tokenAtom.get() === (this.token ?? '')) {
        tokenAtom.set('')
      }

      if (response.status === 204) {
        return undefined as T
      }

      const text = await response.text()
      const payload = parseResponsePayload(text, response.headers.get('content-type'))
      if (!response.ok) {
        const message = responseErrorMessage(response, payload)
        const metadata = responseErrorMetadata(payload)
        if (!options?.suppressErrorToast) {
          toast.error(message)
        }
        throw new APIResponseError(message, response.status, metadata.errorCode, metadata.retryable)
      }

      return payload as T
    } catch (error) {
      if (abortScope.signal.reason instanceof APIRequestTimeoutError) {
        throw abortScope.signal.reason
      }
      throw error
    } finally {
      abortScope.dispose()
    }
  }
}

export function toID(value: string | number | null | undefined): string {
  if (value == null) return ''
  return String(value)
}

export function toOptionalID(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null
  return String(value)
}

export function toNumericID(value: string): number {
  return Number.parseInt(value, 10)
}
