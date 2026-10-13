// api.js — tiny fetch wrapper that handles CSRF and JSON.
(function () {
  let csrf = null;

  async function getCsrf() {
    if (csrf) return csrf;
    const res = await fetch('/api/csrf');
    const data = await res.json();
    csrf = data.token;
    return csrf;
  }

  async function header() {
    const t = await getCsrf();
    return { 'Content-Type': 'application/json', 'x-arbiter-token': t };
  }

  async function get(path) {
    const res = await fetch(path);
    return await parse(res);
  }

  async function post(path, body) {
    return await send('POST', path, body);
  }
  async function put(path, body) {
    return await send('PUT', path, body);
  }
  async function del(path) {
    const res = await fetch(path, { method: 'DELETE', headers: await header() });
    return await parse(res);
  }

  async function send(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: await header(),
      body: JSON.stringify(body || {}),
    });
    return await parse(res);
  }

  async function parse(res) {
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data.error?.message || res.statusText);
      err.status = res.status;
      err.code = data.error?.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  window.arbiterApi = { get, post, put, del, getCsrf };
})();
