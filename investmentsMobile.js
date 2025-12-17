// Mobile Investments Table - Data Attributes & Helpers
// Handles data population for CSS-based responsive layouts

document.addEventListener('DOMContentLoaded', () => {
    const table = document.getElementById('investments-table');
    if (!table) return;

    // --- GAIN TOGGLE & SORT CONFLICT FIX ---
    // Use capture phase to intercept clicks before they reach the sorting handler
    const thead = table.querySelector('thead');
    if (thead) {
        thead.addEventListener('click', (e) => {
            // Activate only on mobile
            if (window.matchMedia("(min-width: 769px)").matches) return;

            const th = e.target.closest('th');
            if (!th) return;

            const index = Array.from(th.parentNode.children).indexOf(th);

            // Target columns: 8 (RT %) or 10 (DAY %)
            // These correspond to the clickable headers for Gain Toggle
            if (index === 8 || index === 10) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation(); // Kill the sort event
                table.classList.toggle('show-total-gain');
            }
        }, true); // CAPTURE PHASE
    }

    // Add data attributes to cells for mobile styling
    function setupMobileTable() {
        // --- DESKTOP MODE (RESTORE) ---
        if (window.matchMedia("(min-width: 769px)").matches) {
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                // Restore RT % (Index 8)
                const totalPctCell = cells[8];
                if (totalPctCell && totalPctCell.textContent.trim() === '' && totalPctCell.hasAttribute('data-percentage')) {
                    totalPctCell.textContent = totalPctCell.getAttribute('data-percentage');
                }
                // Restore DAY % (Index 10)
                const dayPctCell = cells[10];
                if (dayPctCell && dayPctCell.textContent.trim() === '' && dayPctCell.hasAttribute('data-percentage')) {
                    dayPctCell.textContent = dayPctCell.getAttribute('data-percentage');
                }
            });
            return;
        }

        // --- MOBILE MODE (SETUP) ---
        // (rest of the function...)

        const headers = ['TICKER', 'NAME', 'QUANTITY', 'AVG PRICE', 'INVESTED', 'CURRENT', 'VALUE', 'P&L', 'RT %', 'DAY P&L', 'DAY %'];
        const rows = table.querySelectorAll('tbody tr');

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < headers.length) return;

            // 1. Assign Data Labels
            cells.forEach((cell, index) => {
                if (headers[index]) {
                    cell.setAttribute('data-label', headers[index]);
                }
            });

            // 2. Logic: Show Name in Ticker Column for better mobile readability
            const tickerCell = cells[0]; // TICKER
            const nameCell = cells[1]; // NAME
            const quantityCell = cells[2]; // QUANTITY

            if (tickerCell && nameCell) {
                // If we haven't already replaced it
                const nameText = nameCell.textContent.trim();
                // Store original ticker if needed, but for now just swap
                if (nameText && tickerCell.textContent !== nameText) {
                    tickerCell.textContent = nameText;
                }
            }

            // 3. Add Quantity attribute for CSS (::after content)
            if (tickerCell && quantityCell) {
                const quantity = quantityCell.textContent.trim();
                tickerCell.setAttribute('data-quantity', quantity);
            }

            // 4. Day P&L Coloring
            const dayEurCell = cells[9]; // DAY P&L
            if (dayEurCell) {
                const value = parseFloat(dayEurCell.textContent.replace(/[^\d.-]/g, ''));
                if (!isNaN(value)) {
                    dayEurCell.classList.remove('positive', 'negative');
                    dayEurCell.classList.add(value >= 0 ? 'positive' : 'negative');
                }
            }

            // 5. Day % Coloring & Badge Data
            const dayPctCell = cells[10]; // DAY %
            if (dayPctCell) {
                const percentText = dayPctCell.textContent.trim();
                const value = parseFloat(percentText);
                if (!isNaN(value)) {
                    dayPctCell.classList.remove('positive', 'negative');
                    dayPctCell.classList.add(value >= 0 ? 'positive' : 'negative');

                    // For the Compact Table CSS, we need the percentage in data-attribute
                    // The CSS uses ::before { content: attr(data-percentage) }
                    dayPctCell.setAttribute('data-percentage', percentText);

                    // We clear the text content so only the CSS badge shows
                    dayPctCell.textContent = '';
                }
            }

            // 6. Total % Coloring & Badge Data (Index 8)
            const totalPctCell = cells[8]; // RT %
            if (totalPctCell) {
                const percentText = totalPctCell.textContent.trim();
                const value = parseFloat(percentText);
                if (!isNaN(value)) {
                    totalPctCell.classList.remove('positive', 'negative');
                    totalPctCell.classList.add(value >= 0 ? 'positive' : 'negative');

                    // Badge logic for Mobile
                    totalPctCell.setAttribute('data-percentage', percentText);
                    // Clear text to remove potential desktop artifacts/double text
                    totalPctCell.textContent = '';
                }
            }

            // Simple expansion toggle
            row.style.cursor = 'pointer';
            row.onclick = (e) => {
                if (e.target.closest('button') || e.target.closest('a')) return;
                row.classList.toggle('expanded');
            };
        });
    }

    // Run setup on page load
    setupMobileTable();

    // Observe tbody for row changes (additions/removals)
    const tbody = table.querySelector('tbody');
    if (tbody) {
        const observer = new MutationObserver((mutations) => {
            setupMobileTable();
        });

        observer.observe(tbody, {
            childList: true,
            subtree: false
        });
    }
});
