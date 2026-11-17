// push-client.js ― index.html から <script type="module"> で読み込まれる(最終版)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';

/* ====== ここを自分の値に書き換える(3か所) ====== */

// ① Apps Script のウェブアプリURL(デプロイ後に表示される /exec のURL)
export const GAS_URL = 'https://script.google.com/macros/s/AKfycbxHeQ5EWzO547rENMtC95rF9-CwOk_10iZepbx5s-DkP9Ouz4uTgwDXrZCdkErj-C9a0g/exec';

// ② Firebase「プロジェクトの設定 > 全般 > マイアプリ」の firebaseConfig
//    (firebase-messaging-sw.js にも同じ値を入れる)
const firebaseConfig = {
  apiKey: 'AIzaSyAUQ9JrT7QRl8FIQ3RShcYkCOp_z1LVCVw',
  authDomain: 'race-event-notification-d502f.firebaseapp.com',
  projectId: 'race-event-notification-d502f',
  messagingSenderId: '244186219493',
  appId: '1:244186219493:web:6baf3a51be9ba4f110250c'
};

// ③ Firebase「プロジェクトの設定 > Cloud Messaging > ウェブプッシュ証明書」の公開鍵
const VAPID_KEY = 'BD92yY9hxXtPBK_2W8mj3cv77LXBoj8KEkV3BQ_vU6Wxy97ax0vHfz30oBlUQnjOFSqNARe7tl7vTgt2vHi-VBs';

/* ============================================== */

const LS_LEAD = 'push.leadMin';
const LS_TOKEN = 'push.token';

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Apps Script への通信(GET。POST は iPhone で失敗しやすいため使わない)
async function callGas(body) {
  const q = new URLSearchParams({
    action: body.action,
    token: body.token || '',
    leadMin: String(body.leadMin || '')
  });
  const res = await fetch(GAS_URL + '?' + q.toString());
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'server error');
  return json;
}

export async function enablePush(leadMin) {
  if (isIOS && !isStandalone) {
    throw new Error('iPhoneは、共有ボタン →「ホーム画面に追加」したアイコンから開き直してください。');
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('このブラウザはプッシュ通知に対応していません。');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした。端末の設定から許可してください。');

  const reg = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
  await navigator.serviceWorker.ready;

  const messaging = getMessaging(initializeApp(firebaseConfig));
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) throw new Error('通知トークンを取得できませんでした。');

  await callGas({ action: 'subscribe', token, leadMin });
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_LEAD, String(leadMin));
  startForegroundListener();
}

export async function changeLead(leadMin) {
  const token = localStorage.getItem(LS_TOKEN);
  if (!token) return enablePush(leadMin);
  await callGas({ action: 'subscribe', token, leadMin });   // 同じトークンで上書き
  localStorage.setItem(LS_LEAD, String(leadMin));
}

export async function disablePush() {
  const token = localStorage.getItem(LS_TOKEN);
  if (token) await callGas({ action: 'unsubscribe', token });
  localStorage.removeItem(LS_TOKEN);
}

// <div id="push-panel"></div> を置くと、設定UIを描画する
export function mountPushPanel(el) {
  const enabled = !!localStorage.getItem(LS_TOKEN);
  const lead = localStorage.getItem(LS_LEAD) || '10';
  el.innerHTML = `
    <label>通知タイミング
      <select id="push-lead">
        <option value="10">10分前</option>
        <option value="15">15分前</option>
        <option value="30">30分前</option>
      </select>
    </label>
    <button id="push-on">${enabled ? '設定を更新' : '通知をオンにする'}</button>
    <button id="push-off" ${enabled ? '' : 'hidden'}>通知をオフ</button>
    <span id="push-msg" role="status"></span>`;

  const $ = (id) => el.querySelector(id);
  const msg = (t) => { $('#push-msg').textContent = t; };
  $('#push-lead').value = lead;

  $('#push-on').onclick = async () => {
    try {
      msg('設定中…');
      await changeLead(Number($('#push-lead').value));
      msg($('#push-lead').selectedOptions[0].text + 'に通知します');
      $('#push-on').textContent = '設定を更新';
      $('#push-off').hidden = false;
    } catch (e) { msg(e.message); }
  };
  $('#push-off').onclick = async () => {
    try {
      await disablePush();
      msg('通知をオフにしました');
      $('#push-on').textContent = '通知をオンにする';
      $('#push-off').hidden = true;
    } catch (e) { msg(e.message); }
  };
}

// スケジュール取得
export async function fetchSchedule() {
  const res = await fetch(GAS_URL + '?action=schedule');
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json;   // { data: [...], serverTime, timezone }
}

/* ===== アプリを開いている間の通知(フォアグラウンド) ===== */

let fgStarted = false;

function showToast(title, body) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 12px);' +
    'z-index:9999;background:#111318;color:#fff;border-radius:14px;padding:14px 16px;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.3);font-size:14px;line-height:1.5;';
  const t = document.createElement('div');
  t.style.fontWeight = '800';
  t.textContent = title;
  const b = document.createElement('div');
  b.style.cssText = 'opacity:.85;margin-top:2px;';
  b.textContent = body;
  el.append(t, b);
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 10000);
}

async function startForegroundListener() {
  if (fgStarted) return;
  try {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!localStorage.getItem(LS_TOKEN)) return;

    const reg = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
    const messaging = getMessaging(initializeApp(firebaseConfig));

    onMessage(messaging, (payload) => {
      const d = payload.data || {};
      const title = d.title || 'Race Event';
      const body = d.body || '';

      showToast(title, body);
      if (navigator.vibrate) navigator.vibrate(200);

      reg.showNotification(title, {
        body: body,
        icon: './icon-192.png',
        tag: d.tag || undefined,
        data: { url: d.url || './' }
      }).catch(() => {});
    });

    fgStarted = true;
  } catch (e) {
    console.warn('foreground listener error', e);
  }
}

startForegroundListener();
