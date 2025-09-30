// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * FHE_Governance_Voting.sol
 *
 * FHE Shareholders' Meeting — Governance & Voting
 * ------------------------------------------------
 * This contract demonstrates a privacy-preserving governance workflow designed
 * for corporate/DAO shareholders’ meetings. It is written to be FRONTEND-FRIENDLY
 * and to satisfy the following integration rules that the user requested:
 *
 *  1) A universal KV store exposed via:
 *        - function isAvailable() public pure returns (bool)
 *        - function setData(string calldata key, bytes calldata value) external
 *        - function getData(string calldata key) external view returns (bytes memory)
 *     These three methods are the only methods a generic frontend MUST rely on.
 *
 *  2) Rich governance features are implemented UNDER THE HOOD to show an
 *     “FHE-style” design: proposals, encrypted ballots, nullifiers, weighted
 *     models, and auditable events. These functions can be used by advanced
 *     frontends or off-chain services, while simple frontends can still work
 *     through the universal KV interface above.
 *
 *  3) No real homomorphic cryptography is executed on-chain (as that would
 *     require specialized precompiles). Instead, this contract is structured
 *     to support FHE off-chain workflows:
 *        - Ballots are uploaded as ciphertexts (bytes).
 *        - Aggregation is represented by publishing only totals + a proof blob.
 *        - Individual plaintext choices are never stored on-chain.
 *
 * SECURITY NOTE
 * -------------
 * - This is a reference design demonstrating data shapes and audit flows.
 * - Production FHE integration must replace the off-chain pieces with a real
 *   FHE client + on-chain verification, or a hybrid approach with ZK proofs.
 *
 * © 2025 FHE Governance. All rights reserved.
 */

/// @notice Minimal interface for ERC20 balance queries (for token-weighted voting)
interface IERC20Like {
    function balanceOf(address who) external view returns (uint256);
}

contract FHE_Governance_Voting {
    // ---------------------------------------------------------------------
    // Universal KV Store (Frontend Contract Interface)
    // ---------------------------------------------------------------------

    event DataStored(address indexed sender, string key, bytes value);

    mapping(bytes32 => bytes) private _kv;

    /// @notice Health check (required by frontend integration spec)
    function isAvailable() public pure returns (bool) {
        return true;
    }

    /**
     * @notice Set an arbitrary value under a string key.
     * @dev    This is intentionally generic so different apps can share a single adapter.
     */
    function setData(string calldata key, bytes calldata value) external {
        bytes32 h = keccak256(abi.encodePacked(key));
        _kv[h] = value;
        emit DataStored(msg.sender, key, value);
    }

    /**
     * @notice Read raw bytes for a given string key.
     */
    function getData(string calldata key) external view returns (bytes memory) {
        bytes32 h = keccak256(abi.encodePacked(key));
        return _kv[h];
    }

    // ---------------------------------------------------------------------
    // Domain Types for Governance
    // ---------------------------------------------------------------------

    enum WeightModel {
        OneShareOneVote,   // each unit of share counts 1
        TokenWeighted,     // weight = ERC20 balance
        Quadratic          // weight = sqrt(shares or token balance)
    }

    enum ProposalStatus {
        Active,
        Finalized,
        Cancelled
    }

    struct Proposal {
        string id;                // human-friendly id (e.g., "1700000000-q41x2a")
        string title;
        string description;
        uint64 createdAt;         // unix seconds
        uint64 deadline;          // unix seconds
        address createdBy;        // organizer
        WeightModel model;        // how weights are computed
        bool optFor;              // option enabled
        bool optAgainst;          // option enabled
        bool optAbstain;          // option enabled
        ProposalStatus status;    // lifecycle
    }

    struct EncryptedBallot {
        // FHE ciphertext blob (opaque to the chain)
        bytes ciphertext;
        // Nullifier prevents duplicate votes per (proposal, voter).
        // We bind this to msg.sender in this reference design,
        // but other identity schemes (soulbound, passport) can be added off-chain.
        bytes32 nullifier; // keccak256(abi.encodePacked(proposalId, voterAddressLowercase))
        uint64 submittedAt;
    }

    struct AggregatedResult {
        // Only publish totals. DO NOT store any plaintext ballots.
        uint256 totalFor;
        uint256 totalAgainst;
        uint256 totalAbstain;
        uint256 totalWeight;
        // Optional proof blob (ZK/FHE) attesting correct aggregation.
        bytes proof;
        uint64 finalizedAt;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    // Proposals by string id
    mapping(string => Proposal) private _proposals;
    // Existence map
    mapping(string => bool) private _proposalExists;
    // Index list (for discovery)
    string[] private _proposalIds;

    // Encrypted ballots: proposalId => voter => EncryptedBallot
    mapping(string => mapping(address => EncryptedBallot)) private _ballots;
    // Simple flag to check "has voted" quickly
    mapping(string => mapping(address => bool)) private _hasVoted;

    // Aggregated results by proposalId
    mapping(string => AggregatedResult) private _results;
    mapping(string => bool) private _hasResult;

    // Optional: token used for TokenWeighted model
    IERC20Like public weightToken;
    // Optional: mapping of address => shares (for OneShareOneVote / Quadratic if using off-chain register)
    mapping(address => uint256) public registeredShares;
    address public owner;

    // ---------------------------------------------------------------------
    // Events (Auditable)
    // ---------------------------------------------------------------------

    event ProposalCreated(string indexed id, address indexed creator, uint64 deadline, WeightModel model);
    event ProposalFinalized(string indexed id, uint256 totalFor, uint256 totalAgainst, uint256 totalAbstain, uint256 totalWeight);
    event ProposalCancelled(string indexed id);
    event BallotSubmitted(string indexed id, address indexed voter, bytes32 nullifier);
    event ResultPublished(string indexed id, bytes proof);
    event SharesRegistered(address indexed who, uint256 shares);
    event WeightTokenUpdated(address indexed token);

    // ---------------------------------------------------------------------
    // Access Control (simple owner)
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor(address initialOwner, address tokenForWeights) {
        owner = initialOwner == address(0) ? msg.sender : initialOwner;
        if (tokenForWeights != address(0)) {
            weightToken = IERC20Like(tokenForWeights);
            emit WeightTokenUpdated(tokenForWeights);
        }
    }

    // ---------------------------------------------------------------------
    // Owner Utilities
    // ---------------------------------------------------------------------

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        owner = newOwner;
    }

    function setWeightToken(address token) external onlyOwner {
        weightToken = IERC20Like(token);
        emit WeightTokenUpdated(token);
    }

    /// @notice Register or update shares for address-based weighting.
    function setShares(address who, uint256 shares) external onlyOwner {
        registeredShares[who] = shares;
        emit SharesRegistered(who, shares);
    }

    // ---------------------------------------------------------------------
    // Proposal Lifecycle
    // ---------------------------------------------------------------------

    function createProposal(
        string calldata id_,
        string calldata title_,
        string calldata description_,
        uint64 deadline_,
        WeightModel model_,
        bool enableFor,
        bool enableAgainst,
        bool enableAbstain
    ) external {
        require(!_proposalExists[id_], "id exists");
        require(bytes(id_).length > 0, "empty id");
        require(deadline_ > block.timestamp, "deadline in past");
        require(enableFor || enableAgainst || enableAbstain, "no options");

        Proposal memory p = Proposal({
            id: id_,
            title: title_,
            description: description_,
            createdAt: uint64(block.timestamp),
            deadline: deadline_,
            createdBy: msg.sender,
            model: model_, 
            optFor: enableFor,
            optAgainst: enableAgainst,
            optAbstain: enableAbstain,
            status: ProposalStatus.Active
        });

        _proposals[id_] = p;
        _proposalExists[id_] = true;
        _proposalIds.push(id_);

        emit ProposalCreated(id_, msg.sender, deadline_, model_);
    }

    function cancelProposal(string calldata id_) external {
        require(_proposalExists[id_], "not found");
        Proposal storage p = _proposals[id_];
        require(msg.sender == p.createdBy || msg.sender == owner, "no perm");
        require(p.status == ProposalStatus.Active, "not active");
        p.status = ProposalStatus.Cancelled;
        emit ProposalCancelled(id_);
    }

    // ---------------------------------------------------------------------
    // Voting — Encrypted Ballots with Nullifiers
    // ---------------------------------------------------------------------

    /**
     * @notice Submit an encrypted ballot.
     * @dev    Ciphertext is opaque bytes produced off-chain by an FHE client.
     *         The nullifier binds (proposalId, voterAddressLowercase) to prevent duplicates.
     *         The contract does not store any plaintext choice.
     */
    function submitEncryptedBallot(
        string calldata id_,
        bytes calldata ciphertext_,
        bytes32 nullifier_
    ) external {
        require(_proposalExists[id_], "proposal not found");
        Proposal memory p = _proposals[id_];
        require(p.status == ProposalStatus.Active, "not active");
        require(block.timestamp < p.deadline, "voting closed");
        require(!_hasVoted[id_][msg.sender], "already voted");
        require(ciphertext_.length > 0, "empty ciphertext");

        // Basic nullifier check: must match the expected pattern for this sender
        bytes32 expected = keccak256(abi.encodePacked(_toLowerAddr(msg.sender), id_));
        require(nullifier_ == expected, "bad nullifier");

        _ballots[id_][msg.sender] = EncryptedBallot({
            ciphertext: ciphertext_,
            nullifier: nullifier_,
            submittedAt: uint64(block.timestamp)
        });
        _hasVoted[id_][msg.sender] = true;

        emit BallotSubmitted(id_, msg.sender, nullifier_);
    }

    /// @notice Whether an address has already submitted a ballot.
    function hasVoted(string calldata id_, address who) external view returns (bool) {
        return _hasVoted[id_][who];
    }

    /// @notice Get a raw encrypted ballot (for off-chain FHE aggregation).
    function getEncryptedBallot(string calldata id_, address voter) external view returns (EncryptedBallot memory) {
        return _ballots[id_][voter];
    }

    // ---------------------------------------------------------------------
    // Finalization — Publish Aggregated Totals + Proof
    // ---------------------------------------------------------------------

    /**
     * @notice Publish aggregated result (totals only) and attach a proof blob.
     * @dev    The actual aggregation must be computed off-chain using FHE over
     *         the ciphertexts, then verified and posted here. We only store
     *         totals and a proof (e.g., ZK) that can be audited.
     */
    function publishAggregatedResult(
        string calldata id_,
        uint256 totalFor_,
        uint256 totalAgainst_,
        uint256 totalAbstain_,
        uint256 totalWeight_,
        bytes calldata proof_
    ) external {
        require(_proposalExists[id_], "proposal not found");
        Proposal storage p = _proposals[id_];
        require(msg.sender == p.createdBy || msg.sender == owner, "no perm");
        require(p.status == ProposalStatus.Active, "not active");
        require(block.timestamp >= p.deadline, "deadline not reached");
        require(!_hasResult[id_], "already finalized");

        AggregatedResult memory r = AggregatedResult({
            totalFor: totalFor_,
            totalAgainst: totalAgainst_,
            totalAbstain: totalAbstain_,
            totalWeight: totalWeight_,
            proof: proof_,
            finalizedAt: uint64(block.timestamp)
        });

        _results[id_] = r;
        _hasResult[id_] = true;
        p.status = ProposalStatus.Finalized;

        emit ProposalFinalized(id_, totalFor_, totalAgainst_, totalAbstain_, totalWeight_);
        emit ResultPublished(id_, proof_);
    }

    function getResult(string calldata id_) external view returns (AggregatedResult memory) {
        return _results[id_];
    }

    function hasResult(string calldata id_) external view returns (bool) {
        return _hasResult[id_];
    }

    function getProposal(string calldata id_) external view returns (Proposal memory) {
        require(_proposalExists[id_], "not found");
        return _proposals[id_];
    }

    function listProposals(uint256 start, uint256 limit) external view returns (Proposal[] memory out) {
        uint256 n = _proposalIds.length;
        if (start >= n) return new Proposal[](0);
        uint256 end = start + limit;
        if (end > n) end = n;
        uint256 m = end - start;
        out = new Proposal[](m);
        for (uint256 i = 0; i < m; i++) {
            out[i] = _proposals[_proposalIds[start + i]];
        }
    }

    function proposalsCount() external view returns (uint256) {
        return _proposalIds.length;
    }

    // ---------------------------------------------------------------------
    // Weight Helpers (view)
    // ---------------------------------------------------------------------

    function voterWeight(address who, WeightModel model) public view returns (uint256) {
        if (model == WeightModel.OneShareOneVote) {
            return registeredShares[who];
        } else if (model == WeightModel.TokenWeighted) {
            if (address(weightToken) == address(0)) return 0;
            return weightToken.balanceOf(who);
        } else {
            // Quadratic — sqrt of shares/balance
            uint256 base = registeredShares[who];
            if (address(weightToken) != address(0)) {
                uint256 bal = weightToken.balanceOf(who);
                if (bal > base) base = bal; // choose the larger base for demo
            }
            return _sqrt(base);
        }
    }

    // ---------------------------------------------------------------------
    // Internal Helpers
    // ---------------------------------------------------------------------

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        // Babylonian method
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _toLowerAddr(address a) internal pure returns (string memory) {
        // Represent address as lowercase hex without 0x (for deterministic nullifier message)
        bytes20 b = bytes20(a);
        bytes memory s = new bytes(40);
        bytes16 hexSymbols = 0x30313233343536373839616263646566; // '0'...'f'
        for (uint256 i = 0; i < 20; i++) {
            uint8 hi = uint8(b[i] >> 4);
            uint8 lo = uint8(b[i] & 0x0f);
            s[2 * i] = bytes1(hexSymbols[hi]);
            s[2 * i + 1] = bytes1(hexSymbols[lo]);
        }
        return string(s);
    }

    // ---------------------------------------------------------------------
    // Convenience: Mirror important records into KV for generic frontends
    // ---------------------------------------------------------------------
    // These helpers are OPTIONAL. They allow an off-chain service (or the
    // proposal creator) to export proposals and results into the universal KV
    // so a no-ABI frontend can read them via getData("key").
    // Keys used here follow the same convention as the user's React app:
    //   - "gv_proposal_keys" -> JSON array of proposal ids
    //   - "gv_proposal_<id>" -> JSON of Proposal
    //   - "gv_result_<id>"   -> JSON of AggregatedResult
    // NOTE: Strings are encoded as UTF-8 JSON outside the contract; we store bytes.

    function mirrorProposalIntoKV(string calldata id_) external {
        require(_proposalExists[id_], "not found");
        // We do not JSON-encode on-chain; the off-chain caller should provide serialized payloads.
        // This function is kept as a stub for future extension if needed.
        // In current integration, generic frontends call setData directly with JSON bytes.
        revert("use setData off-chain with serialized JSON");
    }

    function mirrorResultIntoKV(string calldata id_) external view returns (bytes memory) {
        require(_hasResult[id_], "no result");
        // Return ABI-encoded result so off-chain can turn it into JSON and then setData()
        AggregatedResult memory r = _results[id_];
        return abi.encode(r.totalFor, r.totalAgainst, r.totalAbstain, r.totalWeight, r.proof, r.finalizedAt);
    }
}
