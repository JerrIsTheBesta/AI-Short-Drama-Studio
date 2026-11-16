export function normalizeRouterBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入完整的 Base URL，例如 https://api.example.com/v1') }
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL 不应包含账号、密钥、查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/i.test(url.hostname))) {
    throw new Error('远程接口请使用 HTTPS；本机接口可使用 HTTP')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '')
  return url.origin + (path || '/v1')
}
