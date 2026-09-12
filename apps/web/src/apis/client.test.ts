import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('normalizeEndpointURL', () => {
  it('keeps an /api endpoint rooted at /api', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const { normalizeEndpointURL } = await import('./client')

    expect(normalizeEndpointURL('http://127.0.0.1:2023/api')).toBe('http://127.0.0.1:2023/api')
  })

  it('appends /api to a mount prefix that matches the current document path', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const { normalizeEndpointURL } = await import('./client')

    expect(normalizeEndpointURL('http://127.0.0.1:2023/custom', '/custom/')).toBe('http://127.0.0.1:2023/custom/api')
  })

  it('falls back to the root /api when the typed path is not the current mount prefix', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const { normalizeEndpointURL } = await import('./client')

    // 用户在「接口地址」里多写了一段页面路径（/settings、/index.html）：
    // 曾经会被拼成 <origin>/settings/api，所有请求都打到 WebUI 静态处理器，
    // 非 GET 请求被回 {"error":"method should be GET or HEAD"}，面板报废。
    expect(normalizeEndpointURL('http://127.0.0.1:2023/settings')).toBe('http://127.0.0.1:2023/api')
    expect(normalizeEndpointURL('http://127.0.0.1:2023/index.html')).toBe('http://127.0.0.1:2023/api')
    // 已经存坏的值也能自愈
    expect(normalizeEndpointURL('http://127.0.0.1:2023/settings/api')).toBe('http://127.0.0.1:2023/api')
  })

  it('never treats a document path as a mount prefix', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const { normalizeEndpointURL } = await import('./client')

    // 面板自身 served 在 /index.html 时，照着地址栏抄的地址同样不该被当成挂载前缀
    expect(normalizeEndpointURL('http://127.0.0.1:2023/index.html', '/index.html')).toBe('http://127.0.0.1:2023/api')
    expect(normalizeEndpointURL('http://127.0.0.1:2023/index.htm', '/index.htm')).toBe('http://127.0.0.1:2023/api')
  })

  it('keeps a real mount prefix when the document is served under it', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const { normalizeEndpointURL } = await import('./client')

    expect(normalizeEndpointURL('http://127.0.0.1:2023/panel', '/panel/')).toBe('http://127.0.0.1:2023/panel/api')
    expect(normalizeEndpointURL('http://127.0.0.1:2023/panel/configs/1', '/panel/')).toBe(
      'http://127.0.0.1:2023/panel/api',
    )
    expect(normalizeEndpointURL('http://127.0.0.1:2023/panel/api/configs/1', '/panel/')).toBe(
      'http://127.0.0.1:2023/panel/api',
    )
  })

  it('trims API resource paths to the API root', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const { normalizeEndpointURL } = await import('./client')

    expect(normalizeEndpointURL('http://127.0.0.1:2023/api/configs/1')).toBe('http://127.0.0.1:2023/api')
    expect(normalizeEndpointURL('http://127.0.0.1:2023/configs/1')).toBe('http://127.0.0.1:2023/api')
    expect(normalizeEndpointURL('http://127.0.0.1:2023/configs/api')).toBe('http://127.0.0.1:2023/api')
    expect(normalizeEndpointURL('http://127.0.0.1:2023/panel/api/configs/1', '/panel/')).toBe(
      'http://127.0.0.1:2023/panel/api',
    )
    expect(normalizeEndpointURL('http://127.0.0.1:2023/panel/configs/api', '/panel/')).toBe(
      'http://127.0.0.1:2023/panel/api',
    )
  })
})

describe('aPI client', () => {
  it('preserves typed retryable HTTP errors for caller-owned recovery', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: 'request header read timeout',
            errorCode: 'request_header_timeout',
            retryable: true,
          }),
          {
            status: 408,
            headers: { 'content-type': 'application/json' },
          },
        )
      }),
    )

    const { APIClient, APIResponseError } = await import('./client')
    const client = new APIClient('http://127.0.0.1:2023/api')
    const error = await client
      .post('/nodes/latencies', {}, undefined, { suppressErrorToast: true })
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(APIResponseError)
    expect(error).toMatchObject({
      status: 408,
      errorCode: 'request_header_timeout',
      retryable: true,
    })
  })

  it('forwards a caller abort signal to fetch', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { APIClient } = await import('./client')
    const caller = new AbortController()
    const client = new APIClient('http://127.0.0.1:2023/api')
    const request = client.get('/general', undefined, { signal: caller.signal })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    caller.abort(new Error('navigation cancelled'))
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await expect(request).rejects.toThrow('navigation cancelled')
  })

  it('resolves leading-slash paths under the /api base path', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return new Response(JSON.stringify({ ok: true, url: String(input) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { APIClient } = await import('./client')
    const client = new APIClient('http://127.0.0.1:2023/api')
    await client.get('/auth/status')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:2023/api/auth/status')
  })

  it('builds event API URLs with query parameters', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    const { buildAPIURL } = await import('./client')

    const url = buildAPIURL('http://127.0.0.1:2023/api', '/events/runtime', {
      windowSec: 600,
      maxPoints: 240,
    })

    expect(url.toString()).toBe('http://127.0.0.1:2023/api/events/runtime?windowSec=600&maxPoints=240')
  })

  it('reports static WebUI handler responses as endpoint errors', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('Method Not Allowed\n\nmethod should be GET or HEAD\n', {
          status: 405,
          statusText: 'Method Not Allowed',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }),
    )

    const { APIClient } = await import('./client')
    const client = new APIClient('http://127.0.0.1:2023/configs')

    await expect(client.put('/1', {})).rejects.toThrow(
      'API request reached the WebUI static handler; check the endpoint URL and make sure it points to /api',
    )
  })

  it('keeps a newer token when a stale authenticated request receives 401', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'authentication required' }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const { tokenAtom } = await import('~/store')
    const { APIClient } = await import('./client')

    tokenAtom.set('new-token')
    const staleClient = new APIClient('http://127.0.0.1:2023/api', 'old-token')
    await expect(staleClient.get('/general')).rejects.toThrow('authentication required')

    expect(tokenAtom.get()).toBe('new-token')
  })

  it('keeps a newer token when a stale unauthenticated request receives 401', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'authentication required' }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const { tokenAtom } = await import('~/store')
    const { APIClient } = await import('./client')

    tokenAtom.set('new-token')
    const staleClient = new APIClient('http://127.0.0.1:2023/api')
    await expect(staleClient.get('/general')).rejects.toThrow('authentication required')

    expect(tokenAtom.get()).toBe('new-token')
  })

  it('clears the current token when the active authenticated request receives 401', async () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'authentication required' }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const { tokenAtom } = await import('~/store')
    const { APIClient } = await import('./client')

    tokenAtom.set('current-token')
    const client = new APIClient('http://127.0.0.1:2023/api', 'current-token')
    await expect(client.get('/general')).rejects.toThrow('authentication required')

    expect(tokenAtom.get()).toBe('')
  })
})

describe('static handler error hint', () => {
  const hint = 'API request reached the WebUI static handler; check the endpoint URL and make sure it points to /api'

  const stubRejectedPost = (body: string, contentType: string | null) => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: '127.0.0.1',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(body, {
          status: 405,
          statusText: 'Method Not Allowed',
          headers: contentType ? { 'content-type': contentType } : {},
        })
      }),
    )
  }

  // daed 的静态文件处理器对非 GET/HEAD 请求回 {"error":"method should be GET or HEAD"}，
  // 上游只对「纯文本」响应做了翻译，JSON 对象分支直接把原文抛给用户，所以面板显示的是那句后端黑话。
  it('rewrites the daed static handler error carried in a JSON body', async () => {
    stubRejectedPost(JSON.stringify({ error: 'method should be GET or HEAD' }), 'application/json')
    const { APIClient } = await import('./client')

    const client = new APIClient('http://127.0.0.1:2023/api')
    await expect(client.post('/auth/login', {}, undefined, { suppressErrorToast: true })).rejects.toThrow(hint)
  })

  it('rewrites the same text when the body is not JSON', async () => {
    stubRejectedPost('method should be GET or HEAD', null)
    const { APIClient } = await import('./client')

    const client = new APIClient('http://127.0.0.1:2023/api')
    await expect(client.post('/auth/login', {}, undefined, { suppressErrorToast: true })).rejects.toThrow(hint)
  })

  it('leaves unrelated API errors untouched', async () => {
    stubRejectedPost(JSON.stringify({ error: 'incorrect username or password' }), 'application/json')
    const { APIClient } = await import('./client')

    const client = new APIClient('http://127.0.0.1:2023/api')
    await expect(client.post('/auth/login', {}, undefined, { suppressErrorToast: true })).rejects.toThrow(
      'incorrect username or password',
    )
  })
})
