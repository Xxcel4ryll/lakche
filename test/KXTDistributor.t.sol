// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {KXTDistributor} from "../contracts/KXTDistributor.sol";

contract MockKXT is ERC20 {
    constructor() ERC20("KonectX Token", "KXT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract KXTDistributorTest is Test {
    uint256 constant FUNDING = 1_000_000 ether;

    MockKXT kxt;
    KXTDistributor distributor;

    address admin = makeAddr("admin");
    address rootSetter = makeAddr("rootSetter");
    address pauser = makeAddr("pauser");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address relayer = makeAddr("relayer");

    function setUp() public {
        kxt = new MockKXT();
        distributor = new KXTDistributor(kxt, admin);
        bytes32 rootSetterRole = distributor.ROOT_SETTER_ROLE();
        bytes32 pauserRole = distributor.PAUSER_ROLE();
        vm.startPrank(admin);
        distributor.grantRole(rootSetterRole, rootSetter);
        distributor.grantRole(pauserRole, pauser);
        vm.stopPrank();
        kxt.mint(address(distributor), FUNDING);
    }

    // --- helpers ------------------------------------------------------------------------------

    function _leaf(address account, uint256 cumulativeAmount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
    }

    /// Builds a 2-leaf tree by hand and publishes its root. OpenZeppelin's MerkleProof hashes each
    /// pair in sorted order, so the root is keccak256 of the smaller leaf followed by the larger one,
    /// and each leaf's proof is just its sibling.
    function _publishTwoLeafRoot(address a, uint256 amountA, address b, uint256 amountB)
        internal
        returns (bytes32[] memory proofA, bytes32[] memory proofB)
    {
        bytes32 leafA = _leaf(a, amountA);
        bytes32 leafB = _leaf(b, amountB);
        bytes32 root = leafA < leafB
            ? keccak256(abi.encodePacked(leafA, leafB))
            : keccak256(abi.encodePacked(leafB, leafA));

        vm.prank(rootSetter);
        distributor.setMerkleRoot(root);

        proofA = new bytes32[](1);
        proofA[0] = leafB;
        proofB = new bytes32[](1);
        proofB[0] = leafA;
    }

    // --- roles and roots ----------------------------------------------------------------------

    function test_SetMerkleRoot_IncrementsEpochAndEmits() public {
        bytes32 root = keccak256("root-1");
        vm.expectEmit(address(distributor));
        emit KXTDistributor.MerkleRootUpdated(1, bytes32(0), root);
        vm.prank(rootSetter);
        distributor.setMerkleRoot(root);

        assertEq(distributor.epoch(), 1);
        assertEq(distributor.merkleRoot(), root);
    }

    function test_RevertWhen_NonRoleSetsRoot() public {
        bytes32 role = distributor.ROOT_SETTER_ROLE();
        // Not even the admin can set a root without being granted the role.
        address[2] memory outsiders = [alice, admin];
        for (uint256 i; i < outsiders.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsiders[i], role)
            );
            vm.prank(outsiders[i]);
            distributor.setMerkleRoot(keccak256("evil"));
        }
        assertEq(distributor.epoch(), 0);
    }

    function test_RevertWhen_NonRolePausesOrUnpauses() public {
        bytes32 role = distributor.PAUSER_ROLE();
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        vm.prank(alice);
        distributor.pause();

        vm.prank(pauser);
        distributor.pause();
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        vm.prank(alice);
        distributor.unpause();
    }

    function test_RevertWhen_RootIsZero() public {
        vm.expectRevert(KXTDistributor.ZeroRoot.selector);
        vm.prank(rootSetter);
        distributor.setMerkleRoot(bytes32(0));
    }

    // --- claims -------------------------------------------------------------------------------

    function test_Claim_PaysAccountWhoeverSubmits() public {
        (bytes32[] memory proofAlice,) = _publishTwoLeafRoot(alice, 100 ether, bob, 40 ether);

        vm.expectEmit(address(distributor));
        emit KXTDistributor.Claimed(alice, 1, 100 ether, 100 ether);
        vm.prank(relayer);
        distributor.claim(alice, 100 ether, proofAlice);

        assertEq(kxt.balanceOf(alice), 100 ether);
        assertEq(kxt.balanceOf(relayer), 0);
        assertEq(distributor.claimed(alice), 100 ether);
    }

    function test_Claim_HigherRootPaysOnlyTheDifference() public {
        (bytes32[] memory proofAlice1,) = _publishTwoLeafRoot(alice, 100 ether, bob, 40 ether);
        distributor.claim(alice, 100 ether, proofAlice1);

        (bytes32[] memory proofAlice2, bytes32[] memory proofBob2) = _publishTwoLeafRoot(alice, 250 ether, bob, 90 ether);
        vm.expectEmit(address(distributor));
        emit KXTDistributor.Claimed(alice, 2, 150 ether, 250 ether);
        distributor.claim(alice, 250 ether, proofAlice2);
        assertEq(kxt.balanceOf(alice), 250 ether);

        // Bob skipped epoch 1, so his first claim pays his whole cumulative amount.
        distributor.claim(bob, 90 ether, proofBob2);
        assertEq(kxt.balanceOf(bob), 90 ether);
        assertEq(kxt.balanceOf(address(distributor)), FUNDING - 340 ether);
    }

    function test_RevertWhen_ClaimedTwice() public {
        (bytes32[] memory proofAlice,) = _publishTwoLeafRoot(alice, 100 ether, bob, 40 ether);
        distributor.claim(alice, 100 ether, proofAlice);

        vm.expectRevert(KXTDistributor.NothingToClaim.selector);
        distributor.claim(alice, 100 ether, proofAlice);
        assertEq(kxt.balanceOf(alice), 100 ether);
    }

    function test_RevertWhen_ProofIsWrong() public {
        (bytes32[] memory proofAlice, bytes32[] memory proofBob) = _publishTwoLeafRoot(alice, 100 ether, bob, 40 ether);

        vm.expectRevert(KXTDistributor.InvalidProof.selector);
        distributor.claim(alice, 101 ether, proofAlice); // inflated amount

        vm.expectRevert(KXTDistributor.InvalidProof.selector);
        distributor.claim(alice, 100 ether, proofBob); // someone else's proof

        vm.expectRevert(KXTDistributor.InvalidProof.selector);
        distributor.claim(relayer, 100 ether, proofAlice); // alice's entitlement redirected

        assertEq(kxt.balanceOf(address(distributor)), FUNDING);
    }

    function test_RevertWhen_Paused() public {
        (bytes32[] memory proofAlice,) = _publishTwoLeafRoot(alice, 100 ether, bob, 40 ether);
        vm.prank(pauser);
        distributor.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        distributor.claim(alice, 100 ether, proofAlice);

        vm.prank(pauser);
        distributor.unpause();
        distributor.claim(alice, 100 ether, proofAlice);
        assertEq(kxt.balanceOf(alice), 100 ether);
    }

    function test_RevertWhen_Underfunded_StateIsRolledBack() public {
        (bytes32[] memory proofAlice,) = _publishTwoLeafRoot(alice, FUNDING + 1, bob, 40 ether);
        vm.expectRevert();
        distributor.claim(alice, FUNDING + 1, proofAlice);
        assertEq(distributor.claimed(alice), 0);
    }

    // --- fuzz ---------------------------------------------------------------------------------

    /// Across two epochs, whoever submits, the account ends up with exactly its latest cumulative
    /// amount: the first claim pays `first`, the second pays only `increase`, and an unchanged amount
    /// pays nothing.
    function testFuzz_ClaimsPayExactlyTheCumulativeAmount(uint256 first, uint256 increase, address caller) public {
        first = bound(first, 1, FUNDING / 2);
        increase = bound(increase, 0, FUNDING / 2);
        uint256 second = first + increase;

        (bytes32[] memory proof1,) = _publishTwoLeafRoot(alice, first, bob, 1 ether);
        vm.prank(caller);
        distributor.claim(alice, first, proof1);
        assertEq(kxt.balanceOf(alice), first);

        (bytes32[] memory proof2,) = _publishTwoLeafRoot(alice, second, bob, 1 ether);
        if (increase == 0) vm.expectRevert(KXTDistributor.NothingToClaim.selector);
        vm.prank(caller);
        distributor.claim(alice, second, proof2);

        assertEq(kxt.balanceOf(alice), second);
        assertEq(distributor.claimed(alice), second);
        assertEq(kxt.balanceOf(address(distributor)), FUNDING - second);
    }
}
