// Encodes PlanExecutor.execute(plan, webauthnAuth). Usage: node encode_execute.mjs '<plan json>' '<auth json>'
import { encodeFunctionData, parseAbi } from 'viem';
const abi = parseAbi(['function execute((address account,uint256 amountIn,uint256 swapAmount,uint256 minAmountOut,bool unwrap,uint256 nonce,uint256 deadline) plan,(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s) auth)']);
const p = JSON.parse(process.argv[2]), a = JSON.parse(process.argv[3]);
const plan = { account: p[0], amountIn: BigInt(p[1]), swapAmount: BigInt(p[2]), minAmountOut: BigInt(p[3]), unwrap: p[4], nonce: BigInt(p[5]), deadline: BigInt(p[6]) };
console.log(encodeFunctionData({ abi, functionName: 'execute', args: [plan, { ...a, challengeIndex: BigInt(a.challengeIndex), typeIndex: BigInt(a.typeIndex) }] }));
