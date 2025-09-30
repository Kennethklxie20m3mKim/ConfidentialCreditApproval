# DAOPrivacyVotingFHE

Privacy-preserving DAO proposal voting powered by Fully Homomorphic Encryption (FHE) on **fhEVM** (Zama).  
Individual ballots remain encrypted end-to-end; only **aggregate results** (if policy allows) may be decrypted under threshold control, or the system can run in **minimal disclosure** mode with ZK proofs.

> Version: 1.0.0 • Build date: 2025-09-30 11:45:02 UTC

---

## ✨ Key Features

- **Encrypted ballots on-chain** using fhEVM `euint`/`ebool` types
- **Homomorphic tallying** (sum/argmax) without decrypting ballots
- Multiple voting modes:
  - Single-choice / Multi-choice
  - **Token-weighted** (snapshot block)
  - **Quadratic voting** (client transforms with sqrt under ZK)
  - (Optional) Ranked choice (Borda-like, client computes encrypted scores)
- **Anti-sybil** with eligibility nullifiers & Merkle allowlist placeholder
- **Overwrite before deadline** (last-vote-wins) and **delegation** (private choice)
- **Disclosure policies**:
  - **Minimal**: Publish ZK proof + ordering/winner only
  - **AggregateOnly**: Threshold decrypt aggregate tallies *only*

---

## 🧱 File List

- `DAOPrivacyVotingFHE.sol` — fhEVM-compatible Solidity contract (≥300 LOC)
- `README.md` — this document

Download:
- [DAOPrivacyVotingFHE.sol](sandbox:/mnt/data/DAOPrivacyVotingFHE.sol)
- [README.md](sandbox:/mnt/data/README.md)

---

## ⚠️ Prerequisites

This repository targets **Zama fhEVM**. Ensure you have:
- fhEVM-compatible toolchain and network
- Access to `TFHE` library and encrypted types (`euintXX`, `ebool`)
- A prover/verifier stack for the ZK proofs referenced here (not included)

> The contract ships with **TFHE stubs** so it can pass generic Solidity linters.  
> When compiling for fhEVM, **remove stubs** and import real fhEVM headers instead.

---

## 🚀 Deploy

1. Configure your fhEVM RPC/chain and compiler.
2. Compile and deploy `DAOPrivacyVotingFHE.sol`.
3. (Optional) Set a timelock executor:
   ```solidity
   setTimelock(0xYourTimelock);
   ```

---

## 🗳️ Workflow Overview

1. **Create proposal**
   ```solidity
   ProposalMeta meta = ProposalMeta(
     "Title",
     "Description",
     startTs,
     endTs,
     bufferTs,                 // anti-rush window
     VoteType.SingleChoice,    // or MultiChoice/Quadratic/TokenWeighted/RankedChoice
     Disclosure.Minimal,       // or AggregateOnly
     optionCount,
     snapshotBlock,
     eligibilityMerkle,
     true,   // enableOverwrite
     true,   // enableDelegation
     true    // exists (set internally)
   );
   createProposal(meta);
   ```

2. **Submit encrypted ballots**
   - Client builds encrypted vector `euint64[optionCount]`:
     - Single-choice: one-hot
     - Quadratic: sqrt(stake) encoded under ZK
   - Produce ZK proofs of *valid vote* and (if needed) *weight correctness*.
   - Call `submitBallot(pid, nullifier, cipher)` to store opaque ciphertext for auditing.
   - Optionally call `accumulateEncryptedVector(pid, encVector)` periodically (aggregator/relayer).

3. **Finalize**
   - After `endTs + bufferTs`, call `finalize(pid)`.
   - If `Disclosure.Minimal`: publish ZK showing correct ordering & winner.
   - If `AggregateOnly`: committee threshold-decrypts **only** aggregate tallies and publishes values.

---

## 🔐 Eligibility & Anti-Sybil

- **Eligibility nullifier**: `bytes32` per identity; contract enforces 1 ballot per nullifier.
- **Overwrite** allowed if enabled: last ballot is effective; earlier ones are invalidated.
- **Merkle allowlist** placeholder via `setAllowlistRoot` (verify proofs in a separate verifier or with ZK).

---

## 🧮 Tallies & Decryption

- Tallies are stored as encrypted vectors `euint64[]` per proposal.
- Use `allowAggregateView(pid, viewer)` to grant aggregate decryption *if policy permits*.
- Never decrypt individual ballots.

---

## 📦 Front-End Hooks

- `isAvailable()` for health check.
- `getProposal(pid)` / `getEncryptedTally(pid)` for UI rendering.
- `hasVoted(pid, addr)` / `ballotMeta(pid, addr)` for participation UX.
- `submitBallot(...)` and `accumulateEncryptedVector(...)` for voting/aggregation.

> Pair this contract with your existing `WalletManager`, `WalletSelector`, and fhEVM-ready provider.

---

## 🛡️ Notes & Limitations

- The on-chain argmax and vector arithmetic are **outlined**; use real TFHE ops in fhEVM.
- ZK circuits and verifiers are not included; integrate your stack (Circom/Halo2/etc.).
- Gas/size of encrypted payloads require batching and/or an aggregator/rollup design.

---

## 📄 License

MIT
