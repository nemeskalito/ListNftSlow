const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Address } = require('ton');
require('dotenv').config();
const POWER_DB = require('./power.json');

process.env.NTBA_FIX_350 = 'true';

// Бот для команд и текста (через прокси)
const bot = new TelegramBot(process.env.API_TOKEN, {
  polling: true,
  baseApiUrl: 'https://tg-proxy.borisenko-igor2021.workers.dev'
});

// Прямой клиент для отправки картинок
const telegramDirect = axios.create({
  baseURL: 'https://api.telegram.org',
  timeout: 30000
});

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
const MAX_PENDING_TIME = 5 * 60 * 1000;
const SENT_TTL = 10 * 60 * 1000;
let last429Log = 0;

const axiosImage = axios.create({ timeout: 15000 });
const axiosInstance = axios.create({ timeout: 10000 });

// -------------------- safe GET --------------------
async function safeGet(url, params = {}) {
  let tries = 0;
  let wait = 2000;
  while (tries < 5) {
    try {
      const { data } = await axiosInstance.get(url, { params });
      return data;
    } catch (e) {
      if (e.response?.status === 429) {
        const now = Date.now();
        if (now - last429Log > 5000) {
          console.warn(`⏳ Rate limit, retry in ${wait}ms`);
          last429Log = now;
        }
        await new Promise(r => setTimeout(r, wait));
        tries++;
        wait *= 2;
      } else {
        return null;
      }
    }
  }
  return null;
}

// -------------------- helpers --------------------
function toFriendlyAddress(rawAddress) {
  try {
    return Address.parse(rawAddress).toString({ urlSafe: true });
  } catch {
    return null;
  }
}

function getSaleLink(nft) {
  if (!nft?.address) return null;
  const friendly = toFriendlyAddress(nft.address);
  return friendly ? `https://getgems.io/nft/${friendly}` : null;
}

function getBestImageUrl(nft) {
  if (!Array.isArray(nft.previews)) return null;
  const bestPreview = nft.previews
    .filter(p => p.url?.startsWith('https://'))
    .sort((a, b) => {
      const sizeA = parseInt(a.resolution?.split('x')[0]) || 0;
      const sizeB = parseInt(b.resolution?.split('x')[0]) || 0;
      return sizeB - sizeA;
    })[0];
  return bestPreview?.url || null;
}

// -------------------- отправка картинки напрямую --------------------
async function sendPhotoDirect(imageBuffer, caption) {
  const FormData = require('form-data');
  const form = new FormData();
  
  form.append('chat_id', CHAT_ID.toString());
  form.append('photo', imageBuffer, { filename: 'nft.jpg', contentType: 'image/jpeg' });
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  
  await telegramDirect.post(`/bot${process.env.API_TOKEN}/sendPhoto`, form, {
    headers: { ...form.getHeaders() }
  });
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
    if (regex.test(textToScan)) bonus += np.power;
  }
  return bonus;
}

// -------------------- get data --------------------
async function getLastNftAddresses(limit = 10) {
  const data = await safeGet(`https://tonapi.io/v2/accounts/${ACCOUNT_ID}/nfts/history`, { limit });
  if (!data) return [];
  return (data.operations ?? []).map(op => op.item?.address).filter(Boolean);
}

async function getNftData(nftId) {
  return await safeGet(`https://tonapi.io/v2/nfts/${nftId}`);
}

// -------------------- send NFT --------------------
async function sendNft(nft) {
  if (!CHAT_ID || !nft) return;

  let name = nft.metadata?.name || 'Без названия';
  const price = nft.sale ? Number(nft.sale.price.value) / 1e9 : null;
  const saleLink = getSaleLink(nft);
  const imageUrl = getBestImageUrl(nft);

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

  // расчет синергии
  const synergyAttrList = [];
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
  const synergyCount = synergyAttrList.length;
  if (synergyCount === 2) synergyBonus = 100;
  else if (synergyCount >= 3) synergyBonus = 300;
  
  if (Array.isArray(nft.metadata?.attributes)) {
    nft.metadata.attributes.forEach(a => {
      const power = POWER_DB.attributes[attrMap[a.value]]?.find(attr => attr.name === a.value)?.power || 0;
      const isSynergy = synergyAttrList.includes(a.value);
      attributesText += `• ${a.trait_type}: ${a.value}⚡${power} ${isSynergy ? ' (Synergy)' : ''}\n`;
    });
  }
  
  if (synergyCount === 0) name += ' (без Synergy)';
  
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
<b>${name}</b>
💰 Цена: ${price ? price + ' TON' : 'в pending'}
<b>💪 Общая сила: ${powerText}</b>

${saleLink ? `🛒 <a href="${saleLink}">Купить на Getgems</a>\n` : ''}
${attributesText.trim()}
`.trim();

  // Отправка
  if (imageUrl) {
    try {
      const response = await axiosImage.get(imageUrl, { responseType: 'arraybuffer' });
      await sendPhotoDirect(Buffer.from(response.data), caption);
    } catch (e) {
      await bot.sendMessage(CHAT_ID, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
    }
  } else {
    await bot.sendMessage(CHAT_ID, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

// -------------------- очередь отправки --------------------
async function processSendQueue() {
  if (sending || sendQueue.length === 0) return;
  sending = true;
  try {
    while (sendQueue.length > 0) {
      const nft = sendQueue.shift();
      await sendNft(nft);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error('Queue error:', e.message);
  } finally {
    sending = false;
  }
}

// -------------------- check new NFT --------------------
async function checkNft() {
  try {
    const nftAddresses = await getLastNftAddresses(5);
    for (const addrRaw of nftAddresses) {
      const normalizedAddress = addrRaw.trim().toLowerCase();
      if (ignoredNfts.has(normalizedAddress)) continue;

      const nft = await getNftData(addrRaw);
      if (!nft) continue;

      const collectionName = nft.collection?.name?.trim();
      if (collectionName !== TARGET_COLLECTION) {
        ignoredNfts.add(normalizedAddress);
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
      await processSendQueue();
    }
  } catch (e) {
    console.error('Check error:', e.message);
  }
}

// -------------------- process pending --------------------
async function processPending() {
  try {
    const now = Date.now();
    let updated = false;

    for (const addrRaw of Object.keys(pendingQueue)) {
      if (now - pendingQueue[addrRaw] > MAX_PENDING_TIME) {
        delete pendingQueue[addrRaw];
        continue;
      }

      const nft = await getNftData(addrRaw);
      if (!nft) continue;

      const price = nft.sale ? Number(nft.sale.price.value) / 1e9 : null;
      const nftKey = `${addrRaw}_${price ?? 'pending'}`;

      if (price && (!sentNfts.has(nftKey) || Date.now() - sentNfts.get(nftKey) > SENT_TTL)) {
        sendQueue.push(nft);
        sentNfts.set(nftKey, Date.now());
        delete pendingQueue[addrRaw];
        updated = true;
      }
    }
    
    if (updated) await processSendQueue();
  } catch (e) {
    console.error('Pending error:', e.message);
  }
}

// -------------------- команды --------------------
bot.onText(/\/start_nft/, async (msg) => {
  if (msg.chat.id !== CHAT_ID) return;
  if (!nftInterval) {
    nftInterval = setInterval(() => checkNft(), 5000);
    pendingInterval = setInterval(() => processPending(), 5000);
    setInterval(() => processSendQueue(), 1000);
    await bot.sendMessage(CHAT_ID, '🚀 NFT отслеживание запущено');
  } else {
    await bot.sendMessage(CHAT_ID, '⚠️ Уже запущено');
  }
});

bot.onText(/\/stop_nft/, async (msg) => {
  if (msg.chat.id !== CHAT_ID) return;
  if (nftInterval) {
    clearInterval(nftInterval);
    clearInterval(pendingInterval);
    nftInterval = null;
    pendingInterval = null;
    await bot.sendMessage(CHAT_ID, '🛑 NFT отслеживание остановлено');
  } else {
    await bot.sendMessage(CHAT_ID, '⚠️ Не запущено');
  }
});

console.log('🤖 Бот запущен');