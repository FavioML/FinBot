const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'placeholder',
  timeout: 60000,
  maxRetries: 3,
});

module.exports = { openai };
