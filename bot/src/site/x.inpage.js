// In-page functions for x.com, shared by BOTH drivers (Playwright and the Python browser-use sidecar).
//
// This file is read as TEXT and never imported: tsx/esbuild would inject `__name(...)` helpers into
// transpiled functions, which don't exist inside the page. So it stays plain JavaScript, and it is ONE
// expression (the object literal below). Callers evaluate:
//
//     JSON.stringify((<this file>)[name](ctx))      ctx = { sel, text, guard, ...extra }
//
// Rules: methods are synchronous, touch only the DOM and `this` (sibling helpers), and return
// JSON-serialisable values. Stamps are data-tc-* attributes so later clicks can find the same element.
({
  // ---- helpers ------------------------------------------------------------------------------
  _norm(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
  },

  // A post's OWN permalink is the /status/ link that wraps its <time>. A quoted post's link has one
  // too, but it comes later in document order, so the first match is always the outer post.
  _idOf(el) {
    const link = [...el.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time'));
    const m = link?.getAttribute('href')?.match(/^\/([^/]+)\/status\/(\d+)/);
    return m ? { author: m[1], id: m[2] } : null;
  },

  _find(c, id) {
    return [...document.querySelectorAll(c.sel.article)].find((a) => this._idOf(a)?.id === id) ?? null;
  },

  // Bottom edge of any sticky/fixed header covering the top of the column at x.
  _stickyBottom(x) {
    let bottom = 0;
    for (const hit of document.elementsFromPoint(x, 2)) {
      for (let e = hit; e && e !== document.body; e = e.parentElement) {
        const pos = getComputedStyle(e).position;
        if (pos === 'sticky' || pos === 'fixed') {
          bottom = Math.max(bottom, e.getBoundingClientRect().bottom);
          break;
        }
      }
    }
    return bottom < innerHeight / 2 ? bottom : 0;
  },

  // ---- session ------------------------------------------------------------------------------
  isLoggedIn(c) {
    return !!document.querySelector(c.sel.loggedIn);
  },

  myHandle(c) {
    const spans = document.querySelectorAll(c.sel.handle);
    const raw = spans[spans.length - 1]?.innerText ?? '';
    return { handle: raw.replace(/^@/, '').toLowerCase() || null };
  },

  // Stamps the "For you" tab (data-tc-tab) so the driver can click it natively.
  forYouTab(c) {
    document.querySelectorAll('[data-tc-tab]').forEach((e) => e.removeAttribute('data-tc-tab'));
    const tab = [...document.querySelectorAll(c.sel.tab)].find((t) => t.innerText.toLowerCase().includes(c.text.forYou));
    if (!tab) return { state: 'missing' };
    tab.setAttribute('data-tc-tab', '');
    return { state: tab.getAttribute('aria-selected') === 'true' ? 'selected' : 'stamped' };
  },

  // ---- reading ------------------------------------------------------------------------------
  // Every mounted post in feed order. With c.target, also stamps that post (data-tc-target) and its
  // feed cell (data-tc-cell); without it, existing stamps are left alone.
  scan(c) {
    const retarget = 'target' in c;
    if (retarget) {
      document.querySelectorAll('[data-tc-target],[data-tc-cell]').forEach((e) => {
        e.removeAttribute('data-tc-target');
        e.removeAttribute('data-tc-cell');
      });
    }
    let stamped = false;
    const posts = [];
    for (const el of document.querySelectorAll(c.sel.article)) {
      const who = this._idOf(el);
      if (!who) continue;
      if (retarget && who.id === c.target) {
        el.setAttribute('data-tc-target', '');
        (el.closest(c.sel.cell) ?? el).setAttribute('data-tc-cell', '');
        stamped = true;
      }
      const texts = [...el.querySelectorAll(c.sel.tweetText)].map((n) => n.innerText);
      posts.push({ id: who.id, author: who.author, text: texts[0] ?? '', quoted: texts[1] ?? null });
    }
    return { posts, stamped };
  },

  // "Move to the next post": put post c.target at the top of the viewport, under the sticky header,
  // and outline it so you can follow along. c.smooth animates the scroll.
  focus(c) {
    document.querySelectorAll('[data-tc-focus]').forEach((e) => {
      e.removeAttribute('data-tc-focus');
      e.style.outline = '';
    });
    const el = this._find(c, c.target);
    if (!el) return { found: false };
    el.setAttribute('data-tc-focus', '');
    el.style.outline = '2px solid #1d9bf0';
    el.style.outlineOffset = '-2px';
    const r = el.getBoundingClientRect();
    const top = scrollY + r.top - this._stickyBottom(r.left + r.width / 2) - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: c.smooth ? 'smooth' : 'instant' });
    return { found: true };
  },

  // ---- acting -------------------------------------------------------------------------------
  // Lists the open menu and stamps the item to click (data-tc-choice): exact c.label if given,
  // else the "not interested" entry.
  menu(c) {
    document.querySelectorAll('[data-tc-choice]').forEach((e) => e.removeAttribute('data-tc-choice'));
    const items = [...document.querySelectorAll(c.sel.menuItem)];
    const pick = items.find((i) =>
      c.label != null ? this._norm(i.innerText) === this._norm(c.label) : i.innerText.toLowerCase().includes(c.text.notInterested),
    );
    pick?.setAttribute('data-tc-choice', '');
    return {
      open: items.length > 0,
      labels: items.map((i) => this._norm(i.innerText)),
      stamped: !!pick,
      choice: pick ? this._norm(pick.innerText) : null,
    };
  },

  // After a click: 'hidden' (X's notice replaced it), 'gone' (unmounted), or 'visible' (still there).
  hideState(c) {
    const cell = document.querySelector('[data-tc-cell]');
    if (cell && new RegExp(c.text.hiddenNotice, 'i').test(cell.innerText) && !this._find(c, c.target)) {
      return { state: 'hidden' };
    }
    if (this._find(c, c.target)) return { state: 'visible' };
    return { state: cell ? 'hidden' : 'gone' };
  },

  // Agent path only: numbers the stamped target's buttons that pass the guard (data-tc-btn="n").
  // Links, the quoted block and engagement buttons are never offered.
  postButtons(c) {
    const el = document.querySelector('[data-tc-target]');
    if (!el) return [];
    el.querySelectorAll('[data-tc-btn]').forEach((b) => b.removeAttribute('data-tc-btn'));
    const tid = new RegExp(c.guard.denyButtonTestid, 'i');
    const lab = new RegExp(c.guard.denyButtonLabel, 'i');
    const out = [];
    for (const b of el.querySelectorAll(c.sel.button)) {
      const label = this._norm(b.getAttribute('aria-label') || b.innerText).slice(0, 60);
      if (b.closest('a[href]') || b.closest('div[role="link"]')) continue;
      if (tid.test(b.dataset.testid || '') || lab.test(label)) continue;
      b.setAttribute('data-tc-btn', String(out.length));
      out.push({ n: out.length, label });
    }
    return out;
  },
})
