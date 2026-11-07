export async function api(path, { method = "GET", body, address } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (address) headers["x-wallet-address"] = address;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
