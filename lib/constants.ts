// lib/constants.ts
//
// Styling tokens (C, inputStyle, primaryBtn, Label, StatusBadge) used to
// live here as inline-style objects — superseded by components/ui/* and
// the Tailwind tokens in app/globals.css. This file is now data/business
// logic only: the material catalog, chain config, and the on-chain
// transfer helper.
import type { Material } from "./types";

export const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
};

export const ARC_USDC_ERC20_ADDRESS = "0x3600000000000000000000000000000000000000";

export const ERC20_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
] as const;

export const materialLibrary: Material[] = [
  {
    id: "earthblocks",
    name: "Compressed Earth Blocks (CEB)",
    tag: "Stabilized raw earth",
    savings: "Up to 40% less carbon",
    hook: "Non-fired, high-density blocks made from locally sourced soil and structural binders.",
    explainer: "Compressed Earth Blocks are manufactured by compressing damp soil mixed with stabilizers (such as cement or lime) in a manual or hydraulic press. Unlike traditional clay bricks, they are cured naturally in the sun rather than fired in a kiln, preserving forests and cutting carbon footprint drastically while offering dense, highly soundproof thermal mass walls.",
    whyRare: "Local hydraulic CEB pressing yards in Nigeria are sparse and scattered. Most commercial contractors lack on-site soil testing and press availability.",
    metrics: "290x140x110mm standard modular",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "bubbledeck",
    name: "BubbleDeck Slabs",
    tag: "HDPE void balls",
    savings: "Up to 35% less concrete",
    hook: "Hollow plastic spheres replace non-structural concrete in the slab's core.",
    explainer: "BubbleDeck slabs eliminate dead weight by substituting solid concrete in the center of the structural slab with hollow plastic spheres. This hollow core reduces the slab's dead load, enabling longer spans, thinner floors, fewer columns, and major structural savings on foundation steel.",
    whyRare: "Almost no material suppliers or structural stockists in Nigeria carry these HDPE voids locally. Most specified BubbleDeck projects require custom imports.",
    metrics: "270mm-360mm spherical voids",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "lc3cement",
    name: "LC3 Cement",
    tag: "Limestone Calcined Clay",
    savings: "Up to 40% CO2 reduction",
    hook: "Low-carbon cement blend utilizing calcined clay and limestone to substitute clinker.",
    explainer: "LC3 is a revolutionary cement blend that replaces up to 50% of carbon-intensive clinker with a combination of calcined clay and ground limestone. It achieves equivalent structural strength and durability to standard Ordinary Portland Cement (OPC) while dramatically lowering raw manufacturing emissions.",
    whyRare: "Calcination facilities for structural clay remain in early-stage pilot phases across Nigeria. Commercial distributors still favor standard high-clinker OPC.",
    metrics: "Type IL calcined clay composite",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "geopolymer",
    name: "Geopolymer Concrete",
    tag: "Fly ash / slag binder",
    savings: "Clinker-free concrete",
    hook: "Alkali-activated industrial byproduct binders completely replace Portland cement.",
    explainer: "Geopolymer concrete utilizes industrial byproducts like fly ash, blast furnace slag, or metakaolin activated by alkaline liquids to form a durable binder. This completely eliminates Portland cement, resulting in superb acid resistance, zero clinker emissions, and high early compressive strength.",
    whyRare: "Ready-mix batching plants in Nigeria do not stock liquid alkaline activators or maintain dry-blend slag fly ash storage bins natively.",
    metrics: "30-50 MPa heavy industrial grade",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "hempcrete",
    name: "Hempcrete Blocks",
    tag: "Hemp hurd / lime binder",
    savings: "Carbon-negative walls",
    hook: "Carbon-sequestering composite insulating material made of hemp hurds and hydrated lime.",
    explainer: "Hempcrete is a bio-composite building material made of woody hemp plant cores (hurds) mixed with a lime-based binder. As the hemp grows, it sequesters carbon dioxide, making the final cured blocks carbon-negative over their lifecycle while providing superior insulating and vapor-permeable performance.",
    whyRare: "Hemp cultivation and structural processing infrastructure are in early regulatory phases. No domestic commercial industrial lime blending exists.",
    metrics: "R-value R-2.4 per inch thermal",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "bamboo",
    name: "Structural Bamboo",
    tag: "Laminated Guadua / Dendrocalamus",
    savings: "High tensile rapid renewal",
    hook: "Vetted, treated bamboo columns offering rapid-growth alternative to heavy structural timber.",
    explainer: "Vetted structural bamboo poles represent a rapid-renewal alternative to structural steel and timber. Properly treated with boron salts, structural bamboo poles resist insect attacks, withstand intense seismic shifts, and offer excellent strength-to-weight ratios.",
    whyRare: "Lack of commercial boron-treating preservation facilities and standardized grade-stamping yards for structural bamboo in West Africa.",
    metrics: "80-120mm curated load diameter",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "recycledplastic",
    name: "Recycled Plastic Products",
    tag: "Polymer-wood composites",
    savings: "Zero-rot weather resistance",
    hook: "Compressed high-density structural lumber and composite panels made from municipal plastic waste.",
    explainer: "Polymer-composite building panels are produced by shredding and compressing municipal plastic waste (like HDPE and LDPE) with organic fibers. This creates ultra-dense, zero-rot, completely waterproof cladding boards, structural decking, and formwork boards that outperform natural timber in wet tropical environments.",
    whyRare: "Recycling plants with high-pressure polymer extrusion and composite stabilizing equipment are scarce; most local plastic recycling focuses on PET bottles.",
    metrics: "100% recycled HDPE/LDPE planks",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "passivecooling",
    name: "Passive Cooling Materials",
    tag: "Phase Change Materials (PCM)",
    savings: "Up to 50% HVAC load savings",
    hook: "Thermal energy storage materials that absorb heat during the day and release it at night.",
    explainer: "Phase Change Materials (PCMs) are micro-encapsulated organic paraffin compounds integrated into wallboards or ceiling tiles. They absorb excess thermal heat when room temperature rises and solidify as it cools, stabilizing interior environments and slashing AC energy demand.",
    whyRare: "Almost entirely imported as specialized chemical products. No local supply network exists for structural insulation builders in West Africa.",
    metrics: "21°C - 23°C phase transition shift",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "structuralsystems",
    name: "Light-Gauge Steel Systems",
    tag: "Cold-formed steel framing",
    savings: "90% faster wall erection",
    hook: "Cold-rolled structural steel profiles offering precise, rapid, lightweight structural framing.",
    explainer: "Light-gauge steel framing utilizes structural C and U sections cold-formed from thin galvanized sheets. It provides a lightweight, mold-proof, termite-proof, and fully recyclable framing solution that speeds up multi-story construction schedules immensely.",
    whyRare: "High-precision roll-forming mill operators with local structural design software integration are limited; structural steel remains expensive.",
    metrics: "0.8mm - 1.6mm galvanized structural",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "cement",
    name: "Rapid-Hardening Cement",
    tag: "High-early strength OPC",
    savings: "48-hour formwork strippage",
    hook: "Fine-ground Ordinary Portland Cement designed to achieve high initial compressive strength.",
    explainer: "Rapid-hardening cement is ground to a much higher fineness than traditional OPC. This accelerates the hydration process, allowing concrete to achieve equivalent 7-day strength in just 48 hours, enabling contractors to strip structural formwork early and speed up high-rise frame schedules.",
    whyRare: "Domestic cement plants in Nigeria rarely batch high-fineness OPC on standard run; most specialized rapid cement requires custom mill orders.",
    metrics: "CEMI 52.5R high-early strength",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "tiles",
    name: "Porcelain Raised Access Tiles",
    tag: "Elevated structural tiles",
    savings: "Clean underfloor service runs",
    hook: "Modular porcelain tiles on adjustable pedestals to route active cables and cooling underfoot.",
    explainer: "Raised porcelain floor systems elevate modular porcelain tiles on heavy-duty structural pedestals. This leaves a continuous underfloor chamber to route active power lines, cooling ducts, and IT fiber cables freely, eliminating wall-chasing and permitting rapid office reconfiguration.",
    whyRare: "Standard structural pedestals and dense modular porcelain tiles are rarely stocked in local outlets; mostly imported on-demand.",
    metrics: "600x600x20mm high-traffic modular",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  {
    id: "steel",
    name: "GFRP Reinforcing Bars",
    tag: "Glass-Fiber Rebar",
    savings: "Zero rust, 100-year life",
    hook: "High-tensile, non-corrosive glass-fiber rebar to replace carbon steel in concrete.",
    explainer: "Glass Fiber Reinforced Polymer (GFRP) rebar is a high-strength concrete reinforcement that can never rust, even when exposed to harsh saltwater or humid coastal environments. It is 4x lighter than steel, offers 2x higher tensile strength, and eliminates concrete spalling permanently.",
    whyRare: "No domestic GFRP factories exist in West Africa. Structural engineers default to traditional carbon steel due to unfamiliarity with polymer codes.",
    metrics: "8mm - 16mm tensile profile bar",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
];

/** Deliberately minimal rather than importing Privy's ConnectedWallet type:
 * this function only ever calls these two members, and pinning to Privy's
 * exact type surface would make this file break on every Privy upgrade
 * that renames something we don't even use. */
export interface EthereumWalletLike {
  address: string;
  getEthereumProvider: () => Promise<{
    request: (args: { method: string; params: unknown[] }) => Promise<string>;
  }>;
}

export async function sendUsdcOnArc(
  activeWallet: EthereumWalletLike | null | undefined,
  recipientAddress: string,
  amount: number
): Promise<string> {
  if (!activeWallet) throw new Error("No active connected wallet found.");

  // Get the Ethereum provider from the Privy wallet
  const provider = await activeWallet.getEthereumProvider();

  // Format standard float number to 18-decimal hex value
  const weiValue = BigInt(Math.floor(amount * 1e18));
  const hexValue = "0x" + weiValue.toString(16);

  // Send native transfer tx
  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: activeWallet.address,
        to: recipientAddress,
        value: hexValue,
      },
    ],
  });

  return txHash;
}
