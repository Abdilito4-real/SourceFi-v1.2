// lib/arcEscrowConfig.ts
//
// Contract address + ABI for the SourceFiEscrow contract deployed to Arc
// Testnet during ETHOnline 2026. New for the hackathon — the contract
// itself lives in a separate repo (github.com/Ubaidreak/sourcefi-arc-escrow)
// per Continuity track submission rules; this file is what lets THIS app
// call the already-deployed contract by address.

export const SOURCEFI_ESCROW_ADDRESS = "0xd3a97B44C0D6DD006C29f71180938a5A4EE9B13D" as const;

// Arc Testnet's USDC ERC-20 interface (confirmed against docs.arc.io)
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS = 6;

export const SOURCEFI_ESCROW_ABI = [
  {
    type: "function",
    name: "fundOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "supplier", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "confirmDelivery",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "raiseDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "evidenceURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "buyer", type: "address" },
          { name: "supplier", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fundedAt", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
] as const;

export const USDC_ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;