import { useEffect, useState } from "react";
import { api } from "../api";

interface ApiKey {
  id: string;
  label: string;
  keyPrefix: string;
  isPrimary: boolean;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [freshKey, setFreshKey] = useState("");
  const [label, setLabel] = useState("");

  async function load() {
    setKeys(await api<ApiKey[]>("/keys"));
  }

  useEffect(() => { load(); }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const created = await api<ApiKey & { rawKey: string }>("/keys", { method: "POST", body: JSON.stringify({ label: label || "default" }) });
    setFreshKey(created.rawKey);
    setLabel("");
    await load();
  }

  async function revoke(id: string) {
    await api(`/keys/${id}/revoke`, { method: "POST" });
    await load();
  }

  return (
    <section>
      <h2>API Keys</h2>
      <p style={{ fontSize: 14, color: "#555" }}>
        Use a key as the Bearer token when connecting an MCP client to this gateway's <code>/mcp</code> endpoint.
        The full key is shown only once, at creation.
      </p>
      {freshKey && (
        <div className="card">
          <strong>New key — copy it now, it will not be shown again:</strong>
          <pre>{freshKey}</pre>
        </div>
      )}
      <table>
        <thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {keys.filter((key) => !key.isPrimary).map((key) => (
            <tr key={key.id}>
              <td>{key.label}</td>
              <td><code>{key.keyPrefix}…</code></td>
              <td>{new Date(key.createdAt).toLocaleString()}</td>
              <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}</td>
              <td>{key.revokedAt ? "revoked" : <button className="btn danger" onClick={() => revoke(key.id)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row" onSubmit={create} style={{ marginTop: 16 }}>
        <input placeholder="label (e.g. cursor)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn" type="submit">Generate key</button>
      </form>
    </section>
  );
}
