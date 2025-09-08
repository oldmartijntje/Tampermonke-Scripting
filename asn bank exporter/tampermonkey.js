// ==UserScript==
// @name         ASN Bank History Saver
// @namespace    http://tampermonkey.net/
// @version      1.14
// @description  Export bank transactions with date range, format options, and optional statistics. Tracks actual first/last scanned dates and duration + ETA estimation. Bank selection included.
// @match        https://www.regiobank.nl/online/web/mijnregiobank/*
// @match        https://www.snsbank.nl/online/web/mijnsns/*
// @match        https://www.asnbank.nl/online/web/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const monthMap = {
        'januari': 0, 'februari': 1, 'maart': 2, 'april': 3, 'mei': 4, 'juni': 5,
        'juli': 6, 'augustus': 7, 'september': 8, 'oktober': 9, 'november': 10, 'december': 11
    };

    function parseDutchDate(text) {
        text = (text || '').trim().toLowerCase();
        const today = new Date();
        if (!text) return today;
        if (text.startsWith('vandaag')) return today;
        const parts = text.split(' ');
        if (parts.length === 2) {
            const day = parseInt(parts[0], 10);
            const month = monthMap[parts[1]];
            return new Date(today.getFullYear(), month, day);
        }
        if (parts.length === 3) {
            const day = parseInt(parts[0], 10);
            const month = monthMap[parts[1]];
            const year = parseInt(parts[2], 10);
            return new Date(year, month, day);
        }
        return today;
    }

    function formatDateInput(d) { return d.toISOString().split('T')[0]; }
    function normalizeDescription(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
    function normalizeAmount(a) { return Math.round(a * 100) / 100; }

    function extractTransactions() {
        const transactions = [];
        const elements = document.querySelectorAll('[data-testid="transaction-item"]');
        elements.forEach(el => {
            try {
                const dateEl = el.closest('.ap-transaction-overview')?.querySelector('[data-bb="ap-transaction-overview__date"]');
                const descEl = el.querySelector('[data-testid="title"]');
                const amountEl = el.querySelector('[data-testid="display-value"]');
                if (dateEl && descEl && amountEl) {
                    const date = parseDutchDate(dateEl.textContent.trim());
                    const description = normalizeDescription(descEl.textContent.trim());
                    const rawAmount = parseFloat(amountEl.textContent.trim().replace(/[\u20ac\s]/g, '').replace(',', '.'));
                    const amount = normalizeAmount(rawAmount);
                    transactions.push({ date, description, amount });
                }
            } catch (e) { console.error('Error parsing tx element', e); }
        });
        return transactions;
    }

    function downloadFile(data, filename, type) {
        const blob = new Blob([data], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function toCSV(transactions) {
        const header = 'Date,Description,Amount';
        const rows = transactions.map(t => `${t.date.toISOString().split('T')[0]},"${t.description}",${t.amount}`);
        return [header, ...rows].join('\n');
    }

    function calculateStats(transactions) {
        const income = transactions.filter(t => t.amount > 0);
        const spending = transactions.filter(t => t.amount < 0);
        const totalIncome = income.reduce((s, t) => s + t.amount, 0);
        const totalSpending = spending.reduce((s, t) => s + t.amount, 0);
        return {
            totalIncome,
            totalSpending,
            total: totalIncome + totalSpending,
            incomeTransactionsCount: income.length,
            averageIncomeTransaction: income.length ? totalIncome / income.length : 0,
            spendingTransactionsCount: spending.length,
            averageSpendingTransaction: spending.length ? totalSpending / spending.length : 0
        };
    }

    function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

    function findScrollContainer() {
        const sample = document.querySelector('[data-testid="transaction-item"]');
        if (!sample) return window;
        let el = sample.parentElement;
        while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            const overflowY = style.overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') return el;
            el = el.parentElement;
        }
        return window;
    }

    function waitForMutations(container, timeout = 4500) {
        return new Promise((resolve) => {
            let resolved = false;
            const observer = new MutationObserver((mutations) => {
                if (mutations && mutations.length > 0 && !resolved) {
                    resolved = true;
                    observer.disconnect();
                    resolve(true);
                }
            });
            try {
                const target = (container === window) ? document.body : container;
                observer.observe(target, { childList: true, subtree: true, characterData: true });
            } catch (e) { }
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    observer.disconnect();
                    resolve(false);
                }
            }, timeout);
        });
    }

    function humanDuration(seconds) {
        seconds = Math.max(0, Math.round(seconds));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0px';
        overlay.style.left = '0px';
        overlay.style.background = 'white';
        overlay.style.border = '1px solid #ccc';
        overlay.style.padding = '15px';
        overlay.style.zIndex = '999999';
        overlay.style.borderRadius = '0 0 10px 0';
        overlay.style.boxShadow = '0 4px 10px rgba(0,0,0,0.2)';
        overlay.style.fontFamily = 'sans-serif';
        overlay.style.fontSize = '14px';
        overlay.style.width = '320px';
        overlay.style.maxHeight = '90vh';
        overlay.style.overflow = 'auto';

        // --- Minimize/Close ---
        const minimizeBtn = document.createElement('button');
        minimizeBtn.textContent = '–';
        minimizeBtn.style.position = 'absolute';
        minimizeBtn.style.top = '5px';
        minimizeBtn.style.right = '35px';
        minimizeBtn.style.width = '25px';
        minimizeBtn.style.height = '25px';
        minimizeBtn.style.cursor = 'pointer';
        overlay.appendChild(minimizeBtn);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.position = 'absolute';
        closeBtn.style.top = '5px';
        closeBtn.style.right = '5px';
        closeBtn.style.width = '25px';
        closeBtn.style.height = '25px';
        closeBtn.style.cursor = 'pointer';
        overlay.appendChild(closeBtn);

        const restoreBtn = document.createElement('button');
        restoreBtn.textContent = '▲ ASN Export';
        restoreBtn.style.position = 'fixed';
        restoreBtn.style.top = '5px';
        restoreBtn.style.left = '5px';
        restoreBtn.style.zIndex = '999999';
        restoreBtn.style.display = 'none';
        restoreBtn.style.cursor = 'pointer';
        restoreBtn.style.padding = '5px 10px';
        restoreBtn.style.borderRadius = '5px';
        restoreBtn.style.border = '1px solid #ccc';
        restoreBtn.style.background = 'white';
        document.body.appendChild(restoreBtn);

        minimizeBtn.addEventListener('click', () => {
            overlay.style.display = 'none';
            restoreBtn.style.display = 'block';
        });
        restoreBtn.addEventListener('click', () => {
            overlay.style.display = 'block';
            restoreBtn.style.display = 'none';
        });
        closeBtn.addEventListener('click', () => {
            overlay.remove();
            restoreBtn.remove();
        });

        const title = document.createElement('h3');
        title.textContent = 'ASN Bank History Saver';
        title.style.margin = '0 0 10px 0';
        overlay.appendChild(title);

        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const startOfYear = new Date(today.getFullYear(), 0, 1);

        // --- Bank Selection ---
        const bankLabel = document.createElement('label');
        bankLabel.textContent = 'Bank: ';
        const bankSelect = document.createElement('select');
        ['ASN Bank', 'SNS Bank', 'RegioBank'].forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            bankSelect.appendChild(opt);
        });
        const url = window.location.href.toLowerCase();
        if (url.includes('asnbank')) bankSelect.value = 'ASN Bank';
        else if (url.includes('snsbank')) bankSelect.value = 'SNS Bank';
        else if (url.includes('regiobank')) bankSelect.value = 'RegioBank';
        bankLabel.appendChild(bankSelect);
        overlay.appendChild(bankLabel);
        overlay.appendChild(document.createElement('br'));
        overlay.appendChild(document.createElement('br'));

        // --- Other Inputs ---
        const createInput = (labelText, type, defaultValue) => {
            const label = document.createElement('label');
            label.textContent = labelText;
            const input = document.createElement(type === 'select' ? 'select' : 'input');
            if (type !== 'select') input.type = type;
            if (defaultValue) input.value = defaultValue;
            label.appendChild(input);
            overlay.appendChild(label);
            overlay.appendChild(document.createElement('br'));
            overlay.appendChild(document.createElement('br'));
            return input;
        };

        const nameInput = createInput('Bestandsnaam: ', 'text', 'spaarrekening_export');
        const categoryInput = createInput('Categorie: ', 'text', 'spaarrekening');
        const startInput = createInput('Startdatum: ', 'date', formatDateInput(tomorrow));
        const endInput = createInput('Einddatum: ', 'date', formatDateInput(startOfYear));

        const formatLabel = document.createElement('label');
        formatLabel.textContent = 'Formaat: ';
        const formatSelect = document.createElement('select');
        const optJson = document.createElement('option'); optJson.value = 'json'; optJson.textContent = 'JSON'; optJson.selected = true;
        const optCsv = document.createElement('option'); optCsv.value = 'csv'; optCsv.textContent = 'CSV';
        formatSelect.appendChild(optJson); formatSelect.appendChild(optCsv);
        formatLabel.appendChild(formatSelect);
        overlay.appendChild(formatLabel); overlay.appendChild(document.createElement('br')); overlay.appendChild(document.createElement('br'));

        const statsLabel = document.createElement('label');
        statsLabel.textContent = 'Calculated Statistics: ';
        const statsCheckbox = document.createElement('input');
        statsCheckbox.type = 'checkbox';
        statsCheckbox.checked = true;
        statsLabel.appendChild(statsCheckbox);
        overlay.appendChild(statsLabel);
        overlay.appendChild(document.createElement('br'));
        overlay.appendChild(document.createElement('br'));


        // --- Progress Bar ---
        const progressContainer = document.createElement('div');
        progressContainer.style.width = '100%';
        progressContainer.style.height = '20px';
        progressContainer.style.background = '#eee';
        progressContainer.style.border = '1px solid #ccc';
        progressContainer.style.borderRadius = '5px';
        progressContainer.style.margin = '10px 0';
        const progressBar = document.createElement('div');
        progressBar.style.height = '100%';
        progressBar.style.width = '0%';
        progressBar.style.background = '#4caf50';
        progressBar.style.borderRadius = '5px';
        progressContainer.appendChild(progressBar);
        overlay.appendChild(progressContainer);

        const exportBtn = document.createElement('button'); exportBtn.textContent = 'Exporteren';
        overlay.appendChild(exportBtn);

        const footer = document.createElement('div');
        footer.style.marginTop = '10px'; footer.style.fontSize = '12px'; footer.style.color = '#555';
        footer.innerHTML = '© oldmartijntje<br>Use at your own risk';
        overlay.appendChild(footer);

        document.body.appendChild(overlay);

        function setInputsDisabled(disabled) {
            [nameInput, categoryInput, startInput, endInput, formatSelect, statsCheckbox, exportBtn, bankSelect].forEach(el => el.disabled = disabled);
        }

        exportBtn.addEventListener('click', () => {
            const startDate = new Date(startInput.value);
            const endDate = new Date(endInput.value);
            const format = formatSelect.value;
            const calcStats = statsCheckbox.checked;
            const filenamePrefix = (nameInput.value || 'export').trim();
            const category = (categoryInput.value || '').trim();
            const bank = bankSelect.value; // pass bank value
            const pageUrl = window.location.href;

            setInputsDisabled(true);
            progressBar.style.width = '0%';

            loadAllTransactions(
                startDate, endDate, format, calcStats, filenamePrefix, category, pageUrl, bank,
                (progressFraction) => { progressBar.style.width = `${Math.round(progressFraction * 100)}%`; }
            ).finally(() => setInputsDisabled(false));
        });
    }

    async function loadAllTransactions(startDate, endDate, format, calcStats, filenamePrefix, category, pageUrl, bank, onProgress) {
        const collected = [];
        const seenKeys = new Set();
        const scrollContainer = findScrollContainer();
        console.log('Using scroll container:', scrollContainer === window ? 'window' : scrollContainer);

        let scrollAttempts = 0;
        const maxScrollAttempts = 200;
        let noNewDataRetries = 0;
        const maxNoNewDataRetries = 3;

        let prevOldestSeen = null;
        let scannedMinDate = null;
        let scannedMaxDate = null;
        const startTimestamp = Date.now();

        const keyFor = (t) => `${t.date.toISOString().split('T')[0]}|${t.description}|${t.amount.toFixed(2)}`;

        function computeOldestOnPage(txs) {
            if (!txs || txs.length === 0) return null;
            return txs.reduce((oldest, t) => t.date < oldest ? t.date : oldest, txs[0].date);
        }
        function computeNewestOnPage(txs) {
            if (!txs || txs.length === 0) return null;
            return txs.reduce((newest, t) => t.date > newest ? t.date : newest, txs[0].date);
        }

        while (true) {
            const txs = extractTransactions();
            const oldestOnPage = computeOldestOnPage(txs) || endDate;
            const newestOnPage = computeNewestOnPage(txs) || startDate;

            if (!scannedMinDate || oldestOnPage < scannedMinDate) scannedMinDate = oldestOnPage;
            if (!scannedMaxDate || newestOnPage > scannedMaxDate) scannedMaxDate = newestOnPage;

            txs.forEach(t => {
                const key = keyFor(t);
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    if (t.date >= endDate && t.date <= startDate) collected.push(t);
                }
            });

            if (!prevOldestSeen) prevOldestSeen = oldestOnPage;
            else if (oldestOnPage < prevOldestSeen) prevOldestSeen = oldestOnPage;

            if (onProgress && scannedMinDate && scannedMaxDate) {
                const totalRange = startDate - endDate;
                const covered = scannedMaxDate - scannedMinDate;
                let fraction = Math.min(Math.max(covered / totalRange, 0), 1);
                onProgress(fraction);
            }

            if (oldestOnPage < endDate || scrollAttempts >= maxScrollAttempts) break;

            try {
                if (scrollContainer === window) window.scrollTo(0, document.body.scrollHeight || document.documentElement.scrollHeight);
                else scrollContainer.scrollTop = scrollContainer.scrollHeight;
            } catch (e) { }

            scrollAttempts++;
            const mutated = await waitForMutations(scrollContainer, 4500);
            if (mutated) { await sleep(400); continue; }
            else {
                noNewDataRetries++;
                if (noNewDataRetries >= maxNoNewDataRetries) break;
                try {
                    if (scrollContainer === window) {
                        window.scrollBy(0, -60); await sleep(200); window.scrollBy(0, 120);
                    } else {
                        scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - 60);
                        await sleep(200);
                        scrollContainer.scrollTop = scrollContainer.scrollHeight;
                    }
                    const mutated2 = await waitForMutations(scrollContainer, 3000);
                    if (mutated2) { await sleep(300); continue; }
                } catch (e) { }
                await sleep(500);
            }
        }

        const endTimestamp = Date.now();
        const timeTakenSec = (endTimestamp - startTimestamp) / 1000;
        const timeTakenHuman = humanDuration(timeTakenSec);
        const nowDate = new Date();
        const dateStr = formatDateInput(nowDate);

        if (format === 'csv') {
            downloadFile(toCSV(collected), `${filenamePrefix}_${dateStr}.csv`, 'text/csv');
        } else {
            const jsonData = {
                exportedAt: nowDate.toISOString(),
                startDate: formatDateInput(startDate),
                endDate: formatDateInput(endDate),
                actualFirstScanned: scannedMaxDate ? formatDateInput(scannedMaxDate) : null,
                actualLastScanned: scannedMinDate ? formatDateInput(scannedMinDate) : null,
                timeTakenSeconds: timeTakenSec,
                timeTakenHuman,
                category,
                bank,
                pageUrl,
                stats: calcStats ? calculateStats(collected) : {},
                transactions: collected
            };
            downloadFile(JSON.stringify(jsonData, null, 2), `${filenamePrefix}_${dateStr}.json`, 'application/json');
        }

        console.log(`Export complete. Total transactions exported: ${collected.length}. Time taken: ${timeTakenHuman}`);
        if (onProgress) onProgress(1);
    }

    createOverlay();
})();
