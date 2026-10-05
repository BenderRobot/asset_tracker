/**
 * Coordonne les requêtes d'une même zone d'interface : démarrer une nouvelle
 * requête annule la précédente et invalide son résultat, même si le fournisseur
 * ignore finalement le signal AbortController.
 */
export class LatestRequestController {
    constructor() {
        this.sequence = 0;
        this.abortController = null;
    }

    begin() {
        this.abortController?.abort();
        this.abortController = new AbortController();
        const sequence = ++this.sequence;
        return {
            sequence,
            signal: this.abortController.signal,
            isCurrent: () => this.sequence === sequence && !this.abortController?.signal.aborted
        };
    }

    cancel() {
        this.sequence += 1;
        this.abortController?.abort();
        this.abortController = null;
    }

    finish(sequence) {
        if (this.sequence === sequence) this.abortController = null;
    }
}
