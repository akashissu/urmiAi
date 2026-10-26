import { useEffect, useState } from "react";
import { api, getToken, setToken, type User } from "./api";
import { ServersPage } from "./pages/ServersPage";
import { KeysPage } from "./pages/KeysPage";
import { AuditPage } from "./pages/AuditPage";
import { ChatPage } from "./pages/ChatPage";

type Page = "servers" | "keys" | "audit" | "chat";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>("servers");

  useEffect(() => {
    if (getToken()) {
      api<User>("/auth/me").then(setUser).catch(() => setToken(null));
    }
  }, []);

  if (!user) return <Login onLoggedIn={setUser} />;

  return (
    <div className="app">
      <nav>
        <h1>UrmiAi Gateway</h1>
        <button className={page === "servers" ? "active" : ""} onClick={() => setPage("servers")}>MCP Servers</button>
        <button className={page === "keys" ? "active" : ""} onClick={() => setPage("keys")}>API Keys</button>
        <button className={page === "audit" ? "active" : ""} onClick={() => setPage("audit")}>Audit Log</button>
        <button className={page === "chat" ? "active" : ""} onClick={() => setPage("chat")}>Chat Agent</button>
        <p style={{ fontSize: 12, color: "#9aa6b4", marginTop: 24 }}>{user.email}<br />{user.role}</p>
        <button onClick={() => { setToken(null); setUser(null); }}>Log out</button>
      </nav>
      <main>
        {page === "servers" && <ServersPage isAdmin={user.role === "admin"} />}
        {page === "keys" && <KeysPage />}
        {page === "audit" && <AuditPage />}
        {page === "chat" && <ChatPage />}
      </main>
    </div>
  );
}

function Login({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ token: string; user: User }>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(result.token);
      onLoggedIn(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: "80px auto" }}>
      <div className="card">
        <h2>{mode === "login" ? "Log in" : "Create account"}</h2>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input placeholder="password (min 8)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <span className="error">{error}</span>}
          <button className="btn" type="submit">{mode === "login" ? "Log in" : "Register"}</button>
        </form>
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Need an account? Register" : "Have an account? Log in"}
        </button>
        <p style={{ fontSize: 12, color: "#666" }}>The first account registered becomes the admin.</p>
      </div>
    </main>
  );
}
