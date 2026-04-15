// ==UserScript==
// @name         Reservation priority system V2
// @namespace    https://digikar.jp/
// @version      2.0.0
// @description  受付一覧で優先予約制スコアを計算し、患者メモ欄に診察順・スコア・今回待ち/総待ちタイマーを表示する（検査後の再診察待に対応）
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    refreshIntervalMs: 1000,
    tableScanDebounceMs: 200,
    renderClass: 'tm-priority-score-block-v2',
    storagePrefix: 'tmPriorityStateV2::',

    headers: {
      reservation: '予約',
      arrival: '時間',
      status: 'ステータス',
      patientNo: ['患者番号', '患者ID', 'ID'],
      patientMemo: '患者メモ',
      receptionMemo: '受付メモ',
      department: '診療科',
      doctor: '医師',
      initial: '初'
    },

    waitingStatuses: ['診察待'],
    visibleStatuses: ['受付中', '受付済', '診察待', '再診待', '検査中', '検査待', '検査戻り', '処置待'],
    inactiveStatusKeywords: ['会計', '帰宅', '完了', '中止', '取消', 'キャンセル'],

    doctorTimeRegex: /(院長|担当医|医師)?\s*[（(]?\s*(\d{1,2})\s*:\s*(\d{2})\s*[)）]?/,
    anyTimeRegex: /(\d{1,2})\s*:\s*(\d{2})/,

    score: {
      sameSlotReserved: 40,
      nextSlotReserved: 35,
      overdueReserved: 42,
      futureReserved: 24,
      walkInRevisit: 20,
      walkInInitial: 10,
      waitPerMinute: 0.8,
      overduePerMinute: 0.6,
      sameSlotSoonBonus: 10,
      nextSlotSoonBonus: 5,
      shortVisitStrong: 15,
      shortVisitWeak: 10,
      complaint1: 10,
      complaint2: 20,
      complaint3: 30,
      safetyUrgent: 1000,
      imagingReadyBonus: 3
    },

    shortVisitKeywordsStrong: [
      '注射のみ', '処方のみ', '結果説明のみ', '書類のみ', 'brief', 'クイック', '短時間', 'リハ後診察のみ'
    ],
    shortVisitKeywordsWeak: [
      '注射', '処方', '結果説明', '薬のみ', '物療のみ', 'リハのみ', '再チェックのみ'
    ],

    imagingKeywords: ['🌈', 'RX', 'ＲＸ', 'Xp', 'XP', 'ＸＰ', 'レントゲン', '骨密度', '撮影'],
    urgentKeywords: ['救急', '倒れ', '気分不良', '出血', '啼泣', '動けない', '歩行不可', '処置室', '激痛', 'しびれ急増'],
    complaintKeywords2: ['クレーム', '怒', '不満強い', '大声', '要注意'],
    complaintKeywords3: ['🔥', '激怒', '暴言', 'トラブル', '強いクレーム'],

    colors: {
      top1: '#b91c1c',
      top2: '#c2410c',
      top3: '#92400e',
      normal: '#1d4ed8',
      timer: '#374151',
      border: '#d1d5db',
      bg: '#f8fafc',
      waitingBg: '#eef6ff'
    }
  };

  function findMainTable() {
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    let bestScore = -Infinity;

    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr').length;
      if (!rows) continue;

      const text = table.innerText || '';
      let score = rows;
      if (text.includes(CONFIG.headers.patientMemo)) score += 80;
      if (text.includes(CONFIG.headers.receptionMemo)) score += 40;
      if (text.includes(CONFIG.headers.status)) score += 30;
      if (text.includes(CONFIG.headers.arrival)) score += 20;
      if (text.includes(CONFIG.headers.reservation)) score += 20;
      if (text.includes(CONFIG.headers.patientNo[0])) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = table;
      }
    }
    return best;
  }

  function getHeaderCells(table) {
    const thead = table.querySelector('thead');
    if (thead) return Array.from(thead.querySelectorAll('th,td'));
    const firstRow = table.querySelector('tr');
    return firstRow ? Array.from(firstRow.querySelectorAll('th,td')) : [];
  }

  function normalizeHeaderText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function findColumnIndex(table, header) {
    const target = normalizeHeaderText(header);
    const cells = getHeaderCells(table);
    for (let i = 0; i < cells.length; i += 1) {
      const cellText = normalizeHeaderText(cells[i].textContent || '');
      if (cellText === target) return i;
    }
    return -1;
  }

  function findColumnIndexFromList(table, headers) {
    for (const header of headers) {
      const idx = findColumnIndex(table, header);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function pickColumns(table) {
    return {
      reservation: findColumnIndex(table, CONFIG.headers.reservation),
      arrival: findColumnIndex(table, CONFIG.headers.arrival),
      status: findColumnIndex(table, CONFIG.headers.status),
      patientNo: findColumnIndexFromList(table, CONFIG.headers.patientNo),
      patientMemo: findColumnIndex(table, CONFIG.headers.patientMemo),
      receptionMemo: findColumnIndex(table, CONFIG.headers.receptionMemo),
      department: findColumnIndex(table, CONFIG.headers.department),
      doctor: findColumnIndex(table, CONFIG.headers.doctor),
      initial: findColumnIndex(table, CONFIG.headers.initial)
    };
  }

  function getCellText(tds, idx) {
    if (idx < 0 || !tds[idx]) return '';
    return String(tds[idx].textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function parseHHMM(text) {
    const m = String(text || '').match(CONFIG.anyTimeRegex);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return { hh, mm };
  }

  function parseReservedTime(reservationText, receptionMemoText, patientMemoText) {
    const direct = parseHHMM(reservationText);
    if (direct) return direct;

    const joined = `${receptionMemoText || ''}\n${patientMemoText || ''}`;
    let m = joined.match(CONFIG.doctorTimeRegex);
    if (m) return { hh: Number(m[2]), mm: Number(m[3]) };

    m = joined.match(CONFIG.anyTimeRegex);
    if (m) return { hh: Number(m[1]), mm: Number(m[2]) };

    return null;
  }

  function todayAt(hh, mm) {
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    return d;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function formatScore(score) {
    return round1(score).toFixed(1);
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${String(mm)}:${String(ss).padStart(2, '0')}`;
  }

  function includesAny(text, keywords) {
    return keywords.some(keyword => String(text || '').includes(keyword));
  }

  function countComplaintLevel(text) {
    const source = String(text || '');
    if (!source) return 0;

    const explicitCount = (source.match(/💢/g) || []).length;
    if (includesAny(source, CONFIG.complaintKeywords3)) return 3;
    if (explicitCount >= 2 || includesAny(source, CONFIG.complaintKeywords2)) return 2;
    if (explicitCount >= 1) return 1;
    return 0;
  }

  function isInitialVisit(initialText) {
    return String(initialText || '').trim() !== '';
  }

  function isVisibleStatus(statusText) {
    const text = String(statusText || '').trim();
    if (!text) return false;
    if (CONFIG.inactiveStatusKeywords.some(keyword => text.includes(keyword))) return false;
    if (CONFIG.visibleStatuses.includes(text)) return true;
    return /(待|中)/.test(text) && !CONFIG.inactiveStatusKeywords.some(keyword => text.includes(keyword));
  }

  function isWaitingStatus(statusText) {
    const text = String(statusText || '').trim();
    return CONFIG.waitingStatuses.includes(text);
  }

  function getStorageKey(patientNo) {
    return `${CONFIG.storagePrefix}${patientNo}`;
  }

  function loadState(patientNo) {
    if (!patientNo) return null;
    try {
      const raw = localStorage.getItem(getStorageKey(patientNo));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveState(patientNo, state) {
    if (!patientNo) return;
    try {
      localStorage.setItem(getStorageKey(patientNo), JSON.stringify(state));
    } catch (e) {
    }
  }

  function deleteState(patientNo) {
    if (!patientNo) return;
    try {
      localStorage.removeItem(getStorageKey(patientNo));
    } catch (e) {
    }
  }

  function removeRender(cell) {
    if (!cell) return;
    const old = cell.querySelector(`.${CONFIG.renderClass}`);
    if (old) old.remove();
  }

  function ensureRender(cell) {
    let el = cell.querySelector(`.${CONFIG.renderClass}`);
    if (!el) {
      el = document.createElement('div');
      el.className = CONFIG.renderClass;
      el.style.marginTop = '4px';
      el.style.padding = '4px 6px';
      el.style.border = `1px solid ${CONFIG.colors.border}`;
      el.style.borderRadius = '6px';
      el.style.background = CONFIG.colors.bg;
      el.style.whiteSpace = 'pre-line';
      el.style.lineHeight = '1.28';
      el.style.fontSize = '12px';
      cell.appendChild(el);
    }
    return el;
  }

  function clearAllOldRenders(table, cols) {
    if (!table) return;
    table.querySelectorAll('tbody tr').forEach(row => {
      const tds = row.querySelectorAll('td');
      if (!tds.length) return;
      const patientMemoCell = cols.patientMemo >= 0 ? tds[cols.patientMemo] : null;
      const receptionMemoCell = cols.receptionMemo >= 0 ? tds[cols.receptionMemo] : null;
      removeRender(patientMemoCell);
      if (receptionMemoCell !== patientMemoCell) removeRender(receptionMemoCell);
    });
  }

  function updateTransitionState(patientNo, statusText, arrivalAt, nowMs) {
    if (!patientNo) return null;

    const prev = loadState(patientNo) || {};
    const prevStatus = prev.lastStatus || '';
    const currentStatus = String(statusText || '').trim();
    const waitingNow = isWaitingStatus(currentStatus);
    const waitingPrev = isWaitingStatus(prevStatus);

    let totalStartAt = prev.totalStartAt || null;
    let currentWaitingStartAt = prev.currentWaitingStartAt || null;

    if (!totalStartAt && arrivalAt) {
      totalStartAt = arrivalAt.getTime();
    }
    if (!totalStartAt) {
      totalStartAt = nowMs;
    }

    if (waitingNow && !waitingPrev) {
      currentWaitingStartAt = nowMs;
    }

    if (!waitingNow) {
      currentWaitingStartAt = prev.currentWaitingStartAt || currentWaitingStartAt || null;
    }

    const nextState = {
      lastStatus: currentStatus,
      lastSeenAt: nowMs,
      totalStartAt,
      currentWaitingStartAt
    };

    saveState(patientNo, nextState);
    return nextState;
  }

  function cleanupMissingRows(seenPatientNos) {
    const prefix = CONFIG.storagePrefix;
    const removeKeys = [];

    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const patientNo = k.slice(prefix.length);
      if (!seenPatientNos.has(patientNo)) {
        removeKeys.push(k);
      }
    }

    removeKeys.forEach(k => {
      try {
        localStorage.removeItem(k);
      } catch (e) {
      }
    });
  }

  function buildRowData(row, cols, now) {
    const tds = row.querySelectorAll('td');
    if (!tds || !tds.length) return null;

    const statusText = getCellText(tds, cols.status);
    const patientMemoText = getCellText(tds, cols.patientMemo);
    const receptionMemoText = getCellText(tds, cols.receptionMemo);
    const reservationText = getCellText(tds, cols.reservation);
    const arrivalText = getCellText(tds, cols.arrival);
    const patientNoText = getCellText(tds, cols.patientNo);
    const departmentText = getCellText(tds, cols.department);
    const doctorText = getCellText(tds, cols.doctor);
    const initialText = getCellText(tds, cols.initial);

    const displayCell = cols.patientMemo >= 0 ? tds[cols.patientMemo] : (cols.receptionMemo >= 0 ? tds[cols.receptionMemo] : null);
    if (!displayCell) return null;

    if (!isVisibleStatus(statusText)) {
      removeRender(displayCell);
      if (patientNoText && CONFIG.inactiveStatusKeywords.some(keyword => String(statusText).includes(keyword))) {
        deleteState(patientNoText);
      }
      return null;
    }

    const arrivalParsed = parseHHMM(arrivalText);
    const reservedParsed = parseReservedTime(reservationText, receptionMemoText, patientMemoText);
    const arrivalAt = arrivalParsed ? todayAt(arrivalParsed.hh, arrivalParsed.mm) : null;
    const reservedAt = reservedParsed ? todayAt(reservedParsed.hh, reservedParsed.mm) : null;

    const nowMs = now.getTime();
    const state = updateTransitionState(patientNoText, statusText, arrivalAt, nowMs) || {};
    const totalStartAtMs = state.totalStartAt || (arrivalAt ? arrivalAt.getTime() : nowMs);
    const currentWaitingStartAtMs = state.currentWaitingStartAt || nowMs;

    const totalWaitMs = Math.max(0, nowMs - totalStartAtMs);
    const currentWaitMs = isWaitingStatus(statusText) ? Math.max(0, nowMs - currentWaitingStartAtMs) : 0;

    const currentWaitMin = currentWaitMs / 60000;
    const initial = isInitialVisit(initialText);
    const joinedMemo = `${patientMemoText}\n${receptionMemoText}`;
    const complaintLevel = countComplaintLevel(joinedMemo);
    const hasImaging = includesAny(joinedMemo, CONFIG.imagingKeywords);
    const isUrgent = includesAny(joinedMemo, CONFIG.urgentKeywords);
    const hasShortStrong = includesAny(joinedMemo, CONFIG.shortVisitKeywordsStrong);
    const hasShortWeak = !hasShortStrong && includesAny(joinedMemo, CONFIG.shortVisitKeywordsWeak);

    const slotMin = initial ? 10 : 5;
    const untilReservedMin = reservedAt ? (reservedAt.getTime() - nowMs) / 60000 : null;
    const overdueReservedMin = reservedAt ? Math.max(0, (nowMs - reservedAt.getTime()) / 60000) : 0;

    let base = 0;
    let baseLabel = '';

    if (reservedAt) {
      if (untilReservedMin < 0) {
        base = CONFIG.score.overdueReserved;
        baseLabel = '予約超過';
      } else if (untilReservedMin <= slotMin) {
        base = CONFIG.score.sameSlotReserved;
        baseLabel = '同枠予約';
      } else if (untilReservedMin <= slotMin * 2) {
        base = CONFIG.score.nextSlotReserved;
        baseLabel = '次枠予約';
      } else {
        base = CONFIG.score.futureReserved;
        baseLabel = '将来枠予約';
      }
    } else {
      base = initial ? CONFIG.score.walkInInitial : CONFIG.score.walkInRevisit;
      baseLabel = initial ? '予約外初診' : '予約外再診';
    }

    const waitScore = round1(currentWaitMin * CONFIG.score.waitPerMinute);

    let timePressureScore = 0;
    if (reservedAt) {
      if (untilReservedMin < 0) {
        timePressureScore = round1(Math.min(30, overdueReservedMin * CONFIG.score.overduePerMinute));
      } else if (untilReservedMin <= 5) {
        timePressureScore = CONFIG.score.sameSlotSoonBonus;
      } else if (untilReservedMin <= 10) {
        timePressureScore = CONFIG.score.nextSlotSoonBonus;
      }
    }

    let shortBonus = 0;
    let shortLabel = '';
    if (hasShortStrong) {
      shortBonus = CONFIG.score.shortVisitStrong;
      shortLabel = '短時間強';
    } else if (hasShortWeak) {
      shortBonus = CONFIG.score.shortVisitWeak;
      shortLabel = '短時間';
    }

    let complaintScore = 0;
    if (complaintLevel === 1) complaintScore = CONFIG.score.complaint1;
    if (complaintLevel === 2) complaintScore = CONFIG.score.complaint2;
    if (complaintLevel >= 3) complaintScore = CONFIG.score.complaint3;

    let imagingBonus = 0;
    if (initial && hasImaging) {
      imagingBonus = CONFIG.score.imagingReadyBonus;
    }

    const safetyScore = isUrgent ? CONFIG.score.safetyUrgent : 0;
    const totalScore = base + waitScore + timePressureScore + shortBonus + complaintScore + imagingBonus + safetyScore;

    const details = [
      `${baseLabel}+${formatScore(base)}`,
      `今回待+${formatScore(waitScore)}`
    ];
    if (timePressureScore) details.push(`圧+${formatScore(timePressureScore)}`);
    if (shortBonus) details.push(`${shortLabel}+${formatScore(shortBonus)}`);
    if (complaintScore) details.push(`💢+${formatScore(complaintScore)}`);
    if (imagingBonus) details.push(`画像+${formatScore(imagingBonus)}`);
    if (safetyScore) details.push(`安全+${formatScore(safetyScore)}`);

    return {
      row,
      tds,
      displayCell,
      patientNoText,
      departmentText,
      doctorText,
      statusText,
      patientMemoText,
      receptionMemoText,
      reservationText,
      arrivalText,
      arrivalAt,
      reservedAt,
      initial,
      currentWaitMs,
      totalWaitMs,
      currentWaitMin,
      score: totalScore,
      detailText: details.join(' / '),
      sortReservedAt: reservedAt ? reservedAt.getTime() : Number.MAX_SAFE_INTEGER,
      sortArrivalAt: arrivalAt ? arrivalAt.getTime() : Number.MAX_SAFE_INTEGER
    };
  }

  function compareRows(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.sortReservedAt !== b.sortReservedAt) return a.sortReservedAt - b.sortReservedAt;
    if (a.sortArrivalAt !== b.sortArrivalAt) return a.sortArrivalAt - b.sortArrivalAt;
    return String(a.patientNoText || '').localeCompare(String(b.patientNoText || ''), 'ja');
  }

  function renderRow(item, rank) {
    const el = ensureRender(item.displayCell);

    let color = CONFIG.colors.normal;
    if (rank === 1) color = CONFIG.colors.top1;
    else if (rank === 2) color = CONFIG.colors.top2;
    else if (rank === 3) color = CONFIG.colors.top3;

    const reservedStr = item.reservationText && item.reservationText !== '-' ? item.reservationText : '予約外';
    const currentWaitStr = formatDuration(item.currentWaitMs);
    const totalWaitStr = formatDuration(item.totalWaitMs);

    el.style.color = color;
    el.style.fontWeight = rank <= 3 ? '800' : '700';
    el.style.borderColor = rank <= 3 ? color : CONFIG.colors.border;
    el.style.background = isWaitingStatus(item.statusText) ? CONFIG.colors.waitingBg : CONFIG.colors.bg;

    el.textContent =
      `診察順 ${rank}位 / ${formatScore(item.score)}点\n` +
      `⌚今回待ち ${currentWaitStr}\n` +
      `⌚総待ち ${totalWaitStr}\n` +
      `予 ${reservedStr}`;

    el.title =
      `${item.detailText}\n` +
      `状態:${item.statusText}\n` +
      `診療科:${item.departmentText}\n` +
      `医師:${item.doctorText}`;
  }

  function updateOnce() {
    const table = findMainTable();
    if (!table) return;

    const cols = pickColumns(table);
    if (cols.status < 0 || (cols.patientMemo < 0 && cols.receptionMemo < 0) || cols.patientNo < 0) return;

    const now = new Date();
    const items = [];
    const seenPatientNos = new Set();

    table.querySelectorAll('tbody tr').forEach(row => {
      const tds = row.querySelectorAll('td');
      if (!tds || !tds.length) return;

      const patientNoText = getCellText(tds, cols.patientNo);
      if (patientNoText) seenPatientNos.add(patientNoText);

      const item = buildRowData(row, cols, now);
      if (item) items.push(item);
    });

    items.sort(compareRows);
    clearAllOldRenders(table, cols);
    items.forEach((item, idx) => {
      renderRow(item, idx + 1);
    });

    cleanupMissingRows(seenPatientNos);
  }

  let scheduled = false;

  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      updateOnce();
    }, CONFIG.tableScanDebounceMs);
  }

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.body, { childList: true, subtree: true });

  updateOnce();
  window.setInterval(updateOnce, CONFIG.refreshIntervalMs);
})();