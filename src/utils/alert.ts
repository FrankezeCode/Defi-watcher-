import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import path from "path";

// dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../.env") }); // adjust path if needed



// --- Config ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

// Bot instance
let bot: TelegramBot | null = null;

if (token && chatId) {
  bot = new TelegramBot(token, { polling: false });
  console.log("✅ Telegram bot initialized");
} else {
  console.warn(
    "⚠️ Telegram not configured. Alerts will be printed to console only."
  );
}

// --- Rate-limit queue ---
interface AlertItem {
  message: string;
}

const ALERT_QUEUE: AlertItem[] = [];
let sending = false;
const TELEGRAM_INTERVAL_MS = 1000; // send 1 message/sec max to avoid Telegram limits

function processQueue() {
  if (!bot || sending || ALERT_QUEUE.length === 0) return;

  sending = true;
  const item = ALERT_QUEUE.shift()!;
  bot
    .sendMessage(chatId!, item.message)
    .catch((err) =>
      console.error("Telegram send error:", err?.message ?? err)
    )
    .finally(() => {
      sending = false;
      if (ALERT_QUEUE.length > 0) {
        setTimeout(processQueue, TELEGRAM_INTERVAL_MS);
      }
    });
}

/**
 * Sends an alert message to Telegram (rate-limited)
 * Falls back to console if Telegram is not configured
 */
export function sendAlert(message: string) {
  const time = new Date().toISOString();
  const payload = `[${time}] ${message}`;

  if (!bot) {
    console.log("ALERT:", payload);
    return;
  }

  // Add to queue
  ALERT_QUEUE.push({ message: payload });
  processQueue();
}

