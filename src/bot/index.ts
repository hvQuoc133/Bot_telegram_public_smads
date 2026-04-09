import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { handleMessage } from './core/messageHandler';
import { handleCallbackQuery } from './core/callbackHandler';
import { setupCommands } from './utils/setupCommands';
import { bot } from './botInstance';
import { startScheduler } from './services/scheduler';
import { setupConfigCostCommand } from './commands/configCost';

export function initBot() {
  // Setup commands for the menu button
  setupCommands(bot);

  // Setup config cost command
  setupConfigCostCommand(bot);

  // Start the background scheduler
  startScheduler();

  // Handle incoming messages
  bot.on('message', handleMessage);

  // Handle inline keyboard callbacks
  bot.on('callback_query', handleCallbackQuery);

  // Error handling
  bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
  });
}
