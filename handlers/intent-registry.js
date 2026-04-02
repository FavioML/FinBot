const fs = require('fs');
const path = require('path');

const handlers = {};
const intentsDir = path.join(__dirname, 'intents');
const files = fs.readdirSync(intentsDir).filter(f => f.endsWith('.js'));

for (const file of files) {
  const mod = require(path.join(intentsDir, file));
  if (mod.intents && mod.handle) {
    for (const intent of mod.intents) {
      handlers[intent] = mod.handle;
    }
  }
}

function getHandler(intent) {
  return handlers[intent] || null;
}

module.exports = { getHandler };
