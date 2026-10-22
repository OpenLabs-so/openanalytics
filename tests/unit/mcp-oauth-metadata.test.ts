import { describe, expect, it } from 'vitest'
import { createMcpRoutes } from '../../apps/api/src/http/mcp.ts'

describe('MCP OAuth resource metadata', () => {
  const makeApp = () =>
    createMcpRoutes({
      dispatch: async () => new Response(),
      resourceUrl: 'https://analytics.example',
      authorizationServer: 'https://analytics.example/api/auth',
      verifyBearer: async () => null,
      siteTimezone: async () => null,
    })

  it('advertises offline access alongside the product grant scopes', async () => {
    const app = makeApp()

    const response = await app.request('/.well-known/oauth-protected-resource')
    const metadata = (await response.json()) as { scopes_supported: string[] }

    expect(metadata.scopes_supported).toContain('offline_access')
    expect(metadata.scopes_supported).toContain('analytics:read')
  })

  it('keeps the unauthenticated 401 challenge pointing at resource metadata', async () => {
    const app = makeApp()
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://analytics.example/.well-known/oauth-protected-resource"',
    )
  })
})
