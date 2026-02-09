const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Address } = require('ton');
require('dotenv').config();
const POWER_DB = require('./power.json');

const bot = new TelegramBot(process.env.API_TOKEN, { polling: true });

const ACCOUNT_ID = '0:39d63083e48f46452ff8a04cd0d3733a90c8be299aa5951b62741759b2c17e0e';
const TARGET_COLLECTION = 'Unstoppable Tribe from ZarGates';

const pendingQueue = {};
const sentNfts = new Map();
const ignoredNfts = new Set();

const sendQueue = [];
let sending = false;

let nftInterval = null;
let pendingInterval = null;

const CHAT_ID = -1003888068464;
const MAX_PENDING_TIME = 5 * 60 * 1000; // 5 минут
const SENT_TTL = 10 * 60 * 1000; // повторно показывать NFT через 10 минут
let last429Log = 0;

// -------------------- safe GET с backoff --------------------
async function safeGet(url, params = {}) {
  let tries = 0;
  let wait = 2000;
  while (tries < 5) {
    try {
      const { data } = await axios.get(url, { params });
      return data;
    } catch (e) {
      if (e.response?.status === 429) {
        const now = Date.now();
        if (now - last429Log > 5000) {
          console.warn(`⏳ 429 rate limit, повтор через ${wait}мс`);
          last429Log = now;
        }
        await new Promise(r => setTimeout(r, wait));
        tries++;
        wait *= 2;
      } else {
        console.error('❌ HTTP ошибка:', e.message);
        return null;
      }
    }
  }
  return null;
}

// -------------------- TON address → friendly --------------------
function toFriendlyAddress(rawAddress) {
  try {
    return Address.parse(rawAddress).toString({ urlSafe: true });
  } catch {
    return null;
  }
}

// -------------------- Getgems link --------------------
function getSaleLink(nft) {
  if (!nft?.address) return null;
  const friendly = toFriendlyAddress(nft.address);
  return friendly ? `https://getgems.io/nft/${friendly}` : null;
}

// -------------------- last NFT addresses --------------------
async function getLastNftAddresses(limit = 10) {
  const data = await safeGet(`https://tonapi.io/v2/accounts/${ACCOUNT_ID}/nfts/history`, { limit });
  if (!data) return [];
  return (data.operations ?? []).map(op => op.item?.address).filter(Boolean);
}

// -------------------- NFT data --------------------
async function getNftData(nftId) {
  return await safeGet(`https://tonapi.io/v2/nfts/${nftId}`);
}

// -------------------- best image --------------------
function getBestImage(nft) {
  if (!Array.isArray(nft.previews)) return null;
  return nft.previews
    .filter(p => p.url?.startsWith('https://'))
    .sort((a, b) => Number(b.resolution.split('x')[0]) - Number(a.resolution.split('x')[0]))[0]?.url || null;
}

// -------------------- бонус за числа --------------------
function getNumberPowerBonus(nft, powerDb) {
  let bonus = 0;
  const textToScan = [
    nft.metadata?.name || '',
    ...(Array.isArray(nft.metadata?.attributes) ? nft.metadata.attributes.map(a => a.value) : [])
  ].join(' ');

  for (const np of powerDb.number_power) {
    const regex = new RegExp(`\\b${np.sticker_number}\\b`, 'g');
    if (regex.test(textToScan)) {
      bonus += np.power;
    }
  }

  return bonus;
}

// -------------------- send NFT с учетом синергии и Number --------------------
async function sendNft(nft) {
  if (!CHAT_ID || !nft) return;

  let name = nft.metadata?.name || 'Без названия';
  const price = nft.sale ? Number(nft.sale.price.value) / 1e9 : null;
  const image = getBestImage(nft);
  const saleLink = getSaleLink(nft);
  if (!image) return;

  let attributesText = '';
  let totalPower = 0;
  const attrNamesForSynergy = [];
  const attrMap = {};

  if (Array.isArray(nft.metadata?.attributes)) {
    nft.metadata.attributes.forEach(a => {
      let type = a.trait_type;
      if (type.toLowerCase().includes('earring') && POWER_DB.attributes['Earrings']) type = 'Earrings';
      if (type.toLowerCase().includes('cap') && POWER_DB.attributes['Cap']) type = 'Cap';

      const attrPowerObj = POWER_DB.attributes[type]?.find(attr => attr.name === a.value);
      const power = attrPowerObj ? attrPowerObj.power : 0;
      totalPower += power;
      attrMap[a.value] = type;

      if (type !== 'Skin Tone') attrNamesForSynergy.push(a.value);
    });
  }

// --------- расчет синергии ---------
  const synergyAttrList = []; // заменяем Set на массив
  for (let i = 0; i < attrNamesForSynergy.length; i++) {
    const words1 = attrNamesForSynergy[i].split(/\s+/);
    for (let j = i + 1; j < attrNamesForSynergy.length; j++) {
      const words2 = attrNamesForSynergy[j].split(/\s+/);
      if (words1.some(w1 => words2.some(w2 =>
        POWER_DB.synergy.some(s => w1.toLowerCase().startsWith(s.toLowerCase()) && w2.toLowerCase().startsWith(s.toLowerCase()))
      ))) {
        synergyAttrList.push(attrNamesForSynergy[i]);
        synergyAttrList.push(attrNamesForSynergy[j]);
      }
    }
  }
  
  let synergyBonus = 0;
  const synergyCount = synergyAttrList.length; // теперь учитываем все повторения
  if (synergyCount === 2) synergyBonus = 100;
  else if (synergyCount >= 3) synergyBonus = 300;
  
  if (Array.isArray(nft.metadata?.attributes)) {
    nft.metadata.attributes.forEach(a => {
      const power = POWER_DB.attributes[attrMap[a.value]]?.find(attr => attr.name === a.value)?.power || 0;
      const isSynergy = synergyAttrList.includes(a.value); // проверка через массив
      attributesText += `• ${a.trait_type}: ${a.value}⚡${power} ${isSynergy ? ' (Synergy)' : ''}\n`;
    });
  }
  
  if (synergyCount === 0) name += ' (без Synergy)';
  
  // --------- бонус за числа ---------
  const numberBonus = getNumberPowerBonus(nft, POWER_DB);
  const totalPowerFinal = totalPower + synergyBonus + numberBonus;
	
  let numberTextTop = '';
  if (numberBonus === 500) numberTextTop = '💥 Крутой номер!';
  else if (numberBonus === 1000) numberTextTop = '🔥 Невероятный номер!';
  else if (numberBonus === 5000) numberTextTop = '🍀 Самый счастливый номер!';

  let powerText = `⚡${totalPowerFinal}`;
  const bonusParts = [];
  if (synergyBonus && !numberBonus) bonusParts.push(`в том числе Synergy +${synergyBonus}`);
  if (numberBonus && !synergyBonus) bonusParts.push(`в том числе Number +${numberBonus}`);
  if (numberBonus && synergyBonus) bonusParts.push(`в том числе Synergy +${synergyBonus} и Number +${numberBonus}`);

  if (bonusParts.length) powerText += ` (${bonusParts.join(', ')})`;

  const caption = `
${numberTextTop ? numberTextTop + '\n' : ''}
🖼 <b>${name}</b>
💰 Цена: ${price ? price + ' TON' : 'в pending'}
<b>💪 Общая сила: ${powerText}</b>

${saleLink ? `🛒 <a href="${saleLink}">Купить на Getgems</a>\n` : ''}
${attributesText.trim()}
`.trim();

  await bot.sendPhoto(CHAT_ID, image, {
    caption,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  console.log(`✅ NFT ПОКАЗАНА | ${name} | ${price ? price + ' TON' : 'pending'} | Power: ${totalPowerFinal}`);
}

// -------------------- очередь отправки --------------------
async function processSendQueue() {
  if (sending || sendQueue.length === 0) return;
  sending = true;

  console.log('⏸ Ждём 10 секунд перед отправкой в Telegram...');
  await new Promise(r => setTimeout(r, 10_000));
  
  while (sendQueue.length > 0) {
    const nft = sendQueue.shift();
    await sendNft(nft);
    await new Promise(r => setTimeout(r, 1000));
  }

  sending = false;
}

// -------------------- check new NFT --------------------
async function checkNft() {
  const nftAddresses = await getLastNftAddresses(5);

  for (const addrRaw of nftAddresses) {
    const normalizedAddress = addrRaw.trim().toLowerCase();
    if (ignoredNfts.has(normalizedAddress)) continue;

    const nft = await getNftData(addrRaw);
    if (!nft) continue;

    const collectionName = nft.collection?.name?.trim();
    if (collectionName !== TARGET_COLLECTION) {
      ignoredNfts.add(normalizedAddress);
      console.log(`❌ NFT ПРОПУЩЕНА | ${nft.metadata?.name || 'Без названия'} | другая коллекция`);
      continue;
    }

    const price = nft.sale ? Number(nft.sale.price.value) / 1e9 : null;
    const nftKey = `${normalizedAddress}_${price ?? 'pending'}`;

    if (sentNfts.has(nftKey) && Date.now() - sentNfts.get(nftKey) < SENT_TTL) continue;

    if (!price) {
      pendingQueue[addrRaw] = Date.now();
      continue;
    }

    sendQueue.push(nft);
    sentNfts.set(nftKey, Date.now());
    delete pendingQueue[addrRaw];
  }
}

// -------------------- process pending --------------------
async function processPending() {
  const now = Date.now();

  for (const addrRaw of Object.keys(pendingQueue)) {
    const normalizedAddress = addrRaw.trim().toLowerCase();

    if (now - pendingQueue[addrRaw] > MAX_PENDING_TIME) {
      delete pendingQueue[addrRaw];
      ignoredNfts.add(normalizedAddress);
      continue;
    }

    const nft = await getNftData(addrRaw);
    if (!nft) continue;

    const price = nft.sale ? Number(nft.sale.price.value) / 1e9 : null;
    const nftKey = `${normalizedAddress}_${price ?? 'pending'}`;

    if (price && (!sentNfts.has(nftKey) || Date.now() - sentNfts.get(nftKey) > SENT_TTL)) {
      sendQueue.push(nft);
      sentNfts.set(nftKey, Date.now());
      delete pendingQueue[addrRaw];
    }
  }
}

// -------------------- команды --------------------
bot.onText(/\/start_nft/, (msg) => {
  if (msg.chat.id !== CHAT_ID) return

  if (!nftInterval) {
    nftInterval = setInterval(checkNft, 1000);
    pendingInterval = setInterval(processPending, 1000);
    setInterval(processSendQueue, 500);
    bot.sendMessage(CHAT_ID, '🚀 NFT отслеживание запущено');
  } else {
    bot.sendMessage(CHAT_ID, '⚠️ Уже запущено');
  }
});

bot.onText(/\/stop_nft/, (msg) => {
  if (msg.chat.id !== CHAT_ID) return
  if (nftInterval) {
    clearInterval(nftInterval);
    clearInterval(pendingInterval);
    nftInterval = null;
    pendingInterval = null;
    bot.sendMessage(CHAT_ID, '🛑 NFT отслеживание остановлено');
  } else {
    bot.sendMessage(CHAT_ID, '⚠️ Не запущено');
  }
});
process.on('uncaughtException', e => console.error('UNCAUGHT:', e));
process.on('unhandledRejection', e => console.error('UNHANDLED REJECTION:', e));

const express = require('express')
const app = express()
const port = process.env.PORT || 4000 

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})