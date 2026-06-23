// brokerService.js — Gestion dynamique des brokers par utilisateur
import { auth, db } from './firebaseConfig.js';

const LS_KEY = 'userBrokers';

export const DEFAULT_BROKERS = [
    { value: 'RV-CT',    label: 'Revolut' },
    { value: 'TR-CT',    label: 'Trade Republic' },
    { value: 'BB-PEA',   label: 'Boursobank PEA' },
    { value: 'Binance',  label: 'Binance' },
    { value: 'Bitstack', label: 'Bitstack' },
];

let _mem = null;

function loadFromLS() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
}

function saveToLS(brokers) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(brokers)); } catch {}
}

function waitForAuth() {
    return new Promise(resolve => {
        const unsub = auth.onAuthStateChanged(u => { unsub(); resolve(u); });
    });
}

export async function getBrokers() {
    if (_mem) return _mem;
    const ls = loadFromLS();
    if (ls) { _mem = ls; return _mem; }

    const user = await waitForAuth();
    if (!user) return DEFAULT_BROKERS;

    try {
        const snap = await db.collection('users').doc(user.uid).get();
        const data = snap.data();
        _mem = (data?.brokers?.length > 0) ? data.brokers : DEFAULT_BROKERS;
        saveToLS(_mem);
        return _mem;
    } catch {
        return DEFAULT_BROKERS;
    }
}

export function getBrokersSync() {
    return _mem || loadFromLS() || DEFAULT_BROKERS;
}

export function invalidateBrokerCache() {
    _mem = null;
    try { localStorage.removeItem(LS_KEY); } catch {}
}

export async function addBroker(label) {
    label = label.trim();
    if (!label) return null;

    const user = await waitForAuth();
    if (!user) throw new Error('Non connecté');

    const brokers = await getBrokers();

    const existing = brokers.find(b => b.label.toLowerCase() === label.toLowerCase());
    if (existing) return existing;

    // Générer un code unique depuis le nom
    const base = label.toUpperCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // enlève les accents
        .replace(/[^A-Z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 12);
    let value = base;
    let i = 2;
    while (brokers.some(b => b.value === value)) value = `${base}-${i++}`;

    const newBroker = { value, label };
    const updated = [...brokers, newBroker];

    // set+merge pour créer le champ même si le document n'a pas encore de champ brokers
    await db.collection('users').doc(user.uid).set({ brokers: updated }, { merge: true });
    _mem = updated;
    saveToLS(updated);
    return newBroker;
}

export async function removeBroker(value) {
    const user = await waitForAuth();
    if (!user) throw new Error('Non connecté');

    const brokers = await getBrokers();
    const updated = brokers.filter(b => b.value !== value);

    await db.collection('users').doc(user.uid).set({ brokers: updated }, { merge: true });
    _mem = updated;
    saveToLS(updated);
    return updated;
}

// Remplit un <select> avec la liste de brokers fournie
// opts: { includeAll: string|false, includeEmpty: string|false, includeAdd: bool }
export function fillSelect(select, brokers, opts = {}) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = '';

    if (opts.includeAll !== undefined && opts.includeAll !== false) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = typeof opts.includeAll === 'string' ? opts.includeAll : 'All Brokers';
        select.appendChild(o);
    }
    if (opts.includeEmpty !== undefined && opts.includeEmpty !== false) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = typeof opts.includeEmpty === 'string' ? opts.includeEmpty : 'Select Broker';
        select.appendChild(o);
    }

    (brokers || DEFAULT_BROKERS).forEach(b => {
        const o = document.createElement('option');
        o.value = b.value;
        o.textContent = b.label;
        select.appendChild(o);
    });

    if (opts.includeAdd !== false) {
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = '──────────────';
        select.appendChild(sep);

        const o = document.createElement('option');
        o.value = '__add__';
        o.textContent = '＋ Ajouter un broker...';
        select.appendChild(o);
    }

    if (current && [...select.options].some(o => o.value === current)) {
        select.value = current;
    }
}

// Charge les brokers depuis Firestore puis remplit le select
export async function populateSelect(select, opts = {}) {
    const brokers = await getBrokers();
    fillSelect(select, brokers, opts);
    return brokers;
}

// Toast in-page (aucun alert navigateur)
function showBrokerToast(msg, isError = false) {
    let toast = document.getElementById('broker-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'broker-toast';
        toast.style.cssText = `
            position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);
            background:var(--bg-card);border:1px solid var(--border-color);color:var(--text-primary);
            padding:10px 20px;border-radius:10px;font-size:13px;font-family:Inter,sans-serif;
            box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:99999;
            opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap;`;
        document.body.appendChild(toast);
    }
    toast.style.borderColor = isError ? '#ef4444' : 'var(--accent-green, #22c55e)';
    toast.style.color      = isError ? '#ef4444' : 'var(--text-primary)';
    toast.textContent = msg;
    clearTimeout(toast._t);
    toast.style.opacity   = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast._t = setTimeout(() => {
        toast.style.opacity   = '0';
        toast.style.transform = 'translateX(-50%) translateY(20px)';
    }, 3000);
}

// Input inline qui remplace le prompt() natif
function showInlineInput(select, onConfirm) {
    // Supprimer un éventuel ancien widget
    document.getElementById('broker-inline-input')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'broker-inline-input';
    wrap.style.cssText = `
        display:inline-flex;align-items:center;gap:6px;
        position:absolute;z-index:9999;
        background:var(--bg-card);border:1px solid var(--accent-blue, #3b82f6);
        border-radius:8px;padding:6px 8px;
        box-shadow:0 4px 16px rgba(0,0,0,.35);`;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Nom du broker';
    input.style.cssText = `
        border:none;outline:none;background:transparent;
        color:var(--text-primary);font-size:13px;width:160px;`;

    const btnOk = document.createElement('button');
    btnOk.textContent = '✓';
    btnOk.type = 'button';
    btnOk.style.cssText = `
        background:var(--accent-blue, #3b82f6);color:#fff;border:none;
        border-radius:6px;padding:3px 8px;cursor:pointer;font-size:13px;`;

    const btnCancel = document.createElement('button');
    btnCancel.textContent = '✕';
    btnCancel.type = 'button';
    btnCancel.style.cssText = `
        background:transparent;color:var(--text-muted);border:none;
        cursor:pointer;font-size:13px;padding:3px 6px;`;

    wrap.appendChild(input);
    wrap.appendChild(btnOk);
    wrap.appendChild(btnCancel);

    // Positionner sous le select
    const rect = select.getBoundingClientRect();
    wrap.style.top  = `${rect.bottom + window.scrollY + 4}px`;
    wrap.style.left = `${rect.left  + window.scrollX}px`;
    document.body.appendChild(wrap);
    input.focus();

    const close = () => wrap.remove();

    btnCancel.addEventListener('click', () => { close(); select.value = ''; });

    const confirm = () => {
        const val = input.value.trim();
        close();
        if (val) onConfirm(val);
        else select.value = '';
    };
    btnOk.addEventListener('click', confirm);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') confirm();
        if (e.key === 'Escape') { close(); select.value = ''; }
    });

    // Fermer si clic extérieur
    setTimeout(() => {
        document.addEventListener('click', function handler(e) {
            if (!wrap.contains(e.target) && e.target !== select) {
                close(); select.value = '';
                document.removeEventListener('click', handler);
            }
        });
    }, 100);
}

// Attache le handler "＋ Ajouter" sur un select
// refreshTargets: [{ el, opts }] — selects à rafraîchir après ajout (inclut le select courant)
export function attachAddBrokerHandler(select, refreshTargets = []) {
    if (!select) return;
    select.addEventListener('change', function () {
        if (this.value !== '__add__') return;
        const self = this;

        showInlineInput(self, async (label) => {
            try {
                const newBroker = await addBroker(label);
                if (newBroker) {
                    const brokers = getBrokersSync();
                    for (const { el, opts } of refreshTargets) {
                        fillSelect(el, brokers, opts);
                    }
                    const target = refreshTargets.find(t => t.el === self);
                    if (target) self.value = newBroker.value;
                    showBrokerToast(`Broker ajouté : ${newBroker.label}`);
                }
            } catch (e) {
                showBrokerToast('Erreur : ' + e.message, true);
                self.value = '';
            }
        });
    });
}
