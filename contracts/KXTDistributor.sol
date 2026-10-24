// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract KXTDistributor is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant ROOT_SETTER_ROLE = keccak256("ROOT_SETTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable kxt;
    bytes32 public merkleRoot;
    uint256 public epoch;
    mapping(address => uint256) public claimed;

    event MerkleRootUpdated(uint256 indexed epoch, bytes32 previousRoot, bytes32 newRoot);
    event Claimed(address indexed account, uint256 indexed epoch, uint256 amount, uint256 cumulativeAmount);

    error ZeroAddress();
    error ZeroRoot();
    error InvalidProof();
    error NothingToClaim();

    constructor(IERC20 _kxt, address admin) {
        if (address(_kxt) == address(0) || admin == address(0)) revert ZeroAddress();
        kxt = _kxt;
        // Only the admin role is granted here. The admin then grants ROOT_SETTER_ROLE and PAUSER_ROLE
        // to separate keys, so no single key holds every power.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // Leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))))
    // Allowed while paused, so a bad root can be replaced before claims resume.
    function setMerkleRoot(bytes32 newRoot) external onlyRole(ROOT_SETTER_ROLE) {
        if (newRoot == bytes32(0)) revert ZeroRoot();
        bytes32 previousRoot = merkleRoot;
        merkleRoot = newRoot;
        epoch += 1;
        emit MerkleRootUpdated(epoch, previousRoot, newRoot);
    }

    /// Anyone may submit the claim for `account`, e.g. a relayer paying gas for an operator who holds
    /// no CELO. This is safe because the caller controls neither who is paid nor how much: the leaf
    /// binds `account` to its cumulative amount, tokens are only ever sent to `account`, and the payout
    /// is fixed by the root and `claimed[account]`. The most a third party can do is pay the gas to
    /// deliver the operator's own tokens earlier than the operator would have.
    function claim(address account, uint256 cumulativeAmount, bytes32[] calldata proof) external whenNotPaused {
        // Checks
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();
        uint256 alreadyClaimed = claimed[account];
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim();
        uint256 amount = cumulativeAmount - alreadyClaimed;

        // Effects
        claimed[account] = cumulativeAmount;
        emit Claimed(account, epoch, amount, cumulativeAmount);

        // Interactions
        kxt.safeTransfer(account, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
