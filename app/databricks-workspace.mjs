// Server-side credentials are supplied by the Databricks App runtime.
export function workspaceOrigin(value) {
  const url = new URL(value?.includes('://') ? value : 'https://' + value);
  const supported = /\.(?:cloud\.databricks\.(?:com|us)|gcp\.databricks\.com|azuredatabricks\.net|databricks\.azure\.(?:us|cn))$/i;
  if (url.protocol !== 'https:' || !supported.test(url.hostname) || url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid Databricks workspace host.');
  }
  return url.origin;
}

export function volumePath(value) {
  if (!/^\/Volumes\/(?:[\w-]+\/){2}[\w-]+\/?$/.test(value)) throw new Error('Invalid Poseidon volume.');
  return value.replace(/\/$/, '');
}

export function createWorkspaceRequest(env = process.env, fetchImpl = fetch) {
  let token, expiresAt = 0, login;
  async function authenticate(origin) {
    if (!env.DATABRICKS_CLIENT_ID || !env.DATABRICKS_CLIENT_SECRET) throw new Error('Missing app credentials.');
    const credentials = Buffer.from(env.DATABRICKS_CLIENT_ID + ':' + env.DATABRICKS_CLIENT_SECRET).toString('base64');
    const response = await fetchImpl(origin + '/oidc/v1/token', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{Authorization:'Basic ' + credentials},
      body:new URLSearchParams({grant_type:'client_credentials',scope:'all-apis'})
    });
    if (!response.ok) throw new Error('App authentication failed.');
    const auth = await response.json();
    if (typeof auth.access_token !== 'string' || !auth.access_token) throw new Error('No app access token.');
    token = auth.access_token;
    expiresAt = Date.now() + Math.max(0, Number(auth.expires_in || 0) - 60) * 1000;
    return token;
  }
  return async function request(path, options = {}) {
    const origin = workspaceOrigin(env.DATABRICKS_HOST);
    if (!path.startsWith('/api/')) throw new Error('Invalid Databricks API path.');
    if (!token || Date.now() >= expiresAt) {
      login ??= authenticate(origin).finally(() => { login = undefined; });
      await login;
    }
    const usedToken = token;
    const response = await fetchImpl(origin + path, {
      ...options, redirect:'error', signal:options.signal ?? AbortSignal.timeout(30000),
      headers:{...options.headers, Authorization:'Bearer ' + usedToken}
    });
    if (response.status === 401 && token === usedToken) token = undefined;
    return response;
  };
}
