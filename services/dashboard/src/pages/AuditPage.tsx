import { useEffect, useState } from "react";
import { api } from "../api";

interface AuditEntry {
  id: number;
  user_email: string | null;
  server_slug: string;
  tool_name: string;
  started_at: string;
  duration_ms: number;
  success: boolean;
  error_message: string | null;
}

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  async function load() {
    setEntries(await api<AuditEntry[]>("/audit?limit=200"));
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section>
      <h2>Audit Log</h2>
      <table>
        <thead><tr><th>When</th><th>User</th><th>Server</th><th>Tool</th><th>Duration</th><th>Result</th></tr></thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{new Date(entry.started_at).toLocaleString()}</td>
              <td>{entry.user_email ?? "deleted user"}</td>
              <td><code>{entry.server_slug}</code></td>
              <td><code>{entry.tool_name}</code></td>
              <td>{entry.duration_ms} ms</td>
              <td>{entry.success ? "ok" : <span className="error">{entry.error_message}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
