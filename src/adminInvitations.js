import { auth, db } from './firebaseConfig.js';

// ── n8n Webhook ───────────────────────────────────────────────────────────
// Colle l'URL de ton webhook n8n ici (Webhook node → "Test URL" ou "Production URL")
const N8N_WEBHOOK_URL = 'https://n8n.asset-tracker.fr/webhook/75994465-3031-4972-bfd8-3575326885b5';
// Secret partagé : même valeur dans n8n (Header Auth ou champ dans le body)
const N8N_SECRET = 'CHANGE_ME';

const MODULES = [
    { id: 'dashboard',     label: 'Dashboard',     icon: '🚀' },
    { id: 'assets',        label: 'Assets',         icon: '📈' },
    { id: 'transactions',  label: 'Transactions',   icon: '📋' },
    { id: 'analytics',     label: 'Analytics',      icon: '📊' },
    { id: 'watchlist',     label: 'Watchlist',      icon: '👁️' },
    { id: 'screener',      label: 'Screener',       icon: '🔍' },
    { id: 'news',          label: 'News',            icon: '📰' },
    { id: 'realestate',    label: 'Immobilier',     icon: '🏢' },
    { id: 'assistant',     label: 'Assistant IA',   icon: '🤖' },
];

function defaultModules() {
    return Object.fromEntries(MODULES.map(m => [m.id, true]));
}

// ── Auth guard ────────────────────────────────────────────────────────────

auth.onAuthStateChanged(async user => {
    if (!user) {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#ef4444;font-family:Inter,sans-serif;font-size:16px;">Accès non autorisé.</div>';
        return;
    }
    try {
        const snap = await db.collection('users').doc(user.uid).get();
        if (!snap.exists || snap.data().isAdmin !== true) {
            document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#ef4444;font-family:Inter,sans-serif;font-size:16px;">Accès non autorisé.</div>';
            return;
        }
    } catch (e) {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#ef4444;font-family:Inter,sans-serif;font-size:16px;">Accès non autorisé.</div>';
        return;
    }
    init();
});

function init() {
    setupTabs();
    setupGenerateBtn();
    setupEmailModal();
    loadCodes();
    loadUsers();
    loadStats();
}

// ── Tabs ──────────────────────────────────────────────────────────────────

function setupTabs() {
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        });
    });
}

// ── Invitation codes ──────────────────────────────────────────────────────

function generateRandomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `INV-${rand(4)}-${rand(4)}`;
}

// ── Module selection modal ────────────────────────────────────────────────

const BASIC_MODULES  = ['dashboard', 'assets', 'transactions'];
const FULL_MODULES   = MODULES.map(m => m.id);

function buildModalGrid() {
    const grid = document.getElementById('gen-modules-grid');
    if (!grid) return;
    // Default: basic preset
    grid.innerHTML = MODULES.map(m => {
        const on = BASIC_MODULES.includes(m.id);
        return `<span class="modal-module-chip ${on ? 'on' : 'off'}" data-mod="${m.id}">
                    <span class="dot"></span>${m.icon} ${m.label}
                </span>`;
    }).join('');

    grid.querySelectorAll('.modal-module-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            chip.classList.toggle('on');
            chip.classList.toggle('off');
            // Mark preset as custom
            document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.preset-btn[data-preset="custom"]')?.classList.add('active');
        });
    });
}

function applyPreset(preset) {
    const grid = document.getElementById('gen-modules-grid');
    if (!grid) return;
    const enabledIds = preset === 'full' ? FULL_MODULES : BASIC_MODULES;
    grid.querySelectorAll('.modal-module-chip').forEach(chip => {
        const on = enabledIds.includes(chip.dataset.mod);
        chip.classList.toggle('on', on);
        chip.classList.toggle('off', !on);
    });
}

function getModalModules() {
    const grid = document.getElementById('gen-modules-grid');
    const result = {};
    grid?.querySelectorAll('.modal-module-chip').forEach(chip => {
        result[chip.dataset.mod] = chip.classList.contains('on');
    });
    return result;
}

function openGenModal() {
    buildModalGrid();
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.preset-btn[data-preset="basic"]')?.classList.add('active');
    applyPreset('basic');
    const overlay = document.getElementById('gen-modal-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.style.opacity = '1';
    overlay.style.visibility = 'visible';
}

function closeGenModal() {
    const overlay = document.getElementById('gen-modal-overlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.style.opacity = '';
    overlay.style.visibility = '';
}

function setupGenerateBtn() {
    document.getElementById('generate-code-btn')?.addEventListener('click', openGenModal);
    document.getElementById('gen-modal-cancel')?.addEventListener('click', closeGenModal);

    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (btn.dataset.preset !== 'custom') applyPreset(btn.dataset.preset);
        });
    });

    // Confirm generation
    document.getElementById('gen-modal-confirm')?.addEventListener('click', async () => {
        const confirmBtn = document.getElementById('gen-modal-confirm');
        confirmBtn.disabled = true;
        const code = generateRandomCode();
        const modules = getModalModules();
        try {
            await db.collection('invitationCodes').doc(code).set({
                code,
                createdAt: Date.now(),
                createdBy: auth.currentUser.email,
                status: 'available',
                modules,
                usedBy: null,
                usedAt: null,
                expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
            });
            await navigator.clipboard.writeText(code).catch(() => {});
            closeGenModal();
            showToast(`Code généré : ${code} — copié !`);
            loadCodes();
            loadStats();
        } catch (err) {
            showToast('Erreur : ' + err.message, true);
        } finally {
            confirmBtn.disabled = false;
        }
    });

    // Close on overlay click
    document.getElementById('gen-modal-overlay')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('gen-modal-overlay')) closeGenModal();
    });
}

async function loadCodes() {
    const container = document.getElementById('codes-list');
    try {
        const snap = await db.collection('invitationCodes').orderBy('createdAt', 'desc').get();
        if (snap.empty) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-ticket-alt"></i><p>Aucun code d\'invitation.</p></div>';
            return;
        }
        container.innerHTML = snap.docs.map(doc => {
            const d = doc.data();
            const expired = d.expiresAt && Date.now() > d.expiresAt;
            const statusKey = expired ? 'expired' : d.status;
            const statusLabel = { available: 'Disponible', used: 'Utilisé', expired: 'Expiré' }[statusKey] || statusKey;
            const badgeClass = { available: 'badge-available', used: 'badge-used', expired: 'badge-expired' }[statusKey];
            const usedInfo = d.usedBy
                ? `Utilisé par <strong>${d.usedBy}</strong> le ${new Date(d.usedAt).toLocaleDateString('fr-FR')}`
                : `Expire le ${new Date(d.expiresAt).toLocaleDateString('fr-FR')}`;
            const modCount = d.modules ? Object.values(d.modules).filter(Boolean).length : MODULES.length;
            const modLabel = `${modCount}/${MODULES.length} module${modCount > 1 ? 's' : ''}`;
            return `
                <div class="code-item">
                    <div style="flex:1;min-width:0;">
                        <div class="code-value">${d.code}</div>
                        <div class="code-meta">${usedInfo} · <span style="color:var(--accent-blue)">${modLabel}</span></div>
                    </div>
                    <span class="status-badge ${badgeClass}">${statusLabel}</span>
                    ${statusKey === 'available' ? `<button class="btn-icon" onclick="openSendModal('${d.code}')" title="Envoyer par email"><i class="fas fa-envelope"></i></button>` : ''}
                    <button class="btn-icon" onclick="copyCode('${d.code}')" title="Copier"><i class="fas fa-copy"></i></button>
                    <button class="btn-icon danger" onclick="deleteCode('${doc.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
                </div>`;
        }).join('');
    } catch (err) {
        container.innerHTML = `<p style="color:var(--accent-red)">Erreur : ${err.message}</p>`;
    }
}

window.copyCode = (code) => {
    navigator.clipboard.writeText(code).catch(() => {});
    showToast(`Code copié : ${code}`);
};

window.deleteCode = async (id) => {
    if (!confirm('Supprimer ce code ?')) return;
    try {
        await db.collection('invitationCodes').doc(id).delete();
        showToast('Code supprimé.');
        loadCodes();
        loadStats();
    } catch (err) {
        showToast('Erreur : ' + err.message, true);
    }
};

// ── Email via n8n webhook ─────────────────────────────────────────────────

function openEmailModal(code) {
    document.getElementById('email-modal-code').textContent = code;
    document.getElementById('email-modal-input').value = '';
    const overlay = document.getElementById('email-modal-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.style.opacity = '1';
    overlay.style.visibility = 'visible';
    setTimeout(() => document.getElementById('email-modal-input')?.focus(), 50);
}

function closeEmailModal() {
    const overlay = document.getElementById('email-modal-overlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.style.opacity = '';
    overlay.style.visibility = '';
}

async function sendViaWebhook(recipientEmail, code) {
    const res = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': N8N_SECRET,
        },
        body: JSON.stringify({ recipientEmail, invitationCode: code }),
    });
    if (!res.ok) throw new Error(`Webhook erreur ${res.status}`);
}

function setupEmailModal() {
    document.getElementById('email-modal-cancel')?.addEventListener('click', closeEmailModal);

    document.getElementById('email-modal-overlay')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('email-modal-overlay')) closeEmailModal();
    });

    // Envoi au Enter dans le champ
    document.getElementById('email-modal-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('email-modal-confirm')?.click();
    });

    document.getElementById('email-modal-confirm')?.addEventListener('click', async () => {
        const email = document.getElementById('email-modal-input').value.trim();
        const code = document.getElementById('email-modal-code').textContent;

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            showToast('Email invalide.', true);
            return;
        }

        const btn = document.getElementById('email-modal-confirm');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Envoi…';

        try {
            await sendViaWebhook(email, code);
            closeEmailModal();
            showToast(`Invitation envoyée à ${email}`);
        } catch (err) {
            showToast('Erreur : ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-paper-plane"></i> Envoyer';
        }
    });
}

window.openSendModal = (code) => openEmailModal(code);

// ── Users + Module management ─────────────────────────────────────────────

async function loadUsers() {
    const container = document.getElementById('users-list');
    container.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Chargement...</p></div>';
    try {
        const snap = await db.collection('users').get();
        if (snap.empty) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-users"></i><p>Aucun utilisateur.</p></div>';
            return;
        }
        // Sort in JS to avoid requiring a Firestore index
        const docs = [];
        snap.forEach(doc => docs.push(doc));
        docs.sort((a, b) => (b.data().createdAt || 0) - (a.data().createdAt || 0));
        container.innerHTML = '';
        docs.forEach(doc => {
            const d = doc.data();
            const uid = doc.id;
            const email = d.email || 'Email inconnu';
            const isAdmin = d.isAdmin === true;
            const initial = email.charAt(0).toUpperCase();
            const createdDate = d.createdAt ? new Date(d.createdAt).toLocaleDateString('fr-FR') : '—';
            const modules = { ...defaultModules(), ...(d.modules || {}) };
            // Admin always has all modules
            const effectiveModules = isAdmin ? defaultModules() : modules;

            const modulesHtml = MODULES.map(mod => {
                const enabled = isAdmin ? true : (effectiveModules[mod.id] !== false);
                const locked = isAdmin ? 'pointer-events:none;opacity:0.6;' : '';
                return `
                    <span class="module-chip ${enabled ? 'enabled' : 'disabled'}"
                          style="${locked}"
                          data-uid="${uid}"
                          data-module="${mod.id}"
                          onclick="toggleModule(this, '${uid}', '${mod.id}')">
                        <span class="module-dot"></span>
                        ${mod.icon} ${mod.label}
                    </span>`;
            }).join('');

            const card = document.createElement('div');
            card.className = 'user-card';
            card.id = `user-${uid}`;
            card.innerHTML = `
                <div class="user-card-header">
                    <div class="user-avatar">${initial}</div>
                    <div>
                        <div class="user-email">${email}</div>
                        <div class="user-meta">Inscrit le ${createdDate}${d.invitationCode ? ` · Code : ${d.invitationCode}` : ''}</div>
                    </div>
                    <div class="user-badges">
                        ${isAdmin ? '<span class="badge-admin"><i class="fas fa-star"></i> Admin</span>' : ''}
                        <span class="saving-indicator" id="saving-${uid}"><i class="fas fa-circle-notch fa-spin"></i> Sauvegarde…</span>
                        ${!isAdmin ? `<button class="btn-icon danger" onclick="deleteUser('${uid}', '${email.replace(/'/g, "\\'")}')" title="Supprimer l'utilisateur"><i class="fas fa-trash"></i></button>` : ''}
                    </div>
                </div>
                <div class="modules-label">Modules accessibles</div>
                <div class="modules-grid">${modulesHtml}</div>`;
            container.appendChild(card);
        });
    } catch (err) {
        container.innerHTML = `<p style="color:var(--accent-red)">Erreur : ${err.message}</p>`;
    }
}

window.toggleModule = async (chip, uid, moduleId) => {
    const wasEnabled = chip.classList.contains('enabled');
    const nowEnabled = !wasEnabled;

    // Optimistic UI update
    chip.classList.toggle('enabled', nowEnabled);
    chip.classList.toggle('disabled', !nowEnabled);

    const indicator = document.getElementById(`saving-${uid}`);
    if (indicator) indicator.classList.add('visible');

    try {
        // Build the updated modules object from current UI state
        const card = document.getElementById(`user-${uid}`);
        const modules = {};
        card.querySelectorAll('.module-chip[data-uid]').forEach(c => {
            modules[c.dataset.module] = c.classList.contains('enabled');
        });
        await db.collection('users').doc(uid).update({ modules });
    } catch (err) {
        // Revert on failure
        chip.classList.toggle('enabled', wasEnabled);
        chip.classList.toggle('disabled', !wasEnabled);
        showToast('Erreur de sauvegarde : ' + err.message, true);
    } finally {
        if (indicator) indicator.classList.remove('visible');
    }
};

window.deleteUser = async (uid, email) => {
    if (!confirm(`Supprimer l'utilisateur ${email} ?\n\nSon profil et ses données seront supprimés. Son compte de connexion Firebase reste actif (il ne pourra plus accéder à l'app).`)) return;
    try {
        await db.collection('users').doc(uid).delete();
        document.getElementById(`user-${uid}`)?.remove();
        showToast(`Utilisateur supprimé : ${email}`);
        loadStats();
    } catch (err) {
        showToast('Erreur : ' + err.message, true);
    }
};

// ── Stats ─────────────────────────────────────────────────────────────────

async function loadStats() {
    try {
        const [codesSnap, usersSnap] = await Promise.all([
            db.collection('invitationCodes').get(),
            db.collection('users').get(),
        ]);
        let available = 0, used = 0;
        codesSnap.forEach(doc => {
            const d = doc.data();
            const expired = d.expiresAt && Date.now() > d.expiresAt;
            if (!expired && d.status === 'available') available++;
            else if (d.status === 'used') used++;
        });
        document.getElementById('stat-available').textContent = available;
        document.getElementById('stat-used').textContent = used;
        document.getElementById('stat-users').textContent = usersSnap.size;
    } catch (err) {
        console.warn('[Admin] loadStats failed:', err);
    }
}

// ── Toast helper ──────────────────────────────────────────────────────────

function showToast(msg, isError = false) {
    let toast = document.getElementById('admin-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'admin-toast';
        toast.style.cssText = `
            position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);
            background:var(--bg-card);border:1px solid var(--border-color);color:var(--text-primary);
            padding:10px 20px;border-radius:10px;font-size:13px;font-family:Inter,sans-serif;
            box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:99999;
            opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap;`;
        document.body.appendChild(toast);
    }
    toast.style.borderColor = isError ? 'var(--accent-red)' : 'var(--accent-green)';
    toast.style.color = isError ? '#ef4444' : 'var(--text-primary)';
    toast.textContent = msg;
    clearTimeout(toast._timer);
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast._timer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(20px)';
    }, 3000);
}
