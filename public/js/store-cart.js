/* Profiteers store cart — client-side, persisted in localStorage.
   Cart shape: { "<itemId>": qty }. Personal gear only (vehicles use the
   platoon-fund flow). Buttons with .add-to-cart[data-item-id] add to it;
   elements with .cart-count show the total; the /store/cart page renders it. */
(function () {
    const KEY = 'profiteers_cart';

    function read() {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch (e) { return {}; }
    }
    function write(cart) {
        localStorage.setItem(KEY, JSON.stringify(cart));
        updateBadges();
    }
    function count(cart) {
        return Object.values(cart || read()).reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
    }
    function updateBadges() {
        const n = count();
        document.querySelectorAll('.cart-count').forEach(el => {
            el.textContent = n;
            el.style.display = n > 0 ? '' : 'none';
        });
    }
    function add(itemId, qty) {
        const cart = read();
        cart[itemId] = (cart[itemId] || 0) + (qty || 1);
        write(cart);
    }
    function setQty(itemId, qty) {
        const cart = read();
        if (qty <= 0) delete cart[itemId]; else cart[itemId] = qty;
        write(cart);
    }
    function remove(itemId) { setQty(itemId, 0); }
    function clear() { localStorage.removeItem(KEY); updateBadges(); }

    function toast(msg, type) {
        let el = document.getElementById('toast');
        if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
        el.textContent = msg;
        el.className = 'toast ' + (type || 'success') + ' show';
        setTimeout(() => el.classList.remove('show'), 3000);
    }

    window.ProfiteersCart = { read, write, add, setQty, remove, clear, count, updateBadges };

    document.addEventListener('DOMContentLoaded', () => {
        updateBadges();

        // Add-to-cart buttons anywhere on the page.
        document.querySelectorAll('.add-to-cart').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const id = btn.dataset.itemId;
                if (!id) return;
                const qtyInput = btn.closest('.store-item-card, .item-page-buy')?.querySelector('.qty-input');
                const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
                add(id, qty);
                toast('Added to cart');
            });
        });

        // Render the cart page if we're on it.
        const container = document.getElementById('cartContainer');
        if (container) renderCartPage(container);
    });

    async function renderCartPage(container) {
        const cart = read();
        const ids = Object.keys(cart);
        const emptyEl = document.getElementById('cartEmpty');
        const summaryEl = document.getElementById('cartSummary');

        if (!ids.length) {
            container.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            if (summaryEl) summaryEl.style.display = 'none';
            return;
        }

        let items = [];
        try {
            const res = await fetch('/store/api/cart', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids })
            });
            const data = await res.json();
            items = data.items || [];
        } catch (e) { toast('Failed to load cart', 'error'); return; }

        // Drop ids that no longer resolve (deactivated/removed items).
        const live = new Set(items.map(i => String(i.id)));
        let changed = false;
        ids.forEach(id => { if (!live.has(id)) { delete cart[id]; changed = true; } });
        if (changed) write(cart);

        if (!items.length) { container.innerHTML = ''; if (emptyEl) emptyEl.style.display = ''; if (summaryEl) summaryEl.style.display = 'none'; return; }
        if (emptyEl) emptyEl.style.display = 'none';
        if (summaryEl) summaryEl.style.display = '';

        let total = 0;
        container.innerHTML = items.map(it => {
            const qty = parseInt(cart[it.id], 10) || 1;
            const line = it.base_price * qty;
            total += line;
            const img = it.image_url
                ? `<img src="${it.image_url}" alt="" loading="lazy">`
                : `<div class="item-placeholder">📦</div>`;
            return `
                <div class="cart-row" data-item-id="${it.id}">
                    <a class="cart-thumb" href="/store/item/${it.id}">${img}</a>
                    <div class="cart-info">
                        <a class="cart-name" href="/store/item/${it.id}">${it.display_name}</a>
                        <span class="item-type-badge type-${it.item_type}">${it.item_type}</span>
                    </div>
                    <div class="qty-selector">
                        <button type="button" class="qty-btn cart-minus">−</button>
                        <input type="number" class="qty-input cart-qty" value="${qty}" min="1" max="99" readonly>
                        <button type="button" class="qty-btn cart-plus">+</button>
                    </div>
                    <div class="cart-line-price"><span class="line-total">${line.toLocaleString()}</span> ¢</div>
                    <button type="button" class="btn btn-danger cart-remove">✕</button>
                </div>`;
        }).join('');

        const totalEl = document.getElementById('cartTotal');
        if (totalEl) totalEl.textContent = total.toLocaleString();

        const balance = parseInt((document.getElementById('walletBalance')?.textContent || '0').replace(/[^\d]/g, ''), 10) || 0;
        const checkoutBtn = document.getElementById('checkoutBtn');
        if (checkoutBtn) checkoutBtn.disabled = total > balance || total === 0;
        const warn = document.getElementById('cartWarn');
        if (warn) warn.style.display = total > balance ? '' : 'none';

        // Wire per-row controls.
        container.querySelectorAll('.cart-row').forEach(row => {
            const id = row.dataset.itemId;
            row.querySelector('.cart-plus').addEventListener('click', () => {
                const c = read(); const q = Math.min(99, (parseInt(c[id], 10) || 1) + 1); setQty(id, q); renderCartPage(container);
            });
            row.querySelector('.cart-minus').addEventListener('click', () => {
                const c = read(); const q = (parseInt(c[id], 10) || 1) - 1; setQty(id, q); renderCartPage(container);
            });
            row.querySelector('.cart-remove').addEventListener('click', () => { remove(id); renderCartPage(container); });
        });
    }

    // Checkout button (bound once; reads the live cart at click time).
    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('checkoutBtn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            const cart = read();
            const items = Object.entries(cart).map(([itemId, quantity]) => ({ itemId, quantity }));
            if (!items.length) return;
            btn.disabled = true;
            const orig = btn.textContent;
            btn.textContent = '⏳ Processing...';
            try {
                const res = await fetch('/store/api/checkout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items })
                });
                const data = await res.json();
                if (data.success) {
                    clear();
                    const wb = document.getElementById('walletBalance');
                    if (wb) wb.textContent = data.balance.toLocaleString();
                    toast('Purchase complete!');
                    const container = document.getElementById('cartContainer');
                    if (container) renderCartPage(container);
                } else {
                    toast(data.error || 'Checkout failed', 'error');
                    btn.disabled = false;
                    btn.textContent = orig;
                }
            } catch (e) {
                toast('Network error', 'error');
                btn.disabled = false;
                btn.textContent = orig;
            }
        });
    });
})();
