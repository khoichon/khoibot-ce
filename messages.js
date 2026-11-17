const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const messagesFilePath = path.join(__dirname, 'messages.yaml');
const messagesFileContents = fs.readFileSync(messagesFilePath, 'utf8');
if (messagesFileContents.charCodeAt(0) === 0xFEFF) {
    messagesFileContents = messagesFileContents.slice(1);
}
let messages = yaml.load(messagesFileContents);

const getMessage = (key) => {
  const messageList = messages[key];
  if (!messageList) {
    throw new Error(`Message key "${key}" not found in messages.yaml`);
  }
  const randomIndex = Math.floor(Math.random() * messageList.length);
  return messageList[randomIndex];
};

module.exports = { getMessage };