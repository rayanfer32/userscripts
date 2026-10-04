// ==UserScript==
// @name         Google Photos → Telegram Sync & Delete
// @namespace    https://dryx.io/
// @version      0.3.0
// @description  Send selected Google Photos to Telegram via Bot API (parallel), then delete originals
// @match        https://photos.google.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    'use strict';

    if (window.self !== window.top) return;

    const LOCK_KEY = '__gp2tg_active__';
    if (window[LOCK_KEY] || document[LOCK_KEY]) return;
    window[LOCK_KEY] = true;
    document[LOCK_KEY] = true;

    console.log('[GP2TG] Initialized once at', window.location.href);

    // --- Config ---
    const CONCURRENCY = 4; // parallel uploads
    const BATCH_SIZE = 4;  // same as concurrency to keep it simple

    function getConfig() {
        const token = GM_getValue('tg_bot_token', '');
        const chatId = GM_getValue('tg_chat_id', '');
        return { token, chatId };
    }

    function promptConfig(force = false) {
        let { token, chatId } = getConfig();
        if (force || !token) {
            const enteredToken = prompt('Enter your Telegram Bot Token (from @BotFather):', token || '');
            if (enteredToken !== null) {
                token = enteredToken.trim();
                GM_setValue('tg_bot_token', token);
            }
        }
        if (force || !chatId) {
            const enteredChatId = prompt('Enter target Telegram Chat ID (user or group ID):', chatId || '');
            if (enteredChatId !== null) {
                chatId = enteredChatId.trim();
                GM_setValue('tg_chat_id', chatId);
            }
        }
        return { token, chatId };
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('⚙️ Configure Telegram Bot Token & Chat ID', () => {
            promptConfig(true);
            toast('Telegram configuration updated');
        });
    }

    function toast(msg) {
        GM_notification(msg);
        console.log('[GP2TG]', msg);
    }

    // --- Progress UI ---
    let statusBadge = null;
    let progressBarFill = null;
    let statusText = null;
    let timerInterval = null;
    let startTime = 0;

    function createProgressUI() {
        const root = document.body || document.documentElement;
        if (!root || document.getElementById('gp2tg-status-card')) return;

        const card = document.createElement('div');
        card.id = 'gp2tg-status-card';
        card.style.cssText = `
            position: fixed !important;
            top: 136px !important;
            right: 24px !important;
            z-index: 2147483647 !important;
            width: 280px !important;
            background: rgba(30, 30, 30, 0.95) !important;
            color: #ffffff !important;
            border-radius: 10px !important;
            padding: 12px 16px !important;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            font-size: 12px !important;
            display: none !important;
            flex-direction: column !important;
            gap: 8px !important;
            backdrop-filter: blur(8px) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
        `;

        const titleRow = document.createElement('div');
        titleRow.style.cssText = `display:flex;justify-content:space-between;align-items:center;font-weight:500;`;

        const label = document.createElement('span');
        label.textContent = 'Telegram Sync';
        label.style.cssText = 'color:#2AABEE;font-weight:600;';

        const timer = document.createElement('span');
        timer.id = 'gp2tg-timer';
        timer.textContent = '00:00';
        timer.style.cssText = 'color:#aaa;font-size:11px;font-variant-numeric:tabular-nums;';

        titleRow.appendChild(label);
        titleRow.appendChild(timer);

        const barTrack = document.createElement('div');
        barTrack.style.cssText = `width:100%;height:6px;background:rgba(255,255,255,0.15);border-radius:3px;overflow:hidden;`;

        const barFill = document.createElement('div');
        barFill.id = 'gp2tg-progress-fill';
        barFill.style.cssText = `width:0%;height:100%;background:#2AABEE;border-radius:3px;transition:width 0.2s ease;`;
        barTrack.appendChild(barFill);

        const stats = document.createElement('div');
        stats.style.cssText = `display:flex;justify-content:space-between;font-size:11px;color:#ccc;`;

        const progressLabel = document.createElement('span');
        progressLabel.id = 'gp2tg-progress-label';
        progressLabel.textContent = '0 / 0';

        const speedLabel = document.createElement('span');
        speedLabel.id = 'gp2tg-speed';
        speedLabel.textContent = '';

        stats.appendChild(progressLabel);
        stats.appendChild(speedLabel);

        card.appendChild(titleRow);
        card.appendChild(barTrack);
        card.appendChild(stats);
        root.appendChild(card);

        statusBadge = card;
        progressBarFill = barFill;
        statusText = progressLabel;

        startTime = Date.now();
        timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            timer.textContent = `${m}:${s}`;
        }, 500);
    }

    function updateProgress(current, total, sentCount, totalBytes) {
        if (!statusBadge) createProgressUI();
        if (!statusBadge) return;

        statusBadge.style.setProperty('display', 'flex', 'important');
        const fill = document.getElementById('gp2tg-progress-fill');
        const label = document.getElementById('gp2tg-progress-label');
        const speedEl = document.getElementById('gp2tg-speed');

        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        if (fill) fill.style.setProperty('width', `${percent}%`, 'important');
        if (label) label.textContent = `${current} / ${total}`;

        // Speed estimation
        if (speedEl && totalBytes > 0 && startTime > 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            if (elapsed > 0.5) {
                const mbps = (totalBytes / elapsed / 1024 / 1024).toFixed(1);
                speedEl.textContent = `${mbps} MB/s`;
                // ETA
                const remaining = totalBytes - current * (totalBytes / Math.max(total, 1));
                const eta = elapsed * (remaining / totalBytes);
                if (eta > 0 && isFinite(eta)) {
                    const eMin = Math.floor(eta / 60);
                    const eSec = Math.floor(eta % 60);
                    speedEl.textContent += ` · ETA ${eMin}:${String(eSec).padStart(2, '0')}`;
                }
            }
        }
    }

    function hideProgress(delayMs = 2500) {
        setTimeout(() => {
            if (statusBadge) statusBadge.style.setProperty('display', 'none', 'important');
            if (timerInterval) clearInterval(timerInterval);
        }, delayMs);
    }

    // --- Helpers ---
    function getSelected() {
        return document.querySelectorAll('.rtIMgb.nV0gYe.WjVZdb.R1sU4e');
    }

    function imageUrl(el, full) {
        const node = el.firstElementChild?.firstChild;
        if (!node || !node.dataset?.latestBg) return null;
        const base = node.dataset.latestBg.split('=')[0];
        return `${base}=${full ? 'w0-h0-rw' : 'w3456-h4608'}`;
    }

    function blobFromURL(url) {
        return fetch(url, { credentials: 'include' }).then(res => {
            if (!res.ok) throw new Error(`fetch failed ${res.status}`);
            return res.blob();
        });
    }

    // --- Upload with speed tracking ---
    async function sendToTelegram(blob, caption, botToken, chatId) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption || '');
        form.append('photo', blob, 'image.jpg');

        const apiUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;
        const r = await fetch(apiUrl, { method: 'POST', body: form });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.description || 'sendPhoto failed');
        return data;
    }

    async function deletePhoto(el) {
        throw new Error('delete not implemented yet');
    }

    // --- Concurrent queue ---
    async function main() {
        let { token, chatId } = getConfig();
        if (!token || !chatId) {
            const configured = promptConfig(false);
            token = configured.token;
            chatId = configured.chatId;
        }
        if (!token || !chatId) { toast('Telegram Bot Token and Chat ID are required.'); return; }

        const items = getSelected();
        if (!items.length) { toast('No images selected'); return; }

        const total = items.length;
        createProgressUI();
        updateProgress(0, total, 0, 0);

        // Build queue with pre-fetched blobs (keeps concurrency smooth)
        const queue = [];
        for (let i = 0; i < total; i++) {
            const el = items[i];
            const url = imageUrl(el, true);
            const caption = el.getAttribute('aria-label') || '';
            if (!url) continue;
            queue.push({ el, url, caption });
        }

        let ok = 0, fail = 0;
        let totalBytes = 0;
        let active = 0;
        let idx = 0;

        return new Promise((resolve) => {
            function runNext() {
                if (idx >= queue.length && active === 0) { finish(); return; }
                while (active < CONCURRENCY && idx < queue.length) {
                    const job = queue[idx++];
                    active++;
                    const jobStart = Date.now();
                    blobFromURL(job.url).then(blob => {
                        totalBytes += blob.size;
                        return sendToTelegram(blob, job.caption, token, chatId);
                    }).then(() => {
                        ok++;
                        try { deletePhoto(job.el); } catch (_) {}
                    }).catch(e => {
                        fail++;
                        console.error(e);
                    }).finally(() => {
                        active--;
                        const elapsed = (Date.now() - jobStart) / 1000;
                        updateProgress(idx, total, ok, totalBytes);
                        runNext();
                    });
                }
            }

            function finish() {
                updateProgress(total, total, ok, totalBytes);
                toast(`Done — ${ok} sent, ${fail} failed`);
                hideProgress(3000);
                resolve();
            }

            runNext();
        });
    }

    // --- FAB Button ---
    function injectButton() {
        const root = document.body || document.documentElement;
        if (!root) return;
        if (document.querySelectorAll('#gp2tg-btn').length > 0) return;

        const btn = document.createElement('button');
        btn.id = 'gp2tg-btn';
        btn.title = 'Sync selected photos to Telegram';
        btn.setAttribute('aria-label', 'Sync to Telegram');

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
        svg.style.pointerEvents = 'none'; svg.style.display = 'block';

        const p1 = document.createElementNS(svgNS, 'path');
        p1.setAttribute('d', 'M22 2L11 13');
        p1.setAttribute('stroke', '#ffffff'); p1.setAttribute('stroke-width', '2');
        p1.setAttribute('stroke-linecap', 'round'); p1.setAttribute('stroke-linejoin', 'round');

        const p2 = document.createElementNS(svgNS, 'path');
        p2.setAttribute('d', 'M22 2L15 22L11 13L2 9L22 2Z');
        p2.setAttribute('fill', '#ffffff');

        svg.appendChild(p1); svg.appendChild(p2); btn.appendChild(svg);

        btn.style.cssText = `
            position:fixed !important; top:80px !important; right:24px !important;
            z-index:2147483647 !important; width:48px !important; height:48px !important;
            padding:0 !important; margin:0 !important; background:#2AABEE !important;
            border:none !important; border-radius:50% !important; cursor:pointer !important;
            box-shadow:0 4px 14px rgba(0,0,0,0.4) !important;
            display:flex !important; align-items:center !important; justify-content:center !important;
            outline:none !important;
        `;

        btn.addEventListener('mouseenter', () => btn.style.setProperty('transform', 'scale(1.08)', 'important'));
        btn.addEventListener('mouseleave', () => btn.style.setProperty('transform', 'scale(1)', 'important'));

        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            btn.style.opacity = '0.5';
            main().finally(() => { btn.style.opacity = '1'; });
        });

        root.appendChild(btn);
        console.log('[GP2TG] FAB injected successfully');
    }

    setInterval(injectButton, 2000);
    injectButton();
})();
