// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title StrategyAuditLog
 * @notice Emit-only on-chain intent audit trail for Mantle hackathon demo.
 *         No custody — events link swap intents to executed transactions via intentHash.
 */
contract StrategyAuditLog {
    event IntentLogged(
        bytes32 indexed intentHash,
        address indexed user,
        string action,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint16 maxSlippageBps,
        uint8 riskScore,
        uint256 timestamp
    );

    function logIntent(
        bytes32 intentHash,
        address user,
        string calldata action,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint16 maxSlippageBps,
        uint8 riskScore
    ) external {
        emit IntentLogged(
            intentHash,
            user,
            action,
            tokenIn,
            tokenOut,
            amountIn,
            maxSlippageBps,
            riskScore,
            block.timestamp
        );
    }
}
