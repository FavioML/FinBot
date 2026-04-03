const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'placeholder',
  timeout: 30000,
  maxRetries: 1,
});

module.exports = { openai };
