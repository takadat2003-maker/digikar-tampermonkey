// ==UserScript==
// @name         ＃18-13-4-7
// @namespace    https://digikar.jp/
// @version      18.13
// @match        *://digikar.jp/reception*
// @match        *://*.digikar.jp/reception*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// 13-2　は診療科リストが表示されて変更登録ができるが、ステータスは変更できない
// 2025/12/26　登録ボタンが消えて更新ボタンになっている　72行名修正＞＞有効になった>>更新だけで登録は押せない
//2025/12/27　#18-14-2-1 更新でも登録でもボタンが押せるようになった
//2025/12/27　#18-13-4-5 ステータス変更が可能になった

(() => {
  'use strict';

    const DKDBG = (...a)=>console.log('[DK18-DBG]', ...a);
DKDBG('boot', {href: location.href, time: new Date().toISOString()});
window.DKDBG = DKDBG;

// ===== DK18 NET WATCH BEGIN =====
(function installNetWatch(){
  if (window.__dk18_netwatch_installed) return;
  window.__dk18_netwatch_installed = true;

  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    try {
      const url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
      DKDBG('NET fetch =>', url, args[1]?.method || 'GET');
      const res = await origFetch(...args);
      DKDBG('NET fetch <=', url, res.status);
      return res;
    } catch (e) {
      DKDBG('NET fetch !!', e);
      throw e;
    }
  };

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;

  XHR.open = function(method, url, ...rest){
    this.__dk18 = {method, url};
    return origOpen.call(this, method, url, ...rest);
  };

  XHR.send = function(body){
    const info = this.__dk18 || {};
    DKDBG('NET xhr =>', info.method, info.url);
    this.addEventListener('load', () => {
      DKDBG('NET xhr <=', info.method, info.url, this.status);
    });
    this.addEventListener('error', () => {
      DKDBG('NET xhr !!', info.method, info.url);
    });
    return origSend.call(this, body);
  };
})();
 // ===== DK18 NET WATCH END =====


function fireOpenLike(el){
  if(!el) return;
  const opt = {bubbles:true, cancelable:true, view: window};
  el.dispatchEvent(new PointerEvent('pointerdown', opt));
  el.dispatchEvent(new MouseEvent('mousedown', opt));
  el.dispatchEvent(new PointerEvent('pointerup', opt));
  el.dispatchEvent(new MouseEvent('mouseup', opt));
  el.dispatchEvent(new MouseEvent('click', opt));
}

function fireMenuPick(el){
  if(!el) return;

  // Radix対策：menuitemの“中身”がクリック対象のことが多い
  const inner = el.querySelector('span, div, p') || el;
  const optP = {bubbles:true, cancelable:true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true};
  const optM = {bubbles:true, cancelable:true, view: window};

  // hover系（onPointerMove/onMouseMove を見ている実装がある）
  inner.dispatchEvent(new MouseEvent('mousemove', optM));
  inner.dispatchEvent(new MouseEvent('mouseenter', optM));
  inner.dispatchEvent(new PointerEvent('pointermove', optP));
  inner.dispatchEvent(new PointerEvent('pointerenter', optP));
  inner.dispatchEvent(new PointerEvent('pointerover', optP));
  inner.dispatchEvent(new MouseEvent('mouseover', optM));

  // “選択確定”で使われやすい一連
  inner.dispatchEvent(new PointerEvent('pointerdown', optP));
  inner.dispatchEvent(new MouseEvent('mousedown', optM));
  inner.dispatchEvent(new PointerEvent('pointerup', optP));
  inner.dispatchEvent(new MouseEvent('mouseup', optM));
  inner.dispatchEvent(new MouseEvent('click', optM));

  // キーボード確定を見ている実装向け（念のため）
  inner.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, cancelable:true, key:'Enter', code:'Enter'}));
  inner.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true, cancelable:true, key:'Enter', code:'Enter'}));
}



  const DEPT_CONFIG = {
    '中待合':   { text: '中', bg: 'rgba(0,0,0,.90)', targetValue: '中待合室' , autoStatus: '診察待'},
    '第1診察室': { text: '①', bg: 'rgba(0,120,255,.95)', targetValue: '整形外科（1診）', autoStatus: '診察中' },
    '第2診察室': { text: '②', bg: 'rgba(255,120,0,.95)', targetValue: '整形外科（2診）', autoStatus: '診察中' }
  };

  let activeBadge = null;
  const DISPLAY_DURATION = 1500;

  // STEP2　BEGIN --- ステータス変更：ターゲット周辺からボタンを探す ---
  async function updateStatusDirectly(targetEl, statusText) {
  DKDBG('STEP2 start', {statusText});

  const row = targetEl.closest('tr') || targetEl.closest('[role="row"]');
  DKDBG('STEP2 row=', row);

  if (!row) {
    DKDBG('STEP2 FAIL: row not found');
    return;
  }

  // まず “会計済” ボタンを狙い撃ち（あなたのログで唯一テキストが入っていた）
  // ステータス候補（表示されうる文言）
const STATUS_WORDS = ['予約済','受付中','診察待','診察中','検査中','処置中','会計待','会計済','再計待','不在','取消'];

// 「会計済」固定をやめて、その行で“ステータス文言を含むボタン”を拾う
const statusBtn = Array.from(row.querySelectorAll('button'))
  .find(b => STATUS_WORDS.some(t => ((b.textContent || '').trim()).includes(t)));

const beforeText = statusBtn ? (statusBtn.textContent || '').trim() : null;
DKDBG('STEP2 statusBtn picked=', statusBtn, 'before=', beforeText);

if (!statusBtn) {
  const btnTexts = Array.from(row.querySelectorAll('button'))
    .map(b => (b.textContent||'').trim())
    .filter(Boolean);
  DKDBG('STEP2 FAIL: statusBtn not found. row button texts=', btnTexts);
  return;
}

  DKDBG('STEP2 statusBtn picked=', statusBtn);

  if (!statusBtn) {
    DKDBG('STEP2 FAIL: statusBtn not found (text was not 会計済)');
    return;
  }

  // ここが本丸：開くイベントを投げる
  fireOpenLike(statusBtn);
  DKDBG('STEP2 fired open-like');

  // “メニューがDOMに出たか”を観測（ここがStep2の成功判定）
  setTimeout(() => {
    const menu = document.querySelector('[role="menu"]');
    DKDBG('STEP2 menu exists?', !!menu, menu);

//STEP 3-1 BEGIN
if (menu) {
  // Step3-1: role="menuitem" を優先的に列挙
  const menuItems = Array.from(menu.querySelectorAll('[role="menuitem"]'))
    .map(el => (el.innerText || '').trim())
    .filter(Boolean);

  DKDBG('STEP3 menuitem texts=', menuItems);

  // Step3-2: 念のため、menu配下の全テキストも列挙（Radix対策）
  const allTexts = Array.from(menu.querySelectorAll('*'))
    .map(el => (el.innerText || '').trim())
    .filter(t => t && t.length < 20); // ノイズ防止

  DKDBG('STEP3 menu ALL texts (filtered)=', allTexts);

  // Step3-3: 「診察中」が存在するかを明示的に判定
const hasTargetStatus =
  menuItems.includes(statusText) ||
  allTexts.includes(statusText);

DKDBG('STEP3 has target status ?', statusText, hasTargetStatus);


// STEP 3 END

// STEP 4 BEGIN
     // ▼▼▼ ここに Step4 を貼り付け ▼▼▼
    if (hasTargetStatus) {
      // 1) role=menuitem から「診察中」を探す
      const menuEls = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      let target = menuEls.find(el =>
  (el.innerText || '').replace(/\s+/g, '').includes(statusText)
);

if (!target) {
  target = Array.from(menu.querySelectorAll('*'))
    .find(el =>
      (el.innerText || '').replace(/\s+/g, '').includes(statusText)
    );
}
DKDBG('STEP4 candidates=', menuEls.map(el => (el.innerText || '').replace(/\s+/g,'')));


      // 2) 保険：menu配下の全要素からテキスト一致を探す
      if (!target) {
        target = Array.from(menu.querySelectorAll('*'))
          .find(el => (el.innerText || '').trim() === '診察中');
      }

      DKDBG('STEP4 target for 診察中 =', target);

if (target) {
  DKDBG('STEP4 target attrs', {
    ariaDisabled: target.getAttribute('aria-disabled'),
    dataDisabled: target.getAttribute('data-disabled'),
    class: target.className
  });
}

      if (target) {
      const clickable =
  (target.querySelector('span, div') || target).closest('[role="menuitem"]') ||
  target.closest('[role="menuitem"]') ||
  target;


    // ★Radix対策：clickではなく pointerdown 系で選択確定させる
        fireMenuPick(clickable);
        DKDBG('STEP4 fireMenuPick 診察中');

    // 選択後に、行のステータス表示が変わったか確認
        const checkAfter = (ms) => {
  setTimeout(() => {
    const afterBtn = Array.from(row.querySelectorAll('button'))
      .find(b => STATUS_WORDS.some(t => ((b.textContent || '').trim()).includes(t)));
    const afterText = afterBtn ? (afterBtn.textContent || '').trim() : null;
    DKDBG(`STEP4 after(${ms}ms) statusBtn text=`, afterText, 'btn=', afterBtn);
  }, ms);
};

checkAfter(600);
checkAfter(1500);



        setTimeout(() => {
          const stillMenu = document.querySelector('[role="menu"]');
          DKDBG('STEP4 menu still exists?', !!stillMenu, stillMenu?.getAttribute?.('data-state'));
        }, 300);
      } else {
        DKDBG('STEP4 FAIL: 診察中 element not found (unexpected)');
      }
    }
    // ▲▲▲ Step 4 ここまで ▲▲▲
    // Step 4 END
}

    if (menu) {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
        .map(x => (x.innerText || '').trim())
        .filter(Boolean);
      DKDBG('STEP2 menu items=', items);
    }
  }, 700);
}


  // --- 以下、バッジ描画・別窓操作・メニュー設定 ---
  // (18-12とほぼ同じですが、activeBadgeにtargetElを保持して渡すように整理)

  async function automateEditWindow(targetText) {
  const selects = Array.from(document.querySelectorAll('select'));
  const targetSelect = selects.find(s =>
    Array.from(s.options).some(opt => (opt.text || '').includes(targetText))
  );

  if (!targetSelect) {
    DKDBG('MODAL: targetSelect not found for', targetText);
    return;
  }

  const targetOption = Array.from(targetSelect.options).find(opt =>
    (opt.text || '').includes(targetText)
  );

  if (!targetOption) {
    DKDBG('MODAL: targetOption not found for', targetText);
    return;
  }

  // 診療科セット
  targetSelect.value = targetOption.value;
  targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
  DKDBG('MODAL: select changed to', targetOption.text, targetOption.value);

  // 「登録」「更新」どちらでも押す（保険で「保存」も）
  setTimeout(() => {
    const buttons = Array.from(document.querySelectorAll('button'));

    const commitBtn = buttons.find(b => {
      const t = (b.textContent || '').trim();
      return /^(登録|更新|保存)$/.test(t);
    });

    DKDBG('MODAL: commitBtn=', commitBtn ? (commitBtn.textContent || '').trim() : null);

    if (commitBtn) {
      // click()より確実にしたいなら fireOpenLike を流用してもOK
      commitBtn.click();
      DKDBG('MODAL: commit clicked');
    } else {
      // 参考：ボタン一覧も出しておく
      const texts = buttons.map(b => (b.textContent || '').trim()).filter(Boolean);
      DKDBG('MODAL: commit NOT found. buttons=', texts);
    }
  }, 50);
}

  function renderBadge() {
    let layer = document.getElementById('dk-float-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'dk-float-layer';
      layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
      document.documentElement.appendChild(layer);
    }
    layer.innerHTML = '';
    if (!activeBadge) return;

    const now = Date.now();
    const elapsed = now - activeBadge.startTime;

    if (elapsed > DISPLAY_DURATION) {
      const conf = DEPT_CONFIG[activeBadge.deptKey];
      if (conf.autoStatus) {
        updateStatusDirectly(activeBadge.targetEl, conf.autoStatus);
      }
      activeBadge = null;
      return;
    }

    const r = activeBadge.targetEl.getBoundingClientRect();
    if (r.width === 0 || r.top < 0) return;

    const conf = DEPT_CONFIG[activeBadge.deptKey];
    const badge = document.createElement('div');
    badge.textContent = conf.text;
    const opacity = (DISPLAY_DURATION - elapsed) < 500 ? (DISPLAY_DURATION - elapsed) / 500 : 1;

    badge.style.cssText = `position:fixed; width:45px; height:45px; border-radius:50%; background:${conf.bg}; color:white; font-size:26px; font-weight:bold; display:flex; align-items:center; justify-content:center; left:${r.left + (r.width/2) - 22.5}px; top:${r.top - 55}px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); z-index: 2147483647; border: 3px solid #fff; opacity: ${opacity};`;
    layer.appendChild(badge);
  }

  function setupMenu() {
    const menu = document.createElement('div');
    menu.id = 'dk-float-menu';
    menu.style.cssText = 'position:fixed;display:none;z-index:2147483647;background:white;border:1px solid #ccc;border-radius:10px;box-shadow:0 6px 25px rgba(0,0,0,0.3);padding:8px;';
    let html = '<div style="padding:8px;font-weight:bold;font-size:13px;border-bottom:1px solid #eee;margin-bottom:5px;color:#333;">＃18 診察室選択</div>';
    for (const key in DEPT_CONFIG) html += `<div class="dk-item" data-dept="${key}" style="padding:12px 20px;cursor:pointer;font-size:15px;color:#111;border-radius:5px;">${key}</div>`;
    menu.innerHTML = html;
    document.documentElement.appendChild(menu);

    document.addEventListener('pointerdown', (e) => {
      if (!e.altKey) return;
      const target = e.target.closest('button, .edit-icon, [role="button"], svg, input') || e.target;
      e.preventDefault(); e.stopPropagation();

      // メニュー表示
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.style.display = 'block';

      // クリック時に情報を一時保持
      menu.dataset.targetId = "";
      window._lastTarget = target;
    }, true);

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.dk-item');
      if (!item || !window._lastTarget) return;
      const deptKey = item.getAttribute('data-dept');
      activeBadge = { deptKey, targetEl: window._lastTarget, startTime: Date.now() };
      automateEditWindow(DEPT_CONFIG[deptKey].targetValue);
      menu.style.display = 'none';
    });
    window.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) menu.style.display = 'none'; }, true);
  }

  setupMenu();
  setInterval(renderBadge, 100);
})();