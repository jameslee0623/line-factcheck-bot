/**
 * LINE 群組事實查核機器人 — Google Apps Script 版
 *
 * 用免費的 Gemini API 查核群組裡轉發的文章 / 說法，語氣溫和，先肯定再補充。
 * 成本 $0：只用 reply 回覆（回覆不計費），不主動 push。
 *
 * === 設定 ===
 * 全部設定都存在「專案設定 > 指令碼屬性」，程式每次收到訊息都會重讀，
 * 所以改屬性不用重新部署。也可以在 LINE 1:1 傳送「設定」開啟設定面板
 * （只有擁有者可以用），面板改的就是這些屬性。
 *   LINE_CHANNEL_ACCESS_TOKEN — LINE Developers Console > Messaging API channel
 *   GEMINI_API_KEY            — Google AI Studio (aistudio.google.com) 免費申請
 *   GEMINI_MODEL              — 主要模型，預設 gemini-3.8-flash（每月檢查自動更新，不用手動改）
 *   GEMINI_MODEL_FALLBACK     — 備用模型，預設 gemini-3.5-flash-lite（每月檢查自動更新，不用手動改）
 *   WEBHOOK_TOKEN             — 自己訂一串亂碼，LINE webhook URL 後面加 ?token=這串，用來防偽冒
 *   OWNER_USER_ID             — 擁有者的 LINE userId；第一次在 1:1 傳送「設定」的人會自動成為擁有者
 *   SYSTEM_PROMPT             — 查核提示詞（預設見下方 SYSTEM_PROMPT_DEFAULT）
 *   TRIGGERS                  — 手動觸發詞，用逗號分開（預設：!查,!fact,!check,!factcheck,查,查一下,幫我查）
 *   AUTO_MIN_CHARS            — 自動查核的字數下限（預設 200 字；手動觸發不受限）
 *   MAX_REPLY_CHARS           — 回覆字數上限（預設 5000；LINE 單則訊息上限就是 5000，設滿才不會在來源清單中間被切斷）
 *   MAX_OUTPUT_TOKENS         — 回答長度上限（預設 2000 tokens；600 字回答 + 5 條長網址來源約 2100 字，1200 不夠）
 *   FETCH_LINK_TEXT           — 1=抓取連結內文再查核，0=只傳連結（預設 1）
 *   IMAGE                     — 1=有字圖片查核（1:1 和群組用同一個開關），0=不查（預設 1）
 *   TAVILY_API_KEY            — Tavily 免費搜尋金鑰（tavily.com 申請，1000 次/月不用信用卡）；沒設就照原本方式回答
 *   TAVILY                     — 1=即時搜尋開，0=關（預設 1；沒設 TAVILY_API_KEY 時就算開也不會搜尋）
 *   GROUP_NAMES               — 自動學到的群組名單（JSON，機器人自己寫）
 *   GROUP_MEMBERS_<groupId>   — 自動學到的群組成員（JSON，機器人自己寫）
 *   ALLOW_<groupId>           — 該群組可以自動查核的人（JSON，面板設定；沒設就是全部人）
 *   PANEL_<ownerId>           — 設定面板的進行狀態（JSON，機器人自己寫）
 *
 * === 模型每月檢查 ===
 *   每月 1 號早上 9 點跑一次 monthlyModelCheck（排程不用手動建立，
 *   下一則 LINE 訊息進來時機器人自己建立）。只有當現在用的模型已經退役
 *   （不在 Google 的模型清單裡），才換成最新的 Flash（主要）和
 *   最新的 Flash-Lite（備用）。舊模型還在就什麼都不做，不會因為
 *   出了新模型就一直換。模型不在設定面板裡，面板只能看，不能改。
 *
 * === 觸發條件 ===
 *   群組：訊息開頭是手動觸發詞（查 / !fact / !check…），或 @ 提到機器人，
 *         或內含網址（影片連結不自動觸發），或純文字超過字數下限；
 *         自動查核只對面板裡勾選的人生效，手動觸發任何人都可以用。
 *   1:1 私聊：任何文字都回（方便測試）；有字圖片也可以。
 *   設定面板：1:1 傳送「設定」「setting」「settings」（整則訊息只有這幾個字），只有擁有者可以用。
 *   影片查核目前暫停：影片檔案和影片連結都不查。
 */

// ---------- 常數 ----------
// 版本號：每次改 Code.gs 就加一號，log 裡會印出來，方便確認部署的是哪一版。
const SCRIPT_VERSION = '1.1.17';
const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_CONTENT_URL = 'https://api.line.me/v2/bot/message/'; // + messageId + '/content'
const LINE_API_BASE = 'https://api.line.me/v2/bot/';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const TRIGGERS_DEFAULT = ['!查', '!fact', '!check', '!factcheck', '查', '查一下', '幫我查'];
const PANEL_TRIGGERS = ['設定', 'setting', 'settings']; // 整則訊息只有這幾個字才開面板
const VIDEO_URL_RE = /youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|facebook\.com\/watch|instagram\.com\/reel/i;

const USAGE = '我是查核小幫手。用法：\n'
  + '• 貼文章連結，我會幫你查證\n'
  + '• 輸入「查」+ 想問的內容，例如：查 台積電要被美國罰款是真的嗎\n'
  + '• 在群組 @ 我也可以\n'
  + '• 傳送「設定」可以改模型、提示詞等設定（只有擁有者）';

// 加入群組時打招呼，讓大家知道機器人來了。
const JOIN_HELLO = '大家好，我是查核小幫手。長訊息和連結我會自動查核；想查某則訊息，就回覆它並 @ 我。';

const SYSTEM_PROMPT_DEFAULT = [
  '你是一個在家庭群組裡的溫和事實查核小幫手。',
  '用繁體中文回答，語氣像晚輩對長輩一樣尊重、溫和。',
  '先肯定訊息中正確或有道理的部分，再用「補充資料」的方式指出錯誤或缺少的脈絡，不要直接說對方錯了，也不要用對抗、嘲諷的語氣。',
  '用搜尋到的資料查核，不要只憑記憶；每個關鍵說法都要有來源，內文用 [1]、[2] 這種編號標來源；不要自己寫「資料來源：」清單，機器人會附上真正的清單；沒有搜尋結果時不要編造來源連結。',
  '來源有標可信度等級：優先採用官方／權威來源（政府機關、醫院、大學），其次是主流媒體；一般網站只能當參考，不能當作唯一依據；如果不同來源說法不一致，要直接說出來，不要只挑一種講。',
  '回答要簡短，重點清楚，不要超過 600 字。',
  '如果查不到可靠資料，就說查不到，不要硬編答案。'
].join('\n');

// ---------- 小工具 ----------
function prop(name, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return v ? v : (fallback || '');
}

function setProp(name, value) {
  PropertiesService.getScriptProperties().setProperty(name, String(value));
}

function numProp(name, dflt) {
  const n = parseInt(prop(name, ''), 10);
  return isNaN(n) ? dflt : n;
}

function splitList(s) {
  return (s || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}

function jsonProp(name, dflt) {
  try {
    const raw = prop(name, '');
    return raw ? JSON.parse(raw) : dflt;
  } catch (e) {
    return dflt;
  }
}

function textOut(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

function doGet() {
  return textOut('LINE 查核機器人運作中');
}

// ---------- 設定 ----------
// 每次收到訊息都重讀屬性，所以面板改設定立刻生效，不用重新部署。
function settings() {
  return {
    model: prop('GEMINI_MODEL', 'gemini-3.8-flash'),
    fallback: prop('GEMINI_MODEL_FALLBACK', 'gemini-3.5-flash-lite'),
    systemPrompt: prop('SYSTEM_PROMPT', SYSTEM_PROMPT_DEFAULT),
    triggers: splitList(prop('TRIGGERS', TRIGGERS_DEFAULT.join(','))),
    autoMinChars: numProp('AUTO_MIN_CHARS', 200),
    maxReplyChars: numProp('MAX_REPLY_CHARS', 5000),
    maxOutputTokens: numProp('MAX_OUTPUT_TOKENS', 2000),
    fetchLinkText: prop('FETCH_LINK_TEXT', '1') !== '0',
    image: prop('IMAGE', '1') !== '0',
    tavily: prop('TAVILY', '1') !== '0' && prop('TAVILY_API_KEY', '') !== '',
    ownerId: prop('OWNER_USER_ID', '')
  };
}

// ---------- 擁有者 ----------
function isOwner(userId, s) {
  return !!s.ownerId && !!userId && userId === s.ownerId;
}

// 第一次在 1:1 傳送「設定」的人自動成為擁有者（只限 1:1，不限群組）。
function claimOwner(userId) {
  if (!prop('OWNER_USER_ID', '') && userId) {
    setProp('OWNER_USER_ID', userId);
    console.log('擁有者設定為: ' + userId);
    return true;
  }
  return prop('OWNER_USER_ID', '') === userId;
}

// ---------- 設定面板狀態 ----------
function panelState(ownerId) {
  return jsonProp('PANEL_' + ownerId, {});
}

function savePanelState(ownerId, st) {
  setProp('PANEL_' + ownerId, JSON.stringify(st));
}

function clearPanelState(ownerId) {
  savePanelState(ownerId, {});
}

function isPanelTrigger(text) {
  const t = (text || '').trim().toLowerCase();
  return PANEL_TRIGGERS.indexOf(t) !== -1;
}

// ---------- 群組與成員學習 ----------
// LINE 沒有「列出我加入的群組」的 API，群組和成員是收到訊息時學到的。
function lineGet(path, token) {
  try {
    const res = UrlFetchApp.fetch(LINE_API_BASE + path, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText());
  } catch (e) {
    return null;
  }
}

function learnGroupAndMember(src) {
  if (!src || src.type !== 'group' || !src.groupId) return;
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN', '');
  if (!token) return;
  const names = jsonProp('GROUP_NAMES', {});
  if (!names[src.groupId]) {
    const g = lineGet('group/' + encodeURIComponent(src.groupId) + '/summary', token);
    if (g && g.groupName) {
      names[src.groupId] = g.groupName;
      setProp('GROUP_NAMES', JSON.stringify(names));
    }
  }
  if (src.userId) {
    const key = 'GROUP_MEMBERS_' + src.groupId;
    const members = jsonProp(key, {});
    if (!members[src.userId]) {
      const m = lineGet('group/' + encodeURIComponent(src.groupId) + '/member/' + encodeURIComponent(src.userId), token);
      if (m && m.displayName) {
        members[src.userId] = m.displayName;
        setProp(key, JSON.stringify(members));
      }
    }
  }
}

// ---------- 自動查核名單 ----------
// 沒設名單 = 全部人都可以自動查核（原本的行為）。
// 一旦在面板動過任何一個人，名單就建立了，之後新加入的人預設是關的，要在面板打開。
function allowMap(groupId) {
  return jsonProp('ALLOW_' + groupId, null);
}

function isAllowed(groupId, userId) {
  const map = allowMap(groupId);
  if (!map) return true;
  return !!map[userId];
}

function setAllowed(groupId, userId, on) {
  let map = allowMap(groupId);
  if (!map) {
    // 第一次建立名單：先把已知的成員全部設為開，再改這一個。
    map = {};
    const members = jsonProp('GROUP_MEMBERS_' + groupId, {});
    Object.keys(members).forEach(function (id) { map[id] = true; });
  }
  if (on) map[userId] = true; else delete map[userId];
  setProp('ALLOW_' + groupId, JSON.stringify(map));
}

function setAllAllowed(groupId, on) {
  const map = {};
  const members = jsonProp('GROUP_MEMBERS_' + groupId, {});
  Object.keys(members).forEach(function (id) { if (on) map[id] = true; });
  setProp('ALLOW_' + groupId, JSON.stringify(map));
}

// ---------- 連結 ----------
// 抓連結內文（去 HTML 標籤，只取前 4000 字）。抓不到就回空字串，改用原本的連結查核。
function fetchLinkText(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return '';
    let html = res.getContentText();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    let text = html.replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
    return text.replace(/\s+/g, ' ').trim().slice(0, 4000);
  } catch (e) {
    return '';
  }
}

// 每次搜尋拿幾個結果：8 個比 5 個多，模型可以交叉比對；
// Tavily basic 一次搜尋就是 1 點，不管幾個結果；來源清單 8 則還是遠在 5000 字回覆上限內。
const SEARCH_MAX_RESULTS = 8;

// ---------- 來源可信度分級 ----------
// 只看網域，不看內容。第 1 級：官方和權威機構；第 2 級：主流媒體和參考資料；
// 第 3 級：其他網站（預設）。等級只幫模型判斷該信哪個來源，不代表內容一定正確。
const TIER1_DOMAINS = ['who.int', 'cna.com.tw', 'pts.org.tw', 'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nature.com', 'science.org', 'nejm.org', 'thelancet.com'];
const TIER2_DOMAINS = ['wikipedia.org', 'udn.com', 'chinatimes.com', 'ltn.com.tw', 'tvbs.com.tw', 'setn.com', 'ettoday.net', 'ftvnews.com.tw', 'cts.com.tw', 'storm.mg', 'yahoo.com', 'commonhealth.com.tw'];
function hostMatches(host, domain) {
  return host === domain || host.slice(-domain.length - 1) === '.' + domain;
}
function sourceTier(url) {
  const m = String(url || '').toLowerCase().match(/^https?:\/\/([^/:]+)/);
  let host = m ? m[1] : '';
  if (host.slice(0, 4) === 'www.') host = host.slice(4);
  if (!host) return 3;
  if (TIER1_DOMAINS.some(function (d) { return hostMatches(host, d); })) return 1;
  if (TIER2_DOMAINS.some(function (d) { return hostMatches(host, d); })) return 2;
  // 官方和學術網域後綴：.gov、.gov.tw、.edu、.edu.tw、.ac.uk 等
  if (host.slice(-4) === '.gov' || host.slice(-7) === '.gov.tw' ||
      host.slice(-4) === '.edu' || host.slice(-7) === '.edu.tw' ||
      host.indexOf('.ac.') !== -1) return 1;
  return 3;
}
function tierLabel(tier) {
  if (tier === 1) return '【官方／權威來源】';
  if (tier === 2) return '【主流媒體】';
  return '【一般網站，僅供參考】';
}

// Tavily 即時搜尋（免費 1000 次/月，不用信用卡）：把問題拿去搜尋，
// 回傳結果陣列 [{title, url, content}]，交給 Gemini 判斷。
// 沒設 TAVILY_API_KEY、搜尋失敗或沒有結果都回空陣列，機器人就照原本的方式回答。
function tavilySearch(query) {
  const key = prop('TAVILY_API_KEY', '');
  if (!key || !query) return [];
  try {
    const res = UrlFetchApp.fetch('https://api.tavily.com/search', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify({ query: query.slice(0, 500), search_depth: 'basic', max_results: SEARCH_MAX_RESULTS, include_answer: false }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      console.log('Tavily 搜尋失敗: ' + res.getResponseCode());
      return [];
    }
    const data = JSON.parse(res.getContentText());
    const results = (data.results || []).map(function (r) {
      return { title: r.title || '', url: r.url || '', content: (r.content || '').slice(0, 500) };
    }).filter(function (r) { return r.url; });
    console.log('Tavily 搜尋：找到 ' + results.length + ' 則結果');
    return results;
  } catch (err) {
    console.log('Tavily 搜尋失敗: ' + err);
    return [];
  }
}

function firstUrl(text) {
  const m = (text || '').match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : '';
}

function isVideoUrl(url) {
  return VIDEO_URL_RE.test(url || '');
}

// ---------- webhook 入口 ----------
function doPost(e) {
  console.log('Bot version: ' + SCRIPT_VERSION);
  const body = (e && e.postData && e.postData.contents) || '';
  try {
    // Apps Script 的 doPost 看不到 HTTP header，無法驗 LINE 簽名，
    // 改用 webhook URL 後面的 ?token=... 驗證（在 LINE Console 設定 webhook 時加上）。
    const needToken = prop('WEBHOOK_TOKEN', '');
    if (needToken) {
      const got = (e && e.parameter && e.parameter.token) || '';
      if (got !== needToken) {
        console.log('webhook token 不符，拒絕');
        return textOut('forbidden');
      }
    }
    const data = JSON.parse(body);
    (data.events || []).forEach(handleEvent);
  } catch (err) {
    console.log('doPost 錯誤: ' + err);
  }
  return textOut('OK');
}

// ---------- 最近訊息 ----------
// 回覆指定查核用的：機器人收到群組 / 1:1 的每一則文字和圖片訊息，都把 id 和內容
// 記在 cache 裡（最多 20 則，6 小時）。有人回覆某則訊息並 @ 機器人或打觸發詞時，
// webhook 裡的 quotedMessageId 可以對到這裡的 id，就能查被回覆的那則。
// LINE 不會把被回覆訊息的內容再送一次，所以沒記到的（超過 6 小時、機器人加入
// 之前的訊息）就查不到，只能請對方把文字複製給我。
function recentKey(chatId) {
  return 'recent_' + chatId;
}

function rememberMessage(chatId, msg, senderName) {
  if (!msg || !msg.id) return;
  if (msg.type !== 'text' && msg.type !== 'image') return;
  try {
    const cache = CacheService.getScriptCache();
    const key = recentKey(chatId);
    let list = [];
    try { list = JSON.parse(cache.get(key) || '[]'); } catch (e) { list = []; }
    list = list.filter(function (m) { return m.id !== msg.id; });
    list.push({
      id: msg.id,
      type: msg.type,
      text: (msg.text || '').slice(0, 1000),
      sender: senderName || '',
      t: Date.now()
    });
    while (list.length > 20) list.shift();
    cache.put(key, JSON.stringify(list), 21600);
  } catch (err) {
    console.log('記最近訊息失敗: ' + err);
  }
}

function findRecentMessage(chatId, messageId) {
  try {
    const cache = CacheService.getScriptCache();
    const list = JSON.parse(cache.get(recentKey(chatId)) || '[]');
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === messageId) return list[i];
    }
  } catch (err) {
    console.log('找最近訊息失敗: ' + err);
  }
  return null;
}

// ---------- 事件處理 ----------
function handleEvent(ev) {
  if (!ev || !ev.replyToken) return;
  const token = ev.replyToken;

  // 去重：LINE 沒收到 200 會重送，同一 replyToken 只處理一次
  const cache = CacheService.getScriptCache();
  if (cache.get('evt:' + token)) return;
  cache.put('evt:' + token, '1', 600);

  // 按鈕（postback）事件：設定面板的操作
  if (ev.type === 'postback') {
    handlePostback(ev);
    return;
  }
  // 加入群組時打招呼，讓大家知道機器人來了（join 事件有 replyToken，可以回覆）
  if (ev.type === 'join') {
    replyLine(token, JOIN_HELLO, settings());
    return;
  }
  if (ev.type !== 'message') return; // leave / follow 等事件不處理

  const msg = ev.message || {};
  const src = ev.source || {};
  const isGroup = src.type === 'group' || src.type === 'room';
  const groupId = src.type === 'group' ? src.groupId : (src.type === 'room' ? src.roomId : '');
  const s = settings();

  // 學群組名單和成員名字（群組訊息才有）
  if (isGroup) learnGroupAndMember(src);

  // 記住這則訊息（回覆指定查核用；不論這則會不會觸發查核都要記）
  const chatId = isGroup ? groupId : ('dm_' + (src.userId || ''));
  let senderName = '';
  if (isGroup && src.userId) {
    senderName = (jsonProp('GROUP_MEMBERS_' + groupId, {})[src.userId]) || '';
  }
  if (msg.type === 'text' || msg.type === 'image') rememberMessage(chatId, msg, senderName);

  if (msg.type === 'text') {
    const text = (msg.text || '').trim();

    // 設定面板：1:1 裡整則訊息只有「設定 / setting / settings」才開
    if (!isGroup && isPanelTrigger(text)) {
      if (!claimOwner(src.userId)) {
        replyLine(token, '設定只有擁有者可以使用。', s);
        return;
      }
      clearPanelState(src.userId);
      replyFlex(token, panelFlex(settings()));
      return;
    }

    // 擁有者在 1:1 的面板操作（直接指令或接續輸入）
    if (!isGroup && isOwner(src.userId, s)) {
      if (handlePanelText(token, text, src.userId, s)) return;
    }

    // 回覆指定查核：回覆某則訊息並 @ 機器人或打觸發詞，查被回覆的那則，不是回覆本身
    if (msg.quotedMessageId && (isMentioned(msg) || startsWithTrigger(text, s.triggers))) {
      const target = findRecentMessage(chatId, msg.quotedMessageId);
      if (!target) {
        replyLine(token, '找不到被回覆的那則訊息（只記得最近 6 小時的文字和圖片），請把文字複製給我。', s);
        return;
      }
      if (target.type === 'image') {
        const imageB64 = downloadLineImage(target.id);
        if (!imageB64) {
          replyLine(token, '圖片下載失敗，請再傳一次。', s);
          return;
        }
        const imgAnswer = askGemini('請查核這張圖片裡的內容。', imageB64, s);
        if (imgAnswer) replyLine(token, imgAnswer, s);
        return;
      }
      let q = target.sender ? '以下是' + target.sender + '說的話，請查核：\n' + target.text
        : '以下是被回覆的訊息，請查核：\n' + target.text;
      if (s.fetchLinkText) {
        const url = firstUrl(q);
        if (url && !isVideoUrl(url)) {
          const page = fetchLinkText(url);
          if (page) q = q + '\n\n連結內文：\n' + page;
        }
      }
      const answer = askGemini(q, '', s, target.text);
      if (answer) replyLine(token, answer, s);
      return;
    }

    if (!shouldAnswer(msg, text, isGroup, s, src)) return;

    const question = stripTrigger(text, s.triggers);
    if (!question || /^(help|說明|用法|hi|hello|你好)$/i.test(question)) {
      replyLine(token, USAGE, s);
      return;
    }

    // 連結：先抓內文再查核（影片連結不抓，影片查核暫停中）
    let q = question;
    if (s.fetchLinkText) {
      const url = firstUrl(q);
      if (url && !isVideoUrl(url)) {
        const page = fetchLinkText(url);
        if (page) q = q + '\n\n連結內文：\n' + page;
      }
    }

    const answer = askGemini(q, '', s, question);
    if (!answer) return; // 保險用，現在每條路都會回訊息，不應該是 null
    // 不管多慢都試著回（replyToken 60 秒有效；過期了 LINE 會拒絕，replyLine 會記在 log 裡）
    replyLine(token, answer, s);
    return;
  }

  if (msg.type === 'image') {
    // 有字圖片：1:1 和群組用同一個開關；群組還要看這個人在不在自動查核名單
    if (!s.image) return;
    if (isGroup && !isAllowed(groupId, src.userId)) return;
    const imageB64 = downloadLineImage(msg.id);
    if (!imageB64) {
      replyLine(token, '圖片下載失敗，請再傳一次。', s);
      return;
    }
    const answer = askGemini('請查核這張圖片裡的內容。', imageB64, s);
    if (answer) replyLine(token, answer, s);
    return;
  }

  if (msg.type === 'video') {
    // 影片查核暫停：1:1 說一聲，群組不說話
    if (!isGroup) replyLine(token, '影片查核目前暫停，之後再開。', s);
    return;
  }

  // 貼圖、檔案等不處理
}

function isMentioned(msg) {
  const mentionees = (msg.mention && msg.mention.mentionees) || [];
  return mentionees.some(function (m) { return m.isSelf; });
}

function startsWithTrigger(text, triggers) {
  const lower = (text || '').toLowerCase();
  return triggers.some(function (t) { return lower.indexOf(t.toLowerCase()) === 0; });
}

function shouldAnswer(msg, text, isGroup, s, src) {
  // 手動觸發（@ / 觸發詞）任何人都可以用，不受字數和名單限制
  if (isMentioned(msg)) return true;
  if (startsWithTrigger(text, s.triggers)) return true;
  // 1:1 私聊：任何文字都回（方便測試和自己用）
  if (!isGroup) return true;
  // 群組自動查核：先看這個人在不在名單
  const groupId = src.type === 'group' ? src.groupId : (src.type === 'room' ? src.roomId : '');
  if (!isAllowed(groupId, src.userId)) return false;
  // 影片連結不自動觸發（影片查核暫停）
  const url = firstUrl(text);
  if (url) return !isVideoUrl(url);
  // 純文字：超過字數下限才自動查核（日常短訊不查，轉發的長謠言才查）
  return text.length >= s.autoMinChars;
}

function stripTrigger(text, triggers) {
  let t = text;
  triggers.forEach(function (tr) {
    if (t.toLowerCase().indexOf(tr.toLowerCase()) === 0) t = t.slice(tr.length).trim();
  });
  return t || text;
}

// ---------- 設定面板：文字操作 ----------
// 擁有者在 1:1 傳的文字。回傳 true 表示這則訊息被面板吃掉了，不再查核。
function handlePanelText(token, text, userId, s) {
  // 取消：離開進行中的設定，回到面板
  if (text === '取消') {
    clearPanelState(userId);
    replyFlex(token, panelFlex(settings()));
    return true;
  }

  // 直接指令：字數 <數字>
  let m = text.match(/^字數\s+(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n < 0 || n > 10000) {
      replyLine(token, '字數下限請用 0 到 10000 之間的數字。', s);
      return true;
    }
    clearPanelState(userId);
    setProp('AUTO_MIN_CHARS', n);
    replyMessages(token, [{ type: 'text', text: '自動查核字數下限改成 ' + n + ' 字。' }, panelFlex(settings())]);
    return true;
  }
  if (text === '群組') {
    clearPanelState(userId);
    replyFlex(token, groupListFlex(s));
    return true;
  }
  if (text === '提示詞') {
    savePanelState(userId, { step: 'await_prompt' });
    replyFlex(token, copyFlex('更改提示詞', '點下面複製目前的提示詞，貼到輸入框再改，傳送給我。傳送「取消」可以離開。', s.systemPrompt, '複製目前提示詞'));
    return true;
  }

  // 接續輸入：前面按了按鈕，正在等這則訊息當作設定值
  const st = panelState(userId);
  if (!st.step) return false;

  if (st.step === 'await_prompt') {
    setProp('SYSTEM_PROMPT', text);
    clearPanelState(userId);
    replyMessages(token, [{ type: 'text', text: '提示詞已更新。' }, panelFlex(settings())]);
    return true;
  }
  if (st.step === 'await_number') {
    const n = parseInt(text, 10);
    const limits = { AUTO_MIN_CHARS: [0, 10000], MAX_REPLY_CHARS: [100, 5000], MAX_OUTPUT_TOKENS: [100, 65536] };
    const lim = limits[st.key] || [0, 10000];
    if (isNaN(n) || n < lim[0] || n > lim[1]) {
      replyLine(token, '請傳送 ' + lim[0] + ' 到 ' + lim[1] + ' 之間的數字，或傳送「取消」離開。', s);
      return true;
    }
    setProp(st.key, n);
    clearPanelState(userId);
    replyMessages(token, [{ type: 'text', text: '已更新。' }, panelFlex(settings())]);
    return true;
  }
  if (st.step === 'await_triggers') {
    const list = splitList(text.replace(/，/g, ','));
    if (!list.length) {
      replyLine(token, '請傳送觸發詞，用逗號分開，例如：查,!fact,幫我查，或傳送「取消」離開。', s);
      return true;
    }
    setProp('TRIGGERS', list.join(','));
    clearPanelState(userId);
    replyMessages(token, [{ type: 'text', text: '觸發詞改成：' + list.join('、') + '。' }, panelFlex(settings())]);
    return true;
  }
  return false;
}

// ---------- 設定面板：按鈕操作 ----------
function handlePostback(ev) {
  const token = ev.replyToken;
  const src = ev.source || {};
  const s = settings();
  // 面板只在 1:1 用，而且只有擁有者可以用
  if (src.type !== 'user') return;
  if (!isOwner(src.userId, s)) {
    replyLine(token, '設定只有擁有者可以使用。', s);
    return;
  }
  const userId = src.userId;
  // 按了按鈕就表示換操作了，取消進行中的文字輸入
  clearPanelState(userId);
  const data = (ev.postback && ev.postback.data) || '';
  const p = data.split(':');
  if (p[0] !== 'panel') return;

  if (p[1] === 'home') {
    replyFlex(token, panelFlex(settings()));
    return;
  }
  if (p[1] === 'toggle') {
    const key = p[2];
    if (key !== 'FETCH_LINK_TEXT' && key !== 'IMAGE' && key !== 'TAVILY') return;
    const dflt = '1';
    setProp(key, prop(key, dflt) === '1' ? '0' : '1');
    replyFlex(token, panelFlex(settings()));
    return;
  }
  if (p[1] === 'num') {
    const key = p[2];
    if (key !== 'AUTO_MIN_CHARS' && key !== 'MAX_REPLY_CHARS' && key !== 'MAX_OUTPUT_TOKENS') return;
    savePanelState(userId, { step: 'await_number', key: key });
    const cur = key === 'AUTO_MIN_CHARS' ? String(s.autoMinChars)
      : key === 'MAX_REPLY_CHARS' ? String(s.maxReplyChars) : String(s.maxOutputTokens);
    const hint = key === 'AUTO_MIN_CHARS' ? '例如：200'
      : key === 'MAX_REPLY_CHARS' ? 'LINE 上限 5000，例如：5000' : '例如：2000';
    replyFlex(token, copyFlex('更改數字', '點下面複製目前的數字，貼到輸入框再改，傳送給我（' + hint + '）。傳送「取消」可以離開。', cur, '複製目前數字'));
    return;
  }
  if (p[1] === 'prompt') {
    savePanelState(userId, { step: 'await_prompt' });
    replyFlex(token, copyFlex('更改提示詞', '點下面複製目前的提示詞，貼到輸入框再改，傳送給我。傳送「取消」可以離開。', s.systemPrompt, '複製目前提示詞'));
    return;
  }
  if (p[1] === 'triggers') {
    savePanelState(userId, { step: 'await_triggers' });
    replyFlex(token, copyFlex('更改觸發詞', '點下面複製目前的觸發詞，貼到輸入框再改，傳送給我（用逗號分開，例如：查,!fact,幫我查）。傳送「取消」可以離開。', s.triggers.join(','), '複製目前觸發詞'));
    return;
  }
  if (p[1] === 'groups') {
    replyFlex(token, groupListFlex(s));
    return;
  }
  if (p[1] === 'group') {
    replyFlex(token, memberFlex(p[2] || '', s));
    return;
  }
  if (p[1] === 'user') {
    const groupId = p[2] || '';
    const uid = p[3] || '';
    if (!groupId || !uid) return;
    setAllowed(groupId, uid, !isAllowed(groupId, uid));
    replyFlex(token, memberFlex(groupId, settings()));
    return;
  }
  if (p[1] === 'all') {
    const groupId = p[2] || '';
    if (!groupId) return;
    setAllAllowed(groupId, p[3] === 'on');
    replyFlex(token, memberFlex(groupId, settings()));
    return;
  }
}

// ---------- 設定面板：卡片 ----------
// Flex Message 卡片。按鈕用 postback，點了不會在對話裡留一堆指令文字。
function flexBtn(label, data) {
  return { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: label, data: data } };
}

function flexRow(label, value, btn) {
  const c = [
    { type: 'text', text: label, size: 'sm', flex: 2, gravity: 'center', maxLines: 1 },
    { type: 'text', text: value, size: 'sm', color: '#888888', flex: 2, wrap: true, gravity: 'center', maxLines: 1 }
  ];
  if (btn) c.push(btn);
  return { type: 'box', layout: 'horizontal', spacing: 'sm', contents: c };
}

function flexSection(title, rows) {
  const contents = [{ type: 'text', text: title, size: 'xs', color: '#888888', weight: 'bold' }].concat(rows);
  return { type: 'box', layout: 'vertical', spacing: 'sm', contents: contents };
}

function flexSep() {
  return { type: 'separator', margin: 'md' };
}

// 一張小卡片：說明 + 目前的值 + 一個複製按鈕。
// LINE 沒辦法直接把文字預填進輸入框，點複製再貼上改是最接近的做法。
// 目前的值也印在卡片上，舊版 LINE 不能用複製按鈕時，長按文字也可以複製。
function copyFlex(title, instruction, currentText, copyLabel) {
  return flexBubble(title, '點下面複製目前的值', [
    { type: 'text', text: instruction, size: 'sm', wrap: true },
    { type: 'text', text: currentText, size: 'sm', color: '#888888', wrap: true },
    { type: 'button', style: 'primary', height: 'sm', action: { type: 'clipboard', label: copyLabel, clipboardText: currentText } }
  ]);
}

function flexBubble(headerText, headerSub, bodyContents) {
  return {
    type: 'flex',
    altText: headerText,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: headerText, weight: 'bold', size: 'lg' },
          { type: 'text', text: headerSub, size: 'xs', color: '#888888' }
        ]
      },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: bodyContents }
    }
  };
}

function panelFlex(s) {
  const groupNames = jsonProp('GROUP_NAMES', {});
  const groupCount = Object.keys(groupNames).length;
  const monthlyOk = ensureMonthlyTrigger(); // 打開面板時檢查排程，不存在就建立
  return flexBubble('⚙️ 設定', '只有擁有者可以改', [
    flexSection('自動查核', [
      flexRow('字數下限', s.autoMinChars + ' 字', flexBtn('更改', 'panel:num:AUTO_MIN_CHARS')),
      flexRow('連結內文抓取', s.fetchLinkText ? '開' : '關', flexBtn('切換', 'panel:toggle:FETCH_LINK_TEXT')),
      flexRow('即時搜尋 (Tavily)', s.tavily ? '開' : '關', flexBtn('切換', 'panel:toggle:TAVILY')),
      flexRow('有字圖片', s.image ? '開' : '關', flexBtn('切換', 'panel:toggle:IMAGE')),
      flexRow('影片 · 檔案 / 連結', '暫停', null),
      flexRow('手動觸發', s.triggers.join(' / '), flexBtn('更改', 'panel:triggers'))
    ]),
    flexSep(),
    flexSection('查核提示詞', [
      { type: 'text', text: s.systemPrompt.slice(0, 60) + '…', size: 'sm', color: '#888888', wrap: true, maxLines: 1 },
      flexBtn('更改提示詞', 'panel:prompt')
    ]),
    flexSep(),
    flexSection('群組與成員', [
      flexRow('選擇群組', groupCount ? groupCount + ' 個群組' : '還沒有群組記錄', flexBtn('選擇群組', 'panel:groups')),
      flexRow('回覆長度上限', s.maxReplyChars + ' 字', flexBtn('更改', 'panel:num:MAX_REPLY_CHARS')),
      flexRow('回答長度上限', s.maxOutputTokens + ' tokens', flexBtn('更改', 'panel:num:MAX_OUTPUT_TOKENS'))
    ]),
    flexSep(),
    { type: 'text', text: '版本 ' + SCRIPT_VERSION + ' · 每月檢查：' + (monthlyOk ? '已排程' : '未排程'), size: 'xs', color: '#aaaaaa', align: 'center' }
  ]);
}

function groupListFlex(s) {
  const names = jsonProp('GROUP_NAMES', {});
  const ids = Object.keys(names);
  const rows = ids.map(function (gid) {
    const members = jsonProp('GROUP_MEMBERS_' + gid, {});
    const n = Object.keys(members).length;
    return flexRow(names[gid] || gid, n + ' 位成員', flexBtn('選擇', 'panel:group:' + gid));
  });
  if (!rows.length) {
    rows.push({ type: 'text', text: '還沒有群組記錄。群組裡有人說話後，群組才會出現在這裡。', size: 'sm', color: '#888888', wrap: true });
  }
  rows.push(flexBtn('回設定', 'panel:home'));
  return flexBubble('選擇群組', '先選群組，再選成員', rows);
}

function memberFlex(groupId, s) {
  const names = jsonProp('GROUP_NAMES', {});
  const title = (names[groupId] || '群組') + ' · 自動查核對象';
  const members = jsonProp('GROUP_MEMBERS_' + groupId, {});
  const ids = Object.keys(members);
  const rows = ids.map(function (uid) {
    return flexRow(members[uid] || uid, isAllowed(groupId, uid) ? '開' : '關', flexBtn('切換', 'panel:user:' + groupId + ':' + uid));
  });
  if (!rows.length) {
    rows.push({ type: 'text', text: '這個群組還沒有成員記錄。有人說話後，名字才會出現在這裡。', size: 'sm', color: '#888888', wrap: true });
  }
  rows.push(flexBtn('全部開啟', 'panel:all:' + groupId + ':on'));
  rows.push(flexBtn('全部關閉', 'panel:all:' + groupId + ':off'));
  rows.push(flexBtn('回群組列表', 'panel:groups'));
  rows.push(flexBtn('回設定', 'panel:home'));
  return flexBubble(title, '只有勾選的人會被自動查核', rows);
}

// ---------- 模型每月檢查 ----------
// 每月 1 號早上 9 點跑一次（排程由 ensureMonthlyTrigger 自動建立，見下方）。
// 只有當現在用的模型已經退役（不在 Google 的模型清單裡），才換成
// 最新的 Flash（主要）和最新的 Flash-Lite（備用）。舊模型還在就
// 什麼都不做，不會因為出了新模型就一直換。
function listModels() {
  const key = prop('GEMINI_API_KEY', '');
  if (!key) return null;
  try {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      console.log('列出模型失敗 ' + res.getResponseCode());
      return null;
    }
    const data = JSON.parse(res.getContentText());
    return (data.models || []).map(function (m) {
      return { name: (m.name || '').replace(/^models\//, ''), methods: m.supportedGenerationMethods || [] };
    }).filter(function (m) { return m.name; });
  } catch (e) {
    console.log('列出模型失敗: ' + e);
    return null;
  }
}

// 從模型清單挑最新的 Flash，排好順序。lite=true 挑 Lite 版，否則挑非 Lite 版。
// 只要能 generateContent 的，跳過預覽版、實驗版、Pro（不是免費的）和其他用途的模型。
// 版本號比大小：gemini-3.8-flash > gemini-3.5-flash；沒有版本號的排最後。
function rankFlashModels(models, lite) {
  const cands = models.filter(function (m) {
    const lower = m.name.toLowerCase();
    if (m.methods.indexOf('generateContent') === -1) return false;
    if (lower.indexOf('flash') === -1) return false;
    if (/preview|exp|pro|embedding|image|audio|tts|live/.test(lower)) return false;
    if (lite) return lower.indexOf('lite') !== -1;
    return lower.indexOf('lite') === -1;
  });
  function ver(n) {
    const m = n.match(/(\d+)\.(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
  }
  cands.sort(function (a, b) {
    const va = ver(a.name), vb = ver(b.name);
    return (vb[0] - va[0]) || (vb[1] - va[1]);
  });
  return cands.map(function (m) { return m.name; });
}

// 用一個很小的請求確認這個模型真的能用（免費額度內）。
function verifyModel(name, key) {
  try {
    const res = UrlFetchApp.fetch(GEMINI_BASE + encodeURIComponent(name) + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 5 }
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return false;
    const data = JSON.parse(res.getContentText());
    const cand = (data.candidates || [])[0];
    return !!(cand && cand.content && (cand.content.parts || []).some(function (p) { return p.text; }));
  } catch (e) {
    return false;
  }
}

function monthlyModelCheck() {
  const s = settings();
  const key = prop('GEMINI_API_KEY', '');
  const models = listModels();
  if (!models) {
    console.log('每月模型檢查：拿不到模型清單，這次不換');
    return;
  }
  const names = models.map(function (m) { return m.name; });

  if (names.indexOf(s.model) === -1) {
    const cands = rankFlashModels(models, false);
    let picked = '';
    for (let i = 0; i < cands.length; i++) {
      if (verifyModel(cands[i], key)) { picked = cands[i]; break; }
    }
    if (picked) {
      console.log('每月模型檢查：' + s.model + ' 已退役，換成 ' + picked);
      setProp('GEMINI_MODEL', picked);
    } else {
      console.log('每月模型檢查：' + s.model + ' 已退役，但找不到可用的 Flash 模型');
    }
  } else {
    console.log('每月模型檢查：主要模型 ' + s.model + ' 還在，不換');
  }

  if (names.indexOf(s.fallback) === -1) {
    const cands = rankFlashModels(models, true);
    let picked = '';
    for (let i = 0; i < cands.length; i++) {
      if (verifyModel(cands[i], key)) { picked = cands[i]; break; }
    }
    if (picked) {
      console.log('每月模型檢查：' + s.fallback + ' 已退役，換成 ' + picked);
      setProp('GEMINI_MODEL_FALLBACK', picked);
    } else {
      console.log('每月模型檢查：' + s.fallback + ' 已退役，但找不到可用的 Flash-Lite 模型');
    }
  } else {
    console.log('每月模型檢查：備用模型 ' + s.fallback + ' 還在，不換');
  }
}

// 手動備用：設定面板打開時會自動建立排程，這個函數是在編輯器裡手動建立用的，跑兩次不會重複。
function setupMonthlyCheck() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (tr) {
    if (tr.getHandlerFunction() === 'monthlyModelCheck') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('monthlyModelCheck').timeBased().onMonthDay(1).atHour(9).create();
  console.log('每月模型檢查已排程：每月 1 號早上 9 點');
}

// 設定面板打開時檢查排程：不存在就建立，面板最下面會顯示有沒有排程。
// 不在每一則訊息都檢查，那樣很浪費。
function triggerExists() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'monthlyModelCheck') return true;
    }
  } catch (err) {
    console.log('檢查每月排程失敗: ' + err);
  }
  return false;
}

function ensureMonthlyTrigger() {
  try {
    if (triggerExists()) return true;
    ScriptApp.newTrigger('monthlyModelCheck').timeBased().onMonthDay(1).atHour(9).create();
    console.log('每月模型檢查已排程：每月 1 號早上 9 點');
    return true;
  } catch (err) {
    console.log('建立每月排程失敗: ' + err);
    return false;
  }
}

// ---------- Gemini ----------
// 主要模型用滿（429）或出錯時，自動改用備用模型。兩個模型各有自己的免費額度，
// 所以備用模型不會吃掉主要模型的額度。
// 模型自己寫的「資料來源：」清單編號常常對不上（會漏 [1]、多出沒引用的編號），
// 機器人有真正的來源時，先把模型寫的那段拿掉，再附上真正的清單。
function stripModelSources(text) {
  const i = (text || '').search(/\n\s*資料來源\s*[：:]/);
  return i === -1 ? text : text.slice(0, i).trim();
}

function formatSourceList(items) {
  return items.map(function (it, i) {
    const t = (it.title || '').trim();
    return '- ' + (t ? t + '：' : '') + it.url + ' [' + (i + 1) + ']';
  }).join('\n');
}

// 附上真正的來源清單：編號和給 Gemini 看的搜尋結果編號一致，
// 這樣內文的 [1]、[2] 一定找得到。沒有真正的來源就不附（也不編）。
function attachSources(text, items) {
  items = items || [];
  if (!items.length) return text;
  return stripModelSources(text) + '\n\n資料來源：\n' + formatSourceList(items);
}

function askGemini(question, imageB64, s, searchQuery) {
  s = s || settings();
  const primary = s.model;
  const fallback = s.fallback;
  const key = prop('GEMINI_API_KEY', '');
  if (!key) {
    console.log('未設定 GEMINI_API_KEY');
    return '查核服務還沒設定好，請管理員檢查設定。';
  }

  // Tavily 即時搜尋：有設定 key 且不是圖片時，先把問題（去掉連結）拿去搜尋，
  // 再把結果交給 Gemini。搜尋成功就不用 Google 搜尋工具（免費版 3.x 不能用，會直接 429）。
  // 結果編號 1、2、3… 和回答裡的 [1]、[2] 對上，機器人最後自己附來源清單。
  let q = question;
  let searched = false;
  let tavilyItems = [];
  if (!imageB64 && searchQuery && s.tavily) {
    const queryText = searchQuery.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
    if (queryText.length >= 10) {
      tavilyItems = tavilySearch(queryText);
      if (tavilyItems.length) {
        const lines = tavilyItems.map(function (r, i) {
          return (i + 1) + '. ' + tierLabel(sourceTier(r.url)) + ' ' + r.title + '\n' + r.url + '\n' + r.content;
        });
        q = question + '\n\n即時搜尋結果（請根據這些來源判斷，內文用 [1]、[2] 這種編號標來源；不要自己寫「資料來源：」清單，機器人會附）：\n' + lines.join('\n\n');
        searched = true;
      }
    }
  }

  const res = callGeminiModel(primary, key, q, imageB64, s, !searched);
  if (res.ok) return attachSources(res.text, searched ? tavilyItems : res.sources);

  // 可以換備用模型試試的錯誤：429（額度用完）、404（型號退役）、5xx（Google 那邊暫時出錯）、0（連不上或回應壞掉）
  const retryable = res.code === 429 || res.code === 404 || res.code === 0 || res.code >= 500;
  if (retryable && fallback && fallback !== primary) {
    console.log('主要模型 ' + primary + ' 失敗 (' + res.code + ')，改用備用模型 ' + fallback);
    const res2 = callGeminiModel(fallback, key, q, imageB64, s, !searched);
    if (res2.ok) return attachSources(res2.text, searched ? tavilyItems : res2.sources);
    return friendlyGeminiError(res2.code, res2.body);
  }
  return friendlyGeminiError(res.code, res.body);
}

// 呼叫 Gemini（必要時會重試）。成功回傳 { ok: true, text }，失敗回傳 { ok: false, code, body }。
// useTools=false 時不附 Google 搜尋工具（Tavily 已經搜過了，或本來就沒要用）。
// 503 / 5xx / 連不上時等 2 秒再試一次（Google 暫時太忙，通常幾秒就好）。
function callGeminiModel(model, key, question, imageB64, s, useTools) {
  s = s || settings();
  if (useTools === undefined) useTools = true;
  console.log('Gemini model: ' + model); // 在執行紀錄裡可以看到實際用的型號
  const res = tryOnce(model, key, question, imageB64, useTools, s);
  if (res.ok) return res;
  // 搜尋工具可能不在免費額度內（Gemini 3.x 免費版不能用 Google 搜尋）：
  // 400 / 403 / 429 都拿掉搜尋再試一次（金鑰錯誤除外，重試也沒用）。
  // 如果是真的額度用完，無搜尋重試也會失敗，就回傳原本的錯誤。
  // 第一次就沒用搜尋工具時，重試會是一模一樣的請求，所以不重試。
  if (useTools && (res.code === 400 || res.code === 403 || res.code === 429) && res.body && !/API_KEY_INVALID|API key not valid/i.test(res.body)) {
    console.log(res.code + '，改用無搜尋重試');
    const res2 = tryOnce(model, key, question, imageB64, false, s);
    if (res2.ok) {
      res2.text += '\n\n（這次無法即時搜尋，內容請再確認）';
      return res2;
    }
    return res;
  }
  // 503 / 5xx / 連不上：Google 那邊暫時太忙，通常幾秒就好。
  // 等 2 秒再試一次同一個模型（只試一次；就算兩個模型都等，整個流程還是遠在 LINE 60 秒回覆期限內）。
  // 429 不在這裡等——那是額度問題，等 2 秒沒用，換備用模型才是正解。
  if (res.code === 0 || res.code >= 500) {
    console.log(res.code + '，等 2 秒再試一次');
    Utilities.sleep(2000);
    return tryOnce(model, key, question, imageB64, useTools, s);
  }
  return res;
}

// 真正送一次請求。useTools=true 會附上 Google 搜尋。
function tryOnce(model, key, question, imageB64, useTools, s) {
  s = s || settings();
  const url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

  const parts = [{ text: s.systemPrompt + '\n\n要查核的內容：\n' + question }];
  if (imageB64) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageB64 } });
  }
  const payload = {
    contents: [{ parts: parts }],
    generationConfig: { maxOutputTokens: s.maxOutputTokens }
  };
  // 注意：temperature 在 Gemini 3.6 之後的模型會被忽略，Google 說未來會直接回 400，所以不送。
  if (useTools) payload.tools = [{ googleSearch: {} }];

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.log('Gemini 連線失敗: ' + err);
    return { ok: false, code: 0, body: '' };
  }

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) {
    console.log('Gemini 錯誤 ' + code + ': ' + body.slice(0, 2000)); // 印夠長，quotaId 才看得到
    return { ok: false, code: code, body: body };
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    console.log('Gemini 回應不是 JSON: ' + body.slice(0, 300));
    return { ok: false, code: 0, body: '' };
  }
  const cand = (data.candidates || [])[0];
  const text = cand && cand.content
    ? (cand.content.parts || []).map(function (p) { return p.text || ''; }).join('')
    : '';
  if (!text) {
    console.log('Gemini 沒有文字回應: ' + body.slice(0, 300));
    return { ok: false, code: 0, body: '' };
  }

  // 來源連結（grounding 附的）：只收集起來，不在這裡附上——
  // askGemini 會用同一份編號附上真正的清單，模型自己寫的清單會被拿掉。
  const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const sources = [];
  chunks.forEach(function (c) {
    const w = c.web || {};
    if (w.uri && sources.every(function (s2) { return s2.url !== w.uri; })) {
      sources.push({ title: w.title || '', url: w.uri });
    }
  });
  return { ok: true, text: text.trim(), sources: sources };
}

// 兩個模型都失敗時，給群組看的白話訊息。
// 429 有兩種，要分清楚：每分鐘太多（等一分鐘就好）、每天太多（明天再試）。
// 先看 quotaId（PerMinute / PerDay 最準），再看 retryDelay。
function friendlyGeminiError(code, body) {
  if (code === 429) {
    const b = body || '';
    if (/PerMinute/i.test(b)) return '問太快了，等一分鐘再試一次。';
    if (/PerDay/i.test(b)) return '今天問太多了，主要和備用模型的免費額度都用完了，明天再試。';
    if (/retryDelay|per minute/i.test(b)) return '問太快了，等一分鐘再試一次。';
    return '免費額度暫時用完了，等一會兒再試，如果還是不行就明天再試。';
  }
  if (code === 404) return '模型名稱可能已退役，機器人會在每月檢查時自動換一個新的模型。';
  if (code) return '查核服務出錯了（' + code + '），晚點再試。';
  return '查核服務暫時連不上，晚點再試一次。';
}

// ---------- LINE ----------
function downloadLineImage(messageId) {
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN', '');
  if (!token || !messageId) return '';
  try {
    const res = UrlFetchApp.fetch(LINE_CONTENT_URL + encodeURIComponent(messageId) + '/content', {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return '';
    return Utilities.base64Encode(res.getContent());
  } catch (err) {
    console.log('下載圖片失敗: ' + err);
    return '';
  }
}

function replyMessages(replyToken, messages) {
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN', '');
  if (!token) {
    console.log('未設定 LINE_CHANNEL_ACCESS_TOKEN');
    return false;
  }
  const payload = {
    replyToken: replyToken,
    messages: messages
  };
  try {
    const res = UrlFetchApp.fetch(LINE_REPLY_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      console.log('LINE reply 失敗 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.log('LINE reply 連線失敗: ' + err);
    return false;
  }
}

function replyLine(replyToken, text, s) {
  s = s || settings();
  let t = (text || '').trim();
  if (t.length > s.maxReplyChars) t = t.slice(0, s.maxReplyChars) + '……';
  return replyMessages(replyToken, [{ type: 'text', text: t }]);
}

// Flex 卡片回覆。萬一卡片被 LINE 拒絕，改回文字版設定（至少擁有者還能改）。
function replyFlex(replyToken, flex) {
  if (replyMessages(replyToken, [flex])) return true;
  const s = settings();
  const lines = [
    '⚙️ 設定（文字版，卡片打不開）',
    '主要模型：' + s.model,
    '備用模型：' + s.fallback,
    '字數下限：' + s.autoMinChars + ' 字',
    '連結抓取：' + (s.fetchLinkText ? '開' : '關'),
    '即時搜尋：' + (s.tavily ? '開' : '關'),
    '有字圖片：' + (s.image ? '開' : '關'),
    '影片：暫停',
    '回覆上限：' + s.maxReplyChars + ' 字',
    '版本：' + SCRIPT_VERSION,
    '每月檢查：' + (triggerExists() ? '已排程' : '未排程'),
    '直接改：傳送「字數 <數字>」「提示詞」'
  ];
  return replyLine(replyToken, lines.join('\n'), s);
}
