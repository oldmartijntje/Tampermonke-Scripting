// ==UserScript==
// @name         ASN Bank History Saver
// @namespace    http://tampermonkey.net/
// @version      1.11
// @description  Export bank transactions with date range, format options, and optional statistics. Tracks actual first/last scanned dates and duration + ETA estimation.
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
            } catch (e) {
                console.error('Error parsing tx element', e);
            }
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

    // --- Utilities ---
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

    // --- Robust loader with ETA + actual first/last scanned ---
    async function loadAllTransactions(startDate, endDate, format, calcStats) {
        const collected = [];
        const seenKeys = new Set();
        const scrollContainer = findScrollContainer();
        console.log('Using scroll container:', scrollContainer === window ? 'window' : scrollContainer);

        let scrollAttempts = 0;
        const maxScrollAttempts = 200;
        let noNewDataRetries = 0;
        const maxNoNewDataRetries = 3;

        let prevOldestSeen = null;
        let scannedMinDate = null; // oldest scanned (actualLastScanned)
        let scannedMaxDate = null; // newest scanned (actualFirstScanned)
        const startTimestamp = Date.now();

        const msPerDay = 1000 * 60 * 60 * 24;

        const keyFor = (t) => {
            const dateStr = t.date.toISOString().split('T')[0];
            return `${dateStr}|${t.description}|${t.amount.toFixed(2)}`;
        };

        function computeOldestOnPage(txs) {
            if (!txs || txs.length === 0) return null;
            let oldest = txs[0].date;
            txs.forEach(t => { if (t.date < oldest) oldest = t.date; });
            return oldest;
        }
        function computeNewestOnPage(txs) {
            if (!txs || txs.length === 0) return null;
            let newest = txs[0].date;
            txs.forEach(t => { if (t.date > newest) newest = t.date; });
            return newest;
        }

        while (true) {
            const txs = extractTransactions();
            const oldestOnPage = computeOldestOnPage(txs) || endDate;
            const newestOnPage = computeNewestOnPage(txs) || startDate;

            // update scanned min/max from everything we've seen on page
            if (!scannedMinDate || oldestOnPage < scannedMinDate) scannedMinDate = oldestOnPage;
            if (!scannedMaxDate || newestOnPage > scannedMaxDate) scannedMaxDate = newestOnPage;

            // add unique transactions to collected (within requested window)
            let newUniqueAdded = false;
            txs.forEach(t => {
                const key = keyFor(t);
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    if (t.date >= endDate && t.date <= startDate) collected.push(t);
                    newUniqueAdded = true;
                }
            });

            // detect real progress in oldest date
            let progressed = false;
            if (!prevOldestSeen) {
                prevOldestSeen = oldestOnPage;
                progressed = true;
            } else if (oldestOnPage < prevOldestSeen) {
                prevOldestSeen = oldestOnPage;
                progressed = true;
            }

            // estimation calculation
            const now = Date.now();
            const elapsedSec = (now - startTimestamp) / 1000;
            let etaHuman = 'N/A';
            if (scannedMinDate && scannedMaxDate && scannedMaxDate.getTime() !== scannedMinDate.getTime()) {
                const daysCovered = (scannedMaxDate - scannedMinDate) / msPerDay;
                if (daysCovered > 0 && elapsedSec > 1) {
                    const secondsPerDay = elapsedSec / daysCovered;
                    const remainingDays = Math.max(0, (scannedMinDate - endDate) / msPerDay);
                    const estimatedRemainingSec = secondsPerDay * remainingDays;
                    etaHuman = humanDuration(estimatedRemainingSec);
                }
            }

            // only reset noNewDataRetries when real progress was made (older date found)
            if (progressed) {
                noNewDataRetries = 0;
            }

            console.log(`Collected ${collected.length} transactions. Oldest on page: ${oldestOnPage.toISOString().split('T')[0]}. PrevOldestSeen: ${prevOldestSeen.toISOString().split('T')[0]}. Scroll attempts: ${scrollAttempts}. noNewDataRetries: ${noNewDataRetries}. ETA: ${etaHuman}`);

            // termination checks
            if (oldestOnPage < endDate) {
                console.log('Stopping reason: oldestOnPage < endDate');
                break;
            }
            if (scrollAttempts >= maxScrollAttempts) {
                console.log('Stopping reason: reached max scroll attempts');
                break;
            }

            // scroll
            try {
                if (scrollContainer === window) {
                    window.scrollTo(0, document.body.scrollHeight || document.documentElement.scrollHeight);
                } else {
                    scrollContainer.scrollTop = scrollContainer.scrollHeight;
                }
            } catch (e) { }

            scrollAttempts++;

            // wait for mutations
            const mutated = await waitForMutations(scrollContainer, 4500);
            if (mutated) {
                await sleep(400);
                continue;
            } else {
                noNewDataRetries++;
                console.log(`No DOM changes detected after scroll. noNewDataRetries=${noNewDataRetries}`);

                // nudge trick
                try {
                    if (scrollContainer === window) {
                        window.scrollBy(0, -60);
                        await sleep(200);
                        window.scrollBy(0, 120);
                    } else {
                        scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - 60);
                        await sleep(200);
                        scrollContainer.scrollTop = scrollContainer.scrollHeight;
                    }
                    const mutated2 = await waitForMutations(scrollContainer, 3000);
                    if (mutated2) { await sleep(300); continue; }
                } catch (e) { }

                if (noNewDataRetries >= maxNoNewDataRetries) {
                    console.log('Stopping reason: too many no-new-data retries (no further progress detected)');
                    break;
                }

                await sleep(500);
                continue;
            }
        }

        // finalize export, compute duration and add actual first/last scanned
        const endTimestamp = Date.now();
        const timeTakenSec = (endTimestamp - startTimestamp) / 1000;
        const timeTakenHuman = humanDuration(timeTakenSec);

        const now = new Date();
        const dateStr = formatDateInput(now);
        if (format === 'csv') {
            downloadFile(toCSV(collected), `${filenamePrefix}_${dateStr}.csv`, 'text/csv');
        } else {
            const jsonData = {
                exportedAt: now.toISOString(),
                startDate: formatDateInput(startDate),
                endDate: formatDateInput(endDate),
                actualFirstScanned: scannedMaxDate ? formatDateInput(scannedMaxDate) : null,
                actualLastScanned: scannedMinDate ? formatDateInput(scannedMinDate) : null,
                timeTakenSeconds: timeTakenSec,
                timeTakenHuman: timeTakenHuman,
                category: category,
                pageUrl: pageUrl,
                stats: calcStats ? calculateStats(collected) : {},
                transactions: collected
            };
            downloadFile(JSON.stringify(jsonData, null, 2), `${filenamePrefix}_${dateStr}.json`, 'application/json');
        }

        console.log(`Export complete. Total transactions exported: ${collected.length}. Time taken: ${timeTakenHuman}`);
    }

    // --- Overlay UI ---
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

        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const startOfYear = new Date(today.getFullYear(), 0, 1);

        const title = document.createElement('h3');
        title.textContent = 'ASN Bank History Saver';
        title.style.margin = '0 0 10px 0';
        overlay.appendChild(title);

        // --- Name Input ---
        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Bestandsnaam: ';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = 'spaarrekening_export'; // default name
        nameLabel.appendChild(nameInput);
        overlay.appendChild(nameLabel);
        overlay.appendChild(document.createElement('br'));
        overlay.appendChild(document.createElement('br'));

        // --- Category Input ---
        const categoryLabel = document.createElement('label');
        categoryLabel.textContent = 'Categorie: ';
        const categoryInput = document.createElement('input');
        categoryInput.type = 'text';
        categoryInput.value = 'spaarrekening';
        categoryLabel.appendChild(categoryInput);
        overlay.appendChild(categoryLabel);
        overlay.appendChild(document.createElement('br'));
        overlay.appendChild(document.createElement('br'));

        // --- Date Inputs ---
        const startLabel = document.createElement('label'); startLabel.textContent = 'Startdatum: ';
        const startInput = document.createElement('input'); startInput.type = 'date'; startInput.value = formatDateInput(tomorrow);
        startLabel.appendChild(startInput); overlay.appendChild(startLabel);
        overlay.appendChild(document.createElement('br')); overlay.appendChild(document.createElement('br'));

        const endLabel = document.createElement('label'); endLabel.textContent = 'Einddatum: ';
        const endInput = document.createElement('input'); endInput.type = 'date'; endInput.value = formatDateInput(startOfYear);
        endLabel.appendChild(endInput); overlay.appendChild(endLabel);
        overlay.appendChild(document.createElement('br')); overlay.appendChild(document.createElement('br'));

        const formatLabel = document.createElement('label'); formatLabel.textContent = 'Formaat: ';
        const formatSelect = document.createElement('select');
        const optJson = document.createElement('option'); optJson.value = 'json'; optJson.textContent = 'JSON'; optJson.selected = true;
        const optCsv = document.createElement('option'); optCsv.value = 'csv'; optCsv.textContent = 'CSV';
        formatSelect.appendChild(optJson); formatSelect.appendChild(optCsv); formatLabel.appendChild(formatSelect);
        overlay.appendChild(formatLabel); overlay.appendChild(document.createElement('br')); overlay.appendChild(document.createElement('br'));

        const statsLabel = document.createElement('label'); statsLabel.textContent = 'Calculated Statistics: ';
        const statsCheckbox = document.createElement('input'); statsCheckbox.type = 'checkbox';
        statsLabel.appendChild(statsCheckbox); overlay.appendChild(statsLabel); overlay.appendChild(document.createElement('br')); overlay.appendChild(document.createElement('br'));

        const exportBtn = document.createElement('button'); exportBtn.textContent = 'Exporteren';
        overlay.appendChild(exportBtn);

        const footer = document.createElement('div');
        footer.style.marginTop = '10px'; footer.style.fontSize = '12px'; footer.style.color = '#555';
        footer.innerHTML = '© oldmartijntje<br>Use at your own risk';
        overlay.appendChild(footer);

        document.body.appendChild(overlay);

        exportBtn.addEventListener('click', () => {
            const startDate = new Date(startInput.value);
            const endDate = new Date(endInput.value);
            const format = formatSelect.value;
            const calcStats = statsCheckbox.checked;
            const filenamePrefix = (nameInput.value || 'export').trim();
            const category = (categoryInput.value || '').trim();
            const pageUrl = window.location.href; // automatically save current page URL
            loadAllTransactions(startDate, endDate, format, calcStats, filenamePrefix, category, pageUrl);
        });
    }



    // --- Init ---
    createOverlay();
})();
