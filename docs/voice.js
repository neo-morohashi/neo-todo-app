// ──────────────────────────────────────────────────
// voice.js — 1タップ音声クイック追加
// ホーム画面アイコン → 即マイク起動 → しゃべる → inbox.md に追加
// ?text=... を付けて開けば音声をスキップして直接追加（ショートカット用）
// ──────────────────────────────────────────────────
import { getToken, loadAll, getTags, createTask } from './gh.js?v=5';

const els = {
  mic: document.getElementById('mic'),
  transcript: document.getElementById('transcript'),
  meta: document.getElementById('meta'),
  status: document.getElementById('status'),
  actions: document.getElementById('actions'),
};

function setState(state, status) {
  document.body.dataset.state = state;
  if (status !== undefined) els.status.textContent = status;
}
function setTranscript(text, interim) {
  els.transcript.textContent = text;
  els.transcript.classList.toggle('interim', !!interim);
}
function setActions(buttons) {
  els.actions.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = b.label;
    if (b.primary) el.className = 'primary';
    el.onclick = b.onClick;
    els.actions.appendChild(el);
  }
}
function buzz(pattern) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} }
}

// ── 日付ヘルパー（ローカル日付でISO化） ───────────
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

// ── 日本語の口頭指定をパース ──────────────────────
const WEEKDAYS = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
const PI = { ワン: '1', ツー: '2', スリー: '3', フォー: '4' };
// 「までに」「まで」「中に」などの後置詞（期限表現の直後に付きやすい）
const SUFFIX = '(?:\\s*(?:までに|まで|中に|中|に))?';

function nextWeekday(target, weekOffset) {
  const d = new Date();
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0 && weekOffset === 0) delta = 7; // 「月曜」= 直近の未来の月曜
  d.setDate(d.getDate() + delta + weekOffset * 7);
  return d;
}

// [正規表現, マッチ → Date | null] を上から順に適用（最初に当たったものを採用）
const DUE_RULES = [
  [new RegExp(`(?:今日|本日|きょう)${SUFFIX}`), () => plusDays(0)],
  [new RegExp(`(?:明後日|あさって)${SUFFIX}`), () => plusDays(2)],
  [new RegExp(`(?:明日|あした|あす)${SUFFIX}`), () => plusDays(1)],
  [new RegExp(`(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日${SUFFIX}`), m => {
    const now = new Date();
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (isoDate(d) < isoDate(now)) d.setFullYear(d.getFullYear() + 1); // 過ぎていたら来年
    return d;
  }],
  [new RegExp(`(\\d{1,2})\\s*日後${SUFFIX}`), m => plusDays(Number(m[1]))],
  [new RegExp(`(\\d{1,2})\\s*週間後${SUFFIX}`), m => plusDays(Number(m[1]) * 7)],
  [new RegExp(`(今週|来週|再来週)?(?:の)?([日月火水木金土])曜(?:日)?${SUFFIX}`), m => {
    const offset = { 今週: 0, 来週: 1, 再来週: 2 }[m[1]] ?? 0;
    return nextWeekday(WEEKDAYS[m[2]], offset);
  }],
  [new RegExp(`(?:今週末|週末)${SUFFIX}`), () => nextWeekday(6, 0)],
  [new RegExp(`来月\\s*(\\d{1,2})\\s*日${SUFFIX}`), m => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, Number(m[1]));
  }],
  [new RegExp(`(?:今月末|月末)${SUFFIX}`), () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }],
  [new RegExp(`来週${SUFFIX}`), () => plusDays(7)],
  [new RegExp(`(?:今週|今週中)${SUFFIX}`), () => nextWeekday(5, 0)], // 今週 = 今週の金曜
];

const PRIORITY_RULES = [
  [/(?:優先度\s*)?[pPｐＰ]\s*([1-4１-４])/, m => 'P' + m[1].replace(/[１-４]/, c => '1234'['１２３４'.indexOf(c)])],
  [/ピー\s*(ワン|ツー|スリー|フォー)/, m => 'P' + PI[m[1]]],
  [/(?:最優先|至急|大至急|超急ぎ)/, () => 'P1'],
  [/優先度\s*(高|中|低)/, m => ({ 高: 'P1', 中: 'P2', 低: 'P4' })[m[1]]],
];

// 末尾の「〜を追加して」「〜って入れといて」などの指示文を落とす
const TRAILING_NOISE = [
  /(?:を|って)?\s*(?:追加|登録|メモ)(?:して|しといて|しておいて|とい[てで])?(?:ください|ね|おねがい|お願い)?[。．.！!]*$/,
  /(?:って)?\s*(?:入れ|書い)(?:て|といて|ておいて)(?:ください|ね|おねがい|お願い)?[。．.！!]*$/,
  /\s*(?:お願いします|おねがいします|よろしく)[。．.！!]*$/,
];

export function parseUtterance(raw, knownTags = []) {
  let text = String(raw).trim();
  let due = null;
  let priority = null;
  const tags = [];

  // タグ：「タグは仕事」「タグ 仕事」
  text = text.replace(/タグ(?:は|が)?\s*([^\s、。]+)/, (_, name) => {
    const hit = knownTags.find(t => t.id === name || t.label === name);
    tags.push(hit ? hit.id : name.replace(/^#/, ''));
    return '';
  });

  for (const [re, toDate] of DUE_RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const d = toDate(m);
    if (!d || Number.isNaN(d.getTime())) continue;
    due = isoDate(d);
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    break;
  }

  for (const [re, toP] of PRIORITY_RULES) {
    const m = re.exec(text);
    if (!m) continue;
    priority = toP(m);
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    break;
  }

  for (const re of TRAILING_NOISE) text = text.replace(re, '');

  const name = text
    .replace(/^[、。,\.\s]+|[、。,\.\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { name, due, priority, tags };
}

function renderMeta({ due, priority, tags }) {
  const chips = [];
  if (due) chips.push(`<span class="chip due">◷ ${due}</span>`);
  if (priority) chips.push(`<span class="chip ${priority.toLowerCase()}">${priority}</span>`);
  for (const t of tags) chips.push(`<span class="chip">#${t}</span>`);
  els.meta.innerHTML = chips.join('');
}

// ── データ層（PATは本体アプリと共有） ─────────────
let loadPromise = null;
function warmLoad() {
  loadPromise = getToken() ? loadAll() : null;
  if (loadPromise) loadPromise.catch(() => {}); // 未処理拒否の抑止。失敗はadd時に再送出
  return loadPromise;
}

async function ensureLoaded() {
  try {
    if (!loadPromise) warmLoad();
    await loadPromise;
  } catch (e) {
    warmLoad(); // 失敗したpromiseを掴み続けないよう張り替えて1度だけ再試行
    await loadPromise;
  }
}

async function addTask(utterance) {
  setState('saving', '追加中…');
  setTranscript(utterance);
  try {
    await ensureLoaded();
    const parsed = parseUtterance(utterance, getTags());
    if (!parsed.name) {
      setState('error', '聞き取れませんでした');
      setTranscript('');
      els.meta.innerHTML = '';
      offerRetry();
      return;
    }
    setTranscript(parsed.name);
    renderMeta(parsed);
    await createTask(parsed);
    setState('done', '追加しました ✓');
    buzz(40);
    finish();
  } catch (e) {
    const msg = e.message === 'PAT_INVALID'
      ? 'PAT が無効です。本体アプリの ⚙ で再設定してください'
      : e.message === 'CONFLICT_REFRESH'
        ? '他の端末と競合しました。もう一度お試しください'
        : `失敗: ${e.message}`;
    setState('error', msg);
    offerRetry();
  }
}

function finish() {
  // PWAウィンドウなら閉じる。閉じられない環境では操作ボタンを出す
  setTimeout(() => {
    window.close();
    setTimeout(() => {
      if (document.body.dataset.state !== 'done') return;
      setActions([
        { label: '🎤 続けて追加', primary: true, onClick: () => { warmLoad(); start(); } },
        { label: 'リストを開く', onClick: () => { location.href = './'; } },
      ]);
    }, 400);
  }, 1200);
}

function offerRetry() {
  setActions([
    { label: '🎤 もう一度', primary: true, onClick: () => start() },
    { label: 'リストを開く', onClick: () => { location.href = './'; } },
  ]);
}

// ── キーボード入力フォールバック ──────────────────
function offerManualInput(message) {
  setState('error', message);
  setActions([{
    label: '⌨ キーボードで入力',
    primary: true,
    onClick: () => {
      els.actions.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'タスク名（キーボードの🎤でも入力可）';
      input.style.cssText = 'font-size:16px;padding:13px;border-radius:12px;border:1px solid var(--border);width:100%;font-family:inherit';
      input.onkeydown = e => { if (e.key === 'Enter' && input.value.trim()) addTask(input.value.trim()); };
      els.actions.appendChild(input);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'primary';
      go.textContent = '追加';
      go.onclick = () => { if (input.value.trim()) addTask(input.value.trim()); };
      els.actions.appendChild(go);
      input.focus();
    },
  }, { label: 'リストを開く', onClick: () => { location.href = './'; } }]);
}

// ── 音声認識 ─────────────────────────────────────
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let gotResult = false;

function start() {
  if (!SpeechRec) {
    offerManualInput('この環境は音声認識に未対応です');
    return;
  }
  els.actions.innerHTML = '';
  els.meta.innerHTML = '';
  setTranscript('');
  gotResult = false;

  rec = new SpeechRec();
  rec.lang = 'ja-JP';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => { setState('listening', 'どうぞ、話してください'); buzz(15); };
  rec.onresult = e => {
    let final = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (final.trim()) {
      gotResult = true;
      rec.stop();
      addTask(final.trim());
    } else {
      setTranscript(interim, true);
    }
  };
  rec.onerror = e => {
    if (gotResult) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setState('error', 'マイクがブロックされています');
      setActions([
        { label: '🎤 マイクを許可して開始', primary: true, onClick: () => start() },
        { label: '⌨ キーボードで入力', onClick: () => offerManualInput('キーボードで入力') },
      ]);
    } else if (e.error === 'no-speech') {
      setState('error', '聞き取れませんでした');
      offerRetry();
    } else if (e.error !== 'aborted') {
      offerManualInput(`音声エラー: ${e.error}`);
    }
  };
  rec.onend = () => {
    if (!gotResult && document.body.dataset.state === 'listening') {
      setState('error', '聞き取れませんでした');
      offerRetry();
    }
  };

  try {
    rec.start();
    setState('listening', 'マイク起動中…');
  } catch (e) {
    setState('error', 'タップして開始');
    setActions([{ label: '🎤 タップして話す', primary: true, onClick: () => start() }]);
  }
}

els.mic.onclick = () => {
  const s = document.body.dataset.state;
  if (s === 'listening') { gotResult = false; rec?.stop(); return; }
  if (s === 'saving') return;
  warmLoad();
  start();
};

// ── 起動 ─────────────────────────────────────────
(function boot() {
  if (!getToken()) {
    setState('error', 'まず本体アプリで PAT を設定してください');
    setActions([{ label: '設定を開く', primary: true, onClick: () => { location.href = './'; } }]);
    return;
  }
  warmLoad(); // 音声認識と並行して inbox.md を先読み（体感を詰める）

  const q = new URLSearchParams(location.search);
  const preset = (q.get('text') || q.get('q') || '').trim();
  if (preset) { addTask(preset); return; } // ショートカット等からの直接追加

  start();
})();
