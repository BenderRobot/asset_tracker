// Minimal stub of the Firebase v8-compat global expected by src/firebaseConfig.js.
// The real app loads Firebase via a <script> CDN tag in the browser; under the
// test runner (Node, no DOM) that global doesn't exist, so we fake just enough
// of its surface for firebaseConfig.js to evaluate without throwing.
globalThis.firebase = {
    apps: [],
    initializeApp() { return {}; },
    app() { return {}; },
    auth() {
        return {
            currentUser: null,
            onAuthStateChanged(cb) { cb(null); return () => {}; }
        };
    },
    firestore() {
        return {
            collection() {
                return {
                    doc() {
                        return {
                            collection() {
                                return { doc() { return { get: async () => ({ exists: false }), set: async () => {} }; } };
                            },
                            get: async () => ({ exists: false }),
                            set: async () => {}
                        };
                    }
                };
            }
        };
    }
};

// storage.js reads/writes localStorage in a few places; provide a tiny in-memory stand-in
// so importing modules that touch it at call time doesn't throw under Node.
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear()
    };
}

// portfolioKPIs.js schedules listener notifications via requestAnimationFrame,
// a browser-only API — Node has no rendering loop, so run the callback on the
// next microtask/macrotask instead.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}
