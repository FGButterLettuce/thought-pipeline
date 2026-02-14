// Thyme Bot - Telegram bot that spawns AI Thyme for intelligent responses
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

const BOT_TOKEN = process.env.THYME_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('THYME_BOT_TOKEN not set in .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const USER_ID = '1709443757';
const RESPONSE_DIR = path.join(__dirname, 'data', 'thyme-responses');

// Ensure response directory exists
fs.mkdirSync(RESPONSE_DIR, { recursive: true });

console.log('🌿 Thyme is awake and watching...');

// Handle /start
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  bot.sendMessage(USER_ID, 
    `🌿 Hello! I'm Thyme, your time management companion.\n\n` +
    `I can help you:\n` +
    `• Plan your day and calculate travel times\n` +
    `• Send LEAVE NOW reminders\n` +
    `• Create calendar events\n` +
    `• Manage your schedule\n\n` +
    `Try:\n` +
    `• "Plan my afternoon"\n` +
    `• "I need to be at Dubai Mall by 3 PM"\n` +
    `• "Remind me to leave in 30 minutes"`
  );
});

// Handle /help
bot.onText(/\/help/, (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  bot.sendMessage(USER_ID,
    `🌿 *Thyme Commands:*\n\n` +
    `Just message me naturally:\n` +
    `• "Plan my afternoon"\n` +
    `• "I need to be at [place] by [time]"\n` +
    `• "Remind me to [task] in [time]"\n` +
    `• "What's my schedule today?"`,
    { parse_mode: 'Markdown' }
  );
});

// Check for pending responses every 5 seconds
setInterval(() => {
  fs.readdir(RESPONSE_DIR, (err, files) => {
    if (err) return;
    files.filter(f => f.endsWith('.json')).forEach(file => {
      const filepath = path.join(RESPONSE_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        bot.sendMessage(data.chatId, data.message, {
          reply_to_message_id: data.replyTo
        });
        fs.unlinkSync(filepath); // Delete after sending
      } catch (e) {
        console.error('Failed to process response:', e.message);
      }
    });
  });
}, 5000);

// Forward non-command messages to OpenClaw agent
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  if (msg.text?.startsWith('/')) return;
  
  const text = msg.text;
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const responseId = Date.now().toString();
  
  // Send acknowledgment
  bot.sendMessage(USER_ID, '🌿 Thinking...', { reply_to_message_id: messageId });
  
  // Prepare the task for Thyme agent
  const task = `You are Thyme, Niranjan's time management AI companion.
Read your persona from /home/niranjan/.openclaw/workspace/agents/thyme.md.

Niranjan just messaged you: "${text.replace(/"/g, '\\"')}"

Respond helpfully and concisely (2-4 sentences max). Address him as "Niranjan".

Your response must be written to this file: ${path.join(RESPONSE_DIR, responseId + '.json')}

Write ONLY this exact JSON format, nothing else:
{"chatId":"${chatId}","message":"YOUR_RESPONSE_HERE","replyTo":${messageId}}

Replace YOUR_RESPONSE_HERE with your actual response (escape quotes properly).`;

  // Spawn Thyme agent
  const { spawn } = require('child_process');
  const child = spawn('openclaw', ['sessions_spawn', '--label', 'thyme-' + responseId, '--task', task, '--agentId', 'main', '--timeoutSeconds', '60'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
});

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Thyme polling error:', error);
});

console.log('🌿 Thyme bot is running and listening for messages...');