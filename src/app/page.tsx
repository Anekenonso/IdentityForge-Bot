"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Citation { id: string; type: string; content: string }
interface PendingItem { id: string; type: string; content: string; reason: string }
interface EvidenceRow {
  id: string; timestamp: string; operation: string; blobId: string | null;
  latencyMs: number; resultSummary: string; success: boolean; label: string;
  droppedCount?: number;
}
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  pending?: PendingItem[];
  diagnostics?: { model?: string; snapshotFound?: boolean; degraded?: boolean; droppedCount?: number; latencyMs?: number };
}

interface Provenance {
  relayer: string; mode: string | null; writeReady: boolean | null; status: string;
  apiVersion: string | null; relayerVersion: string | null; buildCommit: string | null;
  capturedAt: string;
}
interface HealthPayload {
  provenance: Provenance | null;
  health: { ok: boolean; mode: string | null; status: string } | null;
  namespace: string | null;
  restore: { restored: number; skipped: number; failed: number; total: number; truncated: boolean } | null;
  accountId: string | null;
  model: string;
  suiExplorer: string | null;
}

export default function Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [role, setRole] = useState<"primary" | "secondary">("primary");
  const [forgetArmed, setForgetArmed] = useState(false);
  const [retired, setRetired] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (res.ok) setHealth(await res.json());
    } catch {
      /* the panel simply stays empty */
    }
  }, []);

  useEffect(() => { void loadHealth(); }, [loadHealth]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Request failed.");

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: data.reply,
          citations: data.citations ?? [],
          pending: data.pending ?? [],
          diagnostics: {
            model: data.model,
            snapshotFound: data.snapshotFound,
            degraded: data.degraded,
            droppedCount: data.droppedCount,
            latencyMs: data.latencyMs,
          },
        },
      ]);
      if (data.diagnostic) setError(data.diagnostic);
      setEvidence((e) => [...e, ...(data.evidence ?? [])].slice(-200));
      void loadHealth();
    } catch (err) {
      setError((err as Error).message);
      setMessages((m) => m.slice(0, -1));
      setInput(text);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (item: PendingItem) => {
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: item.type, content: item.content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Write failed.");
      setEvidence((e) => [
        ...e,
        {
          id: `local-${Date.now()}`,
          timestamp: new Date().toISOString(),
          operation: "remember",
          blobId: data.blobId,
          latencyMs: data.latencyMs,
          resultSummary: `Confirmed: ${item.content}`,
          success: true,
          label: "REAL",
        },
      ].slice(-200));
      setMessages((m) =>
        m.map((msg) =>
          msg.pending?.some((p) => p.id === item.id)
            ? { ...msg, pending: msg.pending.filter((p) => p.id !== item.id) }
            : msg,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const forget = async () => {
    try {
      const res = await fetch("/api/forget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Forget failed.");
      setRetired((r) => [data.retired, ...r]);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Identity forgotten. ${data.disclosure}` },
      ]);
      setForgetArmed(false);
      void loadHealth();
    } catch (err) {
      setError((err as Error).message);
      setForgetArmed(false);
    }
  };

  const mode = health?.provenance?.mode ?? health?.health?.mode ?? null;
  const modeClass = mode === "production" ? "ok" : mode === "benchmark" ? "danger" : "warn";
  const drops = evidence.reduce((s, e) => s + (e.droppedCount ?? 0), 0);
  const writes = evidence.filter((e) => e.operation === "remember").length;

  return (
    <div className="shell">
      <main className="main">
        <header className="masthead">
          <h1>IdentityForge</h1>
          <p className="thesis">
            An agent whose durable identity lives in Walrus Memory can be rebuilt on any
            machine, any deployment, any LLM — and every claim it makes is backed by a
            content-addressed blob that anyone can independently verify on Sui.
          </p>
          <div className="badges">
            <span className={`badge ${modeClass}`}>relayer: {mode ?? "unknown"}</span>
            <span className="badge">{health?.namespace ?? "identity"}</span>
            <span className="badge">{writes} writes</span>
            {drops > 0 && <span className="badge warn">{drops} dropped by relayer</span>}
            {retired.length > 0 && (
              <span className="badge danger">{retired.length} retired generation(s)</span>
            )}
          </div>
        </header>

        <div className="chat">
          {messages.length === 0 && (
            <p className="empty-note">
              Tell the agent something about yourself. It will propose what to remember,
              and code — not the model — decides what is actually written.
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="who">{m.role === "user" ? "you" : `agent · ${m.diagnostics?.model ?? ""}`}</div>
              <div className="body">{m.text}</div>

              {m.citations && m.citations.length > 0 && (
                <div className="cites">
                  {m.citations.map((c) => (
                    <span key={c.id} className="cite" title={c.content}>
                      {c.type} · {c.id.slice(0, 8)}
                    </span>
                  ))}
                </div>
              )}

              {m.pending?.map((p) => (
                <div key={p.id} className="pending">
                  <div className="label">
                    {p.type} requires your confirmation — code holds writes, not the model
                  </div>
                  <div className="text">{p.content}</div>
                  <div className="actions">
                    <button className="primary" onClick={() => void confirm(p)}>Remember this</button>
                    <button onClick={() => setMessages((m2) => m2.map((x, j) => (j === i ? { ...x, pending: x.pending?.filter((y) => y.id !== p.id) } : x)))}>
                      No thanks
                    </button>
                  </div>
                </div>
              ))}

              {m.diagnostics && (
                <div className="cites">
                  {m.diagnostics.snapshotFound === false && (
                    <span className="badge warn">snapshot not found</span>
                  )}
                  {m.diagnostics.degraded && <span className="badge warn">degraded</span>}
                  {typeof m.diagnostics.latencyMs === "number" && (
                    <span className="badge">{m.diagnostics.latencyMs}ms</span>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        {error && (
          <div style={{ padding: "0 24px 10px" }}>
            <span className="badge danger">{error}</span>
          </div>
        )}

        <div className="composer">
          <input
            type="text"
            value={input}
            placeholder="I'm a Rust engineer working on Sui…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
            disabled={busy}
          />
          <button className="primary" onClick={() => void send()} disabled={busy || !input.trim()}>
            {busy ? "Thinking…" : "Send"}
          </button>
        </div>
      </main>

      <aside className="sidebar">
        <div className="section">
          <h2>Relayer provenance</h2>
          <dl className="kv">
            <dt>status</dt><dd>{health?.health?.status ?? health?.provenance?.status ?? "—"}</dd>
            <dt>mode</dt><dd className={modeClass === "ok" ? "" : ""}>{mode ?? "not reported"}</dd>
            <dt>write_ready</dt><dd>{String(health?.provenance?.writeReady ?? "—")}</dd>
            <dt>api</dt><dd>{health?.provenance?.apiVersion ?? "—"}</dd>
            <dt>build</dt><dd>{health?.provenance?.buildCommit?.slice(0, 10) ?? "—"}</dd>
          </dl>
        </div>

        <div className="section">
          <h2>Chain audit</h2>
          <dl className="kv">
            <dt>namespace</dt><dd>{health?.namespace ?? "—"}</dd>
            <dt>blobs on chain</dt><dd>{health?.restore?.total ?? "—"}</dd>
            <dt>indexed</dt><dd>{health?.restore ? health.restore.restored + health.restore.skipped : "—"}</dd>
            <dt>failed</dt><dd className={(health?.restore?.failed ?? 0) > 0 ? "danger" : ""}>{health?.restore?.failed ?? "—"}</dd>
            <dt>truncated</dt><dd>{String(health?.restore?.truncated ?? "—")}</dd>
          </dl>
          {health?.suiExplorer && (
            <p style={{ marginTop: 8, fontSize: 12.5 }}>
              Ownership is public onchain:{" "}
              <a href={health.suiExplorer} target="_blank" rel="noreferrer">
                open MemWalAccount
              </a>
            </p>
          )}
        </div>

        <div className="section">
          <h2>Model</h2>
          <div className="model-switch">
            <button className={role === "primary" ? "active" : ""} onClick={() => setRole("primary")}>
              primary
            </button>
            <button className={role === "secondary" ? "active" : ""} onClick={() => setRole("secondary")}>
              secondary
            </button>
          </div>
          <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--muted)" }}>
            Switching the model is how portability (H2) is demonstrated: same memory,
            different reasoning engine.
          </p>
        </div>

        <div className="section">
          <h2>Forget identity</h2>
          {forgetArmed ? (
            <>
              <p style={{ fontSize: 12.5, color: "var(--warn)", margin: "0 0 8px" }}>
                This retires the current namespace generation. Recall is scoped by owner +
                namespace, so the old memories become unreachable — but the encrypted
                blobs remain on Walrus until their storage epochs lapse.
              </p>
              <button className="danger" onClick={() => void forget()}>Confirm forget</button>
            </>
          ) : (
            <button onClick={() => setForgetArmed(true)}>Forget…</button>
          )}
          {retired.length > 0 && (
            <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8 }}>
              Retired: {retired.join(", ")}
            </p>
          )}
        </div>

        <div className="section">
          <h2>Evidence ({evidence.length})</h2>
          <div className="log">
            {evidence.length === 0 && (
              <p className="empty-note">No operations yet.</p>
            )}
            {[...evidence].reverse().map((e) => (
              <div key={e.id} className={`log-row ${e.success ? "ok" : "fail"}`} title={`${e.timestamp} · ${e.label}`}>
                <span className="op">{e.operation}</span>{" "}
                {e.blobId && <span className="meta">{e.blobId.slice(0, 12)}… </span>}
                <span className="meta">{e.latencyMs}ms</span>
                <div className="sum">{e.resultSummary}</div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
