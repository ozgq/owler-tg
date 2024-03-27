const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
require('dotenv').config();

const db = new sqlite3.Database('./app.db');
const token = process.env.TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log("Bot is running");

bot.onText(/\/start/, (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `Welcome to Owler for Telegram

\/verify <username> <password> - Verify yourself to begin posting
\/update <text> - Update the world on what you're doing
\/get <user> - Get user's last update

Go to https://owler.cloud to sign up for an account!`);
});

bot.onText(/\/verify (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const [username, password] = match[1].split(' ');
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  bot.deleteMessage(chatId, msg.message_id);

  axios.all([
    axios.post('https://api.owler.cloud/v1/account/verify_credentials.json', null, {
      headers: { 'Authorization': `Basic ${auth}` }
    }),
    axios.get(`https://api.owler.cloud/v1/users/show/${username}.json`)
  ])
    .then(axios.spread((res1, res2) => {
      db.run(`INSERT INTO "main"."users" ("userId", "owlerAuth", "owlerId") VALUES ('${chatId}', '${auth}', '${res2.data.id}');`);
      bot.sendMessage(chatId, "Successfully authenticated. Try /update");
    }))
    .catch(function (error) {
      console.error('Error:', error.response ? error.response.data : error.message);
      bot.sendMessage(chatId, "Owler couldn't authenticate. Check your credentials?");
    });
});

bot.onText(/\/update (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const resp = match[1];

  if (!resp) {
    bot.sendMessage(chatId, "Please provide a status to update.");
    return;
  }

  db.get(`SELECT owlerAuth FROM users WHERE userId = ${chatId}`, (err, user) => {
    if (err) {
      console.error('Error fetching user:', err);
      bot.sendMessage(chatId, 'Error fetching user');
    } else {
      if (user && user.owlerAuth) {
        axios({
          method: 'post',
          url: `https://api.owler.cloud/v1/statuses/update.json?status=${encodeURIComponent(resp)}&source=tg`,
          headers: { 'Authorization': `Basic ${user.owlerAuth}` },
        })
          .then(function (response) {
            bot.sendMessage(chatId, "Posted to owler.cloud :D");
          })
          .catch(function (error) {
            console.error('API Request Error:', error.response ? error.response.data : error.message);
            bot.sendMessage(chatId, "Owler couldn't update. Try again?");
          });
      } else {
        bot.sendMessage(chatId, 'User not found. Try /verify <username> <password>.');
      }
    }
  });
});

bot.onText(/\/ping/, (msg, match) => {
  const chatId = msg.chat.id;

  db.get(`SELECT owlerAuth FROM users WHERE userId = ${chatId}`, (err, user) => {
    if (err) {
      console.error('Error fetching user:', err);
      bot.sendMessage(chatId, 'Error fetching user');
    } else {
      console.log('User from database:', user);

      if (user && user.owlerAuth) {
        bot.sendMessage(chatId, 'Pong! You are signed in.');
      } else {
        bot.sendMessage(chatId, 'Pong! You are not signed into Owler. Try /verify <username> <password>.');
      }
    }
  });
});

bot.onText(/\/get (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const resp = match[1];

  if (!resp) {
    bot.sendMessage(chatId, "Please provide a user.");
    return;
  }

  axios({
    method: 'get',
    url: `https://api.owler.cloud/v1/statuses/user_timeline/${resp}.json?count=1`,
  })
    .then(function (response) {
      if (response.data.length === 0) {
        bot.sendMessage(chatId, `${resp} has no recent statuses.`);
        return;
      }

      const statusText = response.data[0]?.text || "no recent status found.";

      bot.sendMessage(chatId, `${resp}: ${statusText} @ ${response.data[0]?.created_at} from ${response.data[0]?.source}`);
    })
    .catch(function (error) {
      if (error.response) {
        const errorMessage = error.response.data.error || "An error occurred.";
        bot.sendMessage(chatId, errorMessage);
      } else {
        bot.sendMessage(chatId, "An unexpected error occurred.");
      }
    });
});

function fetchHomeTimeline(userId, user) {
  console.log('Start of fetchHomeTimeline function');

  axios({
    method: 'get',
    url: 'https://api.owler.cloud/v1/statuses/home_timeline.json?count=1&page=1',
    headers: { 'Authorization': `Basic ${user.owlerAuth}` },
  })
    .then(function (response) {
      console.log('API Response:', response.data);

      if (response.data && response.data.length > 0) {
        db.get('SELECT owlerId, lastUpdateId FROM users WHERE userId = ?', [userId], (err, row) => {
          if (err) {
            console.error('Error fetching user details:', err);
          } else {
            console.log('User details:', row);

            if (row.owlerId == response.data[0].user.id) {
              console.log('Skipped own update.');
            } else {
              console.log('Checking for duplicates...');

              if (row.lastUpdateId == response.data[0].id) {
                console.log('Skipped duplicate');
              } else {
                console.log('Processing new update...');

                const statusText = response.data[0].text || 'no recent status found.';
                console.log('Sending message:', `${response.data[0].user.screen_name}: ${statusText}`);
                bot.sendMessage(userId, `${response.data[0].user.screen_name}: ${statusText}`);
                
                db.run(`UPDATE users SET lastUpdateId = ? WHERE userId = ?`, [response.data[0].id, userId], (updateErr) => {
                  if (updateErr) {
                    console.error('Error updating lastUpdateId:', updateErr);
                  } else {
                    console.log('lastUpdateId updated');
                  }
                });
              }
            }
          }
        });
      }
    })
    .catch(function (error) {
      console.error('API Request Error:', error.response ? error.response.data : error.message);
    });
}

function pingUpdates() {
  db.all('SELECT userId, owlerAuth, owlerId FROM users WHERE owlerAuth IS NOT NULL AND owlerId IS NOT NULL', (err, rows) => {
    if (err) {
      console.error('Error fetching users from the database:', err);
    } else {
      rows.forEach((row) => {
        const userId = row.userId;
        const user = row;

        fetchHomeTimeline(userId, user);
      });
    }
  });
}

pingUpdates();
setInterval(pingUpdates, 60000);