/**
 * LINE 群組事實查核機器人 — Google Apps Script 版
 *
 * 用免費的 Gemini API 查核群組裡轉發的文章 / 說法，語氣溫和，先肯定再補充。
 * 成本 $0：只用 reply 回覆（回覆不計費），不主動 push。
 *
 * === 設定 ===
 * 在 Apps Script「專案設定 > 指令碼屬性」加入以下屬性（不要寫死在程式碼裡）：
 *   LINE_CHANNEL_ACCESS_TOKEN — LINE Developers Console > Messaging API channel
 *   GEMINI_API_KEY            — Google AI Studio (aistudio.google.com) 免費申請
 *   GEMINI_MODEL              — 主要模型，預設 gemini-3.8-flash；若 AI Studio 顯示已退役，改成當前的 Flash 型號
 *   GEMINI_MODEL_FALLBACK     — 備用模型，預設 gemini-3.5-flash-lite；主要模型額度用完或出錯時自動改用它
 *   WEBHOOK_TOKEN             — 自己訂一串亂碼，LINE webhook URL 後面加 ?token=這串，用來防偽冒
 *
 * === 觸發條件 ===
 *   群組：訊息開頭是「查」/「!fact」/「!check」，或 @ 提到機器人，或內含網址
 *   1:1 私聊：任何文字都回（方便測試）；圖片也可以（群組裡的圖片不自動觸發，可能是家人照片）
 */

// ---------- 常數 ----------
const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_CONTENT_URL = 'https://api.line.me/v2/bot/message/'; // + messageId + '/content'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const TRIGGERS = ['!查', '!fact', '!check', '!factcheck', '查', '查一下', '幫我查'];
const MAX_REPLY_CHARS = 1800;

const USAGE = '我是查核小幫手。用法：\n'
  + '• 貼文章連結，我會幫你查證\n'
  + '• 輸入「查」+ 想問的內容，例如：查 台積電要被美國罰款是真的嗎\n'
  + '• 在群組 @ 我也可以';

const SYSTEM_PROMPT = [
  '你是一個在家庭長輩群組裡的溫和事實查核小幫手。',
  '用繁體中文回答，語氣像晚輩對長輩一樣尊重、溫和。',
  '先肯定訊息中正確或有道理的部分，再用「補充資料」的方式指出錯誤或缺少的脈絡，不要直接說對方錯了，也不要用對抗、嘲諷的語氣。',
  '用搜尋到的資料查核，不要只憑記憶；每個關鍵說法都要有來源，回答最後列出「資料來源：」加連結。',
  '回答要簡短，重點清楚，不要超過 600 字。',
  '如果查不到可靠資料，就說查不到，不要硬編答案。'
].join('\n');

// ---------- 小工具 ----------
function prop(name, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return v ? v : (fallback || '');
}

function textOut(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

function doGet() {
  return textOut('LINE 查核機器人運作中');
}

// ---------- webhook 入口 ----------
function doPost(e) {
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

// ---------- 事件處理 ----------
function handleEvent(ev) {
  if (!ev || ev.type !== 'message') return; // join / leave / follow 等事件不處理
  const token = ev.replyToken;
  if (!token) return;

  // 去重：LINE 沒收到 200 會重送，同一 replyToken 只處理一次
  const cache = CacheService.getScriptCache();
  if (cache.get('evt:' + token)) return;
  cache.put('evt:' + token, '1', 600);

  const msg = ev.message || {};
  const src = ev.source || {};
  const isGroup = src.type === 'group' || src.type === 'room';

  let text = '';
  let imageB64 = '';
  if (msg.type === 'text') {
    text = (msg.text || '').trim();
  } else if (msg.type === 'image' && !isGroup) {
    // 群組裡的圖片不自動觸發（可能是家人照片）；1:1 才接受圖片查核
    imageB64 = downloadLineImage(msg.id);
    if (!imageB64) {
      replyLine(token, '圖片下載失敗，請再傳一次。');
      return;
    }
    text = '請查核這張圖片裡的內容。';
  } else {
    return; // 貼圖、影片、檔案等不處理
  }

  if (!shouldAnswer(msg, text, isGroup)) return;

  const question = stripTrigger(text);
  if (!question || /^(help|說明|用法|hi|hello|你好)$/i.test(question)) {
    replyLine(token, USAGE);
    return;
  }

  const answer = askGemini(question, imageB64);
  if (!answer) return; // 保險用，現在每條路都會回訊息，不應該是 null
  // 不管多慢都試著回（replyToken 60 秒有效；過期了 LINE 會拒絕，replyLine 會記在 log 裡）
  replyLine(token, answer);
}

function shouldAnswer(msg, text, isGroup) {
  // 被 @ 提到就回
  const mentionees = (msg.mention && msg.mention.mentionees) || [];
  if (mentionees.some(function (m) { return m.isSelf; })) return true;
  // 開頭是指令就回
  const lower = text.toLowerCase();
  if (TRIGGERS.some(function (t) { return lower.indexOf(t.toLowerCase()) === 0; })) return true;
  // 內含網址就回（長輩轉發的文章通常是連結）
  if (/https?:\/\/|www\./i.test(text)) return true;
  // 1:1 私聊：任何文字都回（方便測試和自己用）
  if (!isGroup) return true;
  return false;
}

function stripTrigger(text) {
  let t = text;
  TRIGGERS.forEach(function (tr) {
    if (t.toLowerCase().indexOf(tr.toLowerCase()) === 0) t = t.slice(tr.length).trim();
  });
  return t || text;
}

// ---------- Gemini ----------
// 主要模型用滿（429）或出錯時，自動改用備用模型。兩個模型各有自己的免費額度，
// 所以備用模型不會吃掉主要模型的額度。
function askGemini(question, imageB64) {
  const primary = prop('GEMINI_MODEL', 'gemini-3.8-flash');
  const fallback = prop('GEMINI_MODEL_FALLBACK', 'gemini-3.5-flash-lite');
  const key = prop('GEMINI_API_KEY', '');
  if (!key) {
    console.log('未設定 GEMINI_API_KEY');
    return '查核服務還沒設定好，請管理員檢查設定。';
  }

  const res = callGeminiModel(primary, key, question, imageB64);
  if (res.ok) return res.text;

  // 可以換備用模型試試的錯誤：429（額度用完）、404（型號退役）、5xx（Google 那邊暫時出錯）、0（連不上或回應壞掉）
  const retryable = res.code === 429 || res.code === 404 || res.code === 0 || res.code >= 500;
  if (retryable && fallback && fallback !== primary) {
    console.log('主要模型 ' + primary + ' 失敗 (' + res.code + ')，改用備用模型 ' + fallback);
    const res2 = callGeminiModel(fallback, key, question, imageB64);
    if (res2.ok) return res2.text;
    return friendlyGeminiError(res2.code, res2.body);
  }
  return friendlyGeminiError(res.code, res.body);
}

// 呼叫一次 Gemini。成功回傳 { ok: true, text }，失敗回傳 { ok: false, code, body }。
function callGeminiModel(model, key, question, imageB64) {
  console.log('Gemini model: ' + model); // 在執行紀錄裡可以看到實際用的型號
  const res = tryOnce(model, key, question, imageB64, true);
  if (res.ok) return res;
  // 搜尋工具可能不在免費額度內（Gemini 3.x 免費版不能用 Google 搜尋）：
  // 400 / 403 / 429 都拿掉搜尋再試一次（金鑰錯誤除外，重試也沒用）。
  // 如果是真的額度用完，無搜尋重試也會失敗，就回傳原本的錯誤。
  if ((res.code === 400 || res.code === 403 || res.code === 429) && res.body && !/API_KEY_INVALID|API key not valid/i.test(res.body)) {
    console.log(res.code + '，改用無搜尋重試');
    const res2 = tryOnce(model, key, question, imageB64, false);
    if (res2.ok) {
      res2.text += '\n\n（這次無法即時搜尋，內容請再確認）';
      return res2;
    }
    return res;
  }
  return res;
}

// 真正送一次請求。useTools=true 會附上 Google 搜尋。
function tryOnce(model, key, question, imageB64, useTools) {
  const url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

  const parts = [{ text: SYSTEM_PROMPT + '\n\n要查核的內容：\n' + question }];
  if (imageB64) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageB64 } });
  }
  const payload = {
    contents: [{ parts: parts }],
    generationConfig: { maxOutputTokens: 1200 }
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

  // 來源連結（grounding 附的）
  const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const sources = [];
  chunks.forEach(function (c) {
    const w = c.web || {};
    if (w.uri && sources.indexOf(w.uri) === -1) sources.push(w.uri);
  });
  let out = text.trim();
  if (sources.length) out += '\n\n資料來源：\n' + sources.slice(0, 5).join('\n');
  return { ok: true, text: out };
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
  if (code === 404) return '模型名稱可能已退役，請到 AI Studio 查現在的 Flash 型號，改 GEMINI_MODEL。';
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

function replyLine(replyToken, text) {
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN', '');
  if (!token) {
    console.log('未設定 LINE_CHANNEL_ACCESS_TOKEN');
    return;
  }
  let t = (text || '').trim();
  if (t.length > MAX_REPLY_CHARS) t = t.slice(0, MAX_REPLY_CHARS) + '……';
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: t }]
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
    }
  } catch (err) {
    console.log('LINE reply 連線失敗: ' + err);
  }
}
