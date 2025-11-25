// ========================= WATCHER BOT (MULTI-PROVIDER + ALCHEMY STREAMS) =========================
//
// Includes:
// - Multi-provider WebSocket redundancy
// - Aave on-chain event listeners
// - Alchemy pending + mined transaction subscriptions (decoded for user address)
// - Telegram alerts
//
// Core Goals: ⚙️ Effectiveness ⚡ Efficiency 🚀 Lowest latency
//

import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers, type BigNumberish, formatUnits } from "ethers";
import dotenv from "dotenv";
import { sendAlert } from "./utils/alert";
import path from "path";
import { Alchemy, Network, AlchemySubscription  } from "alchemy-sdk";

// dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../.env") }); // adjust path if needed
console.log("AAVE_POOL:", process.env.AAVE_POOL)
console.log("WSS_URL:", process.env.WSS_URL)

// ========================= CONFIG =========================
const PROVIDER_URLS = [
  process.env.WSS_URL!, // primary (Alchemy)
  process.env.WSS_URL_SECONDARY ?? "", // optional fallback
].filter(Boolean);

const AAVE_POOL = process.env.AAVE_POOL!;
const HF_THRESHOLD = parseFloat(process.env.HEALTH_FACTOR_THRESHOLD ?? "1.05");
const USER_DEBOUNCE_SECONDS = parseInt(process.env.USER_DEBOUNCE_SECONDS ?? "30", 10);
const MAX_CONCURRENT_CHECKS = parseInt(process.env.MAX_CONCURRENT_CHECKS ?? "4", 10);
const FULL_SCAN_INTERVAL = parseInt(process.env.FULL_SCAN_INTERVAL ?? "900", 10) * 1000;
const TEST_MODE = process.env.TEST_MODE === "true";

// ========================= CONCURRENCY & DEBOUNCE =========================
let activeChecks = 0;
const activeUsers = new Set<string>();
const lastCheck = new Map<string, number>();
const userHealthCache = new Map<string, number>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
function shouldSkipUser(user: string): boolean {
  const last = lastCheck.get(user);
  if (!last) return false;
  return nowSeconds() - last < USER_DEBOUNCE_SECONDS;
}
function parseHealthFactor(hf: BigNumberish): number {
  try {
    return parseFloat(formatUnits(hf, 18));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ========================= MULTI-PROVIDER SETUP =========================
import type { WebSocketProvider } from "ethers";

let activeProvider: WebSocketProvider | null = null;
const providers: WebSocketProvider[] = [];

for (const url of PROVIDER_URLS) {
  const provider = new ethers.WebSocketProvider(url);
  const ws: any = provider.websocket;

  ws?.on?.("open", () => {
    console.log(`✅ WebSocket connected: ${url}`);
    if (!activeProvider) activeProvider = provider;
  });

  ws?.on?.("close", (code: number) => {
    console.warn(`⚠️ WebSocket closed (${code}): ${url}`);
    const fallback = providers.find((p) => p !== provider);
    if (fallback) {
      console.log(`🔁 Switching active provider to fallback.`);
      activeProvider = fallback;
    } else {
      console.warn(`❌ No fallback provider available.`);
      activeProvider = null;
    }
  });

  ws?.on?.("error", (err: any) => {
    console.error(`❌ WebSocket error (${url}):`, err);
  });

  providers.push(provider);
}

if (!activeProvider && providers.length > 0) {
  activeProvider = providers[0] ?? null;
}

// ========================= PROVIDER & CONTRACT =========================
interface AavePoolContract extends ethers.BaseContract {
  getUserAccountData(user: string): Promise<{
    totalCollateralBase: BigNumberish;
    totalDebtBase: BigNumberish;
    availableBorrowsBase: BigNumberish;
    currentLiquidationThreshold: BigNumberish;
    ltv: BigNumberish;
    healthFactor: BigNumberish;
  }>;
}

const AAVE_POOL_ABI = [
  "event Borrow(address indexed user, address indexed reserve, uint256 amount, uint256 borrowRateMode, uint256 borrowRate, uint16 indexed referral)",
  "event Repay(address indexed user, address indexed reserve, uint256 amount)",
  "event Deposit(address indexed user, address indexed reserve, uint256 amount, uint16 indexed referral)",
  "event Withdraw(address indexed user, address indexed reserve, uint256 amount)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const poolContract = new ethers.Contract(
  AAVE_POOL,
  AAVE_POOL_ABI,
  activeProvider ?? providers[0]
) as unknown as AavePoolContract;

// ========================= ACTION HANDLER =========================
async function handleLiquidation(user: string, hf: number): Promise<void> {
  if (TEST_MODE) {
    const msg = `💥 LIQUIDATION ALERT (TEST MODE)
User: ${user}
HealthFactor: ${hf.toFixed(6)}
Threshold: ${HF_THRESHOLD}`;
    console.log(msg);
    void sendAlert(msg);
  } else {
    console.log(`💥 Flashloan execution triggered for ${user} (hf=${hf})`);
    // TODO: integrate flashloan executor here
  }
}

// ========================= USER HEALTH CHECK =========================
async function checkUserHealth(user: string): Promise<void> {
  if (activeUsers.has(user)) return;
  if (shouldSkipUser(user)) return;
  if (activeChecks >= MAX_CONCURRENT_CHECKS) return;

  activeChecks++;
  activeUsers.add(user);
  lastCheck.set(user, nowSeconds());

  try {
    const accountData = await poolContract.getUserAccountData(user);
    const hf = parseHealthFactor(accountData.healthFactor);
    const lastHf = userHealthCache.get(user) ?? Infinity;

    if (hf === lastHf) return;
    userHealthCache.set(user, hf);

    if (hf <= HF_THRESHOLD) await handleLiquidation(user, hf);
  } catch (err: any) {
    console.error("Error checking user health:", err?.message ?? err);
  } finally {
    activeChecks--;
    activeUsers.delete(user);
  }
}

// ========================= EVENT HANDLERS =========================
function onUserEvent(user: string): void {
  checkUserHealth(user.toLowerCase());
}

// ========================= AAVE EVENT SUBSCRIPTIONS =========================
providers.forEach((provider, i) => {
  const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider) as unknown as AavePoolContract;

  ["Borrow", "Repay", "Deposit", "Withdraw"].forEach((evt) => {
    pool.on(evt, (user: string) => onUserEvent(user));
  });

  pool.on(
    "LiquidationCall",
    (
      collateralAsset: string,
      debtAsset: string,
      user: string,
      debtToCover: BigNumberish,
      liquidatedCollateralAmount: BigNumberish,
      liquidator: string,
      receiveAToken: boolean,
      event
    ) => {
      const msg = `💥 Liquidation Executed (on-chain)
user: ${user}
collateral: ${collateralAsset}
debtAsset: ${debtAsset}
debtToCover: ${formatUnits(debtToCover, 18)}
collateralAmount: ${formatUnits(liquidatedCollateralAmount, 18)}
tx: ${event.transactionHash ? `https://etherscan.io/tx/${event.transactionHash}` : "unknown"}`;
      console.log(msg);
      void sendAlert(msg);
    }
  );

  console.log(`👂 Provider #${i + 1} subscribed to Aave events.`);
});


// ========================= ⚡ ALCHEMY TX STREAMS (ENHANCED) =========================
//
// Detects liquidation txs *before* they're mined, decodes the user,
// and instantly verifies health.
//


// Initialize Alchemy WebSocket client
const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY!, // 🔑 ensure this is defined in your .env
  network: Network.MATIC_MAINNET,       // Polygon mainnet
});

try {
  const iface = new ethers.Interface([
    "function liquidationCall(address,address,address,uint256,bool)",
  ]);

  // ⚡ Listen for pending transactions to AAVE_POOL
  alchemy.ws.on(
    {
      method: AlchemySubscription.PENDING_TRANSACTIONS,
      toAddress: [AAVE_POOL],
    },
    async (tx) => {
      try {
        if (tx?.input?.startsWith("0x00aa2d")) {
          const decoded = iface.decodeFunctionData("liquidationCall", tx.input);
          const user = decoded[2];
          console.log(`⚡ Pending liquidation attempt detected for: ${user}`);
          void checkUserHealth(user); // instant health verification
        }
      } catch (err) {
        console.warn("⚠️ Pending tx decode failed:", err);
      }
    }
  );

  // 💥 Listen for confirmed (mined) liquidation transactions
  alchemy.ws.on(
    {
      method: AlchemySubscription.MINED_TRANSACTIONS,
      addresses: [{ to: AAVE_POOL }],
    },
    (tx) => {
      try {
        console.log(`💥 Confirmed liquidation mined: ${tx.transaction.hash}`);
        void sendAlert(
          `💥 Confirmed liquidation mined\nTx: https://polygonscan.com/tx/${tx.transaction.hash}`
        );
      } catch (err) {
        console.warn("⚠️ Mined tx handler failed:", err);
      }
    }
  );

  console.log("🚀 Alchemy Polygon TX Streams active (pending + mined).");
} catch (err) {
  console.error("⚠️ Failed to initialize Alchemy Streams:", err);
}




// ========================= PERIODIC FULL SCAN =========================
const allUsers: string[] = []; // TODO: populate dynamically from Aave Subgraph

async function fullScan(): Promise<void> {
  console.log("🔄 Running periodic full scan...");
  for (const user of allUsers) {
    await checkUserHealth(user);
  }
}

setInterval(() => {
  fullScan().catch((err) => console.error("Full scan error:", err));
}, FULL_SCAN_INTERVAL);

console.log(`🚀 Aave v3 hybrid liquidation watcher started [TEST_MODE=${TEST_MODE}]`);
