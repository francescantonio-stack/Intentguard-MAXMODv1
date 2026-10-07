import { parseAbi } from "viem";

const PLAN = "(address account,uint256 amountIn,uint256 swapAmount,uint256 minAmountOut,bool unwrap,uint256 nonce,uint256 deadline)";
const AUTH = "(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s)";

export const erc20Abi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

export const cctpAbi = parseAbi([
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
  "function receiveMessage(bytes message,bytes attestation) returns (bool)",
]);

export const planExecutorAbi = parseAbi([
  `function execute(${PLAN} plan,${AUTH} auth) returns (uint256 amountOut,uint256 vaultShares)`,
  `function planHash(${PLAN} plan) view returns (bytes32)`,
  "function nonces(address) view returns (uint256)",
  "function remainingThisPeriod(address) view returns (uint256)",
  "function registerPasskey(bytes32 x,bytes32 y,uint256 weeklyCap)",
  "function passkeys(address) view returns (bytes32 x,bytes32 y)",
  "error NotRegistered()",
  "error InvalidSignature()",
  "error BadNonce(uint256 expected,uint256 got)",
  "error Expired()",
  "error AlreadyExecuted()",
  "error InvalidAmounts()",
  "error OverPlanLimit(uint256 amountIn,uint256 maxPlanAmount)",
  "error OverWeeklyCap(uint256 requested,uint256 remaining)",
  "error AlreadyRegistered()",
  "error InvalidCap()",
  "event PlanExecuted(bytes32 indexed planHash,address indexed account,uint256 amountIn,uint256 swapAmount,uint256 amountOut,uint256 vaultShares)",
]);

export const miniSwapAbi = parseAbi([
  "function getAmountOut(address tokenIn,uint256 amountIn) view returns (uint256)",
  "function getReserves() view returns (uint256,uint256)",
  "function token0() view returns (address)",
]);
