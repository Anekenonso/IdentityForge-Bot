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
  const [busyStage, setBusyStage] = useState<string>("");
  const [consolidating, setConsolidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [role, setRole] = useState<"primary" | "secondary">("primary");
  const [forgetArmed, setForgetArmed] = useState(false);
  const [retired, setRetired] = useState<string[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* fallback */
    }
  };

  const consolidate = async () => {
    setConsolidating(true);
    setError(null);
    try {
      const res = await fetch("/api/consolidate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace: health?.namespace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Consolidation failed.");

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `⚡ Consolidated Snapshot v${data.version} committed to Walrus!\n\n${data.summary}`,
          citations: [],
          pending: [],
          diagnostics: {
            model: "system:consolidate",
            snapshotFound: true,
            degraded: false,
            droppedCount: 0,
            latencyMs: data.latencyMs,
          },
        },
      ]);
      void loadHealth();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConsolidating(false);
    }
  };

  const send = async (explicitText?: string) => {
    const text = (explicitText ?? input).trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setBusyStage("Reconstructing memories from Sui…");
    setMessages((m) => [...m, { role: "user", text }]);

    const t1 = setTimeout(() => setBusyStage("Synthesizing with cryptographic grounding…"), 4000);
    const t2 = setTimeout(() => setBusyStage("Verifying citations & checking write gate…"), 12000);
    const t3 = setTimeout(() => setBusyStage("Committing ciphertext to Walrus on Sui…"), 22000);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, role, namespace: health?.namespace }),
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
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      setBusy(false);
      setBusyStage("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send();
  };

  const confirm = async (item: PendingItem) => {
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: item.type, content: item.content, namespace: health?.namespace }),
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
        <header className="masthead" role="banner">
          <div className="brand-row">
            <div className="brand-title-wrap">
              <div className="brand-glyph" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div>
                <h1>
                  IdentityForge
                  <span className="version-tag">Walrus Memory</span>
                </h1>
              </div>
            </div>
            
            <div className="badges" aria-label="System status">
              <span className={`badge ${modeClass}`} title="Relayer execution environment mode">
                <span className="status-dot" aria-hidden="true"></span>
                relayer: {mode ?? "unknown"}
              </span>
              <span className="badge brand" title="Active memory namespace generation">
                <span className="status-dot" aria-hidden="true"></span>
                {health?.namespace ?? "identity"}
              </span>
              <span className="badge" title="Committed memories count">
                {writes} writes
              </span>
              {drops > 0 && (
                <span className="badge warn" title="Silent blob retrieval drops reported by SDK">
                  <span className="status-dot" aria-hidden="true"></span>
                  {drops} dropped
                </span>
              )}
              {retired.length > 0 && (
                <span className="badge danger" title="Retired isolated generations">
                  <span className="status-dot" aria-hidden="true"></span>
                  {retired.length} retired gen
                </span>
              )}
            </div>
          </div>

          <p className="thesis">
            An agent whose durable identity lives in Walrus Memory can be rebuilt on any
            machine, any deployment, any LLM — and every claim it makes is backed by a
            content-addressed blob that anyone can independently verify on Sui.
          </p>
        </header>

        <section className="chat" aria-label="Conversation history" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty-hero">
              <div className="empty-hero-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
              </div>
              <h3>Decentralized Identity on Walrus</h3>
              <p>
                Tell the agent about yourself. It will propose memories, and deterministic code
                — not the model — verifies citations and gates what gets committed on-chain.
              </p>
              <div className="quick-prompts" aria-label="Sample prompts">
                <button
                  type="button"
                  className="quick-prompt-btn"
                  onClick={() => {
                    setInput("I'm a Rust engineer working on Sui DeFi protocols.");
                    inputRef.current?.focus();
                  }}
                >
                  <span>⚡</span> &quot;I&apos;m a Rust engineer working on Sui DeFi&quot;
                </button>
                <button
                  type="button"
                  className="quick-prompt-btn"
                  onClick={() => {
                    setInput("I prefer concise bullet points and zero conversational fluff.");
                    inputRef.current?.focus();
                  }}
                >
                  <span>📝</span> &quot;I prefer concise bullet points&quot;
                </button>
                <button
                  type="button"
                  className="quick-prompt-btn"
                  onClick={() => {
                    setInput("What do you remember about my background and preferences?");
                    inputRef.current?.focus();
                  }}
                >
                  <span>🔍</span> &quot;What do you remember about me?&quot;
                </button>
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <article key={i} className={`msg ${m.role}`}>
              <div className="who">
                {m.role === "user" ? (
                  <span>you</span>
                ) : (
                  <>
                    <span>agent</span>
                    <span>·</span>
                    <span>{m.diagnostics?.model ?? health?.model ?? "model"}</span>
                  </>
                )}
              </div>
              <div className="body">{m.text}</div>

              {m.citations && m.citations.length > 0 && (
                <div className="cites" aria-label="Cited memories">
                  {m.citations.map((c) => (
                    <span key={c.id} className="cite" title={c.content}>
                      <span className="cite-icon" aria-hidden="true">🏷️</span>
                      {c.type} · {c.id.slice(0, 8)}
                    </span>
                  ))}
                </div>
              )}

              {m.pending?.map((p) => (
                <div key={p.id} className="pending" role="alert">
                  <div className="label">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="8" x2="12" y2="12"></line>
                      <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    {p.type} requires your confirmation — code holds writes, not the model
                  </div>
                  <div className="text">{p.content}</div>
                  <div className="actions">
                    <button type="button" className="primary" onClick={() => void confirm(p)}>
                      Remember this
                    </button>
                    <button type="button" onClick={() => setMessages((m2) => m2.map((x, j) => (j === i ? { ...x, pending: x.pending?.filter((y) => y.id !== p.id) } : x)))}>
                      Decline
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
            </article>
          ))}
          <div ref={bottom} />
        </section>

        {error && (
          <div style={{ padding: "0 28px 12px" }}>
            <span className="badge danger" role="alert">
              <span className="status-dot"></span>
              {error}
            </span>
          </div>
        )}

        {busy && busyStage && (
          <div className="progressive-status" role="status" aria-live="polite">
            <span className="progressive-pulse" aria-hidden="true"></span>
            <span className="progressive-text">{busyStage}</span>
          </div>
        )}

        <form className="composer-form" onSubmit={handleFormSubmit}>
          <div className="composer">
            <input
              ref={inputRef}
              type="text"
              value={input}
              placeholder="Type a message or fact to remember…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={busy}
              autoComplete="off"
              spellCheck="false"
              aria-label="Message to agent"
            />
            <button
              type="submit"
              className="primary"
              disabled={busy || !input.trim()}
              aria-label="Send message"
            >
              {busy ? (
                <>
                  <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>Thinking…</span>
                </>
              ) : (
                <>
                  <span>Send</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                  </svg>
                </>
              )}
            </button>
          </div>
        </form>
      </main>

      <aside className="sidebar" aria-label="System telemetry and control">
        <section className="section">
          <h2>
            <span>Chain Audit</span>
            <span className="pill-tag">Onchain receipt</span>
          </h2>
          
          <div className="stat-grid">
            <div className="stat-box">
              <div className="stat-label">Blobs On Chain</div>
              <div className="stat-val">{health?.restore?.total ?? "—"}</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Indexed</div>
              <div className="stat-val ok">
                {health?.restore ? health.restore.restored + health.restore.skipped : "—"}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Failed</div>
              <div className={`stat-val ${(health?.restore?.failed ?? 0) > 0 ? "danger" : "ok"}`}>
                {health?.restore?.failed ?? "0"}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Namespace</div>
              <div className="stat-val brand">{health?.namespace ?? "identity"}</div>
            </div>
          </div>

          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>truncated</dt><dd>{String(health?.restore?.truncated ?? "false")}</dd>
          </dl>

          {health?.suiExplorer && (
            <p style={{ marginTop: 12, marginBottom: 0, fontSize: 12.5 }}>
              Ownership is public onchain:{" "}
              <a href={health.suiExplorer} target="_blank" rel="noreferrer">
                open MemWalAccount ↗
              </a>
            </p>
          )}
        </section>

        <section className="section">
          <h2>
            <span>Relayer Provenance</span>
            <span className="pill-tag">Public relayer</span>
          </h2>
          <dl className="kv">
            <dt>status</dt><dd>{health?.health?.status ?? health?.provenance?.status ?? "—"}</dd>
            <dt>mode</dt><dd style={{ color: modeClass === "ok" ? "var(--accent)" : "var(--warn)" }}>{mode ?? "not reported"}</dd>
            <dt>write_ready</dt><dd>{String(health?.provenance?.writeReady ?? "—")}</dd>
            <dt>api</dt><dd>{health?.provenance?.apiVersion ?? "—"}</dd>
            <dt>build</dt><dd>{health?.provenance?.buildCommit?.slice(0, 10) ?? "—"}</dd>
          </dl>
        </section>

        <section className="section">
          <h2>
            <span>Reasoning Engine</span>
            <span className="pill-tag">Portability (H2)</span>
          </h2>
          <div className="model-switch" role="group" aria-label="Model switcher">
            <button
              type="button"
              className={role === "primary" ? "active" : ""}
              onClick={() => setRole("primary")}
              aria-pressed={role === "primary"}
            >
              primary (gpt-oss-20b)
            </button>
            <button
              type="button"
              className={role === "secondary" ? "active" : ""}
              onClick={() => setRole("secondary")}
              aria-pressed={role === "secondary"}
            >
              secondary (llama-3.3-70b)
            </button>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--muted)", lineHeight: 1.45 }}>
            Switching the model proves identity follows your Walrus key rather than provider weights.
          </p>
        </section>

        <section className="section">
          <h2>
            <span>Snapshot Consolidation</span>
            <span className="pill-tag">v-backbone</span>
          </h2>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 10px", lineHeight: 1.45 }}>
            Synthesizes scattered facts into an immutable versioned snapshot envelope on Walrus.
          </p>
          <button
            type="button"
            className="brand"
            disabled={consolidating || busy}
            onClick={() => void consolidate()}
            style={{ width: "100%" }}
            title="Merges individual memories into a versioned snapshot blob on Walrus"
          >
            {consolidating ? "Consolidating onchain…" : "⚡ Consolidate Snapshot (v+1)"}
          </button>
        </section>

        <section className="section">
          <h2>
            <span>Revocability / Forget</span>
            <span className="pill-tag">Namespace rotation</span>
          </h2>
          {forgetArmed ? (
            <div>
              <p style={{ fontSize: 12.5, color: "var(--warn)", margin: "0 0 10px", lineHeight: 1.5 }}>
                Retires current namespace generation. Recall is scoped by owner + namespace, so old memories become unreachable — SEAL-encrypted blobs persist on Walrus until epoch lapse.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="danger" onClick={() => void forget()}>
                  Confirm Forget
                </button>
                <button type="button" onClick={() => setForgetArmed(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setForgetArmed(true)}
              style={{ width: "100%" }}
            >
              Rotate generation (Forget…)
            </button>
          )}
          {retired.length > 0 && (
            <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8 }}>
              Retired: {retired.join(", ")}
            </p>
          )}
        </section>

        <section className="section">
          <h2>
            <span>Evidence Audit ({evidence.length})</span>
            <span className="pill-tag">Lineage</span>
          </h2>
          <div className="log" role="log">
            {evidence.length === 0 && (
              <p className="empty-note">No operations in this session yet.</p>
            )}
            {[...evidence].reverse().map((e) => (
              <div key={e.id} className={`log-row ${e.success ? "ok" : "fail"}`} title={`${e.timestamp} · ${e.label}`}>
                <div className="log-header">
                  <span className="op">{e.operation}</span>
                  <span className="meta">{e.latencyMs}ms</span>
                </div>
                {e.blobId && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                    <span className="meta">blob:</span>
                    <button
                      type="button"
                      className="blob-copy-btn"
                      onClick={() => void copyToClipboard(e.blobId!, e.id)}
                      title="Click to copy full blob ID"
                    >
                      {e.blobId.slice(0, 14)}…
                      {copiedId === e.id ? "✓ copied" : "📋"}
                    </button>
                  </div>
                )}
                <div className="sum">{e.resultSummary}</div>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}
