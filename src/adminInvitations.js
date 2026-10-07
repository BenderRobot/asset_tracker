import { auth, db } from './firebaseConfig.js';
import { callAdminFunction } from './accessClaims.js';

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
    setupClaimsSync();
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
    const rand = (n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), v => chars[v % chars.length]).join('');
    return `INV-${rand(4)}-${rand(4)}`;
}

// ── Safe DOM helpers ──────────────────────────────────────────────────────
// Les champs affichés ici (usedBy, email, invitationCode…) proviennent de
// documents qu'un utilisateur a pu écrire : ils ne passent JAMAIS par
// innerHTML, uniquement par textContent via el().

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'style') node.style.cssText = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : String(child));
    }
    return node;
}

function iconButton(iconClass, title, onClick, danger = false) {
    return el('button', { className: danger ? 'btn-icon danger' : 'btn-icon', title, onClick },
        el('i', { className: iconClass }));
}

function showListError(container, err) {
    container.replaceChildren(el('p', { style: 'color:var(--accent-red)', text: `Erreur : ${err.message}` }));
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
            container.innerHTML = '<div class="empty-state"><i class="ph ph-ticket"></i><p>Aucun code d\'invitation.</p></div>';
            return;
        }
        container.replaceChildren(...snap.docs.map(doc => {
            const d = doc.data();
            const code = String(d.code ?? doc.id);
            const expired = d.expiresAt && Date.now() > d.expiresAt;
            const statusKey = expired ? 'expired' : d.status;
            const statusLabel = { available: 'Disponible', used: 'Utilisé', expired: 'Expiré' }[statusKey] || String(statusKey);
            const badgeClass = { available: 'badge-available', used: 'badge-used', expired: 'badge-expired' }[statusKey] || '';
            const usedInfo = d.usedBy
                ? ['Utilisé par ', el('strong', { text: String(d.usedBy) }), ` le ${new Date(d.usedAt).toLocaleDateString('fr-FR')}`]
                : [`Expire le ${new Date(d.expiresAt).toLocaleDateString('fr-FR')}`];
            const modCount = d.modules ? Object.values(d.modules).filter(Boolean).length : MODULES.length;
            const modLabel = `${modCount}/${MODULES.length} module${modCount > 1 ? 's' : ''}`;
            return el('div', { className: 'code-item' }, [
                el('div', { style: 'flex:1;min-width:0;' }, [
                    el('div', { className: 'code-value', text: code }),
                    el('div', { className: 'code-meta' }, [
                        ...usedInfo, ' · ',
                        el('span', { style: 'color:var(--accent-blue)', text: modLabel }),
                    ]),
                ]),
                el('span', { className: `status-badge ${badgeClass}`, text: statusLabel }),
                statusKey === 'available' && iconButton('ph ph-envelope-simple', 'Envoyer par email', () => openEmailModal(code)),
                iconButton('ph ph-copy', 'Copier', () => copyCode(code)),
                iconButton('ph ph-trash', 'Supprimer', () => deleteCode(doc.id), true),
            ]);
        }));
    } catch (err) {
        showListError(container, err);
    }
}

function copyCode(code) {
    navigator.clipboard.writeText(code).catch(() => {});
    showToast(`Code copié : ${code}`);
}

async function deleteCode(id) {
    if (!confirm('Supprimer ce code ?')) return;
    try {
        await db.collection('invitationCodes').doc(id).delete();
        showToast('Code supprimé.');
        loadCodes();
        loadStats();
    } catch (err) {
        showToast('Erreur : ' + err.message, true);
    }
}

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
        btn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Envoi…';

        try {
            await sendViaWebhook(email, code);
            closeEmailModal();
            showToast(`Invitation envoyée à ${email}`);
        } catch (err) {
            showToast('Erreur : ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="ph ph-paper-plane-tilt"></i> Envoyer';
        }
    });
}

// ── Users + Module management ─────────────────────────────────────────────

async function loadUsers() {
    const container = document.getElementById('users-list');
    container.innerHTML = '<div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><p>Chargement...</p></div>';
    try {
        const snap = await db.collection('users').get();
        if (snap.empty) {
            container.innerHTML = '<div class="empty-state"><i class="ph ph-users"></i><p>Aucun utilisateur.</p></div>';
            return;
        }
        // Sort in JS to avoid requiring a Firestore index
        const docs = [];
        snap.forEach(doc => docs.push(doc));
        docs.sort((a, b) => (b.data().createdAt || 0) - (a.data().createdAt || 0));
        container.replaceChildren(...docs.map(buildUserCard));
    } catch (err) {
        showListError(container, err);
    }
}

function buildUserCard(doc) {
    const d = doc.data();
    const uid = doc.id;
    const email = String(d.email || 'Email inconnu');
    const isAdmin = d.isAdmin === true;
    const createdDate = d.createdAt ? new Date(d.createdAt).toLocaleDateString('fr-FR') : '—';
    // Admin always has all modules
    const effectiveModules = isAdmin ? defaultModules() : { ...defaultModules(), ...(d.modules || {}) };

    const indicator = el('span', { className: 'saving-indicator' }, [
        el('i', { className: 'ph ph-circle-notch ph-spin' }), ' Sauvegarde…',
    ]);

    const chips = MODULES.map(mod => {
        const enabled = isAdmin || effectiveModules[mod.id] !== false;
        const chip = el('span', {
            className: `module-chip ${enabled ? 'enabled' : 'disabled'}`,
            style: isAdmin ? 'pointer-events:none;opacity:0.6;' : null,
            dataset: { module: mod.id },
        }, [el('span', { className: 'module-dot' }), `${mod.icon} ${mod.label}`]);
        if (!isAdmin) chip.addEventListener('click', () => toggleModule(chip, uid, chips, indicator));
        return chip;
    });

    const meta = `Inscrit le ${createdDate}${d.invitationCode ? ` · Code : ${d.invitationCode}` : ''}`;
    const card = el('div', { className: 'user-card' }, [
        el('div', { className: 'user-card-header' }, [
            el('div', { className: 'user-avatar', text: email.charAt(0).toUpperCase() }),
            el('div', {}, [
                el('div', { className: 'user-email', text: email }),
                el('div', { className: 'user-meta', text: meta }),
            ]),
            el('div', { className: 'user-badges' }, [
                isAdmin && el('span', { className: 'badge-admin' }, [el('i', { className: 'ph ph-star' }), ' Admin']),
                indicator,
                !isAdmin && iconButton('ph ph-trash', "Supprimer l'utilisateur", () => deleteUser(uid, email, card), true),
            ]),
        ]),
        el('div', { className: 'modules-label', text: 'Modules accessibles' }),
        el('div', { className: 'modules-grid' }, chips),
    ]);
    return card;
}

async function toggleModule(chip, uid, chips, indicator) {
    const wasEnabled = chip.classList.contains('enabled');
    const nowEnabled = !wasEnabled;

    // Optimistic UI update
    chip.classList.toggle('enabled', nowEnabled);
    chip.classList.toggle('disabled', !nowEnabled);
    indicator.classList.add('visible');

    try {
        // Build the updated modules object from current UI state
        const modules = Object.fromEntries(chips.map(c => [c.dataset.module, c.classList.contains('enabled')]));
        await db.collection('users').doc(uid).update({ modules });
    } catch (err) {
        // Revert on failure
        chip.classList.toggle('enabled', wasEnabled);
        chip.classList.toggle('disabled', !wasEnabled);
        showToast('Erreur de sauvegarde : ' + err.message, true);
    } finally {
        indicator.classList.remove('visible');
    }
}

async function deleteUser(uid, email, card) {
    if (!confirm(`Supprimer l'utilisateur ${email} ?\n\nSon profil et ses données seront supprimés et son accès aux API retiré. Son compte de connexion Firebase reste actif (il ne pourra plus accéder à l'app).`)) return;
    try {
        // Retirer d'abord le claim `invited` : sans lui, le compte garderait
        // l'accès aux Workers (Gemini, banque) malgré la suppression du profil.
        await callAdminFunction('setUserInvited', { uid, invited: false }).catch(err => {
            if (err.code !== 'functions/not-found') throw err; // compte Auth déjà supprimé
        });
        await db.collection('users').doc(uid).delete();
        card.remove();
        showToast(`Utilisateur supprimé : ${email}`);
        loadStats();
    } catch (err) {
        showToast('Erreur : ' + err.message, true);
    }
}

// ── Claims `invited` (accès aux API) ──────────────────────────────────────
// Migration des comptes créés avant le claim : un premier passage à blanc
// montre ce qui sera accordé, puis l'admin confirme. Les comptes dont
// l'invitation n'est pas vérifiable (ex. anciens comptes Google) sont listés
// pour un accord manuel, un par un.

function setupClaimsSync() {
    const btn = document.getElementById('sync-claims-btn');
    btn?.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            const preview = await callAdminFunction('syncInvitedClaims', { dryRun: true });
            let report = preview;
            if (preview.granted.length && confirm(
                `${preview.granted.length} compte(s) vérifié(s) recevront l'accès aux API :\n` +
                preview.granted.map(u => `• ${u.email || u.uid}`).join('\n') + '\n\nConfirmer ?'
            )) {
                report = await callAdminFunction('syncInvitedClaims', { dryRun: false });
                showToast(`Accès accordé à ${report.granted.length} compte(s).`);
            } else if (!preview.granted.length) {
                showToast('Aucun compte vérifiable à migrer.');
            }
            renderClaimsReport(report);
        } catch (err) {
            showToast('Erreur : ' + err.message, true);
        } finally {
            btn.disabled = false;
        }
    });
}

function renderClaimsReport(report) {
    const container = document.getElementById('claims-report');
    if (!report.unverified.length) {
        container.replaceChildren();
        return;
    }
    const rows = report.unverified.map(u => {
        const label = u.email || u.uid;
        const row = el('div', { className: 'code-item' }, [
            el('div', { style: 'flex:1;min-width:0;', text: label }),
        ]);
        row.append(iconButton('ph ph-key', "Accorder l'accès aux API", async () => {
            if (!confirm(`Accorder l'accès aux API à ${label} ?`)) return;
            try {
                await callAdminFunction('setUserInvited', { uid: u.uid, invited: true });
                row.remove();
                showToast(`Accès accordé : ${label}`);
            } catch (err) {
                showToast('Erreur : ' + err.message, true);
            }
        }));
        return row;
    });
    container.replaceChildren(
        el('div', { className: 'modules-label', text: `Invitation non vérifiable (${rows.length}) — accorder manuellement si légitime` }),
        ...rows,
    );
}

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
