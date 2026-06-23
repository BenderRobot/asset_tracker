import { Storage } from './storage.js';
import { PRICE_PROXY_URL } from './config.js';
import { auth } from './firebaseConfig.js';
import logger from '../utils/logger.js';

const PROXY = PRICE_PROXY_URL;

class WatchlistApp {
    constructor() {
        this.storage = new Storage();
        // Variables for refresh state
        this.isRefreshing = false;
        
        // Sorting state
        this.sortColumn = 'ticker';
        this.sortDirection = 'asc'; // 'asc' or 'desc'
        this.watchlistData = []; // Store parsed watchlist data for sorting

        // Group modal state
        this.currentEditingGroupId = null;
        this.currentFilterGroupId = null; // Groupe sélectionné pour filtrer le tableau
        this.currentAddingGroupId = null; // Groupe pour lequel on ajoute des actifs

        // Attendre que la session firebase soit rétablie ou déclencher le render initial
        auth.onAuthStateChanged((user) => {
            setTimeout(() => {
                this.renderGroups();
                this.renderWatchlist();
                this.refreshWatchlistData();
            }, 800);
        });

        // Ecouter les modifications multi-onglets/firestore sur la watchlist
        window.addEventListener('watchlist-updated', () => {
            this.renderWatchlist();
        });

        // Ecouter les modifications des groupes
        window.addEventListener('watchlist-groups-updated', () => {
            this.renderGroups();
        });
        
        // Setup group modal
        this.setupGroupModal();
        this.setupAssetsModal();
        this.setupGroupFilter();
        
        // Initial fallback render
        setTimeout(() => {
            this.renderGroups();
            this.renderWatchlist();
        }, 100);
    }

    // === GESTION DES GROUPES ===
    setupGroupModal() {
        const modal = document.getElementById('group-modal');
        const addBtn = document.getElementById('add-group-btn');
        const closeBtn = document.getElementById('group-modal-close');
        const cancelBtn = document.getElementById('group-modal-cancel');
        const saveBtn = document.getElementById('group-modal-save');
        const titleEl = document.getElementById('group-modal-title');
        const nameInput = document.getElementById('group-name-input');

        addBtn.addEventListener('click', () => {
            this.currentEditingGroupId = null;
            titleEl.textContent = 'Créer un groupe';
            saveBtn.textContent = 'Créer';
            nameInput.value = '';
            nameInput.focus();
            modal.style.display = 'flex';
        });

        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        cancelBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        saveBtn.addEventListener('click', async () => {
            const name = nameInput.value.trim();
            if (!name) {
                alert('Veuillez entrer un nom de groupe');
                return;
            }

            if (this.currentEditingGroupId) {
                await this.storage.updateWatchlistGroup(this.currentEditingGroupId, { name });
            } else {
                await this.storage.addWatchlistGroup(name);
            }

            modal.style.display = 'none';
            nameInput.value = '';
        });

        // Fermer avec Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                modal.style.display = 'none';
            }
        });
    }

    renderGroups() {
        const grid = document.getElementById('watchlist-groups-grid');
        if (!grid) return;

        const groups = this.storage.getWatchlistGroups() || [];
        const watchlist = this.storage.getWatchlist() || [];

        if (groups.length === 0) {
            grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:40px 20px; color:var(--text-muted);">
                Aucun groupe créé. <a href="#" onclick="document.getElementById('add-group-btn').click(); return false;" style="color:#3b82f6; text-decoration:underline;">Créer un groupe</a>
            </div>`;
            return;
        }

        grid.innerHTML = groups.map(group => {
            const tickers = group.tickers || [];
            const isSelected = this.currentFilterGroupId === group.id;
            
            // Obtenir les 4 actifs les mieux notés du groupe
            const assetsInGroup = watchlist.filter(w => tickers.includes(w.ticker));
            const topAssets = assetsInGroup
                .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                .slice(0, 4);
            
            return `
                <div class="group-card" data-group-id="${group.id}" style="
                    border:2px solid ${isSelected ? '#3b82f6' : 'var(--border-color)'}; 
                    border-radius:12px; 
                    padding:16px; 
                    background:${isSelected ? 'rgba(59,130,246,0.1)' : 'var(--bg-card)'};
                    cursor:pointer;
                    transition:all 0.3s;
                    position:relative;
                    aspect-ratio:1;
                    display:flex;
                    flex-direction:column;
                    justify-content:space-between;
                ">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                        <div style="flex:1;">
                            <div class="group-name" style="
                                font-weight:600;
                                font-size:16px;
                                color:var(--text-color);
                                word-break:break-word;
                                max-height:40px;
                                overflow:hidden;
                            ">${group.name}</div>
                        </div>
                        <div style="
                            background:rgba(59,130,246,0.2);
                            color:#3b82f6;
                            padding:4px 8px;
                            border-radius:6px;
                            font-size:11px;
                            font-weight:600;
                            white-space:nowrap;
                        ">${tickers.length}</div>
                    </div>

                    <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:8px; flex:1; align-items:center; justify-items:center; margin:12px 0;">
                        ${topAssets.map(asset => {
                            const website = asset.website || '';
                            const domain = website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
                            const logoHtml = domain 
                                ? `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" style="width:40px; height:40px; border-radius:6px; object-fit:contain;" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">`
                                : '';
                            return `
                                <div style="position:relative; width:48px; height:48px; border-radius:8px; background:var(--bg-lighter); display:flex; align-items:center; justify-content:center; overflow:hidden;">
                                    ${logoHtml}
                                    <div style="
                                        ${logoHtml ? 'display:none;' : ''}
                                        font-weight:600;
                                        font-size:12px;
                                        color:var(--text-color);
                                    ">${asset.ticker.substring(0, 2)}</div>
                                </div>
                            `;
                        }).join('')}
                        ${topAssets.length < 4 ? Array(4 - topAssets.length).fill(0).map(() => `
                            <div style="
                                width:48px;
                                height:48px;
                                border-radius:8px;
                                border:2px dashed var(--border-color);
                                display:flex;
                                align-items:center;
                                justify-content:center;
                                color:var(--text-muted);
                                font-size:18px;
                            ">+</div>
                        `).join('') : ''}
                    </div>

                    <div class="group-actions" style="display:flex; gap:4px; opacity:0; transition:opacity 0.2s; justify-content:flex-end;">
                        <button class="group-add-assets-btn" title="Ajouter des actifs" style="
                            background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:16px;
                            padding:4px; border-radius:4px;
                        ">➕</button>
                        <button class="group-edit-btn" title="Éditer" style="
                            background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:16px;
                            padding:4px; border-radius:4px;
                        ">✏️</button>
                        <button class="group-delete-btn" title="Supprimer" style="
                            background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:16px;
                            padding:4px; border-radius:4px;
                        ">🗑️</button>
                    </div>
                </div>
            `;
        }).join('');

        // Add event listeners
        grid.querySelectorAll('.group-card').forEach(card => {
            const groupId = card.dataset.groupId;
            const addAssetsBtn = card.querySelector('.group-add-assets-btn');
            const editBtn = card.querySelector('.group-edit-btn');
            const deleteBtn = card.querySelector('.group-delete-btn');

            // Hover effect
            card.addEventListener('mouseenter', () => {
                card.querySelector('.group-actions').style.opacity = '1';
            });
            card.addEventListener('mouseleave', () => {
                card.querySelector('.group-actions').style.opacity = '0';
            });

            // Add assets
            addAssetsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.currentAddingGroupId = groupId;
                this.openAssetsModal();
            });

            // Edit
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editGroup(groupId);
            });

            // Delete
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm('Supprimer ce groupe ?')) {
                    await this.storage.deleteWatchlistGroup(groupId);
                }
            });

            // Click to filter by group
            card.addEventListener('click', () => {
                this.currentFilterGroupId = this.currentFilterGroupId === groupId ? null : groupId;
                this.renderWatchlist();
                this.updateFilterBadge();
            });
        });
    }

    editGroup(groupId) {
        const groups = this.storage.getWatchlistGroups() || [];
        const group = groups.find(g => g.id === groupId);
        if (!group) return;

        this.currentEditingGroupId = groupId;
        const modal = document.getElementById('group-modal');
        const titleEl = document.getElementById('group-modal-title');
        const nameInput = document.getElementById('group-name-input');
        const saveBtn = document.getElementById('group-modal-save');

        titleEl.textContent = 'Éditer le groupe';
        saveBtn.textContent = 'Modifier';
        nameInput.value = group.name;
        nameInput.focus();
        modal.style.display = 'flex';
    }

    viewGroupDetails(groupId) {
        this.currentAddingGroupId = groupId;
        this.openAssetsModal();
    }

    setupAssetsModal() {
        const modal = document.getElementById('group-assets-modal');
        const closeBtn = document.getElementById('group-assets-modal-close');
        const cancelBtn = document.getElementById('group-assets-modal-cancel');
        const searchInput = document.getElementById('group-assets-search');

        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        cancelBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        searchInput.addEventListener('input', () => {
            this.renderAssetsInModal();
        });

        // Fermer avec Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                modal.style.display = 'none';
            }
        });
    }

    openAssetsModal() {
        const modal = document.getElementById('group-assets-modal');
        const groups = this.storage.getWatchlistGroups() || [];
        const group = groups.find(g => g.id === this.currentAddingGroupId);

        if (!group) return;

        const titleEl = document.getElementById('group-assets-modal-title');
        titleEl.textContent = `Ajouter des actifs à "${group.name}"`;

        document.getElementById('group-assets-search').value = '';
        this.renderAssetsInModal();
        modal.style.display = 'flex';
    }

    renderAssetsInModal() {
        const list = document.getElementById('group-assets-list');
        const searchInput = document.getElementById('group-assets-search');
        const query = searchInput.value.toUpperCase();

        const watchlist = this.storage.getWatchlist() || [];
        const groups = this.storage.getWatchlistGroups() || [];
        const currentGroup = groups.find(g => g.id === this.currentAddingGroupId);

        if (!currentGroup) return;

        const filtered = watchlist.filter(w => 
            query === '' || w.ticker.includes(query) || w.name.toUpperCase().includes(query)
        );

        list.innerHTML = filtered.map(asset => {
            const isInGroup = currentGroup.tickers.includes(asset.ticker);
            const btnClass = isInGroup ? 'btn-secondary' : 'btn-primary';
            const btnText = isInGroup ? '✓ Ajouté' : '+ Ajouter';

            return `
                <div class="asset-item" style="
                    display:flex; 
                    justify-content:space-between; 
                    align-items:center; 
                    padding:12px; 
                    border:1px solid var(--border-color); 
                    border-radius:8px; 
                    background:var(--bg-lighter);
                ">
                    <div>
                        <div style="font-weight:600; color:var(--text-color);">${asset.ticker}</div>
                        <div style="font-size:12px; color:var(--text-muted);">${asset.name}</div>
                    </div>
                    <button class="asset-toggle-btn ${btnClass}" data-ticker="${asset.ticker}" data-in-group="${isInGroup}" style="
                        padding:6px 12px; 
                        font-size:12px; 
                        border:1px solid ${isInGroup ? 'var(--border-color)' : 'currentColor'}; 
                        border-radius:6px; 
                        background:${isInGroup ? 'var(--bg-lighter)' : '#3b82f6'}; 
                        color:${isInGroup ? 'var(--text-muted)' : 'white'}; 
                        cursor:pointer;
                        font-weight:500;
                    ">${btnText}</button>
                </div>
            `;
        }).join('');

        // Add event listeners
        list.querySelectorAll('.asset-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const ticker = btn.dataset.ticker;
                const inGroup = btn.dataset.inGroup === 'true';

                if (inGroup) {
                    await this.storage.removeTickerFromGroup(this.currentAddingGroupId, ticker);
                } else {
                    await this.storage.addTickerToGroup(this.currentAddingGroupId, ticker);
                }

                this.renderAssetsInModal();
            });
        });
    }

    setupGroupFilter() {
        const clearBtn = document.getElementById('clear-group-filter');
        clearBtn.addEventListener('click', () => {
            this.currentFilterGroupId = null;
            this.renderWatchlist();
            this.updateFilterBadge();
        });
    }

    updateFilterBadge() {
        const badge = document.getElementById('group-filter-badge');
        const nameEl = document.getElementById('group-filter-name');

        if (this.currentFilterGroupId) {
            const groups = this.storage.getWatchlistGroups() || [];
            const group = groups.find(g => g.id === this.currentFilterGroupId);
            if (group) {
                nameEl.textContent = group.name;
                badge.style.display = 'inline-block';
            }
        } else {
            badge.style.display = 'none';
        }
    }

    sortWatchlist(watchlist) {
        const sorted = [...watchlist];
        
        sorted.sort((a, b) => {
            let aVal, bVal;
            
            switch (this.sortColumn) {
                case 'ticker':
                    aVal = a.ticker?.toUpperCase() || '';
                    bVal = b.ticker?.toUpperCase() || '';
                    break;
                case 'price':
                    aVal = a.priceData?.regularMarketPrice?.raw ?? 0;
                    bVal = b.priceData?.regularMarketPrice?.raw ?? 0;
                    break;
                case 'score':
                    aVal = a.score ?? 0;
                    bVal = b.score ?? 0;
                    break;
                case 'pe':
                    aVal = parseFloat(a.detail?.trailingPE?.raw ?? a.stats?.trailingPE?.raw ?? 0);
                    bVal = parseFloat(b.detail?.trailingPE?.raw ?? b.stats?.trailingPE?.raw ?? 0);
                    break;
                case 'dividend':
                    aVal = (a.detail?.dividendYield?.raw ?? a.detail?.trailingAnnualDividendYield?.raw ?? 0) * 100;
                    bVal = (b.detail?.dividendYield?.raw ?? b.detail?.trailingAnnualDividendYield?.raw ?? 0) * 100;
                    break;
                case 'change':
                    aVal = a.priceData?.regularMarketChange?.raw ?? 0;
                    bVal = b.priceData?.regularMarketChange?.raw ?? 0;
                    break;
                default:
                    return 0;
            }
            
            // Handle numeric vs string comparison
            if (typeof aVal === 'string' && typeof bVal === 'string') {
                return this.sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            } else {
                return this.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
            }
        });
        
        return sorted;
    }

    renderWatchlist() {
        const tbody = document.getElementById('watchlist-table-body');
        if (!tbody) return;

        let watchlist = this.storage.getWatchlist() || [];

        // Filtrer par groupe si un est sélectionné
        if (this.currentFilterGroupId) {
            const groups = this.storage.getWatchlistGroups() || [];
            const selectedGroup = groups.find(g => g.id === this.currentFilterGroupId);
            if (selectedGroup && selectedGroup.tickers) {
                watchlist = watchlist.filter(item => selectedGroup.tickers.includes(item.ticker));
            }
        }

        // Apply sorting
        watchlist = this.sortWatchlist(watchlist);

        if (watchlist.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">
                Votre watchlist est vide.<br><br>
                <a href="screener.html" class="btn-primary" style="display:inline-block; margin-top:10px;">Explorer les actifs</a>
            </td></tr>`;
            return;
        }

        let html = '';
        watchlist.forEach((item) => {
            // Retrieve cached data from Firestore (now stored inside item directly)
            const priceData = item.priceData || null;
            const stats = item.stats || {};
            const financial = item.financial || {};
            const detail = item.detail || {};
            const website = item.website || '';

            let currentPrice = '--';
            let change = 0;
            let changePct = 0;
            let currency = '';
            
            if (priceData) {
                currentPrice = priceData.regularMarketPrice?.raw ?? '--';
                change = priceData.regularMarketChange?.raw ?? 0;
                changePct = priceData.regularMarketChangePercent?.raw ?? 0;
                currency = priceData.currency || '';
            }

            const sign = change >= 0 ? '+' : '';
            const colorClass = change >= 0 ? 'positive' : 'negative';
            const changeStr = priceData ? `${sign}${change.toFixed(2)} (${sign}${(changePct * 100).toFixed(2)}%)` : '--';
            const priceStr = priceData ? `${this.fmt(currentPrice, 2)} ${currency}` : '--';

            // Google favicon logic
            let iconHtml = ``;
            if (website && website.length > 5) {
                // Ensure valid domain format (strip http/https protocols to help favicon service)
                const domain = website.replace(/^https?:\/\//, '').replace(/\/$/, "");
                iconHtml = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" style="width:24px; height:24px; object-fit:contain; border-radius:4px;" alt="logo" onerror="this.outerHTML='<div style=\\'width:36px; height:36px; border-radius:50%; background:var(--bg-lighter); color:var(--text-color); display:flex; align-items:center; justify-content:center; font-weight:600; font-size:16px;\\'>${item.ticker.charAt(0)}</div>'">`;
            } else {
                iconHtml = `<div style="width:36px; height:36px; border-radius:50%; background:var(--bg-lighter); color:var(--text-color); display:flex; align-items:center; justify-content:center; font-weight:600; font-size:16px;">
                    ${item.ticker.charAt(0)}
                </div>`;
            }

            // --- Compute Score ---
            let totalScore = 0;
            let scoreBadgeHtml = '<span style="color:var(--text-muted)">--</span>';
            if (item.score !== undefined) {
                totalScore = item.score;
                const scoreColor = totalScore >= 14 ? '#10b981' : totalScore >= 10 ? '#f59e0b' : '#ef4444';
                scoreBadgeHtml = `<span style="display:inline-block; padding:4px 8px; border-radius:6px; background:rgba(255,255,255,0.05); color:${scoreColor}; font-weight:700;">${totalScore.toFixed(1)}/20</span>`;
            } else if (financial && detail && Object.keys(financial).length > 0) {
                // Fallback computation using the same logic as screener
                totalScore = this.calculateScore(stats, financial, detail);
                const scoreColor = totalScore >= 14 ? '#10b981' : totalScore >= 10 ? '#f59e0b' : '#ef4444';
                scoreBadgeHtml = `<span style="display:inline-block; padding:4px 8px; border-radius:6px; background:rgba(255,255,255,0.05); color:${scoreColor}; font-weight:700;">${totalScore.toFixed(1)}/20</span>`;
            }

            // --- Fundamental data ---
            const trailingPE = detail?.trailingPE?.raw ?? stats?.trailingPE?.raw;
            const peStr = trailingPE ? parseFloat(trailingPE).toFixed(1) + 'x' : '--';
            
            const div = (detail?.dividendYield?.raw ?? detail?.trailingAnnualDividendYield?.raw ?? 0) * 100;
            const divStr = div > 0 ? div.toFixed(2) + '%' : '--';

            html += `
                <tr class="transaction-row" style="cursor: default;">
                    <td style="padding:15px 10px;">
                        <div style="display:flex; align-items:center; gap:12px;">
                            ${iconHtml}
                            <div>
                                <div style="font-weight:600; color:var(--text-color);">${item.ticker}</div>
                                <div style="font-size:12px; color:var(--text-muted);">${item.name}</div>
                            </div>
                        </div>
                    </td>
                    <td style="padding:15px 10px; text-align:right; font-weight:500;">
                        ${priceStr}
                    </td>
                    <td style="padding:15px 10px; text-align:center;">
                        ${scoreBadgeHtml}
                    </td>
                    <td style="padding:15px 10px; text-align:right; font-weight:500;">
                        ${peStr}
                    </td>
                    <td style="padding:15px 10px; text-align:right; font-weight:500;">
                        ${divStr}
                    </td>
                    <td style="padding:15px 10px; text-align:right;">
                        <span class="stock-change ${priceData ? colorClass : ''}" style="display:inline-block; padding:4px 8px; border-radius:6px; font-size:13px; font-weight:500;">
                            ${changeStr}
                        </span>
                    </td>
                    <td style="padding:15px 10px; text-align:center;">
                        <div style="display:flex; justify-content:center; gap:8px;">
                            <a href="screener.html?ticker=${item.ticker}" style="color:#3b82f6; text-decoration:none; padding:8px 12px; border-radius:6px; background:rgba(59,130,246,0.1); display:inline-flex; align-items:center; justify-content:center; transition:0.2s;" title="Voir l'analyse">
                                <i class="fas fa-chart-line"></i>
                            </a>
                            <button class="delete-btn" data-ticker="${item.ticker}" style="color:#ef4444; border:none; padding:8px 12px; border-radius:6px; background:rgba(239,68,68,0.1); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:0.2s;" title="Retirer">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;

        // Bind delete buttons
        tbody.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const ticker = e.currentTarget.dataset.ticker;
                if(confirm(`Voulez-vous retirer ${ticker} de votre watchlist ?`)) {
                    await this.storage.removeFromWatchlist(ticker);
                    this.renderWatchlist();
                }
            });
        });

        // Bind sortable headers
        document.querySelectorAll('.sortable-header').forEach(header => {
            header.addEventListener('click', () => {
                const column = header.dataset.column;
                if (this.sortColumn === column) {
                    // Toggle direction if same column
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    // Change column and default to ascending
                    this.sortColumn = column;
                    this.sortDirection = 'asc';
                }
                this.renderWatchlist();
            });
        });

        // Update sort icons
        document.querySelectorAll('.sortable-header').forEach(header => {
            const icon = header.querySelector('.sort-icon');
            if (header.dataset.column === this.sortColumn) {
                icon.textContent = this.sortDirection === 'asc' ? '▲' : '▼';
            } else {
                icon.textContent = '⇅';
            }
        });
    }

    async refreshWatchlistData() {
        if (this.isRefreshing) return;
        this.isRefreshing = true;

        const watchlist = this.storage.getWatchlist() || [];
        const now = Date.now();
        const refreshPromises = [];

        for (const item of watchlist) {
            // Check if fetched in the last 5 minutes (300000ms), avoid spamming proxy
            if (item.lastFetched && (now - item.lastFetched) < 300000) {
                continue;
            }

            refreshPromises.push(
                (async () => {
                    try {
                        const url = `${PROXY}?symbol=${encodeURIComponent(item.ticker)}&type=QUOTE_SUMMARY`;
                        const res = await fetch(url);
                        if (!res.ok) throw new Error('API Error');
                        const data = await res.json();
                        
                        const stats = data.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
                        const financial = data.quoteSummary?.result?.[0]?.financialData || {};
                        const detail = data.quoteSummary?.result?.[0]?.summaryDetail || {};
                        const priceData = data.quoteSummary?.result?.[0]?.price || null;
                        const assetProfile = data.quoteSummary?.result?.[0]?.assetProfile || {};
                        const website = assetProfile.website || '';

                        // Calculate score to save it explicitly
                        const totalScore = this.calculateScore(stats, financial, detail);

                        // Enregistrer toutes les données récupérées directement dans le document de la watchlist
                        const updatePayload = {
                            priceData,
                            stats,
                            financial,
                            detail,
                            website,
                            score: totalScore,
                            lastFetched: Date.now()
                        };

                        await this.storage.updateWatchlistData(item.ticker, updatePayload);

                    } catch (e) {
                         logger.error('[Watchlist] Background fetch error for', item.ticker, e);
                    }
                })()
            );
        }

        await Promise.allSettled(refreshPromises);
        this.isRefreshing = false;
    }

    fmt(val, decimals = 2) {
        if (!val || isNaN(val)) return '0.00';
        return Number(val).toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    calculateScore(stats, financial, detail) {
        const roe = (financial.returnOnEquity?.raw ?? 0) * 100;
        const roa = (financial.returnOnAssets?.raw ?? 0) * 100;
        const grossMargin = (financial.grossMargins?.raw ?? 0) * 100;
        const operatingMargin = (financial.operatingMargins?.raw ?? 0) * 100;
        const revenueGrowth = (financial.revenueGrowth?.raw ?? 0) * 100;
        const earningsGrowth = (financial.earningsGrowth?.raw ?? 0) * 100;
        const netMargin = (financial.profitMargins?.raw ?? 0) * 100;
        const currentRatio = financial.currentRatio?.raw ?? 1;
        const debtToEquity = financial.debtToEquity?.raw ?? null;
        const dividendYield = (detail.dividendYield?.raw ?? detail.trailingAnnualDividendYield?.raw ?? 0) * 100;
        const dividendRate = detail.dividendRate?.raw ?? detail.trailingAnnualDividendRate?.raw ?? 0;
        const fiveYearAvgYield = detail.fiveYearAvgDividendYield?.raw
            ? detail.fiveYearAvgDividendYield.raw * 100
            : 0;
        const payoutRatio = detail.payoutRatio?.raw ?? null;
        const hasDividend = dividendRate > 0 || dividendYield > 0 || fiveYearAvgYield > 0;

        const scoreReturns = this.cap(((roe + (roa * 1.4)) / 30) * 5, 0, 5);
        const scoreMargins = this.cap(((grossMargin + operatingMargin + netMargin) / 90) * 5, 0, 5);
        const scoreGrowth = this.cap(((revenueGrowth + earningsGrowth + 15) / 55) * 5, 0, 5);
        const scoreProfitability = this.cap(((netMargin + operatingMargin + roe) / 75) * 5, 0, 5);
        const scoreHealthBase = this.cap((currentRatio / 3) * 3.5, 0, 3.5);
        const debtScore = debtToEquity == null ? 1 : debtToEquity <= 80 ? 1.5 : debtToEquity <= 150 ? 1 : 0.4;
        const scoreHealth = this.cap(scoreHealthBase + debtScore, 0, 5);

        const yieldScore = this.cap((dividendYield / 3) * 2.3, 0, 2.3);
        const historyScore = hasDividend ? 1.2 : 0;
        const avgYieldScore = this.cap((fiveYearAvgYield / 2) * 0.8, 0, 0.8);
        const payoutScore = payoutRatio == null ? 0.5 : (payoutRatio >= 0 && payoutRatio <= 0.7 ? 0.7 : payoutRatio <= 1 ? 0.5 : 0.2);
        const scoreDividend = this.cap(yieldScore + historyScore + avgYieldScore + payoutScore, 0, 5);

        const scores = {
            'Retours sur capitaux': scoreReturns,
            'Marges': scoreMargins,
            'Croissance': scoreGrowth,
            'Rentabilité': scoreProfitability,
            'Dividende': scoreDividend,
            'Santé': scoreHealth,
        };

        const vals = Object.values(scores);
        const totalScore = (vals.reduce((s, v) => s + v, 0) / (Object.keys(scores).length * 5)) * 20;

        return totalScore;
    }

    cap(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
}

// Initialise l'app
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.watchlistApp = new WatchlistApp();
    });
} else {
    window.watchlistApp = new WatchlistApp();
}
