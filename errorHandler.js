// ========================================
// errorHandler.js - Gestion centralisée des erreurs
// ========================================

export class ErrorHandler {
    constructor() {
        this.errors = [];
        this.maxErrors = 100;
        this.setupGlobalHandlers();
    }

    setupGlobalHandlers() {
        // Capturer les erreurs non gérées
        window.addEventListener('error', (event) => {
            this.logError({
                type: 'UNCAUGHT_ERROR',
                message: event.message,
                filename: event.filename,
                line: event.lineno,
                column: event.colno,
                stack: event.error?.stack
            });
        });

        // Capturer les promesses rejetées
        window.addEventListener('unhandledrejection', (event) => {
            this.logError({
                type: 'UNHANDLED_REJECTION',
                message: event.reason?.message || event.reason,
                stack: event.reason?.stack
            });
        });
    }

    logError(error) {
        const errorLog = {
            ...error,
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            url: window.location.href
        };

        this.errors.push(errorLog);

        // Limiter la taille du log
        if (this.errors.length > this.maxErrors) {
            this.errors.shift();
        }

        // Logger en console en dev
        if (this.isDevelopment()) {
            console.error('🔴 Erreur:', errorLog);
        }

        // Sauvegarder dans localStorage
        this.saveErrorLog();
    }

    saveErrorLog() {
        try {
            localStorage.setItem('error_log', JSON.stringify(this.errors.slice(-50)));
        } catch (e) {
            // Ignore si localStorage est plein
        }
    }

    getErrors() {
        return this.errors;
    }

    clearErrors() {
        this.errors = [];
        localStorage.removeItem('error_log');
    }

    isDevelopment() {
        return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    }

    // Wrapper pour fonctions asynchrones
    async handleAsync(fn, context = 'Opération') {
        try {
            return await fn();
        } catch (error) {
            this.logError({
                type: 'ASYNC_ERROR',
                context: context,
                message: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    // Wrapper pour requêtes API
    async handleAPICall(fn, endpoint) {
        try {
            return await fn();
        } catch (error) {
            this.logError({
                type: 'API_ERROR',
                endpoint: endpoint,
                message: error.message,
                status: error.status || 'unknown',
                stack: error.stack
            });

            // Déterminer le message utilisateur
            if (error.status === 429) {
                throw new Error('Trop de requêtes. Veuillez patienter.');
            } else if (error.status === 404) {
                throw new Error('Ressource non trouvée.');
            } else if (error.status >= 500) {
                throw new Error('Erreur serveur. Réessayez plus tard.');
            } else {
                throw new Error('Erreur de connexion. Vérifiez votre connexion.');
            }
        }
    }

    // Export du log d'erreurs
    exportErrorLog() {
        const data = JSON.stringify(this.errors, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `error_log_${new Date().toISOString()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }
}

// Export singleton
export const errorHandler = new ErrorHandler();

// Utilitaires pour erreurs courantes
export class ValidationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

export class APIError extends Error {
    constructor(message, status, endpoint) {
        super(message);
        this.name = 'APIError';
        this.status = status;
        this.endpoint = endpoint;
    }
}

export class StorageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StorageError';
    }
}

// Helper pour validation
export function validate(value, rules, fieldName) {
    if (rules.required && !value) {
        throw new ValidationError(`${fieldName} est requis`, fieldName);
    }

    if (rules.type === 'number' && isNaN(value)) {
        throw new ValidationError(`${fieldName} doit être un nombre`, fieldName);
    }

    if (rules.min !== undefined && value < rules.min) {
        throw new ValidationError(`${fieldName} doit être >= ${rules.min}`, fieldName);
    }

    if (rules.max !== undefined && value > rules.max) {
        throw new ValidationError(`${fieldName} doit être <= ${rules.max}`, fieldName);
    }

    if (rules.pattern && !rules.pattern.test(value)) {
        throw new ValidationError(`${fieldName} format invalide`, fieldName);
    }

    return true;
}