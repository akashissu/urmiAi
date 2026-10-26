import { useEffect, useState } from "react";
import { api } from "../api";

interface Server {
  id: string;
  slug: string;
  name: string;
  base_url: string;
  auth_type: string;
  enabled: boolean;
  status: "connected" | "unreachable" | "unknown";
  last_checked_at: string | null;
}

interface Tool {
  name: string;
  description?: string;
}

export function ServersPage({ isAdmin }: { isAdmin: boolean }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [error, setError] = useState("");

  async function load() {
    setServers(await api<Server[]>("/servers"));
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function showTools(server: Server) {
    setExpanded(server.id);
    setTools([]);
    try {
      setTools(await api<Tool[]>(`/servers/${server.id}/tools`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggle(server: Server) {
    await api(`/servers/${server.id}/${server.enabled ? "disable" : "enable"}`, { method: "POST" });
    await load();
  }

  async function remove(server: Server) {
    await api(`/servers/${server.id}`, { method: "DELETE" });
    await load();
  }

  return (
    <section>
      <h2>MCP Servers</h2>
      {error && <p className="error">{error}</p>}
      {servers.map((server) => (
        <div className="card" key={server.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{server.name}</strong> <code>{server.slug}</code>
              <div style={{ fontSize: 13, color: "#666" }}>{server.base_url}</div>
            </div>
            <div className="row">
              <span className={`badge ${server.enabled ? server.status : "unknown"}`}>
                {server.enabled ? server.status : "disabled"}
              </span>
              <button className="btn ghost" onClick={() => showTools(server)}>Tools</button>
              {isAdmin && <button className="btn ghost" onClick={() => toggle(server)}>{server.enabled ? "Disable" : "Enable"}</button>}
              {isAdmin && <button className="btn danger" onClick={() => remove(server)}>Remove</button>}
            </div>
          </div>
          {expanded === server.id && (
            <ul>{tools.map((tool) => <li key={tool.name}><code>{tool.name}</code> — {tool.description}</li>)}</ul>
          )}
        </div>
      ))}
      {isAdmin && <AddServerForm onAdded={load} />}
    </section>
  );
}

function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const [form, setForm] = useState({ slug: "", name: "", baseUrl: "", authType: "none", authHeaderName: "", credential: "" });
  const [error, setError] = useState("");

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/servers", { method: "POST", body: JSON.stringify(form) });
      setForm({ slug: "", name: "", baseUrl: "", authType: "none", authHeaderName: "", credential: "" });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3>Add MCP server</h3>
      <div className="row">
        <input placeholder="slug (e.g. woocommerce)" value={form.slug} onChange={(e) => set("slug", e.target.value)} required />
        <input placeholder="display name" value={form.name} onChange={(e) => set("name", e.target.value)} required />
      </div>
      <input placeholder="https://mcp.example.com/mcp" value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} required />
      <div className="row">
        <select value={form.authType} onChange={(e) => set("authType", e.target.value)}>
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
        </select>
        {form.authType === "header" && (
          <input placeholder="header name" value={form.authHeaderName} onChange={(e) => set("authHeaderName", e.target.value)} />
        )}
        {form.authType !== "none" && (
          <input placeholder="credential" type="password" value={form.credential} onChange={(e) => set("credential", e.target.value)} />
        )}
      </div>
      {error && <span className="error">{error}</span>}
      <button className="btn" type="submit" style={{ alignSelf: "flex-start" }}>Add server</button>
    </form>
  );
}
