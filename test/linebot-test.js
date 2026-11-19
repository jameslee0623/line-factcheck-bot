// LINE fact-check bot tests — runs Code.gs in Node with stubbed Apps Script services.
// Usage: node test/linebot-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ' — ' + e.message);
    console.log('FAIL: ' + name + ' — ' + e.message);
  }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assert failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

// ---- fresh sandbox per test ----
function fresh() {
  const props = new Map();
  const cache = new Map();
  const triggers = [];
  const calls = [];   // every UrlFetchApp.fetch call {url, opts}
  const replies = []; // payloads sent to LINE reply endpoint
  const logs = [];
  const state = {
    gemini: null,      // fn(url, opts) -> {code, body} | 'throw'
    imageOk: true,
    replyCode: 200,
    listCode: 200,
    linkHtml: '<html><head><title>T</title></head><body><p>文章內文在這裡。</p></body></html>',
    linkCode: 200,
    groupName: '家族長輩群',
    memberName: '爸爸',
    modelList: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    ],
  };
  function resp(code, body, bytes) {
    return {
      getResponseCode: () => code,
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
      getContent: () => (bytes || Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))),
    };
  }
  function geminiOk(text, sources) {
    return {
      candidates: [{
        content: { parts: [{ text: text || '查核答案' }] },
        groundingMetadata: { groundingChunks: (sources || ['https://example.com/src']).map(u => ({ web: { uri: u } })) },
      }],
    };
  }
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: (k) => { props.delete(k); },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, v); },
      }),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        calls.push({ url, opts });
        if (url.indexOf(':generateContent') !== -1) {
          if (state.gemini === 'throw') throw new Error('network down');
          if (typeof state.gemini === 'function') return state.gemini(url, opts);
          return resp(200, geminiOk());
        }
        if (url === LINE_REPLY_URL) {
          replies.push(JSON.parse(opts.payload));
          return resp(state.replyCode, '{}');
        }
        if (url.indexOf('/message/') !== -1 && url.endsWith('/content')) {
          if (!state.imageOk) return resp(404, 'not found');
          return resp(200, '', Buffer.from('fake-jpeg-bytes'));
        }
        if (url.indexOf('/group/') !== -1 && url.endsWith('/summary')) {
          return resp(200, { groupId: 'C1', groupName: state.groupName });
        }
        if (url.indexOf('/group/') !== -1 && url.indexOf('/member/') !== -1) {
          return resp(200, { displayName: state.memberName, userId: 'U1' });
        }
        if (url.indexOf('/v1beta/models?') !== -1) {
          if (state.listCode !== 200) return resp(state.listCode, 'err');
          return resp(200, { models: state.modelList });
        }
        // anything else: link fetch
        return resp(state.linkCode, state.linkHtml);
      },
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (tr) => { const i = triggers.indexOf(tr); if (i !== -1) triggers.splice(i, 1); },
      newTrigger: (fn) => ({
        timeBased: () => ({
          onMonthDay: (d) => ({
            atHour: (h) => ({
              create: () => { const tr = { getHandlerFunction: () => fn, day: d, hour: h }; triggers.push(tr); return tr; },
            }),
          }),
        }),
      }),
    },
    ContentService: {
      MimeType: { TEXT: 'text' },
      createTextOutput: (s) => ({ setMimeType: () => ({ getContent: () => s }) }),
    },
    Utilities: { base64Encode: (b) => Buffer.from(b).toString('base64') },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { sb: sandbox, props, cache, triggers, calls, replies, logs, state, geminiOk, resp };
}

function setProps(env, obj) {
  Object.keys(obj).forEach(k => env.props.set(k, String(obj[k])));
}
let tokenN = 0;
function msgEv(o) {
  tokenN++;
  return {
    type: 'message',
    replyToken: 'tok' + tokenN,
    source: o.source || { type: 'user', userId: o.userId || 'Uowner' },
    message: o.message || { type: 'text', text: o.text || '' },
  };
}
function groupEv(o) {
  return msgEv({
    source: { type: 'group', groupId: o.groupId || 'C1', userId: o.userId || 'U1' },
    message: o.message || { type: 'text', text: o.text || '' },
  });
}
function postEv(o) {
  tokenN++;
  return {
    type: 'postback',
    replyToken: 'tok' + tokenN,
    source: { type: 'user', userId: o.userId || 'Uowner' },
    postback: { data: o.data },
  };
}
function replyTexts(env) {
  return env.replies.map(r => (r.messages || []).map(m => m.type === 'text' ? m.text : '[flex:' + (m.altText || '?') + ']').join(' | '));
}
function hasFlex(env) {
  return env.replies.some(r => (r.messages || []).some(m => m.type === 'flex'));
}
function geminiCalls(env) {
  return env.calls.filter(c => c.url.startsWith(GEMINI_BASE));
}
function geminiQuestion(env, i) {
  const c = geminiCalls(env)[i || 0];
  if (!c) return '';
  const payload = JSON.parse(c.opts.payload);
  return payload.contents[0].parts[0].text;
}

// ================= old behavior (regression) =================
t('1. primary 200 -> answer + sources, no fallback', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ text: '查 台積電要被美國罰款是真的嗎' }));
  eq(e.replies.length, 1, 'replies ');
  assert(replyTexts(e)[0].indexOf('查核答案') !== -1, 'answer present');
  assert(replyTexts(e)[0].indexOf('https://example.com/src') !== -1, 'sources present');
  eq(geminiCalls(e).length, 1, 'one gemini call');
});

t('2. primary 429 PerDay -> fallback 200 -> answer', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  let n = 0;
  e.state.gemini = (url) => {
    n++;
    if (n === 1) return e.resp(429, { error: { code: 429, message: 'quota', details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] } });
    if (n === 2) return e.resp(429, { error: { code: 429, message: 'quota' } }); // no-search retry also 429
    return e.resp(200, e.geminiOk('備用答案'));
  };
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('備用答案') !== -1, 'fallback answer');
});

t('3. both models 429 PerDay -> daily message', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.gemini = () => e.resp(429, { error: { code: 429, details: [{ quotaId: 'PerDay' }] } });
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('明天再試') !== -1, 'daily msg: ' + replyTexts(e)[0]);
});

t('4. both models 429 PerMinute -> wait-a-minute message', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.gemini = () => e.resp(429, { error: { code: 429, details: [{ quotaId: 'PerMinute' }] } });
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('等一分鐘') !== -1, 'per-minute msg');
});

t('5. both models 429 no quotaId -> neutral message', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.gemini = () => e.resp(429, { error: { code: 429, message: 'You exceeded your current quota' } });
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('等一會兒再試') !== -1, 'neutral msg');
});

t('6. 400 API_KEY_INVALID -> no retry, error message', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'bad', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.gemini = () => e.resp(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } });
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  eq(geminiCalls(e).length, 1, 'one call only: 400 is not retryable, bad key skips no-search retry');
  assert(replyTexts(e)[0].indexOf('查核服務出錯了（400）') !== -1, '400 msg');
});

t('7. 400 other -> no-search retry succeeds, note appended', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  let n = 0;
  e.state.gemini = () => {
    n++;
    if (n === 1) return e.resp(400, { error: { code: 400, message: 'something' } });
    return e.resp(200, e.geminiOk('無搜尋答案'));
  };
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('無搜尋答案') !== -1, 'retry answer');
  assert(replyTexts(e)[0].indexOf('無法即時搜尋') !== -1, 'note appended');
  const payload = JSON.parse(geminiCalls(e)[1].opts.payload);
  assert(!payload.tools, 'second call has no tools');
});

t('8. network throw -> fallback tried', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  let n = 0;
  e.state.gemini = () => { n++; if (n === 1) return 'throw'; return e.resp(200, e.geminiOk('連上備用')); };
  e.state.gemini = (url) => { n++; if (n === 1) throw new Error('down'); return e.resp(200, e.geminiOk('連上備用')); };
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('連上備用') !== -1, 'fallback after network fail');
});

t('9. 404 both -> model retired message (mentions 設定)', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.gemini = () => e.resp(404, { error: { code: 404, message: 'not found' } });
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('退役') !== -1 && replyTexts(e)[0].indexOf('每月檢查') !== -1, '404 msg: ' + replyTexts(e)[0]);
});

t('10. missing GEMINI_API_KEY -> setup message', () => {
  const e = fresh();
  setProps(e, { LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('還沒設定好') !== -1, 'setup msg');
  eq(geminiCalls(e).length, 0, 'no gemini call');
});

t('11. 200 invalid JSON -> fallback', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  let n = 0;
  e.state.gemini = () => { n++; if (n === 1) return e.resp(200, 'not-json{{{'); return e.resp(200, e.geminiOk('修好')); };
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('修好') !== -1, 'fallback after bad json');
});

t('12. 200 no text -> fallback', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  let n = 0;
  e.state.gemini = () => { n++; if (n === 1) return e.resp(200, { candidates: [{ content: { parts: [] } }] }); return e.resp(200, e.geminiOk('有文字')); };
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(replyTexts(e)[0].indexOf('有文字') !== -1, 'fallback after empty');
});

t('13. image download failure -> retry message', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.imageOk = false;
  e.sb.handleEvent(msgEv({ message: { type: 'image', id: 'mid1' } }));
  assert(replyTexts(e)[0].indexOf('圖片下載失敗') !== -1, 'image fail msg');
});

t('14. doPost logs Bot version 1.1.1', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.doPost({ postData: { contents: JSON.stringify({ events: [groupEv({ text: '查 x' })] }) }, parameter: {} });
  assert(e.logs.some(l => l.indexOf('Bot version: 1.1.1') !== -1), 'version log: ' + e.logs.join(' / '));
});

// ================= panel triggers =================
t('15. panel trigger setting (exact) -> flex panel, owner claimed', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(msgEv({ text: 'setting' }));
  assert(hasFlex(e), 'flex shown');
  eq(e.props.get('OWNER_USER_ID'), 'Uowner', 'owner claimed');
  eq(geminiCalls(e).length, 0, 'no fact-check');
});

t('16. panel trigger Settings (capital) -> panel', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(msgEv({ text: 'Settings' }));
  assert(hasFlex(e), 'flex shown');
});

t('17. panel trigger 設定 with trailing space -> panel', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(msgEv({ text: '設定 ' }));
  assert(hasFlex(e), 'flex shown');
});

t('18. setting inside a sentence -> fact-check, no panel', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(msgEv({ text: 'what is the setting' }));
  assert(!hasFlex(e), 'no flex');
  eq(geminiCalls(e).length, 1, 'fact-checked');
});

t('19. non-owner 設定 -> denial, no panel', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(msgEv({ userId: 'Ustranger', text: '設定' }));
  assert(!hasFlex(e), 'no flex for stranger');
  assert(replyTexts(e)[0].indexOf('只有擁有者') !== -1, 'denial msg');
});

t('20. panel trigger in group -> no panel, silent', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ text: '設定' }));
  eq(e.replies.length, 0, 'silent in group');
  eq(e.props.get('OWNER_USER_ID') || '', '', 'owner not claimed from group');
});

// ================= length gate =================
t('21. group short plain text (<100) -> silent', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ text: '今天天氣很好大家早安' }));
  eq(e.replies.length, 0, 'silent');
  eq(geminiCalls(e).length, 0, 'no gemini');
});

t('22. group long plain text (>=100) -> auto fact-check', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  const long = '這是一個很長的轉發訊息，內容是關於某個健康謠言，說每天喝某種東西可以治百病，請大家一定要看完並且轉發給親友注意身體健康。'.repeat(2);
  assert(long.length >= 100, 'test text long enough: ' + long.length);
  e.sb.handleEvent(groupEv({ text: long }));
  eq(geminiCalls(e).length, 1, 'auto-checked');
});

t('23. manual trigger bypasses length gate', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ text: '查 短' }));
  eq(geminiCalls(e).length, 1, 'manual works short');
});

t('24. short URL in group -> auto fact-check (link fetch)', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ text: 'https://example.com/news/123' }));
  eq(geminiCalls(e).length, 1, 'url auto-checked');
  assert(geminiQuestion(e).indexOf('文章內文在這裡') !== -1, 'link text included in question');
});

// ================= allow-list =================
t('25. allow-list: non-listed user long text silent, listed user checked, manual bypasses', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', ALLOW_C1: JSON.stringify({ U1: true }) });
  const long = '這是一個很長的轉發訊息，內容是關於某個健康謠言，說每天喝某種東西可以治百病，請大家一定要看完並且轉發給親友注意身體健康。'.repeat(2);
  e.sb.handleEvent(groupEv({ userId: 'U2', text: long }));
  eq(geminiCalls(e).length, 0, 'U2 blocked');
  e.sb.handleEvent(groupEv({ userId: 'U1', text: long }));
  eq(geminiCalls(e).length, 1, 'U1 allowed');
  e.sb.handleEvent(groupEv({ userId: 'U2', text: '查 短' }));
  eq(geminiCalls(e).length, 2, 'manual bypasses allow-list');
});

// ================= video pause =================
t('26. video URL in group -> silent', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ text: '看看這個 https://www.youtube.com/watch?v=abc123' }));
  eq(e.replies.length, 0, 'silent for video link');
  eq(geminiCalls(e).length, 0, 'no gemini');
});

t('27. video message in 1:1 -> paused note; in group -> silent', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(msgEv({ message: { type: 'video', id: 'v1' } }));
  assert(replyTexts(e)[0].indexOf('影片查核目前暫停') !== -1, 'paused note in 1:1');
  e.sb.handleEvent(groupEv({ message: { type: 'video', id: 'v2' } }));
  eq(e.replies.length, 1, 'group video silent');
});

// ================= image toggles =================
t('28. group image: IMAGE_GROUP=0 silent, =1 checked', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', IMAGE_GROUP: '0' });
  e.sb.handleEvent(groupEv({ message: { type: 'image', id: 'im1' } }));
  eq(geminiCalls(e).length, 0, 'off silent');
  e.props.set('IMAGE_GROUP', '1');
  e.sb.handleEvent(groupEv({ message: { type: 'image', id: 'im2' } }));
  eq(geminiCalls(e).length, 1, 'on checked');
  assert(geminiQuestion(e).indexOf('圖片') !== -1, 'image question');
});

// ================= postbacks =================
t('29. postback panel:model:set is ignored (models off the panel)', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(postEv({ data: 'panel:model:set:primary:gemini-3.5-flash-lite' }));
  eq(e.props.get('GEMINI_MODEL') || '', '', 'model not changed');
  eq(e.replies.length, 0, 'no reply');
});

t('30. postback toggle flips FETCH_LINK_TEXT and re-shows panel', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner', FETCH_LINK_TEXT: '1' });
  e.sb.handleEvent(postEv({ data: 'panel:toggle:FETCH_LINK_TEXT' }));
  eq(e.props.get('FETCH_LINK_TEXT'), '0', 'flipped off');
  assert(hasFlex(e), 'panel re-shown');
  e.sb.handleEvent(postEv({ data: 'panel:toggle:FETCH_LINK_TEXT' }));
  eq(e.props.get('FETCH_LINK_TEXT'), '1', 'flipped back on');
});

t('31. postback from non-owner -> denial', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(postEv({ userId: 'Ustranger', data: 'panel:toggle:FETCH_LINK_TEXT' }));
  assert(!hasFlex(e), 'no flex');
  assert(replyTexts(e)[0].indexOf('只有擁有者') !== -1, 'denial');
  eq(e.props.get('FETCH_LINK_TEXT') || '1', '1', 'not flipped');
});

t('32. postback group select -> member flex with learned names', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  // a group message first so the bot learns the group + member
  e.sb.handleEvent(groupEv({ userId: 'U1', text: '查 x' }));
  assert(e.props.get('GROUP_NAMES'), 'group learned');
  e.sb.handleEvent(postEv({ data: 'panel:groups' }));
  assert(hasFlex(e), 'group list flex');
  e.sb.handleEvent(postEv({ data: 'panel:group:C1' }));
  const flex = e.replies[e.replies.length - 1].messages[0];
  const dump = JSON.stringify(flex);
  assert(dump.indexOf('爸爸') !== -1, 'member name in card: ' + dump.slice(0, 300));
});

t('33. postback user toggle flips allow-list', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner', GROUP_MEMBERS_C1: JSON.stringify({ U1: '爸爸', U2: '媽媽' }) });
  e.sb.handleEvent(postEv({ data: 'panel:user:C1:U2' }));
  const map = JSON.parse(e.props.get('ALLOW_C1'));
  assert(map.U1 === true && !map.U2, 'U2 off, U1 on: ' + JSON.stringify(map));
  e.sb.handleEvent(postEv({ data: 'panel:user:C1:U2' }));
  assert(JSON.parse(e.props.get('ALLOW_C1')).U2 === true, 'U2 back on');
});

// ================= text inputs (await state) =================
t('34. await_prompt saves SYSTEM_PROMPT, next call uses it', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(postEv({ data: 'panel:prompt' }));
  assert(replyTexts(e)[0].indexOf('傳送新的提示詞') !== -1, 'prompt ask');
  e.sb.handleEvent(msgEv({ text: '你是嚴格的查核員，只說實話。' }));
  eq(e.props.get('SYSTEM_PROMPT'), '你是嚴格的查核員，只說實話。', 'prompt saved');
  e.sb.handleEvent(groupEv({ text: '查 x' }));
  assert(geminiQuestion(e).indexOf('嚴格的查核員') !== -1, 'new prompt used');
});

t('35. await_number valid saves, invalid keeps state', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(postEv({ data: 'panel:num:AUTO_MIN_CHARS' }));
  e.sb.handleEvent(msgEv({ text: 'abc' }));
  assert(replyTexts(e).join(' ').indexOf('請傳送') !== -1, 'invalid rejected');
  eq(e.props.get('AUTO_MIN_CHARS') || '', '', 'not saved');
  e.sb.handleEvent(msgEv({ text: '50' }));
  eq(e.props.get('AUTO_MIN_CHARS'), '50', 'saved 50');
});

t('36. postback panel:model:type is ignored (models off the panel)', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(postEv({ data: 'panel:model:type:primary' }));
  eq(e.replies.length, 0, 'no reply');
  // the next message is fact-checked, not eaten as a model name
  e.sb.handleEvent(msgEv({ text: 'gemini-9-test' }));
  eq(geminiCalls(e).length, 1, 'normal message');
});

t('37. direct command 模型 <name> no longer sets the model', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(msgEv({ text: '模型 gemini-3.5-flash-lite' }));
  eq(e.props.get('GEMINI_MODEL') || '', '', 'model not changed');
  eq(geminiCalls(e).length, 1, 'fact-checked as a normal message');
});

t('38. direct command 字數 <n> updates limit', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(msgEv({ text: '字數 200' }));
  eq(e.props.get('AUTO_MIN_CHARS'), '200', 'limit set');
});

t('39. 取消 clears state and shows panel', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(postEv({ data: 'panel:prompt' }));
  e.sb.handleEvent(msgEv({ text: '取消' }));
  assert(hasFlex(e), 'panel back');
  eq(e.props.get('PANEL_Uowner'), '{}', 'state cleared');
  // the next message is fact-checked, not eaten as a prompt
  e.sb.handleEvent(msgEv({ text: '今天天氣如何' }));
  eq(geminiCalls(e).length, 1, 'normal message after cancel');
});

t('40. triggers setting: new trigger works, old one stops', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.sb.handleEvent(postEv({ data: 'panel:triggers' }));
  e.sb.handleEvent(msgEv({ text: '問,!fact' }));
  eq(e.props.get('TRIGGERS'), '問,!fact', 'triggers saved');
  e.sb.handleEvent(groupEv({ text: '問 短' }));
  eq(geminiCalls(e).length, 1, 'new trigger works');
  e.sb.handleEvent(groupEv({ text: '查 短' }));
  eq(geminiCalls(e).length, 1, 'old trigger no longer works');
});

// ================= link fetch =================
t('41. link fetch failure -> falls back to URL only', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.linkCode = 404;
  e.sb.handleEvent(groupEv({ text: 'https://example.com/news/123' }));
  eq(geminiCalls(e).length, 1, 'still checked');
  assert(geminiQuestion(e).indexOf('https://example.com/news/123') !== -1, 'url in question');
  assert(geminiQuestion(e).indexOf('文章內文在這裡') === -1, 'no page text');
});

t('42. FETCH_LINK_TEXT=0 -> no fetch', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', FETCH_LINK_TEXT: '0' });
  e.sb.handleEvent(groupEv({ text: 'https://example.com/news/123' }));
  const linkCalls = e.calls.filter(c => c.url === 'https://example.com/news/123');
  eq(linkCalls.length, 0, 'no link fetch');
});

// ================= flex structure =================
t('43. flex JSON valid: all buttons postback panel:, data <= 300 chars', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner', GROUP_NAMES: JSON.stringify({ C1: '家族長輩群' }), GROUP_MEMBERS_C1: JSON.stringify({ U1: '爸爸' }) });
  const s = e.sb.settings();
  const cards = [e.sb.panelFlex(s), e.sb.groupListFlex(s), e.sb.memberFlex('C1', s)];
  cards.forEach((card, i) => {
    const dump = JSON.stringify(card);
    assert(dump.length > 100, 'card ' + i + ' non-empty');
    JSON.parse(dump);
    assert(card.type === 'flex' && card.contents.type === 'bubble', 'card ' + i + ' flex bubble');
    const btns = [];
    (function walk(o) {
      if (o && typeof o === 'object') {
        if (o.type === 'button') btns.push(o);
        Object.keys(o).forEach(k => walk(o[k]));
      }
    })(card);
    assert(btns.length > 0, 'card ' + i + ' has buttons');
    btns.forEach(b => {
      eq(b.action.type, 'postback', 'button postback');
      assert(typeof b.action.data === 'string' && b.action.data.indexOf('panel:') === 0, 'data panel: ' + b.action.data);
      assert(b.action.data.length <= 300, 'data length ' + b.action.data.length);
      assert(typeof b.action.label === 'string' && b.action.label.length > 0, 'label present');
    });
  });
});

t('44. group learning stores name + member', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.handleEvent(groupEv({ userId: 'U1', text: '查 x' }));
  eq(JSON.parse(e.props.get('GROUP_NAMES')).C1, '家族長輩群', 'group name learned');
  eq(JSON.parse(e.props.get('GROUP_MEMBERS_C1')).U1, '爸爸', 'member learned');
});

// ================= monthly model check =================
function flashList(names) {
  return names.map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] }));
}

t('45. monthly check: both models still listed -> no change', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL') || '', '', 'primary untouched');
  eq(e.props.get('GEMINI_MODEL_FALLBACK') || '', '', 'fallback untouched');
  assert(e.logs.some(l => l.indexOf('還在，不換') !== -1), 'logged keep: ' + e.logs.join(' / '));
});

t('46. monthly check: primary retired -> newest Flash, fallback unchanged', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.modelList = flashList(['gemini-4.0-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash']);
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL'), 'gemini-4.0-flash', 'primary switched');
  eq(e.props.get('GEMINI_MODEL_FALLBACK') || '', '', 'fallback untouched');
});

t('47. monthly check: fallback retired -> newest Lite', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.modelList = flashList(['gemini-3.8-flash', 'gemini-4.0-flash-lite', 'gemini-2.5-flash-lite']);
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL') || '', '', 'primary untouched');
  eq(e.props.get('GEMINI_MODEL_FALLBACK'), 'gemini-4.0-flash-lite', 'fallback switched');
});

t('48. monthly check: both retired -> both switch', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.modelList = flashList(['gemini-4.0-flash', 'gemini-4.0-flash-lite']);
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL'), 'gemini-4.0-flash', 'primary switched');
  eq(e.props.get('GEMINI_MODEL_FALLBACK'), 'gemini-4.0-flash-lite', 'fallback switched');
});

t('49. monthly check: newer Flash exists but old not retired -> NO switch', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.modelList = flashList(['gemini-3.8-flash', 'gemini-4.0-flash', 'gemini-3.5-flash-lite', 'gemini-4.0-flash-lite']);
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL') || '', '', 'primary not switched to newer');
  eq(e.props.get('GEMINI_MODEL_FALLBACK') || '', '', 'fallback not switched to newer');
});

t('50. monthly check: skips preview/exp/pro, picks newest stable Flash', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.modelList = flashList(['gemini-4.1-flash-preview', 'gemini-4.0-flash', 'gemini-3.5-flash-lite']);
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL'), 'gemini-4.0-flash', 'preview skipped');
});

t('51. monthly check: verify fails for top candidate -> tries next', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.modelList = flashList(['gemini-4.0-flash', 'gemini-3.9-flash', 'gemini-3.5-flash-lite']);
  e.state.gemini = (url) => {
    if (url.indexOf('gemini-4.0-flash') !== -1) return e.resp(500, 'err');
    return e.resp(200, e.geminiOk('ok'));
  };
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL'), 'gemini-3.9-flash', 'fell through to next candidate');
});

t('52. monthly check: list call fails -> no change', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.listCode = 500;
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL') || '', '', 'no change');
});

t('53. monthly check: retired but no candidate -> no change', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', GEMINI_MODEL: 'gemini-9.9-flash' });
  e.state.modelList = flashList(['gemini-1.5-pro', 'gemini-embedding-001']);
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL'), 'gemini-9.9-flash', 'kept old model');
});

t('54. setupMonthlyCheck creates one trigger, twice still one', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.sb.setupMonthlyCheck();
  e.sb.setupMonthlyCheck();
  eq(e.triggers.length, 1, 'one trigger');
  eq(e.triggers[0].getHandlerFunction(), 'monthlyModelCheck', 'handler name');
  eq(e.triggers[0].day, 1, '1st of month');
  eq(e.triggers[0].hour, 9, '9am');
});

t('55. panel has no model section', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  const dump = JSON.stringify(e.sb.panelFlex(e.sb.settings()));
  assert(dump.indexOf('主要模型') === -1, 'no primary row');
  assert(dump.indexOf('備用模型') === -1, 'no fallback row');
  assert(dump.indexOf('panel:model') === -1, 'no model postbacks');
  assert(dump.indexOf('panel:models') === -1, 'no models postbacks');
});

t('56. flex reply fails -> text fallback has no model command', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_USER_ID: 'Uowner' });
  e.state.replyCode = 500;
  e.sb.handleEvent(msgEv({ text: '設定' }));
  eq(e.replies.length, 2, 'flex attempt + text fallback');
  const fallback = e.replies[1].messages[0].text;
  assert(fallback.indexOf('模型 <名稱>') === -1, 'no model command in fallback');
  assert(fallback.indexOf('主要模型：gemini-3.8-flash') !== -1, 'models still shown as info');
});

t('57. rankFlashModels orders by version, filters correctly', () => {
  const e = fresh();
  const models = [
    { name: 'gemini-2.5-flash', methods: ['generateContent'] },
    { name: 'gemini-4.0-flash-preview', methods: ['generateContent'] },
    { name: 'gemini-3.8-flash', methods: ['generateContent'] },
    { name: 'gemini-4.0-flash', methods: ['generateContent'] },
    { name: 'gemini-4.0-flash-lite', methods: ['generateContent'] },
    { name: 'gemini-1.5-pro', methods: ['generateContent'] },
    { name: 'gemini-4.0-flash', methods: ['countTokens'] },
  ];
  eq(JSON.stringify(e.sb.rankFlashModels(models, false)), JSON.stringify(['gemini-4.0-flash', 'gemini-3.8-flash', 'gemini-2.5-flash']), 'primary ranking');
  eq(JSON.stringify(e.sb.rankFlashModels(models, true)), JSON.stringify(['gemini-4.0-flash-lite']), 'lite ranking');
});

t('58. listModels parses names and methods', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k' });
  e.state.modelList = [{ name: 'models/gemini-9.9-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }];
  const out = e.sb.listModels();
  eq(out.length, 1, 'one model');
  eq(out[0].name, 'gemini-9.9-flash', 'prefix stripped');
  assert(out[0].methods.indexOf('generateContent') !== -1, 'methods kept');
});

t('59. monthly check uses newest Lite only for fallback, never as primary', () => {
  const e = fresh();
  setProps(e, { GEMINI_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' });
  e.state.modelList = flashList(['gemini-4.0-flash-lite', 'gemini-3.5-flash-lite']);
  e.sb.monthlyModelCheck();
  eq(e.props.get('GEMINI_MODEL') || '', '', 'primary not set to a Lite');
});

// ================= summary =================
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  console.log('Failures:\n' + failures.map(f => ' - ' + f).join('\n'));
  process.exit(1);
}
