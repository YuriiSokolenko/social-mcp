export function githubClient({ repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO, token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN } = {}) {
  const requireConfig = () => {
    if (!repo || !token) throw new Error('GitHub repository and token are required');
  };
  const root = repo ? `https://api.github.com/repos/${repo}` : null;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  async function api(path, method = 'GET', body) {
    requireConfig();
    const response = await fetch(root + path, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }
  async function pages(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
  async function ensureLabel(name, color, description) {
    requireConfig();
    const response = await fetch(root + '/labels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color, description }),
    });
    if (![201, 422].includes(response.status)) {
      throw new Error(`Cannot ensure ${name} label: ${response.status} ${await response.text()}`);
    }
  }
  return { api, pages, ensureLabel, repo };
}
