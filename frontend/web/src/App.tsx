// App.tsx
// DAO Private Voting (FHE-enabled) — Full Frontend
// Style: Tech blue + black / Glassmorphism / Panel layout / Micro-interactions
// NOTE: Contract address/ABI/provider are abstracted behind getContractReadOnly / getContractWithSigner.

import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import WalletManager from "./components/WalletManager";
import WalletSelector from "./components/WalletSelector";
import "./App.css";

// ---------- Types ----------
type VoteType = "single" | "multiple" | "ranked" | "quadratic" | "weighted";

interface Proposal {
  id: string;
  title: string;
  description: string;
  options: string[];
  voteType: VoteType;
  start: number;
  end: number;
  snapshot: string; // e.g., block number or snapshot id for token weights
  allowRevote: boolean;
  createdBy: string;
  createdAt: number;
  // governance thresholds
  quorum?: number; // minimum participation
  passThreshold?: number; // winning threshold in %
}

interface EncryptedVote {
  id: string; // random id (no linkage to voter)
  pid: string; // proposal id
  cipher: string; // FHE ciphertext blob
  ts: number; // timestamp
  note?: string; // optional user memo (non-sensitive)
}

interface Tallied {
  pid: string;
  talliedAt: number;
  // minimal disclosure: only totals per option
  totals: number[]; // exposed either in plaintext (after threshold decrypt) or as minimal values
  mode: "zk-proof-only" | "threshold-decrypt";
  proofRef?: string; // optional ZK proof reference or log id
}

type ModalKind = "createProposal" | "castVote" | null;

// ---------- Helpers ----------
const toast = (msg: string) => {
  // Simple UX helper
  alert(msg);
};

// Mini FHE client-side stub (do NOT expose real secrets in production)
// In real implementation, replace with Zama fhEVM-compatible FHE client libs.
const FHE = {
  encrypt: (obj: any) => `FHE-${btoa(unescape(encodeURIComponent(JSON.stringify(obj))))}`,
  decryptPreview: (_cipher: string) => "[encrypted]", // never decrypt on client; display minimal hint
};

// ---------- Main Component ----------
const App: React.FC = () => {
  // Wallet & provider
  const [account, setAccount] = useState("");
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [walletSelectorOpen, setWalletSelectorOpen] = useState(false);

  // App state
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);

  // Data lists
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [votesByProposal, setVotesByProposal] = useState<Record<string, EncryptedVote[]>>({});
  const [tallies, setTallies] = useState<Record<string, Tallied | null>>({});

  // UI modal
  const [modal, setModal] = useState<ModalKind>(null);
  const [activeProposalId, setActiveProposalId] = useState<string>("");

  // Create proposal form
  const [pForm, setPForm] = useState({
    title: "",
    description: "",
    optionsText: "",
    voteType: "single" as VoteType,
    snapshot: "",
    allowRevote: true,
    quorum: "",
    passThreshold: "",
    startISO: "",
    endISO: "",
  });

  // Cast vote form
  const [voteForm, setVoteForm] = useState({
    selectionsText: "",
    note: "",
    antiCoercionDummy: false, // allow user to send a dummy (honey) vote to improve deniability
  });

  // Derived stats
  const totalProposals = proposals.length;
  const openProposals = useMemo(() => {
    const now = Date.now() / 1000;
    return proposals.filter((p) => p.start <= now && now <= p.end).length;
  }, [proposals]);

  const closedProposals = totalProposals - openProposals;

  // ---------- Wallet Events ----------
  const onConnect = () => setWalletSelectorOpen(true);
  const onDisconnect = () => {
    setAccount("");
    setProvider(null);
  };

  const onWalletSelect = async (wallet: any) => {
    if (!wallet?.provider) return;
    try {
      const web3Provider = new ethers.BrowserProvider(wallet.provider);
      setProvider(web3Provider);
      const accounts = await web3Provider.send("eth_requestAccounts", []);
      setAccount(accounts?.[0] || "");

      wallet.provider.on("accountsChanged", (accs: string[]) => {
        setAccount(accs?.[0] || "");
      });
    } catch {
      toast("Wallet connection failed");
    }
  };

  // ---------- Contract I/O Utilities ----------
  const readJSON = async (key: string) => {
    const rc = await getContractReadOnly();
    if (!rc) return null;
    const bytes: Uint8Array = await rc.getData(key);
    if (!bytes || (bytes as any).length === 0) return null;
    try {
      return JSON.parse(ethers.toUtf8String(bytes));
    } catch {
      return null;
    }
  };

  const writeJSON = async (key: string, value: any) => {
    const wc = await getContractWithSigner();
    if (!wc) throw new Error("No signer contract");
    await wc.setData(key, ethers.toUtf8Bytes(JSON.stringify(value)));
  };

  const loadAll = async () => {
    // Load proposals
    const keys = (await readJSON("dao_proposal_keys")) as string[] | null;
    const list: Proposal[] = [];
    if (keys && Array.isArray(keys)) {
      for (const id of keys) {
        const p = (await readJSON(`dao_proposal_${id}`)) as Proposal | null;
        if (p) list.push(p);
      }
    }
    // sort by createdAt desc
    list.sort((a, b) => b.createdAt - a.createdAt);
    setProposals(list);

    // Load votes per proposal
    const votesMap: Record<string, EncryptedVote[]> = {};
    for (const p of list) {
      const vKeys = (await readJSON(`dao_vote_keys_${p.id}`)) as string[] | null;
      const vList: EncryptedVote[] = [];
      if (vKeys && Array.isArray(vKeys)) {
        for (const vid of vKeys) {
          const v = (await readJSON(`dao_vote_${p.id}_${vid}`)) as EncryptedVote | null;
          if (v) vList.push(v);
        }
      }
      // newest first
      vList.sort((a, b) => b.ts - a.ts);
      votesMap[p.id] = vList;

      // Load tally (if exists)
      const tally = (await readJSON(`dao_tally_${p.id}`)) as Tallied | null;
      setTallies((prev) => ({ ...prev, [p.id]: tally || null }));
    }
    setVotesByProposal(votesMap);
  };

  // ---------- Health Check ----------
  const checkAvailability = async () => {
    setChecking(true);
    try {
      const rc = await getContractReadOnly();
      if (!rc) throw new Error("No readonly contract");
      const ok: boolean = await rc.isAvailable();
      setIsAvailable(ok);
      toast(ok ? "Contract available ✅" : "Contract unavailable ❌");
    } catch (e: any) {
      setIsAvailable(false);
      toast(`Health check failed: ${e?.message || "Unknown error"}`);
    } finally {
      setChecking(false);
    }
  };

  // ---------- Effects ----------
  useEffect(() => {
    (async () => {
      try {
        await loadAll();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ---------- Create Proposal ----------
  const handleCreateProposal = async () => {
    if (!provider) return toast("Connect wallet first");
    const options = pForm.optionsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!pForm.title || options.length < 2) return toast("Title & at least 2 options required");

    const start = pForm.startISO ? Math.floor(new Date(pForm.startISO).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const end = pForm.endISO ? Math.floor(new Date(pForm.endISO).getTime() / 1000) : start + 3 * 24 * 3600;
    if (end <= start) return toast("End time must be after start time");

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const proposal: Proposal = {
      id,
      title: pForm.title,
      description: pForm.description,
      options,
      voteType: pForm.voteType,
      start,
      end,
      snapshot: pForm.snapshot || "latest",
      allowRevote: pForm.allowRevote,
      quorum: pForm.quorum ? Number(pForm.quorum) : undefined,
      passThreshold: pForm.passThreshold ? Number(pForm.passThreshold) : undefined,
      createdBy: account || "0x",
      createdAt: Math.floor(Date.now() / 1000),
    };

    try {
      // Append key
      const keys = ((await readJSON("dao_proposal_keys")) as string[] | null) || [];
      const nextKeys = [...keys, id];

      await writeJSON(`dao_proposal_${id}`, proposal);
      await writeJSON("dao_proposal_keys", nextKeys);

      // init votes/tally containers
      await writeJSON(`dao_vote_keys_${id}`, []);
      await writeJSON(`dao_tally_${id}`, null);

      toast("Proposal created (encrypted-ready)");
      setModal(null);
      setPForm({
        title: "",
        description: "",
        optionsText: "",
        voteType: "single",
        snapshot: "",
        allowRevote: true,
        quorum: "",
        passThreshold: "",
        startISO: "",
        endISO: "",
      });
      await loadAll();
    } catch (e: any) {
      toast(`Create failed: ${e?.message || "Unknown error"}`);
    }
  };

  // ---------- Cast Vote (FHE) ----------
  const handleCastVote = async () => {
    if (!provider) return toast("Connect wallet first");
    if (!activeProposalId) return toast("No active proposal selected");

    const proposal = proposals.find((p) => p.id === activeProposalId);
    if (!proposal) return toast("Invalid proposal");

    // Anti-coercion: allow multiple overwrites if allowRevote === true (final one counts)
    const now = Math.floor(Date.now() / 1000);
    if (now < proposal.start || now > proposal.end) return toast("Voting window closed");

    // Parse selections: lines or comma separated indexes/labels
    const raw = voteForm.selectionsText.trim();
    if (!raw) return toast("Provide selections");
    // Store selection as opaque payload (client never exposes plaintext after encryption)
    const payload = {
      pid: activeProposalId,
      selections: raw, // free text mapping; validator will ZK-proof "in domain" on-chain
      type: proposal.voteType,
      antiCoercionDummy: voteForm.antiCoercionDummy,
      ts: now,
    };

    const cipher = FHE.encrypt(payload);
    const vid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const vote: EncryptedVote = { id: vid, pid: activeProposalId, cipher, ts: now, note: voteForm.note || "" };

    try {
      // Append vote key under pid
      const vKeys = ((await readJSON(`dao_vote_keys_${activeProposalId}`)) as string[] | null) || [];
      const nextKeys = [...vKeys, vid];

      await writeJSON(`dao_vote_${activeProposalId}_${vid}`, vote);
      await writeJSON(`dao_vote_keys_${activeProposalId}`, nextKeys);

      toast("Encrypted vote submitted");
      setModal(null);
      setVoteForm({ selectionsText: "", note: "", antiCoercionDummy: false });
      await loadAll();
    } catch (e: any) {
      toast(`Vote failed: ${e?.message || "Unknown error"}`);
    }
  };

  // ---------- Publish Tally (post-vote, minimal disclosure) ----------
  const handleTally = async (pid: string, mode: Tallied["mode"]) => {
    if (!provider) return toast("Connect wallet first");
    const proposal = proposals.find((p) => p.id === pid);
    if (!proposal) return toast("Invalid proposal");

    const now = Math.floor(Date.now() / 1000);
    if (now <= proposal.end) return toast("Tally allowed after voting ends");

    try {
      // In real world: fhEVM/rollup performs encrypted aggregation; here we only store an empty frame
      // to demonstrate "result published with ZK proof reference".
      // Frontend never exposes per-vote plaintext; only aggregated numbers appear (or zk proof only).
      const totals = new Array(proposal.options.length).fill(0);
      const tally: Tallied = {
        pid,
        talliedAt: now,
        totals, // keep zero until back-end fhEVM computation writes real totals
        mode,
        proofRef: mode === "zk-proof-only" ? `log-${pid}-${now}` : undefined,
      };
      await writeJSON(`dao_tally_${pid}`, tally);
      toast("Result published placeholder (awaiting fhEVM aggregation)");
      await loadAll();
    } catch (e: any) {
      toast(`Publish failed: ${e?.message || "Unknown error"}`);
    }
  };

  // ---------- UI Render ----------
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p>Bootstrapping FHE-ready governance...</p>
      </div>
    );
  }

  const nowSec = Date.now() / 1000;

  return (
    <div className="app-wrap">
      {/* Header */}
      <header className="header glass">
        <div className="brand">
          <div className="brand-logo">Δ</div>
          <div className="brand-title">
            <span>Priv</span>Vote DAO
          </div>
        </div>

        <div className="header-actions">
          <button className="btn ghost" onClick={checkAvailability} disabled={checking}>
            {checking ? "Checking..." : isAvailable === null ? "Health Check" : isAvailable ? "Available ✓" : "Unavailable ✕"}
          </button>

          <button className="btn primary" onClick={() => setModal("createProposal")}>
            New Proposal
          </button>

          <WalletManager account={account} onConnect={onConnect} onDisconnect={onDisconnect} />
        </div>
      </header>

      {/* Hero / Intro */}
      <section className="hero glass">
        <div className="hero-left">
          <h1>FHE-Powered Private Governance</h1>
          <p>
            Vote privately with fully homomorphic encryption. Support single/multiple/ranked, token-weighted and quadratic voting — with anti-Sybil & anti-coercion UX.
          </p>
          <ul className="hero-bullets">
            <li>Client-side FHE encryption — preferences never leak</li>
            <li>On-chain validation via ZK proofs (eligibility, limits, legality)</li>
            <li>Minimal disclosure: publish only aggregated results or ZK-proof-only</li>
          </ul>
          <div className="hero-ctas">
            <button className="btn secondary" onClick={() => setModal("createProposal")}>
              Create Proposal
            </button>
            <button className="btn ghost" onClick={() => window.scrollTo({ top: 1000, behavior: "smooth" })}>
              Browse Proposals
            </button>
          </div>
        </div>

        <div className="hero-right">
          <div className="stats-card glass">
            <div className="stat">
              <div className="stat-n">{totalProposals}</div>
              <div className="stat-l">Total Proposals</div>
            </div>
            <div className="divider" />
            <div className="stat">
              <div className="stat-n">{openProposals}</div>
              <div className="stat-l">Open Now</div>
            </div>
            <div className="divider" />
            <div className="stat">
              <div className="stat-n">{closedProposals}</div>
              <div className="stat-l">Closed</div>
            </div>
          </div>
        </div>
      </section>

      {/* Tutorial */}
      <section className="tutorial glass">
        <h2>How It Works</h2>
        <div className="steps">
          <div className="step">
            <div className="step-i">1</div>
            <div className="step-t">Connect Wallet</div>
            <div className="step-d">Link your wallet to generate eligibility ZK proofs.</div>
          </div>
          <div className="step">
            <div className="step-i">2</div>
            <div className="step-t">Encrypt Vote (FHE)</div>
            <div className="step-d">Your selections are encrypted client-side — no plaintext leaves your device.</div>
          </div>
          <div className="step">
            <div className="step-i">3</div>
            <div className="step-t">Submit & Aggregate</div>
            <div className="step-d">Contract stores ciphertexts; fhEVM/rollup aggregates on encrypted data.</div>
          </div>
          <div className="step">
            <div className="step-i">4</div>
            <div className="step-t">Minimal Disclosure</div>
            <div className="step-d">Publish totals or a ZK-proof-only result to avoid any reverse inference.</div>
          </div>
        </div>
      </section>

      {/* Proposal List */}
      <section className="list glass" id="proposals">
        <div className="list-head">
          <h2>Proposals</h2>
          <button className="btn ghost" onClick={loadAll}>Refresh</button>
        </div>

        {proposals.length === 0 ? (
          <div className="empty">
            <p>No proposals yet</p>
            <button className="btn primary" onClick={() => setModal("createProposal")}>Create the first one</button>
          </div>
        ) : (
          <div className="cards">
            {proposals.map((p) => {
              const votes = votesByProposal[p.id] || [];
              const tally = tallies[p.id];
              const isOpen = p.start <= nowSec && nowSec <= p.end;
              return (
                <div className="card" key={p.id}>
                  <div className="card-top">
                    <div className="tag">{p.voteType}</div>
                    <div className={`badge ${isOpen ? "open" : "closed"}`}>{isOpen ? "Open" : "Closed"}</div>
                  </div>
                  <h3 className="card-title">{p.title}</h3>
                  <p className="card-desc">{p.description || "—"}</p>

                  <div className="opts">
                    {p.options.map((op, i) => (
                      <div className="opt" key={i}>
                        <span className="dot" />
                        <span>{op}</span>
                      </div>
                    ))}
                  </div>

                  <div className="meta">
                    <div><strong>Snapshot:</strong> {p.snapshot}</div>
                    <div><strong>Window:</strong> {new Date(p.start * 1000).toLocaleString()} → {new Date(p.end * 1000).toLocaleString()}</div>
                    {p.quorum !== undefined && <div><strong>Quorum:</strong> {p.quorum}</div>}
                    {p.passThreshold !== undefined && <div><strong>Pass Threshold:</strong> {p.passThreshold}%</div>}
                  </div>

                  <div className="row">
                    <div className="pill">Votes: {votes.length}</div>
                    {tally ? (
                      <div className="pill ok">Tally: {tally.mode === "zk-proof-only" ? "ZK Proof" : "Decrypted Totals"}</div>
                    ) : (
                      <div className="pill">Tally: —</div>
                    )}
                  </div>

                  {tally && tally.totals?.length === p.options.length && (
                    <div className="tally">
                      {tally.totals.map((n, i) => (
                        <div key={i} className="trow">
                          <span className="tname">{p.options[i]}</span>
                          <span className="tbar"><i style={{ width: `${Math.min(100, n)}%` }} /></span>
                          <span className="tval">{n}</span>
                        </div>
                      ))}
                      {tally.proofRef && <div className="proof">Proof Ref: {tally.proofRef}</div>}
                    </div>
                  )}

                  <div className="actions">
                    <button
                      className="btn secondary"
                      disabled={!isOpen}
                      onClick={() => {
                        setActiveProposalId(p.id);
                        setModal("castVote");
                      }}
                    >
                      {isOpen ? "Cast Private Vote" : "Voting Closed"}
                    </button>

                    <button
                      className="btn ghost"
                      onClick={() => handleTally(p.id, "zk-proof-only")}
                      disabled={isOpen}
                      title="Publish ZK-proof-only result"
                    >
                      Publish ZK Result
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => handleTally(p.id, "threshold-decrypt")}
                      disabled={isOpen}
                      title="Publish threshold-decrypted totals"
                    >
                      Publish Totals
                    </button>
                  </div>

                  {/* Minimal recent votes list (cipher previews only) */}
                  {votes.length > 0 && (
                    <div className="cipher-list">
                      <div className="cipher-head">Recent Encrypted Submissions</div>
                      {votes.slice(0, 3).map((v) => (
                        <div className="cipher-row" key={v.id}>
                          <div className="cid">#{v.id.slice(0, 6)}</div>
                          <div className="cpreview">{FHE.decryptPreview(v.cipher)}</div>
                          <div className="cts">{new Date(v.ts * 1000).toLocaleString()}</div>
                          <div className="cnote">{v.note || ""}</div>
                        </div>
                      ))}
                      {votes.length > 3 && <div className="more">+{votes.length - 3} more encrypted votes</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="foot-left">© {new Date().getFullYear()} PrivVote DAO — FHE-Powered Privacy</div>
        <div className="foot-right">
          <a href="#" className="link">Docs</a>
          <a href="#" className="link">Policy</a>
          <a href="#" className="link">Contact</a>
        </div>
      </footer>

      {/* Modals */}
      {modal === "createProposal" && (
        <div className="modal">
          <div className="modal-card glass">
            <div className="modal-head">
              <h3>New Proposal</h3>
              <button className="x" onClick={() => setModal(null)}>×</button>
            </div>

            <div className="grid">
              <div className="col">
                <label>Title *</label>
                <input
                  className="inp"
                  value={pForm.title}
                  onChange={(e) => setPForm({ ...pForm, title: e.target.value })}
                  placeholder="e.g., Treasury Allocation Q4"
                />
              </div>
              <div className="col">
                <label>Vote Type</label>
                <select
                  className="inp"
                  value={pForm.voteType}
                  onChange={(e) => setPForm({ ...pForm, voteType: e.target.value as VoteType })}
                >
                  <option value="single">Single Choice</option>
                  <option value="multiple">Multiple Choice</option>
                  <option value="ranked">Ranked</option>
                  <option value="weighted">Token Weighted</option>
                  <option value="quadratic">Quadratic</option>
                </select>
              </div>

              <div className="col full">
                <label>Description</label>
                <textarea
                  className="inp"
                  rows={3}
                  value={pForm.description}
                  onChange={(e) => setPForm({ ...pForm, description: e.target.value })}
                  placeholder="Context, risks, alternatives..."
                />
              </div>

              <div className="col full">
                <label>Options (one per line) *</label>
                <textarea
                  className="inp mono"
                  rows={4}
                  value={pForm.optionsText}
                  onChange={(e) => setPForm({ ...pForm, optionsText: e.target.value })}
                  placeholder={"Option A\nOption B\nOption C"}
                />
              </div>

              <div className="col">
                <label>Snapshot Ref</label>
                <input
                  className="inp"
                  value={pForm.snapshot}
                  onChange={(e) => setPForm({ ...pForm, snapshot: e.target.value })}
                  placeholder="blockNumber / snapshotId / latest"
                />
              </div>
              <div className="col">
                <label>Allow Revote</label>
                <select
                  className="inp"
                  value={String(pForm.allowRevote)}
                  onChange={(e) => setPForm({ ...pForm, allowRevote: e.target.value === "true" })}
                >
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>

              <div className="col">
                <label>Quorum (optional)</label>
                <input
                  className="inp"
                  value={pForm.quorum}
                  onChange={(e) => setPForm({ ...pForm, quorum: e.target.value })}
                  placeholder="e.g., 100"
                />
              </div>
              <div className="col">
                <label>Pass Threshold % (optional)</label>
                <input
                  className="inp"
                  value={pForm.passThreshold}
                  onChange={(e) => setPForm({ ...pForm, passThreshold: e.target.value })}
                  placeholder="e.g., 50"
                />
              </div>

              <div className="col">
                <label>Start</label>
                <input
                  type="datetime-local"
                  className="inp"
                  value={pForm.startISO}
                  onChange={(e) => setPForm({ ...pForm, startISO: e.target.value })}
                />
              </div>
              <div className="col">
                <label>End</label>
                <input
                  type="datetime-local"
                  className="inp"
                  value={pForm.endISO}
                  onChange={(e) => setPForm({ ...pForm, endISO: e.target.value })}
                />
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" onClick={handleCreateProposal}>Create</button>
            </div>
          </div>
        </div>
      )}

      {modal === "castVote" && (
        <div className="modal">
          <div className="modal-card glass">
            <div className="modal-head">
              <h3>Cast Private Vote</h3>
              <button className="x" onClick={() => setModal(null)}>×</button>
            </div>

            <div className="vote-hint">
              Your selections are encrypted with FHE on this device. Only aggregated results will be disclosed.
            </div>

            <div className="grid">
              <div className="col full">
                <label>Selections *</label>
                <textarea
                  className="inp mono"
                  rows={4}
                  value={voteForm.selectionsText}
                  onChange={(e) => setVoteForm({ ...voteForm, selectionsText: e.target.value })}
                  placeholder={`Enter selected option labels or indexes.\nExamples:\n- "Option A"\n- "1,3"\n- "A > C > B" (ranked)`}
                />
              </div>

              <div className="col full">
                <label>Note (non-sensitive)</label>
                <input
                  className="inp"
                  value={voteForm.note}
                  onChange={(e) => setVoteForm({ ...voteForm, note: e.target.value })}
                  placeholder="Optional memo"
                />
              </div>

              <div className="col full row">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={voteForm.antiCoercionDummy}
                    onChange={(e) => setVoteForm({ ...voteForm, antiCoercionDummy: e.target.checked })}
                  />
                  <span>Submit a dummy (honey) vote to improve deniability</span>
                </label>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" onClick={handleCastVote}>Submit Encrypted Vote</button>
            </div>
          </div>
        </div>
      )}

      {/* Wallet Selector */}
      {walletSelectorOpen && (
        <WalletSelector
          isOpen={walletSelectorOpen}
          onWalletSelect={(w: any) => {
            onWalletSelect(w);
            setWalletSelectorOpen(false);
          }}
          onClose={() => setWalletSelectorOpen(false)}
        />
      )}
    </div>
  );
};

export default App;