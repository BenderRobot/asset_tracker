// ========================================
// assistantApp.js - AI Portfolio Assistant
// ========================================

import { Storage } from './storage.js';
import { DataManager } from './dataManager.js';
import { PriceAPI } from './api.js';
import { GEMINI_PROXY_URL } from './config.js';

const STORAGE_KEY = 'assistant_conversations_v2';
const LEGACY_KEY = 'assistant_conversation';
const MAX_GEMINI_HISTORY = 20; // 10 tours user+assistant
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONV = 80;
const FIRESTORE_COLLECTION = 'assistantConversations';

/** Formate un nombre (string ou number) pour les prompts / affichage. */
function fmtNum(val, decimals = 1, suffix = '') {
    const n = Number(val);
    if (!Number.isFinite(n)) return 'N/A';
    return `${n.toFixed(decimals)}${suffix}`;
}

function generateId() {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function truncateTitle(text, max = 42) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'Nouvelle conversation';
    return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

const GREETING_ONLY = /^(hello|bonjour|salut|hey|coucou|hi|bonsoir|cc|ça va|ca va|merci|ok|oui|non)[\s!.?]*$/i;

/** Titres trop génériques → à remplacer par un libellé lié au sujet. */
function isWeakTitle(title) {
    if (!title || title === 'Nouvelle conversation') return true;
    const t = title.trim();
    if (GREETING_ONLY.test(t)) return true;
    if (t.length <= 12 && !/\s/.test(t)) return true;
    return false;
}

/** Titre local à partir des messages (tickers portefeuille, formulations courantes). */
function inferTitleLocally(conv, portfolioContext) {
    const userTexts = conv.messages
        .filter(m => m.role === 'user')
        .map(m => (m.content || '').trim())
        .filter(Boolean);

    for (const text of userTexts) {
        if (GREETING_ONLY.test(text)) continue;

        const lower = text.toLowerCase();
        const holdings = portfolioContext?.holdings || [];

        for (const h of holdings) {
            const ticker = (h.ticker || '').toLowerCase();
            const name = (h.name || '').toLowerCase();
            if (
                (ticker.length >= 2 && lower.includes(ticker)) ||
                (name.length >= 4 && lower.includes(name))
            ) {
                return truncateTitle(`${h.name || h.ticker}`);
            }
        }

        const aboutMatch = text.match(
            /(?:parle(?:-moi)?|analyse(?:r)?|avis|qu['']en penses-tu|explique|dis-moi|infos?)\s+(?:de\s+|du\s+|d['']|sur\s+|moi\s+)?(.+)/i
        );
        if (aboutMatch?.[1]) {
            const subject = aboutMatch[1].replace(/[?.!]+$/, '').trim();
            if (subject.length >= 2) return truncateTitle(subject);
        }

        if (text.length >= 12) return truncateTitle(text);
    }

    return null;
}

function formatConvDate(ts) {
    return new Date(ts).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export class AssistantApp {
    constructor() {
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);
        this.portfolioContext = null;
        this.isProcessing = false;
        this.store = this.loadStore();
        this.activeConversationId = this.store.activeId;
    }

    getActiveConversation() {
        return this.store.conversations.find(c => c.id === this.activeConversationId) || null;
    }

    getActiveMessages() {
        const conv = this.getActiveConversation();
        return conv ? conv.messages : [];
    }

    async init() {
        console.log('Assistant IA initialized 🤖');

        await this.preparePortfolioContext();
        this.displayPortfolioSummary();
        this.setupEventListeners();
        this.renderConversationsList();
        this.loadActiveConversationUI();
        this.refreshLegacyConversationTitles();
        // Load from Firestore in background for cross-device sync
        this.loadFromFirestore();
    }

    /** Met à jour les titres faibles des conversations déjà sauvegardées. */
    refreshLegacyConversationTitles() {
        let changed = false;
        for (const conv of this.store.conversations) {
            if (isWeakTitle(conv.title)) {
                const local = inferTitleLocally(conv, this.portfolioContext);
                if (local) {
                    conv.title = local;
                    changed = true;
                }
            }
        }
        if (changed) {
            this.saveStore();
            this.renderConversationsList();
            this.updateActiveTitleUI();
        }
    }

    // ─── Stockage multi-conversations ─────────────────────────────────────

    loadStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed?.conversations?.length) {
                    return {
                        activeId: parsed.activeId || parsed.conversations[0].id,
                        conversations: parsed.conversations
                    };
                }
            }
        } catch (e) {
            console.warn('[Assistant] loadStore failed:', e);
        }
        return this.migrateLegacyOrCreate();
    }

    migrateLegacyOrCreate() {
        try {
            const legacy = localStorage.getItem(LEGACY_KEY);
            if (legacy) {
                const messages = JSON.parse(legacy)
                    .filter(m => m.role === 'user' || m.role === 'assistant')
                    .map(m => ({
                        role: m.role,
                        content: m.content,
                        timestamp: m.timestamp || Date.now()
                    }));
                if (messages.length > 0) {
                    const id = generateId();
                    const firstUser = messages.find(m => m.role === 'user');
                    const conv = {
                        id,
                        title: truncateTitle(firstUser?.content),
                        createdAt: messages[0].timestamp,
                        updatedAt: messages[messages.length - 1].timestamp,
                        messages
                    };
                    localStorage.removeItem(LEGACY_KEY);
                    return { activeId: id, conversations: [conv] };
                }
            }
        } catch (e) {
            console.warn('[Assistant] legacy migration failed:', e);
        }
        const id = generateId();
        return {
            activeId: id,
            conversations: [{
                id,
                title: 'Nouvelle conversation',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: []
            }]
        };
    }

    saveStore() {
        try {
            this.store.conversations = this.store.conversations
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, MAX_CONVERSATIONS);

            this.store.conversations.forEach(conv => {
                if (conv.messages.length > MAX_MESSAGES_PER_CONV) {
                    conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONV);
                }
            });

            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                activeId: this.activeConversationId,
                conversations: this.store.conversations
            }));
        } catch (e) {
            console.error('[Assistant] saveStore failed:', e);
        }
        // Fire-and-forget Firestore sync for the active conversation
        const conv = this.getActiveConversation();
        if (conv) this.saveConvToFirestore(conv);
    }

    // ─── Firestore sync (cross-device) ───────────────────────────────────

    async getUserId() {
        const sync = this.storage.marketDataSync;
        if (sync?.userId) return sync.userId;
        return new Promise(resolve => {
            const unsub = sync?.auth?.onAuthStateChanged(u => {
                unsub();
                resolve(u ? u.uid : null);
            });
            setTimeout(() => resolve(null), 2000);
        });
    }

    async getConvsCollection() {
        if (this._firestoreCol) return this._firestoreCol;
        const uid = await this.getUserId();
        if (!uid) return null;
        const db = this.storage.marketDataSync?.db;
        if (!db) return null;
        this._firestoreCol = db.collection('users').doc(uid).collection(FIRESTORE_COLLECTION);
        return this._firestoreCol;
    }

    async loadFromFirestore() {
        try {
            const col = await this.getConvsCollection();
            if (!col) return;

            const snapshot = await col.get();

            // Separate tombstones (deleted) from real conversations
            const remoteMap = new Map();
            const deletedIds = new Set();
            snapshot.forEach(doc => {
                const data = doc.data();
                if (!data?.id) return;
                if (data.deleted) deletedIds.add(data.id);
                else remoteMap.set(data.id, data);
            });

            // Bidirectional merge
            const merged = new Map();
            const toUpload = [];
            let localNeedsUpdate = false;

            for (const local of this.store.conversations) {
                if (deletedIds.has(local.id)) {
                    // Was deleted on another device → remove locally
                    localNeedsUpdate = true;
                    continue;
                }
                const remote = remoteMap.get(local.id);
                if (!remote || local.updatedAt > remote.updatedAt) {
                    // Local is newer or new → keep, schedule upload
                    merged.set(local.id, local);
                    toUpload.push(local);
                } else if (remote.updatedAt > local.updatedAt) {
                    // Remote is newer → use remote
                    merged.set(local.id, remote);
                    localNeedsUpdate = true;
                } else {
                    merged.set(local.id, local);
                }
            }

            // Pull in remote conversations not present locally
            for (const [id, remote] of remoteMap) {
                if (!merged.has(id)) {
                    merged.set(id, remote);
                    localNeedsUpdate = true;
                }
            }

            // Upload local-only or locally-newer conversations
            if (toUpload.length > 0) {
                await Promise.all(toUpload.map(c => this.saveConvToFirestore(c)));
            }

            if (!localNeedsUpdate) return;

            this.store.conversations = [...merged.values()]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, MAX_CONVERSATIONS);

            if (!this.store.conversations.find(c => c.id === this.activeConversationId)) {
                this.activeConversationId = this.store.conversations[0]?.id;
                this.store.activeId = this.activeConversationId;
            }

            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                activeId: this.activeConversationId,
                conversations: this.store.conversations
            }));

            this.renderConversationsList();
            this.loadActiveConversationUI();
        } catch (e) {
            console.warn('[Assistant] loadFromFirestore failed:', e);
        }
    }

    async saveConvToFirestore(conv) {
        if (!conv) return;
        try {
            const col = await this.getConvsCollection();
            if (!col) return;
            await col.doc(conv.id).set({
                id: conv.id,
                title: conv.title,
                messages: conv.messages,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                titleAutoGenerated: conv.titleAutoGenerated || false
            });
        } catch (e) {
            console.warn('[Assistant] saveConvToFirestore failed:', e);
        }
    }

    async deleteConvFromFirestore(id) {
        try {
            const col = await this.getConvsCollection();
            if (!col) return;
            // Write a tombstone instead of hard-deleting so other devices detect the deletion
            await col.doc(id).set({ id, deleted: true, deletedAt: Date.now() });
        } catch (e) {
            console.warn('[Assistant] deleteConvFromFirestore failed:', e);
        }
    }

    createConversation() {
        this.saveCurrentConversation();

        const id = generateId();
        const conv = {
            id,
            title: 'Nouvelle conversation',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: []
        };
        this.store.conversations.unshift(conv);
        this.activeConversationId = id;
        this.store.activeId = id;
        this.saveStore();
        this.renderConversationsList();
        this.loadActiveConversationUI();
        this.closePanel();
    }

    switchConversation(id) {
        if (id === this.activeConversationId) return;
        this.saveCurrentConversation();
        this.activeConversationId = id;
        this.store.activeId = id;
        this.saveStore();
        this.renderConversationsList();
        this.loadActiveConversationUI();
        const conv = this.getActiveConversation();
        if (conv && isWeakTitle(conv.title)) {
            this.refreshConversationTitle(conv, { requestGemini: true });
        }
        this.closePanel();
    }

    deleteConversation(id, e) {
        if (e) e.stopPropagation();
        if (!confirm('Supprimer cette conversation ?')) return;

        this.store.conversations = this.store.conversations.filter(c => c.id !== id);
        this.deleteConvFromFirestore(id);

        if (this.store.conversations.length === 0) {
            const newId = generateId();
            this.store.conversations.push({
                id: newId,
                title: 'Nouvelle conversation',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: []
            });
            this.activeConversationId = newId;
        } else if (this.activeConversationId === id) {
            this.activeConversationId = this.store.conversations[0].id;
        }

        this.store.activeId = this.activeConversationId;
        this.saveStore();
        this.renderConversationsList();
        this.loadActiveConversationUI();
    }

    saveCurrentConversation() {
        const conv = this.getActiveConversation();
        if (!conv) return;
        conv.updatedAt = Date.now();
    }

    refreshConversationTitle(conv, { requestGemini = false } = {}) {
        if (!conv) return;

        const local = inferTitleLocally(conv, this.portfolioContext);
        if (local && isWeakTitle(conv.title)) {
            conv.title = local;
            this.renderConversationsList();
            this.updateActiveTitleUI();
        }

        const hasValidAssistant = conv.messages.some(
            m => m.role === 'assistant' && m.content && !m.content.startsWith('❌')
        );
        const userCount = conv.messages.filter(m => m.role === 'user').length;

        if (requestGemini && hasValidAssistant && userCount >= 1 && !conv._titleRefreshing) {
            this.generateTitleWithGemini(conv);
        }
    }

    async generateTitleWithGemini(conv) {
        if (conv._titleRefreshing || conv.messages.length < 2) return;
        conv._titleRefreshing = true;

        const excerpt = conv.messages
            .slice(0, 6)
            .map(m => {
                const label = m.role === 'user' ? 'Utilisateur' : 'Assistant';
                const text = (m.content || '').replace(/\s+/g, ' ').slice(0, 280);
                return `${label}: ${text}`;
            })
            .join('\n');

        const prompt = `Tu dois créer un titre court (maximum 8 mots) en français pour une conversation entre un investisseur et son assistant portfolio.

Règles:
- Résume le SUJET principal (société, actif, thème : diversification, risque, performance, etc.)
- Pas de guillemets, pas de point final, pas d'emoji
- Exemples: "Analyse Soitec et secteur", "Diversification du portefeuille", "Performance Bitcoin"

Conversation:
${excerpt}

Titre:`;

        try {
            const response = await fetch(GEMINI_PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, enableWebSearch: false })
            });

            if (!response.ok) return;

            const data = await response.json();
            let raw = (data.text || '').trim();
            if (!raw) return;

            raw = raw
                .replace(/^["'«]|["'»]$/g, '')
                .replace(/^titre\s*:\s*/i, '')
                .replace(/\n.*/s, '')
                .trim();

            if (raw.length >= 3) {
                const stored = this.store.conversations.find(c => c.id === conv.id);
                if (stored) {
                    stored.title = truncateTitle(raw, 48);
                    stored.titleAutoGenerated = true;
                    this.saveStore();
                    this.renderConversationsList();
                    if (conv.id === this.activeConversationId) {
                        this.updateActiveTitleUI();
                    }
                }
            }
        } catch (e) {
            console.warn('[Assistant] Title generation failed:', e);
        } finally {
            conv._titleRefreshing = false;
        }
    }

    updateActiveTitleUI() {
        const el = document.getElementById('active-conversation-title');
        const conv = this.getActiveConversation();
        if (el && conv) el.textContent = conv.title;
    }

    renderConversationsList() {
        const list = document.getElementById('conversations-list');
        if (!list) return;

        if (this.store.conversations.length === 0) {
            list.innerHTML = '<li class="conv-empty">Aucune conversation</li>';
            return;
        }

        const sorted = [...this.store.conversations].sort((a, b) => b.updatedAt - a.updatedAt);

        list.innerHTML = sorted.map(conv => {
            const isActive = conv.id === this.activeConversationId;
            const preview = conv.messages.length
                ? `${conv.messages.length} message${conv.messages.length > 1 ? 's' : ''}`
                : 'Vide';
            return `
                <li class="conv-item ${isActive ? 'active' : ''}" data-id="${conv.id}">
                    <button type="button" class="conv-item-btn" data-id="${conv.id}">
                        <span class="conv-item-title">${this.escapeHtml(conv.title)}</span>
                        <span class="conv-item-date">${formatConvDate(conv.updatedAt)} · ${preview}</span>
                    </button>
                    <button type="button" class="conv-item-delete" data-id="${conv.id}" title="Supprimer" aria-label="Supprimer">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </li>
            `;
        }).join('');

        list.querySelectorAll('.conv-item-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchConversation(btn.dataset.id));
        });
        list.querySelectorAll('.conv-item-delete').forEach(btn => {
            btn.addEventListener('click', (e) => this.deleteConversation(btn.dataset.id, e));
        });
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── Portfolio context ────────────────────────────────────────────────

    async preparePortfolioContext() {
        try {
            const purchases = this.storage.getPurchases();
            const assetPurchases = purchases.filter(p => {
                const type = (p.assetType || 'Stock').toLowerCase();
                return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
            });

            const holdings = this.dataManager.calculateHoldings(assetPurchases);
            const summary = this.dataManager.calculateSummary(holdings);
            const performance = this.dataManager.analyzePerformance(holdings);
            const diversification = this.dataManager.calculateDiversification(holdings);
            const risk = this.dataManager.calculateRisk(holdings);

            const byType = {};
            holdings.forEach(h => {
                const type = h.assetType || 'Stock';
                if (!byType[type]) byType[type] = [];
                byType[type].push(h);
            });

            const byBroker = {};
            assetPurchases.forEach(p => {
                const broker = p.broker || 'Non spécifié';
                if (!byBroker[broker]) {
                    byBroker[broker] = { count: 0, totalInvested: 0, assets: new Set() };
                }
                byBroker[broker].count++;
                byBroker[broker].totalInvested += (p.price * p.quantity);
                byBroker[broker].assets.add(p.ticker);
            });

            const primaryResidence = this.storage.getPrimaryResidence();

            // Try to get accurate varToday from Firestore liveMetrics (computed by chart with yesterdayCloseMap)
            let accurateDayChange = summary.totalDayChangeEUR;
            let accurateDayChangePct = summary.dayChangePct;
            try {
                const sync = this.storage.marketDataSync;
                // Wait up to 1.5s for auth to resolve if not ready
                const userId = sync.userId || await new Promise(resolve => {
                    const unsub = sync.auth.onAuthStateChanged(u => { unsub(); resolve(u ? u.uid : null); });
                    setTimeout(() => resolve(null), 1500);
                });
                if (userId && sync.db) {
                    const doc = await sync.db.collection('users').doc(userId)
                        .collection('liveMetrics').doc('current').get();
                    if (doc.exists) {
                        const live = doc.data();
                        if (typeof live.varToday === 'number' && live.varToday !== 0) {
                            accurateDayChange = live.varToday;
                            const totalYesterday = summary.totalCurrentEUR - live.varToday;
                            accurateDayChangePct = totalYesterday > 0
                                ? (live.varToday / totalYesterday) * 100 : 0;
                        }
                    }
                }
            } catch (e) {
                console.warn('[Assistant] Could not load liveMetrics:', e);
            }

            this.portfolioContext = {
                summary: {
                    totalValue: summary.totalCurrentEUR,
                    totalInvested: summary.totalInvestedEUR,
                    totalGain: summary.gainTotal,
                    gainPercentage: summary.gainPct,
                    dayChange: accurateDayChange,
                    dayChangePercentage: accurateDayChangePct,
                    assetsCount: holdings.length,
                    transactionsCount: assetPurchases.length
                },
                holdings: holdings.map(h => {
                    const assetTransactions = assetPurchases.filter(p => p.ticker === h.ticker);
                    const brokers = [...new Set(assetTransactions.map(p => p.broker || 'Non spécifié'))];
                    const firstPurchaseDate = assetTransactions.reduce((earliest, p) =>
                        new Date(p.date) < new Date(earliest) ? p.date : earliest,
                        assetTransactions[0].date
                    );
                    const lastPurchaseDate = assetTransactions.reduce((latest, p) =>
                        new Date(p.date) > new Date(latest) ? p.date : latest,
                        assetTransactions[0].date
                    );

                    return {
                        ticker: h.ticker,
                        name: h.name,
                        type: h.assetType,
                        brokers: brokers.join(', '),
                        quantity: h.quantity,
                        avgPrice: Math.round(h.avgPrice * 100) / 100,
                        currentPrice: Math.round(h.currentPrice * 100) / 100,
                        currentValue: Math.round(h.currentValue),
                        invested: Math.round(h.invested),
                        gainEUR: Math.round(h.gainEUR),
                        gainPct: Math.round(h.gainPct * 10) / 10,
                        dayChange: Math.round(h.dayChange),
                        dayPct: Math.round((h.dayPct || 0) * 10) / 10,
                        weight: Math.round(h.weight * 10) / 10,
                        transactionsCount: assetTransactions.length,
                        firstPurchase: firstPurchaseDate,
                        lastPurchase: lastPurchaseDate,
                        transactions: assetTransactions.map(t => ({
                            date: t.date,
                            quantity: t.quantity,
                            price: Math.round(t.price * 100) / 100,
                            broker: t.broker || 'Non spécifié',
                            amount: Math.round(t.price * t.quantity)
                        }))
                    };
                }).sort((a, b) => b.currentValue - a.currentValue),
                byType: Object.keys(byType).map(type => ({
                    type,
                    count: byType[type].length,
                    totalValue: Math.round(byType[type].reduce((sum, h) => sum + h.currentValue, 0)),
                    weight: Math.round(byType[type].reduce((sum, h) => sum + h.weight, 0) * 10) / 10
                })),
                byBroker: Object.keys(byBroker).map(broker => ({
                    broker,
                    assetsCount: byBroker[broker].assets.size,
                    transactionsCount: byBroker[broker].count,
                    totalInvested: Math.round(byBroker[broker].totalInvested),
                    assets: [...byBroker[broker].assets]
                })),
                performance: {
                    topPerformers: performance.topPerformers.slice(0, 3).map(p => ({
                        ticker: p.ticker,
                        name: p.name,
                        gainPct: Math.round(p.gainPct * 10) / 10
                    })),
                    worstPerformers: performance.worstPerformers.slice(0, 3).map(p => ({
                        ticker: p.ticker,
                        name: p.name,
                        gainPct: Math.round(p.gainPct * 10) / 10
                    })),
                    avgGain: Number(performance.avgGain),
                    winRate: Number(performance.winRate)
                },
                diversification: {
                    diversityScore: diversification.diversityScore,
                    effectiveAssets: diversification.effectiveAssets,
                    recommendation: diversification.recommendation
                },
                risk: {
                    volatility: risk.volatility,
                    riskLevel: risk.riskLevel
                },
                primaryResidence: primaryResidence ? {
                    name: primaryResidence.name,
                    purchasePrice: primaryResidence.purchasePrice,
                    currentValue: primaryResidence.currentValue,
                    purchaseDate: primaryResidence.purchaseDate,
                    creditsCount: primaryResidence.credits?.length || 0,
                    totalDebt: primaryResidence.credits ? Math.round(
                        primaryResidence.credits.reduce((sum, c) => sum + c.initialAmount, 0)
                    ) : 0,
                    equity: primaryResidence.currentValue - (primaryResidence.credits ?
                        primaryResidence.credits.reduce((sum, c) => sum + c.initialAmount, 0) : 0)
                } : null
            };
        } catch (error) {
            console.error('[Assistant] Error preparing context:', error);
        }
    }

    displayPortfolioSummary() {
        if (!this.portfolioContext) return;

        const formatEUR = (val) => new Intl.NumberFormat('fr-FR', {
            style: 'currency',
            currency: 'EUR',
            minimumFractionDigits: 0
        }).format(val);

        const formatPct = (val) => {
            const sign = val >= 0 ? '+' : '';
            return `${sign}${val.toFixed(2)}%`;
        };

        document.getElementById('total-value').textContent = formatEUR(this.portfolioContext.summary.totalValue);

        const returnEl = document.getElementById('total-return');
        returnEl.textContent = `${formatEUR(this.portfolioContext.summary.totalGain)} (${formatPct(this.portfolioContext.summary.gainPercentage)})`;
        returnEl.style.color = this.portfolioContext.summary.totalGain >= 0 ? '#10b981' : '#ef4444';

        const dayEl = document.getElementById('day-change');
        dayEl.textContent = `${formatEUR(this.portfolioContext.summary.dayChange)} (${formatPct(this.portfolioContext.summary.dayChangePercentage)})`;
        dayEl.style.color = this.portfolioContext.summary.dayChange >= 0 ? '#10b981' : '#ef4444';

        document.getElementById('total-assets').textContent = this.portfolioContext.summary.assetsCount;
    }

    // ─── Chat & Gemini ────────────────────────────────────────────────────

    buildGeminiHistory(excludeLastUser = true) {
        let msgs = this.getActiveMessages()
            .filter(m => m.role === 'user' || m.role === 'assistant');

        if (excludeLastUser && msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
            msgs = msgs.slice(0, -1);
        }

        return msgs
            .slice(-MAX_GEMINI_HISTORY)
            .map(m => ({ role: m.role, text: m.content }));
    }

    async sendMessage(userMessage) {
        if (!userMessage.trim() || this.isProcessing) return;

        this.isProcessing = true;
        this.setSendDisabled(true);

        this.persistMessage('user', userMessage);
        this.appendMessageUI('user', userMessage);
        this.refreshConversationTitle(this.getActiveConversation(), { requestGemini: false });
        this.renderConversationsList();
        this.updateActiveTitleUI();

        const typingId = this.showTypingIndicator();

        try {
            let systemPrompt;
            try {
                systemPrompt = this.buildSystemPrompt();
            } catch (promptErr) {
                throw new Error(`Erreur préparation du contexte: ${promptErr.message}`);
            }
            const recentHistory = this.buildGeminiHistory(true);

            const response = await fetch(GEMINI_PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system: systemPrompt,
                    history: recentHistory,
                    message: userMessage,
                    enableWebSearch: true
                })
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                throw new Error(`Proxy Error ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
            }

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            let aiResponse;
            if (data.text) {
                aiResponse = data.text;
            } else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = data.candidates[0].content.parts[0].text;
            } else {
                throw new Error('Réponse proxy invalide (champ text manquant)');
            }

            this.hideTypingIndicator(typingId);
            this.persistMessage('assistant', aiResponse);
            this.appendMessageUI('assistant', aiResponse);
            this.saveCurrentConversation();
            const conv = this.getActiveConversation();
            this.refreshConversationTitle(conv, { requestGemini: !conv?.titleAutoGenerated });
            this.saveStore();
            this.renderConversationsList();
            this.updateActiveTitleUI();

        } catch (error) {
            console.error('Error calling Gemini proxy:', error);
            this.hideTypingIndicator(typingId);
            const hint = error?.message?.includes('Proxy') ? `\n\n_Détail : ${error.message}_` : '';
            this.persistMessage('assistant', `❌ Une erreur s'est produite. Peux-tu réessayer ?${hint}`);
            this.appendMessageUI('assistant', `❌ Une erreur s'est produite. Peux-tu réessayer ?${hint}`, true);
            this.saveStore();
        } finally {
            this.isProcessing = false;
            this.setSendDisabled(false);
        }
    }

    buildSystemPrompt() {
        if (!this.portfolioContext) return 'Tu es un assistant financier expert.';

        const ctx = this.portfolioContext;
        const s = ctx.summary;
        const conv = this.getActiveConversation();
        const msgCount = conv?.messages?.length || 0;

        const holdingsText = ctx.holdings.map(h =>
            `- ${h.ticker} (${h.name}): ${h.quantity} unités, PRU=${h.avgPrice}€, valeur=${h.currentValue}€, gain=${h.gainEUR}€ (${h.gainPct}%), poids=${h.weight}%, brokers=${h.brokers}, 1ère achat=${h.firstPurchase}, dernier achat=${h.lastPurchase}`
        ).join('\n');

        const typesText = ctx.byType.map(t =>
            `- ${t.type}: ${t.count} actifs, ${t.totalValue}€ (${t.weight}%)`
        ).join('\n');

        const brokersText = ctx.byBroker.map(b =>
            `- ${b.broker}: ${b.assetsCount} actifs, ${b.totalInvested}€ investi`
        ).join('\n');

        const residence = ctx.primaryResidence
            ? `Résidence principale: ${ctx.primaryResidence.name}, achetée ${ctx.primaryResidence.purchaseDate}, valeur=${ctx.primaryResidence.currentValue}€, dette=${ctx.primaryResidence.totalDebt}€, équité=${ctx.primaryResidence.equity}€`
            : 'Aucune résidence principale enregistrée.';

        const continuityNote = msgCount > 0
            ? `\n=== CONTINUITÉ DE CONVERSATION ===\nCette conversation a déjà ${msgCount} messages échangés. L'historique précédent t'est fourni : reprends le fil naturellement, ne redis pas "bonjour" ni ne répète une analyse déjà faite sauf si l'utilisateur le demande.\n`
            : '';

        return `Tu es un conseiller financier expert et bienveillant pour Asset Tracker.
Tu as accès à Google Search : utilise-le pour enrichir tes réponses (actualités, contexte marché, secteur, concurrents, résultats récents, valorisation publique).
Tu dois répondre en français, de manière concise, avec des émojis et des bullet points.
${continuityNote}
=== RÈGLES DE RÉPONSE ===
1. PORTEFEUILLE (prioritaire) : PRU, quantités, gains, brokers, dates → uniquement les données ci-dessous. Ne jamais inventer une position.
2. MARCHÉ / ANALYSE : si l'utilisateur demande une analyse, des news, le secteur, les perspectives ou "parle-moi de [société]" → complète avec une recherche web récente, puis croise avec sa position s'il la détient.
3. Si l'actif n'est PAS dans le portefeuille : donne une analyse marché via le web et précise qu'il ne détient pas cette ligne.
4. Cite tes sources web quand tu t'appuies sur des faits récents (titres d'articles ou sites). Ne mentionne jamais "contexte JSON" ou "prompt système".
5. Ce n'est pas un conseil en investissement réglementé : rappelle-le brièvement si tu donnes une opinion.

=== PORTEFEUILLE DU CLIENT ===
Valeur totale: ${s.totalValue}€
Investi: ${s.totalInvested}€
Gain total: ${s.totalGain}€ (${fmtNum(s.gainPercentage, 1, '%')})
Variation du jour: ${s.dayChange}€ (${fmtNum(s.dayChangePercentage, 2, '%')})
Nombre d'actifs: ${s.assetsCount}

=== POSITIONS ===
${holdingsText}

=== PAR TYPE ===
${typesText}

=== PAR COURTIER ===
${brokersText}

=== PERFORMANCE ===
Meilleurs actifs: ${ctx.performance.topPerformers.map(p => `${p.ticker} (+${p.gainPct}%)`).join(', ')}
Pires actifs: ${ctx.performance.worstPerformers.map(p => `${p.ticker} (${p.gainPct}%)`).join(', ')}
Gain moyen: ${fmtNum(ctx.performance.avgGain, 1, '%')}
Taux de réussite: ${fmtNum(ctx.performance.winRate, 0, '%')}

=== DIVERSIFICATION ===
Score: ${ctx.diversification.diversityScore}/100
Actifs effectifs: ${ctx.diversification.effectiveAssets}
Recommandation: ${ctx.diversification.recommendation}

=== IMMOBILIER ===
${residence}`;
    }

    persistMessage(role, content) {
        const conv = this.getActiveConversation();
        if (!conv) return;
        conv.messages.push({ role, content, timestamp: Date.now() });
        conv.updatedAt = Date.now();
    }

    loadActiveConversationUI() {
        const messages = this.getActiveMessages();
        const container = document.getElementById('chat-messages');
        if (!container) return;

        container.innerHTML = '';

        if (messages.length === 0) {
            this.showWelcome(container);
        } else {
            messages.forEach(msg => this.appendMessageUI(msg.role, msg.content, false));
        }

        container.scrollTop = container.scrollHeight;
        this.updateActiveTitleUI();
    }

    showWelcome(container = document.getElementById('chat-messages')) {
        if (!container) return;
        container.innerHTML = `
            <div class="welcome-message">
                <h2>👋 Bonjour ! Je suis ton assistant portfolio</h2>
                <p>J'ai accès à toutes tes données d'investissement et je peux t'aider à :</p>
                <div class="suggestions">
                    <button type="button" class="suggestion-btn">Analyser ma diversification</button>
                    <button type="button" class="suggestion-btn">Optimiser mes positions</button>
                    <button type="button" class="suggestion-btn">Expliquer mes performances</button>
                    <button type="button" class="suggestion-btn">Comparer mes meilleurs actifs</button>
                    <button type="button" class="suggestion-btn">Évaluer mon risque</button>
                </div>
                <p style="margin-top: 20px; font-size: 14px; color: var(--text-muted);">
                    💡 <strong>Astuce :</strong> Utilise « Nouvelle » pour démarrer un sujet, ou reprends une conversation dans le menu à gauche.
                </p>
            </div>
        `;
        this.bindSuggestionButtons(container);
    }

    bindSuggestionButtons(root = document) {
        root.querySelectorAll('.suggestion-btn').forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });
        root.querySelectorAll('.suggestion-btn').forEach(btn => {
            btn.addEventListener('click', () => this.sendMessage(btn.textContent));
        });
    }

    appendMessageUI(role, content, scroll = true) {
        const messagesContainer = document.getElementById('chat-messages');
        const welcome = messagesContainer?.querySelector('.welcome-message');
        if (welcome) welcome.remove();

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}-message${content.startsWith('❌') ? ' error-message' : ''}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.innerHTML = role === 'user' ? '👤' : '🤖';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = this.formatMessage(content);

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        messagesContainer.appendChild(messageDiv);

        if (scroll) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    formatMessage(text) {
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
    }

    showTypingIndicator() {
        const messagesContainer = document.getElementById('chat-messages');
        const typingDiv = document.createElement('div');
        const id = 'typing-' + Date.now();
        typingDiv.id = id;
        typingDiv.className = 'message assistant-message typing-indicator';
        typingDiv.innerHTML = `
            <div class="message-avatar">🤖</div>
            <div class="message-content">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;
        messagesContainer.appendChild(typingDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        return id;
    }

    hideTypingIndicator(id) {
        const indicator = document.getElementById(id);
        if (indicator) indicator.remove();
    }

    setSendDisabled(disabled) {
        const btn = document.getElementById('send-btn');
        const input = document.getElementById('user-input');
        if (btn) btn.disabled = disabled;
        if (input) input.disabled = disabled;
    }

    closePanel() {
        document.getElementById('conversations-panel')?.classList.remove('open');
        document.getElementById('toggle-conv-panel')?.classList.remove('open');
    }

    openPanel() {
        document.getElementById('conversations-panel')?.classList.add('open');
        document.getElementById('toggle-conv-panel')?.classList.add('open');
    }

    setupEventListeners() {
        const sendBtn = document.getElementById('send-btn');
        const input = document.getElementById('user-input');

        sendBtn?.addEventListener('click', () => {
            this.sendMessage(input.value);
            input.value = '';
            input.style.height = 'auto';
        });

        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage(input.value);
                input.value = '';
                input.style.height = 'auto';
            }
        });

        input?.addEventListener('input', (e) => {
            e.target.style.height = 'auto';
            e.target.style.height = (e.target.scrollHeight) + 'px';
        });

        document.getElementById('new-conversation-btn')?.addEventListener('click', () => {
            this.createConversation();
        });

        document.getElementById('toggle-conv-panel')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const panel = document.getElementById('conversations-panel');
            if (panel?.classList.contains('open')) {
                this.closePanel();
            } else {
                this.openPanel();
            }
        });

        // Close dropdown when clicking outside the trigger wrapper
        document.addEventListener('click', (e) => {
            const wrap = document.getElementById('conv-trigger-wrap');
            if (wrap && !wrap.contains(e.target)) {
                this.closePanel();
            }
        });

        this.bindSuggestionButtons();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new AssistantApp();
    app.init();
});
